'use strict';

/**
 * 华为云 APIG V11-HMAC-SHA256 签名器（JavaScript）
 *
 * 严格复刻华为云官方 APIG Python SDK（apig_sdk/signer.py + signer_v11.py）的 V11 算法：
 *   - Credential 作用域固定为：YYYYMMDD/{region}/apic（服务名固定为 apic）
 *   - 密钥派生使用 HKDF-SHA256（IKM=SK，salt=AK，info=credential_scope）
 *   - SignedHeaders 为请求中所有头（小写、排序），含 host 与 x-sdk-date
 *   - 规范请求/待签字符串按官方定义构造
 *   - 签名字段写入标准 Authorization 头
 *
 * 参考（官方源码）：
 *   ApiGateway-python-sdk-2.0.7/apig_sdk/signer.py
 *   ApiGateway-python-sdk-2.0.7/apig_sdk/signer_v11.py
 */

const crypto = require('crypto');

const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const APIC_SERVICE = 'apic';
const DATE_FORMAT = 'YYYYMMDDTHHMMSSZ'; // 用于提示，实际用 getTime()

// 与官方 noEscape 一致的字符表：不可编码字符（字母数字和 - _ . ~）为 1
const noEscape = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0 - 15
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16 - 31
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, // 32 - 47  ( '-'=45 '.'=46 )
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, // 48 - 63
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 64 - 79
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, // 80 - 95  ( '_'=95 )
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 96 - 111
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0  // 112 - 127 ( '~'=126 )
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
    let values = searchParams.getAll(key);
    values.sort();
    for (const v of values) {
      arr.push(ke + '=' + urlEncode(v));
    }
  }
  return arr.join('&');
}

/**
 * CanonicalHeaders：按 signed headers 顺序，name:value\n（value 去首尾空格）。
 *
 * 注意：allHeaders 的 key 可能保留原始大小写（如 X-Security-Token、Content-Type），
 * 而 signedHeaders 中的 key 是全小写。因此必须先构建小写 key 的查找表，
 * 否则会取到 undefined，导致规范请求错误、签名不匹配（表现为 APIG.0602 等）。
 * 该逻辑与官方 signer.py 中 CanonicalHeaders 先构建 _headers[keyEncoded] 字典一致。
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
 * 严格对齐官方 signer_v11.py 的 _hkdf：
 *   salt = AK，ikm = SK，info = credential_scope，输出长度 32 字节 hex。
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

/**
 * V11Signer：使用 AK/SK 对请求做 V11-HMAC-SHA256 签名。
 * @param {Object} options
 * @param {string} options.region 区域（如 cn-southwest-2）
 */
class V11Signer {
  constructor(options = {}) {
    this.Key = '';
    this.Secret = '';
    this.region = options.region || '';
  }

  /**
   * 对请求签名，返回签名后的完整请求头（含 Authorization / x-sdk-date / host）。
   * @param {string} method HTTP 方法
   * @param {string} url 完整 URL
   * @param {Object} headers 业务请求头
   * @param {string} body 请求体字符串（可为空）
   * @returns {Object} 签名后的请求头
   */
  sign(method, url, headers = {}, body = '') {
    const parsedUrl = new URL(url);

    // 初始化请求头：加入 x-sdk-date，缺省 host 时自动补 host
    const allHeaders = {};
    for (const k of Object.keys(headers)) allHeaders[k] = headers[k];
    if (!Object.keys(allHeaders).some((k) => k.toLowerCase() === 'x-sdk-date')) {
      allHeaders['x-sdk-date'] = getTime();
    }
    if (!Object.keys(allHeaders).some((k) => k.toLowerCase() === 'host')) {
      allHeaders['host'] = parsedUrl.host;
    }

    // SignedHeaders = 所有头的小写名，排序
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

module.exports = { V11Signer, hkdfGetDerKeySha256, urlEncode, canonicalHeaders, APIC_SERVICE };
