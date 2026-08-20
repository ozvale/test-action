'use strict';

/**
 * demo-action 插件测试
 *
 * 通过替换 require.cache 注入 FakeObsClient（模拟 esdk-obs-nodejs）并拦截 https.request
 * （模拟 OIDC -> STS 换证 与 APIG 调用），真实执行插件 run()，覆盖：
 *   1. 全流程：读取 file-path 文件 -> OBS 上传（OBS 客户端参数与 putObject 参数正确）-> APIG 调用（V11 签名 + X-Security-Token）
 *   2. 文件缺失校验：file-path 指向的文件不存在 -> setFailed，退出码置 1，不调用 putObject
 *   3. OBS 失败分支：putObject 非 2xx -> setFailed，退出码置 1
 *   4. APIG 非 2xx 分支：APIG 返回 401 -> setFailed，退出码置 1
 */

const assert = require('assert');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const APIG_HOST = '242b859e54a641069d7af46c8b63d9fe.apic.cn-southwest-2.huaweicloudapis.com';

/** 清空插件与 SDK 模块缓存，隔离各用例的凭证缓存与模块状态。 */
function freshModules() {
  delete require.cache[require.resolve('../index.js')];
  delete require.cache[require.resolve('../../sdk/openlibing-client')];
}

/**
 * 拦截 https.request：按 hostname 路由响应，记录请求与请求体。
 * routeResponse(record) 可返回 { statusCode, body } 或直接返回 body（默认 200）。
 */
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

/** 将 require('esdk-obs-nodejs') 重定向到 FakeObsClient。 */
function stubObsClient(Fake) {
  const modPath = require.resolve('esdk-obs-nodejs');
  require.cache[modPath] = { id: modPath, filename: modPath, loaded: true, exports: Fake };
}
function unstubObsClient() {
  delete require.cache[require.resolve('esdk-obs-nodejs')];
}

/** 大小写不敏感地读取请求头。 */
function pickHeader(headers, name) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return undefined;
}

/** STS 换证响应（OIDC -> STS 返回临时凭证）。 */
function stsResponse() {
  return {
    credentials: {
      access_key_id: 'T_AK',
      secret_access_key: 'T_SK',
      security_token: 'T_TOK',
      expiration: new Date(Date.now() + 3600 * 1000).toISOString()
    }
  };
}

async function main() {
  const origExitCode = process.exitCode;
  const tmpFile = path.join(os.tmpdir(), `demo-action-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'Hello OBS via OIDC!');

  function reset(env) {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('INPUT_')) delete process.env[k];
    }
    delete process.env.HUAWEICLOUD_OIDC_TOKEN;
    for (const k of Object.keys(env)) process.env[k] = env[k];
    obsOpts = null;
    putCalls = [];
    putResult = undefined;
    unstubObsClient();
    freshModules();
  }

  // 共享的 FakeObsClient：记录构造参数与 putObject 调用，返回 putResult
  let obsOpts = null;
  let putCalls = [];
  let putResult;
  const FakeObsClient = function (opts) { obsOpts = opts; };
  FakeObsClient.prototype.putObject = async function (params) {
    putCalls.push(params);
    return putResult;
  };
  FakeObsClient.prototype.close = async function () {};

  // ---------- 1. 全流程：读文件 -> OBS 上传 -> APIG 调用（V11 签名 + X-Security-Token） ----------
  reset({
    HUAWEICLOUD_OIDC_TOKEN: 'fake-jwt-token-for-demo-test-1',
    'INPUT_FILE-PATH': tmpFile
  });
  stubObsClient(FakeObsClient);
  putResult = {
    CommonMsg: { Status: 200, Message: 'OK' },
    InterfaceResult: { ETag: '"etag-demo"' }
  };
  const route1 = (rec) => {
    if (rec.hostname.startsWith('sts.')) return stsResponse();
    return { hello: 'world', version: '1.0' };
  };
  const int1 = installRequestInterceptor(route1);
  try {
    const { run } = require('../index.js');
    await run();
    assert.strictEqual(process.exitCode, origExitCode, '全流程成功不应置退出码');

    // OBS 客户端参数
    assert.strictEqual(obsOpts.access_key_id, 'T_AK');
    assert.strictEqual(obsOpts.secret_access_key, 'T_SK');
    assert.strictEqual(obsOpts.security_token, 'T_TOK', '临时凭证应携带 security_token');
    assert.strictEqual(obsOpts.server, 'https://obs.cn-southwest-2.myhuaweicloud.com', 'OBS endpoint 应自动构造');
    // putObject 参数
    assert.strictEqual(putCalls.length, 1);
    assert.strictEqual(putCalls[0].Bucket, 'openlibing-gitcode-action');
    assert.strictEqual(putCalls[0].Key, `oidc-demo-action/${path.basename(tmpFile)}`, '对象名应为 oidc-demo-action/<文件名>');
    assert.strictEqual(putCalls[0].SourceFile, tmpFile, '应上传 file-path 指定的文件');

    // APIG 请求
    const stsRec = int1.records[0];
    assert.ok(stsRec.hostname.startsWith('sts.cn-southwest-2'), '第一次请求应发往 STS');
    const apigRec = int1.records[1];
    assert.strictEqual(apigRec.hostname, APIG_HOST, '第二次请求应发往 APIG');
    assert.strictEqual(apigRec.path, '/version');
    assert.strictEqual(apigRec.method, 'GET');
    const auth = pickHeader(apigRec.headers, 'authorization');
    assert.ok(/^V11-HMAC-SHA256 Credential=T_AK\/\d{8}\/cn-southwest-2\/apic/.test(auth),
      `Authorization 应为 V11 Credential 四段：${auth}`);
    assert.ok(/SignedHeaders=.*x-security-token/.test(auth), 'X-Security-Token 应参与签名');
    assert.strictEqual(pickHeader(apigRec.headers, 'x-security-token'), 'T_TOK', 'APIG 请求应携带 X-Security-Token');
    console.log('PASS 1: 全流程 读文件 -> OBS 上传 -> APIG 调用（V11 签名 + X-Security-Token）成功');
  } finally {
    int1.restore();
    process.exitCode = origExitCode;
  }

  // ---------- 2. 文件缺失校验 ----------
  reset({
    HUAWEICLOUD_OIDC_TOKEN: 'fake-jwt-token-for-demo-test-2',
    'INPUT_FILE-PATH': path.join(os.tmpdir(), 'not-exist-file.txt')
  });
  stubObsClient(FakeObsClient);
  try {
    const { run } = require('../index.js');
    await run();
    assert.strictEqual(process.exitCode, 1, '文件缺失应置退出码 1');
    assert.strictEqual(putCalls.length, 0, '文件缺失不应调用 putObject');
    console.log('PASS 2: 文件缺失校验，file-path 不存在置退出码 1，不调用 putObject');
  } finally {
    process.exitCode = origExitCode;
  }

  // ---------- 3. OBS 失败分支 ----------
  reset({
    HUAWEICLOUD_OIDC_TOKEN: 'fake-jwt-token-for-demo-test-3',
    'INPUT_FILE-PATH': tmpFile
  });
  stubObsClient(FakeObsClient);
  putResult = { CommonMsg: { Status: 403, Code: 'AccessDenied', Message: 'forbidden' } };
  const route3 = (rec) => {
    if (rec.hostname.startsWith('sts.')) return stsResponse();
    throw new Error(`不应请求 ${rec.hostname}`);
  };
  const int3 = installRequestInterceptor(route3);
  try {
    const { run } = require('../index.js');
    await run();
    assert.strictEqual(process.exitCode, 1, 'OBS 上传失败应置退出码 1');
    console.log('PASS 3: OBS 失败分支，putObject 非 2xx 置退出码 1');
  } finally {
    int3.restore();
    process.exitCode = origExitCode;
  }

  // ---------- 4. APIG 非 2xx 分支 ----------
  reset({
    HUAWEICLOUD_OIDC_TOKEN: 'fake-jwt-token-for-demo-test-4',
    'INPUT_FILE-PATH': tmpFile
  });
  stubObsClient(FakeObsClient);
  putResult = {
    CommonMsg: { Status: 200, Message: 'OK' },
    InterfaceResult: { ETag: '"etag-demo-4"' }
  };
  const route4 = (rec) => {
    if (rec.hostname.startsWith('sts.')) return stsResponse();
    return { statusCode: 401, body: { error_code: 'APIG.0602', error_msg: 'signature not match' } };
  };
  const int4 = installRequestInterceptor(route4);
  try {
    const { run } = require('../index.js');
    await run();
    assert.strictEqual(process.exitCode, 1, 'APIG 非 2xx 应置退出码 1');
    console.log('PASS 4: APIG 非 2xx 分支，置退出码 1');
  } finally {
    int4.restore();
    process.exitCode = origExitCode;
  }

  try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
  console.log('\nALL TESTS PASSED');
}

main().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
