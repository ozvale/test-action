'use strict';

/**
 * openlibing-client：openlibing 平台与华为云 / gitcode / github 等平台的交互 SDK（npm 包入口）
 *
 * 本包封装 openlibing 平台对接华为云的通用基础能力：
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
 * 仅依赖 Node 内置模块（https / crypto / url），不依赖 @actions/core；OIDC Token 通过
 * GitHub Actions 环境变量自包含申请，任意 Node 环境均可独立使用。
 *
 * 模块结构（src/）：
 *   config.js       内置配置 + configure() 覆盖（模块级单例 cfg）
 *   logger.js       调试日志输出（debug 开关）+ 敏感字段脱敏工具
 *   http.js         sendRequest HTTPS 请求工具（调试模式打印请求/响应详情）
 *   oidc.js         GitHub OIDC ID Token 申请（环境变量覆盖 / Actions 自申请）
 *   credentials.js  getCredentials：OIDC -> STS 换证（缓存 / force / 并发去重）
 *   signer-v11.js   V11Signer：APIG V11-HMAC-SHA256 签名器
 *
 * 用法：
 *   const openlibing = require('openlibing-client');
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
 *   // => { status, headers, data }
 */

module.exports = {
  getCredentials: require('./credentials').getCredentials,
  configure: require('./config').configure,
  V11Signer: require('./signer-v11').V11Signer,
  sendRequest: require('./http').sendRequest
};
