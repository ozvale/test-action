'use strict';

/**
 * openlibing-client：openlibing 平台与华为云 / gitcode / github 等平台的交互 SDK（单文件，通用基础能力）
 *
 * 本模块封装 openlibing 平台对接华为云的通用基础能力，供上层插件（如 demo-action）以最简单的方式调用：
 *   1. OIDC 认证：getCredentials() 获取华为云临时凭证（AK/SK/SecurityToken），调用链为
 *      GitHub Actions OIDC ID Token（audience = huawei-cloud-service）-> 华为云 STS
 *      AssumeAgencyWithOIDC 换证，带缓存自动刷新、force 强制刷新、并发去重。
 *   2. APIG V11 签名：V11Signer 对 APIG 请求做 V11-HMAC-SHA256 签名（严格复刻华为云官方
 *      APIG Python SDK 的 V11 算法，仅适用于 APIG 网关，作用域服务名固定为 apic）。
 *   3. HTTPS 请求工具：sendRequest() 发送请求并解析 JSON 响应，供调用 APIG 等接口使用。
 *
 * 设计边界：只封装通用基础能力，不封装业务编排（如 callApig / uploadToObs 高层封装）。
 * OBS 上传等业务逻辑由使用方基于本 SDK 提供的临时凭证自行实现（OBS 使用自身签名协议）。
 *
 * 调试模式：默认静默；configure({ debug: true }) 开启后打印关键步骤日志，包括每次
 * HTTP 请求的请求行、请求头、请求体与响应状态码、响应头、响应体（敏感字段自动脱敏）。
 *
 * 仅依赖 Node 内置 https / crypto / url，不依赖 @actions/core；OIDC Token 通过 GitHub
 * Actions 环境变量自包含申请，任意 Node 环境均可独立使用。
 *
 * 用法：
 *   const openlibing = require('./openlibing-client');
 *
 *   // 开启调试模式（打印关键步骤与请求/响应日志，敏感字段脱敏）
 *   openlibing.configure({ debug: true });
 *
 *   // 1) OIDC 认证：获取临时凭证
 *   const cred = await openlibing.getCredentials();
 *   // => { accessKeyId, secretAccessKey, securityToken, expiresAt, expiresIn }
 *
 *   // 强制刷新
 *   const fresh = await openlibing.getCredentials({ force: true });
 *
 *   // 覆盖内置 openlibing 配置（换账号/区域等）
 *   openlibing.configure({ accountId: 'xxx', region: 'cn-north-4' });
 *
 *   // 2) 生成 APIG V11 签名
 *   const signer = new openlibing.V11Signer({ region: 'cn-southwest-2' });
 *   signer.Key = cred.accessKeyId;
 *   signer.Secret = cred.secretAccessKey;
 *   const headers = signer.sign('GET', 'https://{apig-host}/v1/export', {}, '');
 *
 *   // 3) 发送 HTTPS 请求
 *   const res = await openlibing.sendRequest('GET', 'https://{apig-host}/v1/export', headers, '');
 *   // => { status, data }
 */

const https = require('https');
const crypto = require('crypto');

// ==================== 基础工具 ====================

/** 输出日志：仅在调试模式（configure({ debug: true })）下打印（普通 Node 环境使用 console.log，不依赖 @actions/core）。 */
function log(msg) {
  if (cfg.debug) {
    console.log(msg);
  }
}

/** 脱敏：仅保留首尾若干字符，中间用 * 代替。 */
function mask(value, head = 6, tail = 4) {
  if (!value) return '(空)';
  const s = String(value);
  if (s.length <= head + tail) return s.slice(0, 2) + '***' + s.slice(-2);
  return s.slice(0, head) + '***' + s.slice(-tail) + `（长度 ${s.length}）`;
}

/** 调试日志中需要脱敏的字段名（请求头字段与 JSON 字段名，小写比较）。 */
const SENSITIVE_KEYS = [
  'authorization', 'x-security-token', 'x-auth-token', 'password', 'secret',
  'id_token', 'access_key_id', 'secret_access_key', 'security_token',
  'accesskeyid', 'secretaccesskey', 'securitytoken', 'client_secret'
];

/** JWT 特征（三段 base64url，以 eyJ 开头），用于在任意文本中识别并脱敏令牌。 */
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

/** 文本脱敏：将其中的 JWT 令牌整体脱敏。 */
function maskText(text) {
  return String(text).replace(JWT_RE, (m) => mask(m, 20, 10));
}

/** 深度脱敏 JSON 结构：敏感字段名直接脱敏，其余字段递归处理（字符串再做 JWT 识别）。 */
function maskDeep(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return maskText(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = SENSITIVE_KEYS.includes(k.toLowerCase()) ? mask(value[k]) : maskDeep(value[k]);
    }
    return out;
  }
  return value;
}

/** 请求头脱敏：敏感头字段值脱敏，其余原样。 */
function maskHeaders(headers) {
  const out = {};
  for (const k of Object.keys(headers || {})) {
    out[k] = SENSITIVE_KEYS.includes(k.toLowerCase()) ? mask(headers[k]) : headers[k];
  }
  return out;
}

/** 请求体/响应体脱敏：JSON 结构做深度脱敏，非 JSON 文本做 JWT 识别脱敏。 */
function maskBody(body) {
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  try {
    return JSON.stringify(maskDeep(JSON.parse(s)));
  } catch (e) {
    return maskText(s);
  }
}

// ==================== 内置固定配置（openlibing 账号） ====================

const CONFIG = {
  // openlibing 华为云账号 ID
  accountId: '4d29a984c4fe4e6eb5d404a853d0084e',
  // OIDC 受众（申请 GitHub ID Token 的 audience，需与身份提供商注册的客户端 ID 一致）
  audience: 'huawei-cloud-service',
  // IAM 信任委托名称
  agencyName: 'gitcode-actions',
  // OIDC 身份提供商名称
  oidcProviderName: 'GitHubActions',
  // 区域（openlibing 账号固定区域，可显式覆盖）
  region: 'cn-southwest-2',
  // STS 换证路径
  stsAssumePath: '/v5/agencies/assume-with-oidc',
  // 临时凭证默认有效期（秒）
  durationSeconds: 3600,
  // 提前刷新缓冲（秒），避免凭证在边界过期
  refreshBufferSeconds: 300,
  // 调试模式：开启后打印关键步骤日志（含每次 HTTP 请求/响应详情，敏感字段自动脱敏）
  debug: false
};

// 当前生效配置（可用 configure() 覆盖）
let cfg = { ...CONFIG };

// ==================== 对外 API：配置覆盖 ====================

/**
 * 覆盖内置配置（如更换账号 / 区域 / 受众 / 委托等）。
 * @param {Object} overrides 可覆盖字段：accountId/audience/agencyName/oidcProviderName/
 *                           region/stsAssumePath/durationSeconds/refreshBufferSeconds/debug
 * @returns {Object} 覆盖后的完整配置（含全部内置默认值）
 */
function configure(overrides = {}) {
  const allowed = [
    'accountId', 'audience', 'agencyName', 'oidcProviderName',
    'region', 'stsAssumePath', 'durationSeconds', 'refreshBufferSeconds', 'debug'
  ];
  for (const k of allowed) {
    if (overrides[k] !== undefined) {
      cfg[k] = overrides[k];
    }
  }
  return { ...cfg };
}

// ==================== 对外 API：获取临时凭证 ====================

/**
 * 获取 openlibing 账号下的华为云临时凭证。
 * 优先级：有效缓存 > OIDC+STS 换证。
 * @param {Object} [opts]
 * @param {boolean} [opts.force] 为 true 时强制重新换证（忽略缓存）
 * @returns {Promise<{accessKeyId: string, secretAccessKey: string,
 *                     securityToken: string|null, expiresAt: string|null, expiresIn: number|null}>}
 */
async function getCredentials(opts = {}) {
  if (!opts.force && _isValid(_credentials)) {
    const expiresIn = Math.max(0, Math.round((_credentials.expiresAt - Date.now()) / 1000));
    log(`-- 临时凭证缓存有效，直接复用（剩余约 ${expiresIn} 秒）--`);
    return {
      accessKeyId: _credentials.accessKeyId,
      secretAccessKey: _credentials.secretAccessKey,
      securityToken: _credentials.securityToken,
      expiresAt: _credentials.expiresAtISO,
      expiresIn
    };
  }
  if (_credentials) {
    log('-- 临时凭证缓存缺失或已过期，重新换取 --');
  }
  const cred = await _exchangeCredentials();
  return {
    accessKeyId: cred.accessKeyId,
    secretAccessKey: cred.secretAccessKey,
    securityToken: cred.securityToken,
    expiresAt: cred.expiresAtISO,
    expiresIn: Math.max(0, Math.round((cred.expiresAt - Date.now()) / 1000))
  };
}

// ==================== 对外 API：HTTPS 请求工具 ====================

/**
 * 发送 HTTPS 请求并解析 JSON 响应（通用基础能力，供调用 APIG 等接口使用）。
 * 调试模式（configure({ debug: true })）下打印完整请求/响应日志，敏感字段自动脱敏。
 * @param {string} method  HTTP 方法（GET/POST/...）
 * @param {string} url     完整 URL（https://{host}{path}[?query]）
 * @param {Object} [headers] 请求头
 * @param {string} [body]    请求体（字符串）
 * @returns {Promise<{status: number, headers: Object, data: Object|string}>}
 *          JSON 解析失败时 data = { raw }
 */
function sendRequest(method, url, headers, body) {
  if (cfg.debug) {
    log(`--> ${String(method).toUpperCase()} ${url}`);
    log(`--> 请求头: ${JSON.stringify(maskHeaders(headers))}`);
    if (body) {
      log(`--> 请求体: ${maskBody(body)}`);
    }
  }
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      method,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      headers
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (cfg.debug) {
          log(`<-- HTTP 状态码: ${res.statusCode}`);
          log(`<-- 响应头: ${JSON.stringify(res.headers || {})}`);
          log(`<-- 响应体: ${raw ? maskBody(raw) : '(空)'}`);
        }
        let data = {};
        if (raw) {
          try {
            data = JSON.parse(raw);
          } catch (e) {
            data = { raw };
          }
        }
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
    });

    req.on('error', (err) => {
      reject(new Error(`网络请求失败 ${method} ${url}: ${err.message}`));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

// ==================== 内部实现：临时凭证管理（OIDC -> STS，带缓存 + 并发去重） ====================

let _credentials = null; // { accessKeyId, secretAccessKey, securityToken, expiresAt, expiresAtISO }
let _credentialPromise = null; // 进行中的换证 Promise（并发去重）

/** 判断缓存凭证是否仍有效（未过期且留有缓冲时间）。 */
function _isValid(cred) {
  if (!cred || !cred.expiresAt) {
    return false;
  }
  return Date.now() < cred.expiresAt - cfg.refreshBufferSeconds * 1000;
}

/** 申请 GitHub OIDC ID Token（自包含，不依赖 @actions/core）。 */
async function _getOidcToken() {
  const fromEnv = process.env.HUAWEICLOUD_OIDC_TOKEN;
  if (fromEnv) {
    log('-- 使用环境变量 HUAWEICLOUD_OIDC_TOKEN 提供的 OIDC Token（诊断/测试）--');
    return fromEnv;
  }
  const fromActions = await _getOidcTokenFromActions();
  if (fromActions) {
    log('-- 通过 GitHub Actions OIDC 接口自行申请到 ID Token --');
    return fromActions;
  }
  throw new Error(
    '无法申请 OIDC ID Token：缺少 ACTIONS_ID_TOKEN_REQUEST_URL/ACTIONS_ID_TOKEN_REQUEST_TOKEN。' +
    '请确认 workflow 已声明 permissions: id-token: write，或设置环境变量 HUAWEICLOUD_OIDC_TOKEN。'
  );
}

/**
 * 通过 GitHub Actions 环境变量自行申请 OIDC ID Token。
 * 与 @actions/core 的 getIDToken 实现一致：向 ACTIONS_ID_TOKEN_REQUEST_URL 发起
 * GET 请求并携带 audience 查询参数，Authorization 头使用 ACTIONS_ID_TOKEN_REQUEST_TOKEN。
 * @returns {Promise<string|null>}
 */
async function _getOidcTokenFromActions() {
  const reqUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const reqToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!reqUrl || !reqToken) {
    return null;
  }
  const url = new URL(reqUrl);
  url.searchParams.append('audience', cfg.audience);
  const res = await sendRequest('GET', url.toString(), {
    Authorization: `Bearer ${reqToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'OpenlibingClient/1.0'
  }, '');
  if (res.status !== 200 || !res.data || !res.data.value) {
    log(`OIDC Token 申请失败（HTTP ${res.status}）: ${JSON.stringify(res.data)}`);
    return null;
  }
  return res.data.value;
}

/**
 * 通过 GitHub OIDC JWT 调用 STS AssumeAgencyWithOIDC 换取临时 AK/SK/SecurityToken。
 * @returns {Promise<{accessKeyId: string, secretAccessKey: string,
 *                     securityToken: string, expiresAt: number, expiresAtISO: string}>}
 */
async function _assumeAgencyWithOIDC() {
  const providerUrn = `iam::${cfg.accountId}:oidcProvider:${cfg.oidcProviderName}`;
  const agencyUrn = `iam::${cfg.accountId}:agency:${cfg.agencyName}`;
  const stsEndpoint = `https://sts.${cfg.region}.myhuaweicloud.com${cfg.stsAssumePath}`;

  log('=== 步骤1：申请 GitHub OIDC ID Token ===');
  log(`audience=${cfg.audience}`);
  const idToken = await _getOidcToken();
  if (!idToken) {
    throw new Error('获取 OIDC ID Token 为空（请确认 workflow 已声明 permissions: id-token: write）');
  }
  log(`OIDC Token 获取成功，长度 ${idToken.length}`);

  log('-- OIDC Token 声明（用于与华为云信任策略比对）--');
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
    log(`iss : ${JSON.stringify(payload.iss)}`);
    log(`aud : ${JSON.stringify(payload.aud)}`);
    log(`azp : ${JSON.stringify(payload.azp)}`);
    log(`sub : ${JSON.stringify(payload.sub)}`);
  } catch (e) {
    log(`（无法解析 OIDC Token payload：${e.message}）`);
  }

  const body = {
    provider_urn: providerUrn,
    agency_urn: agencyUrn,
    agency_session_name: cfg.agencyName,
    id_token: idToken,
    duration_seconds: cfg.durationSeconds
  };

  log('=== 步骤2：调用 STS AssumeAgencyWithOIDC ===');
  log(`provider_urn        : ${body.provider_urn}`);
  log(`agency_urn          : ${body.agency_urn}`);
  log(`agency_session_name : ${body.agency_session_name}`);
  log(`duration_seconds    : ${body.duration_seconds}`);

  const res = await sendRequest('POST', stsEndpoint, { 'Content-Type': 'application/json' }, JSON.stringify(body));

  if (res.status !== 200) {
    const code = res.data && (res.data.error_code || res.data.code);
    const msg = res.data && (res.data.error_msg || res.data.message);
    log(`STS 失败详情 : ${maskBody(res.data)}`);
    log('=== 排查提示 ===');
    log('STS5.1001/403：多为信任策略条件不匹配，请将上方 OIDC Token 的 iss/aud/azp/sub 与华为云信任策略逐项比对。');
    log('  - iss 必须严格等于 https://token.actions.githubusercontent.com');
    log('  - aud/azp 必须与策略中 oidc:aud 一致（且身份提供商客户端 ID 已注册）');
    log('  - sub 必须能被策略中 oidc:sub 的通配符匹配');
    throw new Error(`STS auth failed (${res.status})${code ? ' [' + code + ']' : ''}: ${msg || '未知错误'}`);
  }

  const cred = res.data.credentials;
  if (!cred || !cred.access_key_id || !cred.secret_access_key || !cred.security_token) {
    log(`STS 响应体 : ${maskBody(res.data)}`);
    throw new Error('STS auth failed: 响应中缺少临时凭证字段');
  }

  log('=== 步骤3：成功获取临时安全凭证 ===');
  log(`临时 AK          : ${mask(cred.access_key_id)}`);
  log(`SecurityToken    : ${mask(cred.security_token, 10, 10)}`);
  log(`凭证过期时间     : ${cred.expiration}`);
  log(`凭证有效期(秒)   : ${Math.round((new Date(cred.expiration).getTime() - Date.now()) / 1000)}`);

  const expiresAt = new Date(cred.expiration).getTime();
  const result = {
    accessKeyId: cred.access_key_id,
    secretAccessKey: cred.secret_access_key,
    securityToken: cred.security_token,
    expiresAt,
    expiresAtISO: cred.expiration
  };
  _credentials = result;
  _credentialPromise = null;
  return result;
}

/**
 * 换取临时凭证（带并发去重：同一时刻只发起一次 STS 换证，其余等待同一结果）。
 * @returns {Promise<Object>} 同 _assumeAgencyWithOIDC 返回
 */
async function _exchangeCredentials() {
  if (_credentialPromise) {
    log('-- 检测到进行中的换证请求，复用同一结果（并发去重）--');
    return _credentialPromise;
  }
  _credentialPromise = _assumeAgencyWithOIDC();
  try {
    return await _credentialPromise;
  } catch (err) {
    _credentialPromise = null;
    throw err;
  }
}

// ==================== 内部实现：APIG V11-HMAC-SHA256 签名器 ====================

const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const APIC_SERVICE = 'apic';

// 与官方 noEscape 一致的字符表：不可编码字符（字母数字和 - _ . ~）为 1
const noEscape = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0,
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1,
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0
];

const hexTable = [];
for (let i = 0; i < 256; ++i) {
  hexTable[i] = '%' + ((i < 16 ? '0' : '') + i.toString(16)).toUpperCase();
}

/** 官方 urlencode 实现（quote(str, safe='~')）。 */
function urlEncode(str) {
  if (typeof str !== 'string') {
    str = str == null ? '' : String(str);
  }
  let out = '';
  let lastPos = 0;
  for (let i = 0; i < str.length; ++i) {
    const c = str.charCodeAt(i);
    if (c < 0x80) {
      if (noEscape[c] === 1) continue;
      if (lastPos < i) out += str.slice(lastPos, i);
      lastPos = i + 1;
      out += hexTable[c];
      continue;
    }
    if (lastPos < i) out += str.slice(lastPos, i);
    if (c < 0x800) {
      lastPos = i + 1;
      out += hexTable[0xC0 | (c >> 6)] + hexTable[0x80 | (c & 0x3F)];
      continue;
    }
    if (c < 0xD800 || c >= 0xE000) {
      lastPos = i + 1;
      out += hexTable[0xE0 | (c >> 12)] +
        hexTable[0x80 | ((c >> 6) & 0x3F)] +
        hexTable[0x80 | (c & 0x3F)];
      continue;
    }
    ++i;
    if (i >= str.length) throw new Error('ERR_INVALID_URI');
    const c2 = str.charCodeAt(i) & 0x3FF;
    lastPos = i + 1;
    const cFull = 0x10000 + (((c & 0x3FF) << 10) | c2);
    out += hexTable[0xF0 | (cFull >> 18)] +
      hexTable[0x80 | ((cFull >> 12) & 0x3F)] +
      hexTable[0x80 | ((cFull >> 6) & 0x3F)] +
      hexTable[0x80 | (cFull & 0x3F)];
  }
  if (lastPos === 0) return str;
  if (lastPos < str.length) return out + str.slice(lastPos);
  return out;
}

/** CanonicalURI：路径按 '/' 分段逐段编码后拼接，末尾补 '/'。 */
function canonicalURI(pathname) {
  const input = pathname || '';
  const uriList = input.split('/');
  const uri = uriList.map((seg) => urlEncode(seg));
  let urlpath = uri.join('/');
  if (urlpath[urlpath.length - 1] !== '/') {
    urlpath = urlpath + '/';
  }
  return urlpath;
}

/** CanonicalQueryString：查询参数按键排序，值排序后拼接。 */
function canonicalQueryString(searchParams) {
  const keys = [];
  for (const key of searchParams.keys()) keys.push(key);
  keys.sort();
  const arr = [];
  for (const key of keys) {
    const ke = urlEncode(key);
    const values = searchParams.getAll(key);
    values.sort();
    for (const v of values) {
      arr.push(ke + '=' + urlEncode(v));
    }
  }
  return arr.join('&');
}

/**
 * CanonicalHeaders：按 signed headers 顺序，name:value\n（value 去首尾空格）。
 * 注意：allHeaders 的 key 可能保留原始大小写，因此先构建小写 key 的查找表，
 * 否则会取到 undefined，导致规范请求错误、签名不匹配（表现为 APIG.0602 等）。
 */
function canonicalHeaders(allHeaders, signedHeaders) {
  const normalized = {};
  for (const k of Object.keys(allHeaders)) {
    normalized[k.toLowerCase()] = allHeaders[k];
  }
  const arr = [];
  for (const k of signedHeaders) {
    arr.push(k + ':' + String(normalized[k]).trim());
  }
  return arr.join('\n') + '\n';
}

/** sha256 hex。 */
function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/** hmac-sha256 hex。 */
function hmacSha256Hex(key, str) {
  return crypto.createHmac('sha256', key).update(str, 'utf8').digest('hex');
}

/**
 * HKDF-SHA256 派生密钥，返回 hex 字符串。
 * 严格对齐官方 signer_v11.py 的 _hkdf：salt = AK，ikm = SK，info = credential_scope。
 */
function hkdfGetDerKeySha256(accessKey, secretKey, credentialScope) {
  const salt = Buffer.from(accessKey, 'utf8');
  const ikm = Buffer.from(secretKey, 'utf8');
  const info = Buffer.from(credentialScope, 'utf8');
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  let okm = Buffer.alloc(0);
  let t = Buffer.alloc(0);
  const length = 32;
  const rounds = Math.ceil((length + 32) / 32);
  for (let i = 1; i <= rounds; ++i) {
    const newInfo = Buffer.concat([t, info, Buffer.from([i])]);
    t = crypto.createHmac('sha256', prk).update(newInfo).digest();
    okm = Buffer.concat([okm, t], okm.length + t.length);
  }
  return okm.slice(0, length).toString('hex').toLowerCase();
}

/** 当前 GMT 时间，格式 YYYYMMDDTHHMMSSZ。 */
function getTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

/**
 * V11Signer：使用 AK/SK 对 APIG 请求做 V11-HMAC-SHA256 签名。
 * 仅适用于 APIG 网关接口（签名作用域服务名固定为 apic）。
 */
class V11Signer {
  constructor(options = {}) {
    this.Key = '';
    this.Secret = '';
    this.region = options.region || '';
  }

  /**
   * 对请求签名，返回签名后的完整请求头（含 Authorization / x-sdk-date / host）。
   * @param {string} method   HTTP 方法（如 GET/POST）
   * @param {string} url      完整 URL（https://{apig-host}{path}[?query]）
   * @param {Object} [headers] 请求头
   * @param {string} [body]    请求体（字符串）
   * @returns {Object} 签名后的请求头
   */
  sign(method, url, headers = {}, body = '') {
    const parsedUrl = new URL(url);

    const allHeaders = {};
    for (const k of Object.keys(headers)) allHeaders[k] = headers[k];
    if (!Object.keys(allHeaders).some((k) => k.toLowerCase() === 'x-sdk-date')) {
      allHeaders['x-sdk-date'] = getTime();
    }
    if (!Object.keys(allHeaders).some((k) => k.toLowerCase() === 'host')) {
      allHeaders['host'] = parsedUrl.host;
    }

    const signedHeaders = Object.keys(allHeaders)
      .map((k) => k.toLowerCase())
      .sort();

    const canonicalURIStr = canonicalURI(parsedUrl.pathname);
    const canonicalQueryStringStr = canonicalQueryString(parsedUrl.searchParams);
    const canonicalHeadersStr = canonicalHeaders(allHeaders, signedHeaders);
    const payloadHash = body ? sha256Hex(body) : EMPTY_BODY_SHA256;

    const canonicalRequest = [
      method.toUpperCase(),
      canonicalURIStr,
      canonicalQueryStringStr,
      canonicalHeadersStr,
      signedHeaders.join(';'),
      payloadHash
    ].join('\n');

    const canonicalRequestHash = sha256Hex(canonicalRequest);

    const time = allHeaders['x-sdk-date'];
    const formattedDate = time.substring(0, 8);
    const credentialScope = formattedDate + '/' + this.region + '/' + APIC_SERVICE;

    const stringToSign =
      'V11-HMAC-SHA256\n' +
      time + '\n' +
      credentialScope + '\n' +
      canonicalRequestHash;

    const realUseSecret = hkdfGetDerKeySha256(this.Key, this.Secret, credentialScope);
    const signature = hmacSha256Hex(realUseSecret, stringToSign);

    allHeaders['Authorization'] =
      'V11-HMAC-SHA256 Credential=' + this.Key + '/' + credentialScope +
      ', SignedHeaders=' + signedHeaders.join(';') +
      ', Signature=' + signature;

    return allHeaders;
  }
}

module.exports = { getCredentials, configure, V11Signer, sendRequest };
