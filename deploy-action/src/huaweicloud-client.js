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

class HuaweiCloudClient {
  /**
   * @param {string} accountId 华为云账号 ID（使用者唯一需要提供的值）
   * @param {Object} [options] 可选配置
   * @param {string} [options.apigHost] APIG 域名，默认使用 DEFAULT_APIG_HOST
   * @param {string} [options.agencySessionName] STS 会话名，默认 github-actions-deploy
   */
  constructor(accountId, options = {}) {
    if (!accountId) {
      throw new Error('huawei-account-id 不能为空');
    }
    this.accountId = accountId;
    this.apigHost = options.apigHost || DEFAULT_APIG_HOST;
    this.agencySessionName = options.agencySessionName || 'github-actions-deploy';

    // 从 APIG 域名自动解析区域（如 cxxx.apic.cn-southwest-2.huaweicloudapis.com -> cn-southwest-2）
    this.region = HuaweiCloudClient.extractRegion(this.apigHost);

    this.providerUrn = `iam::${accountId}:oidcProvider:${OIDC_PROVIDER_NAME}`;
    this.agencyUrn = `iam::${accountId}:agency:${AGENCY_NAME}`;
    this.stsEndpoint = `https://sts.${this.region}.myhuaweicloud.com${STS_ASSUME_PATH}`;

    this._credentials = null; // { accessKeyId, secretAccessKey, securityToken, expiresAt }
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

  /**
   * 调用 APIG 接口。
   * @param {string} path   API 路径，如 /v1/applications/deploy
   * @param {string} method HTTP 方法，如 POST
   * @param {Object} body   请求体对象，可为 null
   * @returns {Promise<{status: number, data: Object}>} 响应状态码与解析后的 JSON 数据
   */
  async callApi(path, method = 'GET', body = null) {
    const credentials = await this._getCredentials();

    const url = `https://${this.apigHost}${path}`;
    const payload = body ? JSON.stringify(body) : '';

    const request = new HttpRequest(method, url, {
      'Content-Type': 'application/json'
    }, payload);

    const signer = new Signer();
    signer.Key = credentials.accessKeyId;
    signer.Secret = credentials.secretAccessKey;

    const signedHeaders = signer.sign(request);
    // 临时凭证调用必须携带会话令牌
    signedHeaders['X-Security-Token'] = credentials.securityToken;

    const res = await this._sendRequest(method, url, signedHeaders, payload);
    return res;
  }

  /**
   * 获取（或刷新）临时凭证。
   * 命中有效缓存则直接复用，否则走完整 OIDC + STS 换证流程。
   */
  async _getCredentials() {
    if (this._isValid(this._credentials)) {
      return this._credentials;
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
    core.info(`申请 GitHub OIDC ID Token（audience=${AUDIENCE}）...`);
    let idToken;
    try {
      idToken = await core.getIDToken(AUDIENCE);
    } catch (e) {
      if (/not a function/i.test(e.message)) {
        throw new Error(`getIDToken is not a function（请确认 workflow 已声明 permissions: id-token: write）：${e.message}`);
      }
      throw e;
    }

    const body = {
      provider_urn: this.providerUrn,
      agency_urn: this.agencyUrn,
      agency_session_name: this.agencySessionName,
      id_token: idToken,
      duration_seconds: DEFAULT_DURATION_SECONDS
    };

    core.info(`调用 STS AssumeAgencyWithOIDC（endpoint=${this.stsEndpoint}）...`);
    const res = await this._sendRequest(
      'POST',
      this.stsEndpoint,
      { 'Content-Type': 'application/json' },
      JSON.stringify(body)
    );

    if (res.status !== 200) {
      const code = res.data && (res.data.error_code || res.data.code);
      const msg = res.data && (res.data.error_msg || res.data.message);
      throw new Error(`STS auth failed (${res.status})${code ? ' [' + code + ']' : ''}: ${msg || '未知错误'}`);
    }

    const cred = res.data.credentials;
    if (!cred || !cred.access_key_id || !cred.secret_access_key || !cred.security_token) {
      throw new Error('STS auth failed: 响应中缺少临时凭证字段');
    }

    core.info('成功获取临时安全凭证。');
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

      req.on('error', (err) => reject(err));

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }
}

module.exports = HuaweiCloudClient;
