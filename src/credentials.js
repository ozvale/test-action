'use strict';

/**
 * 临时凭证模块：getCredentials() 获取华为云临时凭证。
 * 调用链 GitHub Actions OIDC ID Token -> 华为云 STS AssumeAgencyWithOIDC，
 * 带缓存自动刷新、force 强制刷新、并发去重。
 */

const { cfg } = require('./config');
const { log, mask, maskBody } = require('./logger');
const { sendRequest } = require('./http');
const { getOidcToken } = require('./oidc');

let _credentials = null; // { accessKeyId, secretAccessKey, securityToken, expiresAt, expiresAtISO }
let _credentialPromise = null; // 进行中的换证 Promise（并发去重）

/** 判断缓存凭证是否仍有效（未过期且留有缓冲时间）。 */
function _isValid(cred) {
  if (!cred || !cred.expiresAt) {
    return false;
  }
  return Date.now() < cred.expiresAt - cfg.refreshBufferSeconds * 1000;
}

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
  const idToken = await getOidcToken();
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

module.exports = { getCredentials };
