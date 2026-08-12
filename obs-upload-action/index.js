'use strict';

/**
 * OBS Upload Action (OIDC)
 *
 * 流程：
 *   1. 申请 GitHub OIDC ID Token
 *   2. 用 OIDC Token 调用华为云 STS AssumeAgencyWithOIDC 换取临时 AK/SK/SecurityToken
 *   3. 用临时凭证 + esdk-obs-nodejs 上传文件到 OBS
 *
 * 注意：调用 AssumeAgencyWithOIDC 本身无需 AK/SK 签名（由华为云通过
 * 身份提供商的 JWKS 公钥验证 OIDC Token），因此该链路是纯 OIDC 驱动的。
 *
 * 本模块内置脱敏调试日志，敏感信息不会完整打印。
 */

const https = require('https');
const fs = require('fs');
const core = require('@actions/core');
const ObsClient = require('esdk-obs-nodejs');

// ---- 命名约定常量（必须与华为云侧配置一致）----
const OIDC_PROVIDER_NAME = 'GitHubActions';
const AGENCY_NAME = 'github-actions-deploy';
const AUDIENCE = 'huawei-cloud-oidc';
const STS_ASSUME_PATH = '/v5/agencies/assume-with-oidc';
const DEFAULT_DURATION_SECONDS = 3600;

/** 脱敏：仅保留首尾若干字符，中间用 * 代替。 */
function mask(value, head = 6, tail = 4) {
  if (!value) return '(空)';
  const s = String(value);
  if (s.length <= head + tail) return s.slice(0, 2) + '***' + s.slice(-2);
  return s.slice(0, head) + '***' + s.slice(-tail) + `（长度 ${s.length}）`;
}

/** 发送 HTTPS 请求并解析 JSON。 */
function sendRequest(method, url, headers, body) {
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
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = {};
        if (raw) {
          try { data = JSON.parse(raw); } catch (e) { data = { raw }; }
        }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', (err) => reject(new Error(`网络请求失败 ${method} ${url}: ${err.message}`)));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 通过 GitHub OIDC JWT 调用 STS AssumeAgencyWithOIDC 换取临时 AK/SK/SecurityToken。
 */
async function assumeAgencyWithOIDC(accountId, region) {
  const providerUrn = `iam::${accountId}:oidcProvider:${OIDC_PROVIDER_NAME}`;
  const agencyUrn = `iam::${accountId}:agency:${AGENCY_NAME}`;
  const stsEndpoint = `https://sts.${region}.myhuaweicloud.com${STS_ASSUME_PATH}`;

  core.info('=== 步骤1：申请 GitHub OIDC ID Token ===');
  core.info(`audience=${AUDIENCE}`);
  const idToken = await core.getIDToken(AUDIENCE);
  if (!idToken) {
    throw new Error('获取 OIDC ID Token 为空（请确认 workflow 已声明 permissions: id-token: write）');
  }
  core.info(`OIDC Token 获取成功，长度 ${idToken.length}`);

  // 解码并打印 JWT payload（用于与华为云信任策略比对）
  core.info('-- OIDC Token 声明（用于与华为云信任策略比对）--');
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
    core.info(`iss : ${JSON.stringify(payload.iss)}`);
    core.info(`aud : ${JSON.stringify(payload.aud)}`);
    core.info(`azp : ${JSON.stringify(payload.azp)}`);
    core.info(`sub : ${JSON.stringify(payload.sub)}`);
  } catch (e) {
    core.info(`（无法解析 OIDC Token payload：${e.message}）`);
  }

  const body = {
    provider_urn: providerUrn,
    agency_urn: agencyUrn,
    agency_session_name: AGENCY_NAME,
    id_token: idToken,
    duration_seconds: DEFAULT_DURATION_SECONDS
  };

  core.info('=== 步骤2：调用 STS AssumeAgencyWithOIDC ===');
  core.info(`endpoint            : ${stsEndpoint}`);
  core.info(`provider_urn        : ${body.provider_urn}`);
  core.info(`agency_urn          : ${body.agency_urn}`);
  core.info(`agency_session_name : ${body.agency_session_name}`);
  core.info(`duration_seconds    : ${body.duration_seconds}`);
  core.info(`id_token            : ${mask(body.id_token, 20, 20)}`);

  const res = await sendRequest('POST', stsEndpoint, { 'Content-Type': 'application/json' }, JSON.stringify(body));
  core.info(`STS 响应状态码 : ${res.status}`);

  if (res.status !== 200) {
    const code = res.data && (res.data.error_code || res.data.code);
    const msg = res.data && (res.data.error_msg || res.data.message);
    core.info(`STS 失败详情 : ${JSON.stringify(res.data)}`);
    throw new Error(`STS auth failed (${res.status})${code ? ' [' + code + ']' : ''}: ${msg || '未知错误'}`);
  }

  const cred = res.data.credentials;
  if (!cred || !cred.access_key_id || !cred.secret_access_key || !cred.security_token) {
    core.info(`STS 响应体 : ${JSON.stringify(res.data)}`);
    throw new Error('STS auth failed: 响应中缺少临时凭证字段');
  }

  core.info('=== 步骤3：成功获取临时安全凭证 ===');
  core.info(`临时 AK          : ${mask(cred.access_key_id)}`);
  core.info(`SecurityToken    : ${mask(cred.security_token, 10, 10)}`);
  core.info(`凭证过期时间     : ${cred.expiration}`);
  core.info(`凭证有效期(秒)   : ${Math.round((new Date(cred.expiration).getTime() - Date.now()) / 1000)}`);

  return {
    accessKeyId: cred.access_key_id,
    secretAccessKey: cred.secret_access_key,
    securityToken: cred.security_token
  };
}

async function run() {
  try {
    const accountId = core.getInput('huawei-account-id');
    const region = core.getInput('region');
    const bucket = core.getInput('bucket');
    const objectKey = core.getInput('object-key');
    const file = core.getInput('file');
    const body = core.getInput('body');

    core.info('=== 华为云 OBS 上传（OIDC）===');
    core.info(`账号 ID      : ${accountId}`);
    core.info(`区域         : ${region}`);
    core.info(`桶           : ${bucket}`);
    core.info(`对象名       : ${objectKey}`);
    core.info(`本地文件     : ${file || '(未提供，使用 body)'}`);

    // 1. OIDC -> STS 换临时凭证
    const cred = await assumeAgencyWithOIDC(accountId, region);

    // 2. 用临时凭证初始化 OBS 客户端并上传
    core.info('=== 步骤4：初始化 OBS 客户端并上传 ===');
    const endpoint = `https://obs.${region}.myhuaweicloud.com`;
    core.info(`OBS endpoint : ${endpoint}`);
    core.info(`SecurityToken 是否携带 : ${cred.securityToken ? '是' : '否'}`);

    const obsClient = new ObsClient({
      access_key_id: cred.accessKeyId,
      secret_access_key: cred.secretAccessKey,
      security_token: cred.securityToken,
      server: endpoint
    });

    const params = { Bucket: bucket, Key: objectKey };
    if (file && fs.existsSync(file)) {
      params.SourceFile = file;
      core.info(`上传本地文件 : ${file}`);
    } else {
      params.Body = body;
      core.info(`上传内容(body): ${body}`);
    }

    const result = await obsClient.putObject(params);
    const status = result.CommonMsg && result.CommonMsg.Status;
    core.info(`OBS 响应状态码 : ${status}`);

    if (status && status <= 300) {
      const etag = result.InterfaceResult && result.InterfaceResult.ETag;
      core.info(`OBS 上传成功! ETag: ${etag}，RequestId: ${result.CommonMsg.RequestId}`);
      core.setOutput('etag', etag || '');
      core.info('OBS 上传成功!');
    } else {
      const msg = result.CommonMsg && result.CommonMsg.Message;
      const code = result.CommonMsg && result.CommonMsg.Code;
      core.info(`OBS 上传失败详情: ${JSON.stringify(result.CommonMsg)}`);
      throw new Error(`OBS upload failed (${status})${code ? ' [' + code + ']' : ''}: ${msg || '未知错误'}`);
    }

    try { obsClient.close(); } catch (e) { /* ignore */ }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
