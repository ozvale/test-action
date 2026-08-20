'use strict';

/**
 * demo-action：openlibing-client SDK 的使用示例（GitHub Action）
 *
 * 核心流程：
 *   1. 读取前一个 step 生成的文件（输入 file-path，必填）
 *   2. 基于 OIDC 免认证上传到 OBS（SDK getCredentials 换取临时凭证 -> OBS putObject）
 *   3. 基于 OIDC 免认证调用 APIG 接口（SDK getCredentials + V11Signer 签名 + sendRequest）
 *
 * 除 file-path 外，所有参数使用内置演示默认值：
 *   - OIDC 换证参数：SDK 内置 openlibing 账号默认值
 *   - OBS 桶：openlibing-gitcode-action；对象名：oidc-demo-action/<文件名>（取自 file-path）
 *   - APIG：openlibing 网关域名 + 路径 /version
 */

const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
// 顶层静态 require，ncc 打包时会内联整个 OBS SDK 进 dist
const ObsClient = require('esdk-obs-nodejs');
const { getCredentials, configure, V11Signer, sendRequest } = require('../sdk/openlibing-client');

// 演示用内置默认值（openlibing 平台示例资源）
const DEMO_CONFIG = {
  // openlibing 账号固定 OBS 桶
  bucket: 'openlibing-gitcode-action',
  // openlibing 账号固定 APIG 网关域名与调用路径
  apigHost: '242b859e54a641069d7af46c8b63d9fe.apic.cn-southwest-2.huaweicloudapis.com',
  apigPath: '/version'
};

/** 已知 APIG 错误码的精简排查提示。 */
function apigErrorHint(data) {
  const code = data && (data.error_code || data.code);
  const hints = {
    'APIG.0602': 'APIG.0602 签名不匹配：请比对签名的 CanonicalRequest 各段，并确认 x-sdk-date 与服务器时间一致。',
    'APIG.0301': 'APIG.0301 认证失败：请勿使用调试模式请求头（X-Apig-Authorization），应使用标准 Authorization 头。',
    'APIG.0624': 'APIG.0624 签名算法不匹配：应使用 V11-HMAC-SHA256。'
  };
  return hints[code] || '';
}

async function run() {
  try {
    const filePath = core.getInput('file-path', { required: true });
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`file-path 指向的文件不存在: ${filePath}`);
    }
    const objectKey = `oidc-demo-action/${path.basename(filePath)}`;
    const active = configure();
    const region = active.region;

    core.info('=== demo-action：OIDC 上传 OBS + 调用 APIG ===');
    core.info(`文件         : ${filePath}`);
    core.info(`区域         : ${region}`);
    core.info(`OBS 桶       : ${DEMO_CONFIG.bucket}`);
    core.info(`对象名       : ${objectKey}`);
    core.info(`APIG 地址    : https://${DEMO_CONFIG.apigHost}${DEMO_CONFIG.apigPath}`);

    // 1. OIDC 认证：获取临时凭证（SDK getCredentials，带缓存自动刷新）
    const cred = await getCredentials();
    core.info('凭证类型     : 临时凭证（OIDC+STS）');

    // 2. OIDC 免认证上传 OBS（使用 SDK 获取的临时凭证）
    const server = `https://obs.${region}.myhuaweicloud.com`;
    const client = new ObsClient({
      access_key_id: cred.accessKeyId,
      secret_access_key: cred.secretAccessKey,
      security_token: cred.securityToken,
      server
    });
    const upResult = await client.putObject({
      Bucket: DEMO_CONFIG.bucket,
      Key: objectKey,
      SourceFile: filePath
    });
    await client.close();

    const upStatus = upResult.CommonMsg && upResult.CommonMsg.Status;
    if (!(upStatus >= 200 && upStatus < 300)) {
      const code = upResult.CommonMsg && (upResult.CommonMsg.Code || upResult.CommonMsg.Code2);
      const msg = upResult.CommonMsg && upResult.CommonMsg.Message;
      throw new Error(`OBS upload failed (${upStatus})${code ? ' [' + code + ']' : ''}: ${msg || '未知错误'}`);
    }
    const etag = upResult.InterfaceResult && upResult.InterfaceResult.ETag;
    core.info(`OBS 上传成功! ETag: ${etag}`);

    // 3. OIDC 免认证调用 APIG（SDK getCredentials + V11Signer 签名 + sendRequest）
    const signer = new V11Signer({ region });
    signer.Key = cred.accessKeyId;
    signer.Secret = cred.secretAccessKey;
    const headers = { 'Content-Type': 'application/json' };
    if (cred.securityToken) {
      headers['X-Security-Token'] = cred.securityToken;
    }
    const apigUrl = `https://${DEMO_CONFIG.apigHost}${DEMO_CONFIG.apigPath}`;
    const signedHeaders = signer.sign('GET', apigUrl, headers, '');
    const apigResult = await sendRequest('GET', apigUrl, signedHeaders, '');
    core.info(`APIG 接口调用完成，HTTP 状态码: ${apigResult.status}`);
    core.info(`APIG 接口响应: ${JSON.stringify(apigResult.data)}`);

    if (apigResult.status >= 200 && apigResult.status < 300) {
      core.info('demo-action 执行成功!');
    } else {
      const hint = apigErrorHint(apigResult.data);
      if (hint) {
        core.info(hint);
      }
      core.setFailed(`APIG call failed (${apigResult.status}): ${(apigResult.data && (apigResult.data.error_msg || apigResult.data.message)) || 'Unknown'}`);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

module.exports = { run };

if (require.main === module) {
  run();
}
