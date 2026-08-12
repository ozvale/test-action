'use strict';

/**
 * HuaweiCloudClient
 *
 * 封装华为云 OIDC 认证 + STS 换临时凭证 + APIG 签名调用的全部逻辑。
 * 业务层只需调用 callApi(path, method, body) 一个方法，内部自动完成：
 *   1. 检查临时凭证缓存是否有效，有效则复用
 *   2. 无效则调用 core.getIDToken(audience) 申请 GitHub OIDC JWT
 *   3. 用 JWT 调用 STS AssumeAgencyWithOIDC 换取临时 AK/SK/SecurityToken
 *   4. 用临时凭证 + 签名 SDK 对 APIG 请求做 HMAC-SHA256 签名
 *   5. 在请求头携带 X-Security-Token
 *   6. 发送 HTTP 请求到 APIG
 *
 * 本模块内置详细调试日志，覆盖调用链每个关键节点，便于出问题快速定位。
 * 所有敏感信息（AK/SK/SecurityToken/OIDC Token）均会脱敏，不完整打印。
 */

const https = require('https');
const core = require('@actions/core');
const { Signer, HttpRequest } = require('../apig_sdk/signer');

// ---- 命名约定常量（必须与华为云侧配置一致）----
const OIDC_PROVIDER_NAME = 'GitHubActions';
const AGENCY_NAME = 'github-actions-deploy';
const AUDIENCE = 'huawei-cloud-oidc';

// ---- 默认值（可由华为云管理员提供后按需修改）----
const DEFAULT_APIG_HOST = 'c1231bf9a6884b7bb413e56abaa671c0.apic.cn-southwest-2.huaweicloudapis.com';
const STS_ASSUME_PATH = '/v5/agencies/assume-with-oidc';
const DEFAULT_DURATION_SECONDS = 3600;
// 提前 5 分钟刷新临时凭证，避免边界过期
const REFRESH_BUFFER_SECONDS = 300;

// 调试日志开关（可通过环境变量 DEBUG 或 options.debug 控制，默认开启详细日志）
const DEBUG_ENABLED = process.env.DEBUG !== '0';

class HuaweiCloudClient {
  /**
   * @param {string} accountId 华为云账号 ID（使用者唯一需要提供的值）
   * @param {Object} [options] 可选配置
   * @param {string} [options.apigHost] APIG 域名，默认使用 DEFAULT_APIG_HOST
   * @param {string} [options.agencySessionName] STS 会话名，默认 github-actions-deploy
   * @param {string} [options.serviceName] V11 签名派生服务名（Credential 作用域第三段，需与 APIG 期望一致）
   * @param {boolean} [options.debug] 是否输出调试日志，默认 true
   */
  constructor(accountId, options = {}) {
    if (!accountId) {
      throw new Error('huawei-account-id 不能为空');
    }
    this.accountId = accountId;
    this.apigHost = options.apigHost || DEFAULT_APIG_HOST;
    this.agencySessionName = options.agencySessionName || 'github-actions-deploy';
    this.serviceName = options.serviceName || '';
    this.debug = options.debug !== undefined ? options.debug : DEBUG_ENABLED;

    // 从 APIG 域名自动解析区域（如 cxxx.apic.cn-southwest-2.huaweicloudapis.com -> cn-southwest-2）
    this.region = HuaweiCloudClient.extractRegion(this.apigHost);

    this.providerUrn = `iam::${accountId}:oidcProvider:${OIDC_PROVIDER_NAME}`;
    this.agencyUrn = `iam::${accountId}:agency:${AGENCY_NAME}`;
    this.stsEndpoint = `https://sts.${this.region}.myhuaweicloud.com${STS_ASSUME_PATH}`;

    this._credentials = null; // { accessKeyId, secretAccessKey, securityToken, expiresAt }

    this._log('=== HuaweiCloudClient 初始化 ===');
    this._log(`账号 ID        : ${accountId}`);
    this._log(`APIG 域名      : ${this.apigHost}`);
    this._log(`解析区域       : ${this.region}`);
    this._log(`身份提供商 URN : ${this.providerUrn}`);
    this._log(`信任委托 URN   : ${this.agencyUrn}`);
    this._log(`STS 端点       : ${this.stsEndpoint}`);
    this._log(`会话名         : ${this.agencySessionName}`);
    this._log(`OIDC 受众      : ${AUDIENCE}`);
    this._log('（请核对以上 URN 与华为云侧实际配置完全一致）');
  }

  /**
   * 从华为云 APIG 域名中提取区域。
   * 域名格式：{instance}.{product}.{region}.huaweicloudapis.com
   * 如 c1231bf9a6884b7bb413e56abaa671c0.apic.cn-southwest-2.huaweicloudapis.com
   * @param {string} host APIG 域名
   * @returns {string} 区域标识，如 cn-southwest-2
   */
  static extractRegion(host) {
    const match = host.match(/\.([a-z]{2}-[a-z]+-\d+)\.huaweicloudapis\.com$/);
    if (!match || !match[1]) {
      throw new Error(`无法从 APIG 域名解析区域: ${host}`);
    }
    return match[1];
  }

  /** 输出日志（统一走 core.info，便于在 GitHub Actions 日志中检索）。 */
  _log(msg) {
    if (this.debug) {
      core.info(msg);
    }
  }

  /** 脱敏：仅保留字符串首尾若干字符，中间用 * 代替。 */
  static _mask(value, head = 6, tail = 4) {
    if (!value) {
      return '(空)';
    }
    const s = String(value);
    if (s.length <= head + tail) {
      return s.slice(0, 2) + '***' + s.slice(-2);
    }
    return s.slice(0, head) + '***' + s.slice(-tail) + `（长度 ${s.length}）`;
  }

  /**
   * 调用 APIG 接口。
   * @param {string} path   API 路径，如 /v1/applications/deploy
   * @param {string} method HTTP 方法，如 POST
   * @param {Object} body   请求体对象，可为 null
   * @returns {Promise<{status: number, data: Object}>} 响应状态码与解析后的 JSON 数据
   */
  async callApi(path, method = 'GET', body = null) {
    this._log(`=== 调用 APIG 接口 ===`);
    this._log(`URL  : ${method.toUpperCase()} https://${this.apigHost}${path}`);
    this._log(`Body : ${body ? JSON.stringify(body) : '(无)'}`);

    const credentials = await this._getCredentials();

    const url = `https://${this.apigHost}${path}`;
    const payload = body ? JSON.stringify(body) : '';

    const signer = new Signer();
    signer.Key = credentials.accessKeyId;
    signer.Secret = credentials.secretAccessKey;

    this._log(`-- 对 APIG 请求进行 SDK-HMAC-SHA256 签名（X-Apig-Authorization）--`);
    this._log(`使用临时 AK : ${HuaweiCloudClient._mask(credentials.accessKeyId)}`);
    this._log(`SecurityToken 是否携带 : ${credentials.securityToken ? '是' : '否'}`);

    // 与 APIG 调试客户端一致：签名覆盖 user-agent;x-apig-mode;x-sdk-date，
    // 因此仅传入 User-Agent 与 X-Apig-Mode（GET 无请求体，无需 Content-Type 参与签名）
    const signedHeaders = signer.sign(new HttpRequest(method, url, {
      'User-Agent': 'DeployAction/1.0',
      'X-Apig-Mode': 'debug'
    }, payload));
    // 临时凭证调用必须携带会话令牌（不参与签名）
    signedHeaders['X-Security-Token'] = credentials.securityToken;
    // 业务请求仍需声明 JSON 内容类型（不参与签名）
    signedHeaders['Content-Type'] = 'application/json';

    const res = await this._sendRequest(method, url, signedHeaders, payload);

    this._log(`APIG 响应状态码 : ${res.status}`);
    this._log(`APIG 响应体    : ${JSON.stringify(res.data)}`);
    return res;
  }

  /**
   * 获取（或刷新）临时凭证。
   * 命中有效缓存则直接复用，否则走完整 OIDC + STS 换证流程。
   */
  async _getCredentials() {
    if (this._isValid(this._credentials)) {
      this._log(`-- 临时凭证缓存有效，直接复用（有效期剩余约 ${Math.round((this._credentials.expiresAt - Date.now()) / 1000)} 秒）--`);
      return this._credentials;
    }
    if (this._credentials) {
      this._log('-- 临时凭证缓存缺失或已过期，重新换取 --');
    }
    this._credentials = await this._assumeAgencyWithOIDC();
    return this._credentials;
  }

  /** 判断缓存凭证是否仍有效（未过期且留有缓冲时间）。 */
  _isValid(credentials) {
    if (!credentials || !credentials.expiresAt) {
      return false;
    }
    return Date.now() < credentials.expiresAt - REFRESH_BUFFER_SECONDS * 1000;
  }

  /**
   * 通过 GitHub OIDC JWT 调用 STS AssumeAgencyWithOIDC 换取临时 AK/SK/SecurityToken。
   */
  async _assumeAgencyWithOIDC() {
    this._log(`=== 步骤1：申请 GitHub OIDC ID Token ===`);
    this._log(`audience=${AUDIENCE}`);
    let idToken;
    try {
      idToken = await core.getIDToken(AUDIENCE);
    } catch (e) {
      if (/not a function/i.test(e.message)) {
        throw new Error(`getIDToken is not a function（请确认 workflow 已声明 permissions: id-token: write）：${e.message}`);
      }
      throw e;
    }
    if (!idToken) {
      throw new Error('获取 OIDC ID Token 为空（请确认 workflow 已声明 permissions: id-token: write）');
    }
    this._log(`OIDC Token 获取成功，长度 ${idToken.length}`);

    // 解码并打印 JWT payload（用于与信任策略的 iss/aud/sub 比对）
    this._log(`-- OIDC Token 声明（用于与华为云信任策略比对）--`);
    try {
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
      this._log(`iss : ${JSON.stringify(payload.iss)}`);
      this._log(`aud : ${JSON.stringify(payload.aud)}`);
      this._log(`azp : ${JSON.stringify(payload.azp)}`);
      this._log(`sub : ${JSON.stringify(payload.sub)}`);
    } catch (e) {
      this._log(`（无法解析 OIDC Token payload：${e.message}）`);
    }

    const body = {
      provider_urn: this.providerUrn,
      agency_urn: this.agencyUrn,
      agency_session_name: this.agencySessionName,
      id_token: idToken,
      duration_seconds: DEFAULT_DURATION_SECONDS
    };

    this._log(`=== 步骤2：调用 STS AssumeAgencyWithOIDC ===`);
    this._log(`endpoint : ${this.stsEndpoint}`);
    this._log(`provider_urn        : ${body.provider_urn}`);
    this._log(`agency_urn          : ${body.agency_urn}`);
    this._log(`agency_session_name : ${body.agency_session_name}`);
    this._log(`duration_seconds    : ${body.duration_seconds}`);
    this._log(`id_token            : ${HuaweiCloudClient._mask(body.id_token, 20, 20)}`);

    const res = await this._sendRequest(
      'POST',
      this.stsEndpoint,
      { 'Content-Type': 'application/json' },
      JSON.stringify(body)
    );

    this._log(`STS 响应状态码 : ${res.status}`);

    if (res.status !== 200) {
      const code = res.data && (res.data.error_code || res.data.code);
      const msg = res.data && (res.data.error_msg || res.data.message);
      this._log(`STS 失败详情 : ${JSON.stringify(res.data)}`);
      this._log(`=== 排查提示 ===`);
      this._log(`STS5.1001/403：多为信任策略条件不匹配，请将上方 OIDC Token 的 iss/aud/azp/sub 与华为云信任策略逐项比对。`);
      this._log(`  - iss 必须严格等于 https://token.actions.githubusercontent.com`);
      this._log(`  - aud/azp 必须与策略中 oidc:aud 一致`);
      this._log(`  - sub 必须能被策略中 oidc:sub 的通配符匹配`);
      throw new Error(`STS auth failed (${res.status})${code ? ' [' + code + ']' : ''}: ${msg || '未知错误'}`);
    }

    const cred = res.data.credentials;
    if (!cred || !cred.access_key_id || !cred.secret_access_key || !cred.security_token) {
      this._log(`STS 响应体 : ${JSON.stringify(res.data)}`);
      throw new Error('STS auth failed: 响应中缺少临时凭证字段');
    }

    this._log(`=== 步骤3：成功获取临时安全凭证 ===`);
    this._log(`临时 AK          : ${HuaweiCloudClient._mask(cred.access_key_id)}`);
    this._log(`SecurityToken    : ${HuaweiCloudClient._mask(cred.security_token, 10, 10)}`);
    this._log(`凭证过期时间     : ${cred.expiration}`);
    this._log(`凭证有效期(秒)   : ${Math.round((new Date(cred.expiration).getTime() - Date.now()) / 1000)}`);
    return {
      accessKeyId: cred.access_key_id,
      secretAccessKey: cred.secret_access_key,
      securityToken: cred.security_token,
      expiresAt: cred.expiration ? new Date(cred.expiration).getTime() : Date.now() + DEFAULT_DURATION_SECONDS * 1000
    };
  }

  /**
   * 发送 HTTPS 请求并解析 JSON 响应。
   */
  _sendRequest(method, url, headers, body) {
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
          let data = {};
          if (raw) {
            try {
              data = JSON.parse(raw);
            } catch (e) {
              data = { raw };
            }
          }
          resolve({ status: res.statusCode, data });
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
}

module.exports = HuaweiCloudClient;
