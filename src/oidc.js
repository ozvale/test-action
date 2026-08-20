'use strict';

/**
 * OIDC 模块：申请 GitHub Actions OIDC ID Token（自包含，不依赖 @actions/core）。
 */

const { cfg } = require('./config');
const { log } = require('./logger');
const { sendRequest } = require('./http');

/** 申请 GitHub OIDC ID Token（自包含，不依赖 @actions/core）。 */
async function getOidcToken() {
  const fromEnv = process.env.HUAWEICLOUD_OIDC_TOKEN;
  if (fromEnv) {
    log('-- 使用环境变量 HUAWEICLOUD_OIDC_TOKEN 提供的 OIDC Token（诊断/测试）--');
    return fromEnv;
  }
  const fromActions = await getOidcTokenFromActions();
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
async function getOidcTokenFromActions() {
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

module.exports = { getOidcToken };
