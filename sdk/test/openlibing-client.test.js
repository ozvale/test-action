'use strict';

/**
 * openlibing-client SDK 测试套件
 *
 * 覆盖：
 *   1. 模块可加载、导出 getCredentials / configure / V11Signer / sendRequest
 *   2. 内置 openlibing 账号配置正确
 *   3. getCredentials：OIDC -> STS 完整换证链路（环境变量 HUAWEICLOUD_OIDC_TOKEN 覆盖）
 *   4. getCredentials：无 @actions/core 时从 GitHub Actions 环境变量自申请 OIDC Token
 *   5. getCredentials：缓存复用（第二次调用不发起 STS 请求）
 *   6. getCredentials：force 强制刷新（忽略缓存重新换证）
 *   7. getCredentials：并发去重（同时多次调用只发起一次 STS 换证）
 *   8. configure：覆盖 accountId / region / durationSeconds 等字段生效
 *   9. V11Signer：APIG V11-HMAC-SHA256 签名格式（Credential 四段 / SignedHeaders / Signature）
 *  10. sendRequest：HTTPS JSON 请求工具（发送与解析）
 */

const assert = require('assert');
const https = require('https');
const { EventEmitter } = require('events');

const LIB_PATH = '../openlibing-client';
const ACCOUNT_ID = '4d29a984c4fe4e6eb5d404a853d0084e';

/** 重新加载 SDK，清空模块级凭证缓存（_credentials / _credentialPromise）。 */
function freshClient() {
  delete require.cache[require.resolve(LIB_PATH)];
  return require(LIB_PATH);
}

/** 拦截 https.request：按 hostname 路由响应，记录请求与请求体。 */
function installRequestInterceptor(routeResponse) {
  const records = [];
  const origRequest = https.request;
  https.request = function (options, cb) {
    const writes = [];
    const record = {
      options,
      headers: options.headers,
      hostname: options.hostname,
      path: options.path,
      method: options.method,
      url: `https://${options.hostname}${options.path}`,
      writes
    };
    records.push(record);

    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = { 'content-type': 'application/json' };
    // 必须先调用回调挂上 data/end 监听器，再异步触发，否则 sendRequest 的 promise 不会 resolve
    if (typeof cb === 'function') {
      cb(res);
    }
    process.nextTick(() => {
      const r = routeResponse(record);
      let body = r;
      if (r && typeof r === 'object' && 'statusCode' in r) {
        res.statusCode = r.statusCode;
        body = r.body;
      }
      if (body !== null && body !== undefined) {
        res.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
      }
      res.emit('end');
    });
    return { on() {}, write(b) { writes.push(Buffer.isBuffer(b) ? b.toString('utf8') : String(b)); }, end() {} };
  };
  return {
    records,
    restore() { https.request = origRequest; }
  };
}

/** 构造一个 STS 成功响应（临时凭证）。 */
function stsResponse(prefix = 'T') {
  return {
    credentials: {
      access_key_id: `${prefix}_AK`,
      secret_access_key: `${prefix}_SK`,
      security_token: `${prefix}_TOK`,
      expiration: new Date(Date.now() + 3600 * 1000).toISOString()
    }
  };
}

/** 大小写不敏感地读取请求头。 */
function pickHeader(headers, name) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return undefined;
}

async function main() {
  // ---------- 1. 模块加载与导出 ----------
  let client = freshClient();
  assert.strictEqual(typeof client.getCredentials, 'function', '应导出 getCredentials');
  assert.strictEqual(typeof client.configure, 'function', '应导出 configure');
  assert.strictEqual(typeof client.V11Signer, 'function', '应导出 V11Signer');
  assert.strictEqual(typeof client.sendRequest, 'function', '应导出 sendRequest');
  console.log('PASS 1: 模块可加载，导出 getCredentials / configure / V11Signer / sendRequest');

  // ---------- 2. 内置 openlibing 账号配置 ----------
  const c0 = client.configure();
  assert.strictEqual(c0.accountId, ACCOUNT_ID);
  assert.strictEqual(c0.audience, 'huawei-cloud-service');
  assert.strictEqual(c0.agencyName, 'gitcode-actions');
  assert.strictEqual(c0.oidcProviderName, 'GitHubActions');
  assert.strictEqual(c0.region, 'cn-southwest-2');
  assert.strictEqual(c0.stsAssumePath, '/v5/agencies/assume-with-oidc');
  assert.strictEqual(c0.durationSeconds, 3600);
  assert.strictEqual(c0.refreshBufferSeconds, 300);
  console.log('PASS 2: 内置配置 = 账号ID/受众/委托/提供商/区域/STS路径/有效期 全部正确');

  // ---------- 3. OIDC -> STS 完整换证链路（环境变量 OIDC Token 覆盖） ----------
  client = freshClient();
  process.env.HUAWEICLOUD_OIDC_TOKEN = 'fake-jwt-token-for-sts-test';
  const route3 = (rec) => {
    if (rec.hostname.startsWith('sts.')) return stsResponse('T');
    throw new Error(`不应请求 ${rec.hostname}`);
  };
  const int3 = installRequestInterceptor(route3);
  try {
    const cred = await client.getCredentials();
    assert.strictEqual(cred.accessKeyId, 'T_AK');
    assert.strictEqual(cred.secretAccessKey, 'T_SK');
    assert.strictEqual(cred.securityToken, 'T_TOK');
    assert.ok(cred.expiresAt, 'expiresAt 应为 ISO 字符串');
    assert.ok(typeof cred.expiresIn === 'number' && cred.expiresIn > 3500, 'expiresIn 应为剩余秒数');

    assert.strictEqual(int3.records.length, 1, '应只发起一次 STS 请求');
    const rec = int3.records[0];
    assert.ok(rec.hostname.startsWith('sts.cn-southwest-2'), 'STS 端点区域应为 cn-southwest-2');
    assert.ok(rec.path.includes('/v5/agencies/assume-with-oidc'), 'STS 路径应为 assume-with-oidc');
    assert.strictEqual(rec.method, 'POST', 'STS 换证应为 POST');
    const body = JSON.parse(rec.writes[0]);
    assert.strictEqual(body.provider_urn, `iam::${ACCOUNT_ID}:oidcProvider:GitHubActions`);
    assert.strictEqual(body.agency_urn, `iam::${ACCOUNT_ID}:agency:gitcode-actions`);
    assert.strictEqual(body.agency_session_name, 'gitcode-actions');
    assert.strictEqual(body.id_token, 'fake-jwt-token-for-sts-test', 'id_token 应来自环境变量覆盖');
    assert.strictEqual(body.duration_seconds, 3600);
    console.log('PASS 3: getCredentials 完整 OIDC->STS 换证链路，STS 请求体与返回字段正确');
  } finally {
    int3.restore();
    delete process.env.HUAWEICLOUD_OIDC_TOKEN;
  }

  // ---------- 4. 从 GitHub Actions 环境变量自申请 OIDC Token ----------
  client = freshClient();
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://vstoken.actions.githubusercontent.com/org/repo/get_oidc_token';
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'actions-request-token-abc';
  const route4 = (rec) => {
    if (rec.hostname.includes('vstoken.actions.githubusercontent.com')) {
      return { value: 'fake-actions-jwt', type: 'jwt' };
    }
    if (rec.hostname.startsWith('sts.')) return stsResponse('A');
    throw new Error(`不应请求 ${rec.hostname}`);
  };
  const int4 = installRequestInterceptor(route4);
  try {
    const cred = await client.getCredentials();
    assert.strictEqual(cred.accessKeyId, 'A_AK');

    assert.strictEqual(int4.records.length, 2, '应依次请求 vstoken 与 STS');
    const tokenRec = int4.records[0];
    assert.ok(tokenRec.hostname.includes('vstoken.actions.githubusercontent.com'), '第一次请求应发往 vstoken');
    assert.ok(tokenRec.path.includes('audience=huawei-cloud-service'), 'OIDC 请求应携带 audience 查询参数');
    assert.strictEqual(tokenRec.headers['Authorization'], 'Bearer actions-request-token-abc', '应携带 Bearer 认证头');

    const stsRec = int4.records[1];
    const stsBody = JSON.parse(stsRec.writes[0]);
    assert.strictEqual(stsBody.id_token, 'fake-actions-jwt', 'STS 的 id_token 应来自 Actions OIDC 接口');
    console.log('PASS 4: 无 @actions/core 时从 GitHub Actions 环境变量自申请 OIDC Token 的链路正确');
  } finally {
    int4.restore();
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  }

  // ---------- 5. 缓存复用（第二次调用不发起 STS 请求） ----------
  client = freshClient();
  process.env.HUAWEICLOUD_OIDC_TOKEN = 'fake-jwt-cache';
  const int5 = installRequestInterceptor(() => stsResponse('C'));
  try {
    const first = await client.getCredentials();
    const second = await client.getCredentials();
    assert.strictEqual(first.accessKeyId, second.accessKeyId, '第二次应复用同一凭证');
    assert.strictEqual(int5.records.length, 1, '缓存命中时不应再次发起 STS 请求');
    console.log('PASS 5: 缓存复用，第二次调用不发起 STS 请求');
  } finally {
    int5.restore();
    delete process.env.HUAWEICLOUD_OIDC_TOKEN;
  }

  // ---------- 6. force 强制刷新（忽略缓存重新换证） ----------
  client = freshClient();
  process.env.HUAWEICLOUD_OIDC_TOKEN = 'fake-jwt-force';
  const int6 = installRequestInterceptor(() => stsResponse('F'));
  try {
    const first = await client.getCredentials();
    const forced = await client.getCredentials({ force: true });
    assert.strictEqual(int6.records.length, 2, 'force 应忽略缓存重新换证');
    assert.strictEqual(forced.accessKeyId, 'F_AK');
    console.log('PASS 6: force 强制刷新，忽略缓存重新换证');
  } finally {
    int6.restore();
    delete process.env.HUAWEICLOUD_OIDC_TOKEN;
  }

  // ---------- 7. 并发去重（同时多次调用只发起一次 STS 换证） ----------
  client = freshClient();
  process.env.HUAWEICLOUD_OIDC_TOKEN = 'fake-jwt-concurrent';
  const int7 = installRequestInterceptor(() => stsResponse('CC'));
  try {
    const [a, b, c] = await Promise.all([
      client.getCredentials(),
      client.getCredentials(),
      client.getCredentials()
    ]);
    assert.strictEqual(a.accessKeyId, 'CC_AK');
    assert.strictEqual(b.accessKeyId, 'CC_AK');
    assert.strictEqual(c.accessKeyId, 'CC_AK');
    assert.strictEqual(int7.records.length, 1, '并发调用应只发起一次 STS 换证');
    console.log('PASS 7: 并发去重，同时多次调用只发起一次 STS 换证');
  } finally {
    int7.restore();
    delete process.env.HUAWEICLOUD_OIDC_TOKEN;
  }

  // ---------- 8. configure 覆盖生效 ----------
  client = freshClient();
  const c8 = client.configure({ accountId: 'another-account-id', region: 'cn-north-4', durationSeconds: 900 });
  assert.strictEqual(c8.accountId, 'another-account-id');
  assert.strictEqual(c8.region, 'cn-north-4');
  assert.strictEqual(c8.durationSeconds, 900);
  // 未覆盖字段保留内置默认
  assert.strictEqual(c8.audience, 'huawei-cloud-service');
  assert.strictEqual(c8.agencyName, 'gitcode-actions');
  console.log('PASS 8: configure 覆盖 accountId/region/durationSeconds 生效，未覆盖字段保留默认');

  // ---------- 9. V11Signer 签名格式 ----------
  const signer = new client.V11Signer({ region: 'cn-southwest-2' });
  signer.Key = 'AK_SIGN_TEST';
  signer.Secret = 'SK_SIGN_TEST';
  const signedHeaders = signer.sign('GET', `https://242b859e54a641069d7af46c8b63d9fe.apic.cn-southwest-2.huaweicloudapis.com/version`, {
    'X-Security-Token': 'ST_TOK_ONE',
    'Content-Type': 'application/json'
  }, '');
  const auth = pickHeader(signedHeaders, 'authorization');
  assert.ok(/^V11-HMAC-SHA256 Credential=AK_SIGN_TEST\/\d{8}\/cn-southwest-2\/apic/.test(auth),
    `Authorization 应为 V11 Credential 四段：${auth}`);
  assert.ok(/SignedHeaders=.*x-security-token/.test(auth), `SignedHeaders 应含 x-security-token：${auth}`);
  assert.ok(/Signature=[0-9a-f]{64}/.test(auth), 'Signature 应为 64 位 hex');
  assert.ok(signedHeaders['x-sdk-date'], '应自动补充 x-sdk-date');
  assert.strictEqual(signedHeaders['host'], '242b859e54a641069d7af46c8b63d9fe.apic.cn-southwest-2.huaweicloudapis.com', '应自动补充 host');
  console.log('PASS 9: V11Signer 签名格式（Credential 四段 / SignedHeaders / Signature）正确');

  // ---------- 10. sendRequest HTTPS JSON 请求工具 ----------
  const int10 = installRequestInterceptor(() => ({ hello: 'world', version: '1.0' }));
  try {
    const res = await client.sendRequest('GET', 'https://api.example.com/v1/export', {}, '');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.version, '1.0', '应解析 JSON 响应体');
    assert.strictEqual(int10.records.length, 1, '应发起一次请求');
    assert.strictEqual(int10.records[0].method, 'GET');
    console.log('PASS 10: sendRequest 发送请求并解析 JSON 响应正确');
  } finally {
    int10.restore();
  }

  console.log('\nALL TESTS PASSED');
}

main().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
