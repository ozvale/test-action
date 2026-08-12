'use strict';

const assert = require('assert');
const { Signer, HttpRequest } = require('../apig_sdk/signer');
const HuaweiCloudClient = require('../src/huaweicloud-client');

function testSigner() {
  const signer = new Signer();
  signer.Key = 'AK_TEST_ACCESS_KEY';
  signer.Secret = 'SK_TEST_SECRET_KEY';

  const req = new HttpRequest(
    'POST',
    'https://c1231bf9a6884b7bb413e56abaa671c0.apic.cn-southwest-2.huaweicloudapis.com/',
    { 'Content-Type': 'application/json' },
    '{"app_name":"demo"}'
  );

  const headers = signer.sign(req);
  assert.ok(headers['Authorization'], 'Authorization 头应存在');
  assert.ok(/^SDK-HMAC-SHA256 Access=/.test(headers['Authorization']), 'Authorization 前缀应为 SDK-HMAC-SHA256');
  assert.ok(headers['x-sdk-date'], 'x-sdk-date 头应存在');
  assert.ok(headers['host'], 'host 头应存在');
  assert.ok(/SignedHeaders=/.test(headers['Authorization']), '应包含 SignedHeaders');
  assert.ok(/Signature=[0-9a-f]{64}/.test(headers['Authorization']), 'Signature 应为 64 位 hex');
  console.log('PASS testSigner');
}

function testUrnConstruction() {
  const client = new HuaweiCloudClient('12345678901234567890');
  assert.strictEqual(client.providerUrn, 'iam::12345678901234567890:oidcProvider:GitHubActions');
  assert.strictEqual(client.agencyUrn, 'iam::12345678901234567890:agency:github-actions-deploy');
  assert.strictEqual(client.region, 'cn-southwest-2', '区域应从 APIG 域名自动解析');
  assert.strictEqual(
    client.stsEndpoint,
    'https://sts.cn-southwest-2.myhuaweicloud.com/v5/agencies/assume-with-oidc'
  );
  console.log('PASS testUrnConstruction');
}

function testExtractRegion() {
  const host = 'c1231bf9a6884b7bb413e56abaa671c0.apic.cn-southwest-2.huaweicloudapis.com';
  assert.strictEqual(HuaweiCloudClient.extractRegion(host), 'cn-southwest-2');
  assert.throws(() => HuaweiCloudClient.extractRegion('invalid-host.com'));
  console.log('PASS testExtractRegion');
}

function testCredentialCache() {
  const client = new HuaweiCloudClient('12345678901234567890');

  // 无缓存
  assert.strictEqual(client._isValid(null), false);

  // 未过期且留有缓冲
  client._credentials = {
    expiresAt: Date.now() + 60 * 60 * 1000 // 1 小时后过期
  };
  assert.strictEqual(client._isValid(client._credentials), true);

  // 已过期
  client._credentials = {
    expiresAt: Date.now() - 1000
  };
  assert.strictEqual(client._isValid(client._credentials), false);
  console.log('PASS testCredentialCache');
}

testSigner();
testUrnConstruction();
testExtractRegion();
testCredentialCache();
console.log('ALL TESTS PASSED');
