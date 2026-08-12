'use strict';

const core = require('@actions/core');
const HuaweiCloudClient = require('./src/huaweicloud-client');

// 默认账号 ID（可替换为真实华为云账号 ID）
const DEFAULT_ACCOUNT_ID = '12345678901234567890';

async function run() {
  try {
    const accountId = core.getInput('huawei-account-id') || DEFAULT_ACCOUNT_ID;

    // 创建客户端（区域自动从 APIG 域名解析，无需使用者配置）
    const client = new HuaweiCloudClient(accountId);

    core.info(`Deploying via Huawei Cloud APIG (region=${client.region}, account=${accountId})...`);

    // 调用 APIG 接口
    const result = await client.callApi('/', 'POST', {
      action: 'deploy'
    });

    // 打印完整调用结果
    core.info(`APIG 接口调用完成，HTTP 状态码: ${result.status}`);
    core.info(`APIG 接口响应: ${JSON.stringify(result.data)}`);

    if (result.status === 200 && result.data && result.data.success) {
      core.setOutput('deploy-status', 'success');
      core.info('Deploy succeeded!');
    } else {
      core.setOutput('deploy-status', 'failed');
      core.setFailed(`Deploy failed: ${(result.data && result.data.message) || 'Unknown'}`);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
