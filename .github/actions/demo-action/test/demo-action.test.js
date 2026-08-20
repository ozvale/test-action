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
 *
 * 另捕获 stdout（core.info 与 SDK 调试日志均写入 stdout）断言执行步骤与第三方接口
 * 请求/响应日志（含敏感字段脱敏）。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APIG_HOST = '242b859e54a641069d7af46c8b63d9fe.apic.cn-southwest-2.huaweicloudapis.com';

// SDK 来自安装的构建产物包（file: tarball），清缓存需覆盖该包全部模块
const SDK_DIR = path.resolve(__dirname, '../node_modules/@openlibing/huaweicloud-oidc-client');

/** 清空插件与 SDK（node_modules/@openlibing/huaweicloud-oidc-client 包全部模块）缓存，隔离各用例的凭证缓存与模块状态。 */
function freshModules() {
  delete require.cache[require.resolve('../index.js')];
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SDK_DIR)) {
      delete require.cache[key];
    }
  }
}

/**
 * 拦截 globalThis.fetch：按 URL 路由响应，记录请求与请求体。
 * routeResponse(record) 可返回 { statusCode, body } 或直接返回 body（默认 200）。
 */
function installRequestInterceptor(routeResponse) {
  const records = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async function (url, init = {}) {
    const parsed = new URL(url);
    const record = {
      url: url.toString(),
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body || ''
    };
    records.push(record);

    const r = routeResponse(record);
    let statusCode = 200;
    let body = r;
    if (r && typeof r === 'object' && 'statusCode' in r) {
      statusCode = r.statusCode;
      body = r.body;
    }
    const raw = body === null || body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    return {
      status: statusCode,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => raw
    };
  };
  return {
    records,
    restore() { globalThis.fetch = origFetch; }
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

/** 捕获 stdout 输出（core.info 与 SDK 调试日志 console.log 均写入 stdout）。 */
async function captureOutput(fn) {
  const orig = process.stdout.write;
  const chunks = [];
  process.stdout.write = function (chunk) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    const result = await fn();
    return { output: chunks.join(''), result };
  } finally {
    process.stdout.write = orig;
  }
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
    const { output } = await captureOutput(() => run());
    assert.strictEqual(process.exitCode, origExitCode, '全流程成功不应置退出码');

    // 执行步骤日志
    for (const step of ['步骤 1/4', '步骤 2/4', '步骤 3/4', '步骤 4/4']) {
      assert.ok(output.includes(step), `应打印执行步骤日志：${step}`);
    }

    // OBS 请求/响应详情
    assert.ok(output.includes(`OBS 请求     : PUT https://obs.cn-southwest-2.myhuaweicloud.com/openlibing-gitcode-action/oidc-demo-action/${path.basename(tmpFile)}`),
      '应打印 OBS 请求行（方法 + 地址 + 桶/对象名）');
    assert.ok(output.includes('OBS 请求参数'), '应打印 OBS 请求参数');
    assert.ok(output.includes('OBS 响应     : HTTP 200'), '应打印 OBS 响应状态码');
    assert.ok(output.includes('OBS 响应头'), '应打印 OBS 响应头');
    assert.ok(output.includes('OBS 上传成功'), '应打印 OBS 上传成功日志');

    // SDK 调试日志：STS 与 APIG 第三方接口的请求/响应详情
    assert.ok(output.includes('--> POST https://sts.cn-southwest-2.myhuaweicloud.com/v5/agencies/assume-with-oidc'),
      '应打印 STS 请求行（方法 + URL）');
    assert.ok(output.includes(`--> GET https://${APIG_HOST}/version`), '应打印 APIG 请求行（方法 + URL）');
    assert.ok(output.includes('--> 请求头'), '应打印第三方接口请求头');
    assert.ok(output.includes('--> 请求体'), '应打印第三方接口请求体');
    assert.ok(output.includes('<-- HTTP 状态码: 200'), '应打印第三方接口响应状态码');
    assert.ok(output.includes('<-- 响应头'), '应打印第三方接口响应头');
    assert.ok(output.includes('<-- 响应体'), '应打印第三方接口响应体');

    // 敏感字段脱敏
    assert.ok(!output.includes('"secret_access_key":"T_SK"'), '日志中临时 SK 不应明文出现');
    assert.ok(!output.includes('T_TOK'), '日志中 SecurityToken 不应明文出现');

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
    console.log('PASS 1: 全流程 读文件 -> OBS 上传 -> APIG 调用（V11 签名 + X-Security-Token）成功，步骤与第三方接口请求/响应日志完整且脱敏');
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
    await captureOutput(() => run());
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
    await captureOutput(() => run());
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
    await captureOutput(() => run());
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
