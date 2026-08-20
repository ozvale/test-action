'use strict';

/**
 * demo-action：openlibing-client SDK 的使用示例（GitHub Action）
 *
 * 核心流程（每步均打印执行日志，第三方接口调用打印完整请求/响应，敏感字段脱敏）：
 *   1. 读取前一个 step 生成的文件（输入 file-path，必填）
 *   2. 基于 OIDC 免认证获取华为云临时凭证（SDK getCredentials，开启 SDK 调试日志）
 *   3. 基于 OIDC 免认证上传到 OBS（临时凭证 -> OBS putObject，打印 OBS 请求/响应详情）
 *   4. 基于 OIDC 免认证调用 APIG 接口（SDK getCredentials + V11Signer 签名 + sendRequest，
 *      SDK 调试日志打印 APIG 请求行/请求头/请求体与响应状态/响应头/响应体）
 *
 * 除 file-path 外，所有参数使用内置演示默认值：
 *   - OIDC 换证参数：SDK 内置 openlibing 账号默认值
 *   - OBS 桶：openlibing-gitcode-action；对象名：oidc-demo-action/<文件名>（取自 file-path）
 *   - APIG：openlibing 网关域名 + 路径 /version
 */

const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
// 顶层静态 require，ncc 打包时会内联整个 OBS SDK 与构建产物 openlibing-client 包进 dist
// openlibing-client 来自根目录 npm pack 出的 tarball（file:../../../openlibing-client-1.0.0.tgz）
const ObsClient = require('esdk-obs-nodejs');
const { getCredentials, configure, V11Signer, sendRequest } = require('openlibing-client');

// 演示用内置默认值（openlibing 平台示例资源）
const DEMO_CONFIG = {
  // openlibing 账号固定 OBS 桶
  bucket: 'openlibing-gitcode-action',
  // openlibing 账号固定 APIG 网关域名与调用路径
  apigHost: '242b859e54a641069d7af46c8b63d9fe.apic.cn-southwest-2.huaweicloudapis.com',
  apigPath: '/version'
};

/** 日志脱敏：仅保留首尾若干字符（OBS 客户端参数中的临时凭证等）。 */
function mask(value, head = 6, tail = 4) {
  if (!value) return '(空)';
  const s = String(value);
  if (s.length <= head + tail) return s.slice(0, 2) + '***' + s.slice(-2);
  return s.slice(0, head) + '***' + s.slice(-tail) + `（长度 ${s.length}）`;
}

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
    core.info('=== demo-action：基于 OIDC 免认证上传 OBS 并调用 APIG ===');

    // ---- 步骤 1/4：读取并校验待上传文件 ----
    core.info('--- 步骤 1/4：读取并校验待上传文件 ---');
    const filePath = core.getInput('file-path', { required: true });
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`file-path 指向的文件不存在: ${filePath}`);
    }
    const fileSize = fs.statSync(filePath).size;
    const objectKey = `oidc-demo-action/${path.basename(filePath)}`;
    core.info(`输入文件     : ${filePath}（${fileSize} 字节）`);
    core.info(`上传目标对象 : ${DEMO_CONFIG.bucket}/${objectKey}`);

    // 开启 SDK 调试模式：OIDC / STS / APIG 调用的请求行、请求头、请求体、响应状态码、
    // 响应头、响应体均由 SDK 打印（Authorization / X-Security-Token / 凭证字段自动脱敏）
    const active = configure({ debug: true });
    const region = active.region;
    core.info(`区域         : ${region}`);
    core.info(`APIG 地址    : https://${DEMO_CONFIG.apigHost}${DEMO_CONFIG.apigPath}`);

    // ---- 步骤 2/4：OIDC 认证换取华为云临时凭证 ----
    core.info('--- 步骤 2/4：OIDC 认证换取华为云临时凭证（GitHub OIDC -> STS）---');
    const cred = await getCredentials();
    core.info(`凭证获取成功 : 临时凭证（OIDC+STS），剩余有效期约 ${cred.expiresIn} 秒`);
    core.info(`临时 AK      : ${mask(cred.accessKeyId)}`);

    // ---- 步骤 3/4：基于 OIDC 临时凭证上传文件到 OBS ----
    core.info('--- 步骤 3/4：基于 OIDC 临时凭证上传文件到 OBS ---');
    const server = `https://obs.${region}.myhuaweicloud.com`;
    core.info(`OBS 请求     : PUT ${server}/${DEMO_CONFIG.bucket}/${objectKey}`);
    core.info(`OBS 请求参数 : Bucket=${DEMO_CONFIG.bucket}, Key=${objectKey}, SourceFile=${filePath}（${fileSize} 字节）`);
    core.info(`OBS 客户端   : server=${server}, access_key_id=${mask(cred.accessKeyId)}, security_token=${mask(cred.securityToken, 10, 10)}`);
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

    const common = (upResult && upResult.CommonMsg) || {};
    core.info(`OBS 响应     : HTTP ${common.Status}${common.RequestId ? `, RequestId: ${common.RequestId}` : ''}`);
    const iface = upResult && upResult.InterfaceResult;
    if (iface) {
      core.info(`OBS 响应头   : ${JSON.stringify(iface)}`);
    }
    if (!(common.Status >= 200 && common.Status < 300)) {
      const code = common.Code || common.Code2;
      core.info(`OBS 失败详情 : Code=${code || '(空)'}, Message=${common.Message || '(空)'}`);
      throw new Error(`OBS upload failed (${common.Status})${code ? ' [' + code + ']' : ''}: ${common.Message || '未知错误'}`);
    }
    const etag = iface && iface.ETag;
    core.info(`OBS 上传成功！ETag: ${etag}`);

    // ---- 步骤 4/4：基于 OIDC 临时凭证调用 APIG 接口 ----
    core.info('--- 步骤 4/4：基于 OIDC 临时凭证调用 APIG 接口（V11-HMAC-SHA256 签名）---');
    const signer = new V11Signer({ region });
    signer.Key = cred.accessKeyId;
    signer.Secret = cred.secretAccessKey;
    const headers = { 'Content-Type': 'application/json' };
    if (cred.securityToken) {
      headers['X-Security-Token'] = cred.securityToken;
    }
    const apigUrl = `https://${DEMO_CONFIG.apigHost}${DEMO_CONFIG.apigPath}`;
    // APIG 请求行/请求头（签名与安全令牌脱敏）、响应状态码/响应头/响应体由 SDK 调试日志打印
    const signedHeaders = signer.sign('GET', apigUrl, headers, '');
    const apigResult = await sendRequest('GET', apigUrl, signedHeaders, '');
    core.info(`APIG 调用完成，HTTP 状态码: ${apigResult.status}`);

    if (apigResult.status >= 200 && apigResult.status < 300) {
      core.info('demo-action 全部步骤执行成功！');
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
