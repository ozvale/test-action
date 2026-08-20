'use strict';

/**
 * 日志与脱敏模块：调试日志输出（debug 开关控制）+ 敏感字段脱敏工具。
 */

const { cfg } = require('./config');

/** 输出日志：仅在调试模式（configure({ debug: true })）下打印（普通 Node 环境使用 console.log，不依赖 @actions/core）。 */
function log(msg) {
  if (cfg.debug) {
    console.log(msg);
  }
}

/** 脱敏：仅保留首尾若干字符，中间用 * 代替。 */
function mask(value, head = 6, tail = 4) {
  if (!value) return '(空)';
  const s = String(value);
  if (s.length <= head + tail) return s.slice(0, 2) + '***' + s.slice(-2);
  return s.slice(0, head) + '***' + s.slice(-tail) + `（长度 ${s.length}）`;
}

/** 调试日志中需要脱敏的字段名（请求头字段与 JSON 字段名，小写比较）。 */
const SENSITIVE_KEYS = [
  'authorization', 'x-security-token', 'x-auth-token', 'password', 'secret',
  'id_token', 'access_key_id', 'secret_access_key', 'security_token',
  'accesskeyid', 'secretaccesskey', 'securitytoken', 'client_secret'
];

/** JWT 特征（三段 base64url，以 eyJ 开头），用于在任意文本中识别并脱敏令牌。 */
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

/** 文本脱敏：将其中的 JWT 令牌整体脱敏。 */
function maskText(text) {
  return String(text).replace(JWT_RE, (m) => mask(m, 20, 10));
}

/** 深度脱敏 JSON 结构：敏感字段名直接脱敏，其余字段递归处理（字符串再做 JWT 识别）。 */
function maskDeep(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return maskText(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = SENSITIVE_KEYS.includes(k.toLowerCase()) ? mask(value[k]) : maskDeep(value[k]);
    }
    return out;
  }
  return value;
}

/** 请求头脱敏：敏感头字段值脱敏，其余原样。 */
function maskHeaders(headers) {
  const out = {};
  for (const k of Object.keys(headers || {})) {
    out[k] = SENSITIVE_KEYS.includes(k.toLowerCase()) ? mask(headers[k]) : headers[k];
  }
  return out;
}

/** 请求体/响应体脱敏：JSON 结构做深度脱敏，非 JSON 文本做 JWT 识别脱敏。 */
function maskBody(body) {
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  try {
    return JSON.stringify(maskDeep(JSON.parse(s)));
  } catch (e) {
    return maskText(s);
  }
}

module.exports = { log, mask, maskText, maskDeep, maskHeaders, maskBody, SENSITIVE_KEYS };
