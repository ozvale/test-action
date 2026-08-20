'use strict';

/**
 * HTTP 请求工具模块：sendRequest 发送请求并解析 JSON 响应。
 * 基于 Node 内置 fetch（Node 18+），零第三方依赖。
 * 调试模式下打印完整请求/响应日志（敏感字段自动脱敏）。
 */

const { cfg } = require('./config');
const { log, maskHeaders, maskBody } = require('./logger');

/**
 * 发送 HTTPS 请求并解析 JSON 响应（通用基础能力，供调用 APIG 等接口使用）。
 * 调试模式（configure({ debug: true })）下打印完整请求/响应日志，敏感字段自动脱敏。
 * @param {string} method  HTTP 方法（GET/POST/...）
 * @param {string} url     完整 URL（https://{host}{path}[?query]）
 * @param {Object} [headers] 请求头
 * @param {string} [body]    请求体（字符串）
 * @returns {Promise<{status: number, headers: Object, data: Object|string}>}
 *          JSON 解析失败时 data = { raw }
 */
async function sendRequest(method, url, headers, body) {
  if (cfg.debug) {
    log(`--> ${String(method).toUpperCase()} ${url}`);
    log(`--> 请求头: ${JSON.stringify(maskHeaders(headers))}`);
    if (body) {
      log(`--> 请求体: ${maskBody(body)}`);
    }
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body || undefined
    });
  } catch (err) {
    throw new Error(`网络请求失败 ${method} ${url}: ${err.message}`);
  }

  const raw = await res.text();
  if (cfg.debug) {
    log(`<-- HTTP 状态码: ${res.status}`);
    log(`<-- 响应头: ${JSON.stringify(_headersToObject(res.headers))}`);
    log(`<-- 响应体: ${raw ? maskBody(raw) : '(空)'}`);
  }

  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      data = { raw };
    }
  }
  return { status: res.status, headers: _headersToObject(res.headers), data };
}

/** 将 fetch 的 Headers 对象转换为普通对象。 */
function _headersToObject(headers) {
  const out = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

module.exports = { sendRequest };
