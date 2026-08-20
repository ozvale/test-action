'use strict';

/**
 * 配置模块：内置 openlibing 默认配置 + configure() 覆盖。
 * 模块级单例 cfg 供 logger / http / oidc / credentials 共享。
 */

// 内置固定配置（openlibing 账号）
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
const cfg = { ...CONFIG };

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

module.exports = { CONFIG, cfg, configure };
