'use strict';

const assert = require('assert');
const { V11Signer, hkdfGetDerKeySha256, canonicalHeaders, APIC_SERVICE } = require('../apig_sdk/signer_v11');
const HuaweiCloudClient = require('../src/huaweicloud-client');

function testV11Signer() {
  const signer = new V11Signer({ region: 'cn-southwest-2' });
  signer.Key = 'AK_TEST_ACCESS_KEY';
  signer.Secret = 'SK_TEST_SECRET_KEY';

  const headers = signer.sign(
    'GET',
    'https://c1231bf9a6884b7bb413e56abaa671c0.apic.cn-southwest-2.huaweicloudapis.com/',
    { 'Content-Type': 'application/json', 'User-Agent': 'DeployAction/1.0' },
    ''
  );

  assert.ok(headers['Authorization'], 'Authorization 头应存在');
  assert.ok(/^V11-HMAC-SHA256 Credential=/.test(headers['Authorization']), '前缀应为 V11-HMAC-SHA256 Credential=');
  assert.ok(/SignedHeaders=/.test(headers['Authorization']), '应包含 SignedHeaders');
  assert.ok(/Signature=[0-9a-f]{64}/.test(headers['Authorization']), 'Signature 应为 64 位 hex');
  assert.ok(headers['host'], 'host 头应存在（自动加入并参与签名）');
  assert.ok(headers['x-sdk-date'], 'x-sdk-date 头应存在');
  // Credential 作用域应包含 apic 服务名
  assert.ok(new RegExp('/' + APIC_SERVICE + ', ').test(headers['Authorization']), 'Credential 应包含 apic 服务名');
  console.log('PASS testV11Signer');
}

function testV11CredentialScope() {
  const signer = new V11Signer({ region: 'cn-southwest-2' });
  signer.Key = 'AK_TEST_ACCESS_KEY';
  signer.Secret = 'SK_TEST_SECRET_KEY';
  const headers = signer.sign('GET', 'https://x.apic.cn-southwest-2.huaweicloudapis.com/', {}, '');
  const m = headers['Authorization'].match(/Credential=([^,\s]+)/);
  assert.ok(m, '应包含 Credential');
  const parts = m[1].split('/');
  assert.strictEqual(parts.length, 4, 'Credential 应为 AK/date/region/service 四段');
  assert.strictEqual(parts[1], headers['x-sdk-date'].substring(0, 8), 'Credential 日期段应为 YYYYMMDD');
  assert.strictEqual(parts[2], 'cn-southwest-2', 'Credential 区域段应为 cn-southwest-2');
  assert.strictEqual(parts[3], APIC_SERVICE, 'Credential 服务段应为 apic');
  console.log('PASS testV11CredentialScope');
}

function testV11SecurityTokenSigned() {
  const signer = new V11Signer({ region: 'cn-southwest-2' });
  signer.Key = 'AK_TEST_ACCESS_KEY';
  signer.Secret = 'SK_TEST_SECRET_KEY';
  const token = 'hQ5-test-security-token-value';
  const headers = signer.sign(
    'GET',
    'https://x.apic.cn-southwest-2.huaweicloudapis.com/',
    { 'X-Security-Token': token },
    ''
  );
  assert.ok(headers['X-Security-Token'] === token, 'X-Security-Token 头应保留');
  assert.ok(/SignedHeaders=.*x-security-token/.test(headers['Authorization']), 'X-Security-Token 应参与签名');
  console.log('PASS testV11SecurityTokenSigned');
}

function testCanonicalHeadersCaseInsensitive() {
  // 回归测试：canonicalHeaders 必须对小写 key 也能取到原始大小写 key 的值，
  // 否则 X-Security-Token / Content-Type 等头会变成 "undefined"，导致 APIG.0602。
  const headers = { 'Content-Type': 'application/json', 'X-Security-Token': 'tok_ABC123' };
  const signed = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const out = canonicalHeaders(headers, signed);
  assert.ok(out.includes('content-type:application/json'), `应包含 content-type 正确值: ${out}`);
  assert.ok(out.includes('x-security-token:tok_ABC123'), `应包含 x-security-token 正确值: ${out}`);
  assert.ok(!out.includes('undefined'), `不应包含 undefined: ${out}`);
  console.log('PASS testCanonicalHeadersCaseInsensitive');
}

function testHKDF() {
  const key = hkdfGetDerKeySha256('AK_TEST', 'SK_TEST', '20260812/cn-southwest-2/apic');
  assert.ok(key, 'HKDF 应派生密钥');
  assert.match(key, /^[0-9a-f]{64}$/, '派生密钥应为 64 位 hex');
  console.log('PASS testHKDF');
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

function testPermanentCredentials() {
  const client = new HuaweiCloudClient('12345678901234567890');

  // 默认未设置环境变量 -> 返回 null（走 OIDC/STS 链路）
  delete process.env.HUAWEICLOUD_SDK_AK;
  delete process.env.HUAWEICLOUD_SDK_SK;
  assert.strictEqual(client._getPermanentCredentials(), null, '未配置永久 AK/SK 时应返回 null');

  // 设置了永久 AK/SK -> 返回永久凭证且不带 securityToken
  process.env.HUAWEICLOUD_SDK_AK = 'AK_PERMANENT';
  process.env.HUAWEICLOUD_SDK_SK = 'SK_PERMANENT';
  const cred = client._getPermanentCredentials();
  assert.ok(cred, '配置永久 AK/SK 后应返回永久凭证');
  assert.strictEqual(cred.accessKeyId, 'AK_PERMANENT');
  assert.strictEqual(cred.mode, '永久');
  assert.strictEqual(cred.securityToken, null, '永久凭证不应携带 securityToken');

  delete process.env.HUAWEICLOUD_SDK_AK;
  delete process.env.HUAWEICLOUD_SDK_SK;
  console.log('PASS testPermanentCredentials');
}

function testMask() {
  const masked = HuaweiCloudClient._mask('abcdefghijklmnopqrst');
  assert.ok(masked.includes('***'), '脱敏结果应包含掩码');
  assert.ok(!masked.includes('cdefghijklmnopqr'), '脱敏不应泄露中间内容');
  assert.strictEqual(HuaweiCloudClient._mask(''), '(空)');
  assert.strictEqual(HuaweiCloudClient._mask(null), '(空)');
  console.log('PASS testMask');
}

function testMaskSensitiveJson() {
  const client = new HuaweiCloudClient('12345678901234567890');
  const out = client._maskSensitiveJson({
    credentials: {
      access_key_id: 'AK_SECRET_VALUE_123',
      secret_access_key: 'SK_SECRET_VALUE_456',
      security_token: 'TOKEN_SECRET_VALUE_789',
      expiration: '2026-08-12T08:58:09Z'
    },
    error_code: 'APIG.0602',
    error_msg: 'Bad request'
  });
  assert.ok(!out.includes('AK_SECRET_VALUE_123'), 'AK 应被脱敏');
  assert.ok(!out.includes('SK_SECRET_VALUE_456'), 'SK 应被脱敏');
  assert.ok(!out.includes('TOKEN_SECRET_VALUE_789'), 'SecurityToken 应被脱敏');
  assert.ok(out.includes('APIG.0602'), '非敏感字段应保留');
  assert.ok(out.includes('2026-08-12T08:58:09Z'), '过期时间应保留');
  assert.strictEqual(client._maskSensitiveJson(null), '(无)');
  assert.strictEqual(client._maskSensitiveJson(undefined), '(无)');
  console.log('PASS testMaskSensitiveJson');
}

testV11Signer();
testV11CredentialScope();
testV11SecurityTokenSigned();
testCanonicalHeadersCaseInsensitive();
testHKDF();
testUrnConstruction();
testExtractRegion();
testCredentialCache();
testPermanentCredentials();
testMask();
testMaskSensitiveJson();
console.log('ALL TESTS PASSED');
