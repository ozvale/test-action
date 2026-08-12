'use strict';

/**
 * 华为云 APIG AK/SK 签名 SDK（JavaScript）
 *
 * 实现了华为云 API 网关（APIG）"IAM 认证" 的签名算法 SDK-HMAC-SHA256。
 * 提供 Signer 类用于对请求做 HMAC-SHA256 签名，生成 Authorization / X-Sdk-Date 请求头。
 * 支持永久凭证与临时凭证（临时凭证需额外携带 X-Security-Token 头）。
 *
 * 参考：华为云《API 签名指南 - AK/SK 认证》。
 */

const crypto = require('crypto');

/**
 * RFC3986 编码：对 URI 组件做百分号编码。
 * encodeURIComponent 不转义 !'()*，需手动补充。
 */
function encodeRfc3986(uriComponent) {
  return encodeURIComponent(uriComponent)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

/**
 * HttpRequest：待签名的 HTTP 请求描述。
 * @param {string} method  HTTP 方法（GET/POST/PUT/DELETE 等）
 * @param {string} url     完整 URL（含协议与可选的查询参数）
 * @param {Object} headers 请求头（键不区分大小写）
 * @param {string} body    请求体（字符串）
 */
class HttpRequest {
  constructor(method = '', url = '', headers = {}, body = '') {
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.body = body;
  }
}

/**
 * Signer：使用 AK/SK 对 HttpRequest 进行签名。
 */
class Signer {
  constructor() {
    this.Key = '';    // Access Key
    this.Secret = ''; // Secret Key
  }

  /**
   * 对请求签名，返回需要附加到请求上的请求头（含 Authorization / X-Sdk-Date / Host）。
   * @param {HttpRequest} r 待签名请求
   * @returns {Object} 签名后的请求头
   */
  sign(r) {
    const headers = {};
    // Host 头
    headers['host'] = new URL(r.url).host;
    // 请求时间（GMT，格式 YYYYMMDDTHHMMSSZ）
    headers['x-sdk-date'] = this.#getTime();
    // 合并用户自定义请求头（统一转小写）
    if (r.headers) {
      for (const key of Object.keys(r.headers)) {
        headers[key.toLowerCase()] = r.headers[key];
      }
    }

    const signedHeaders = this.#getSignedHeaders(headers);
    const canonicalRequest = this.#getCanonicalRequest(r, headers);
    const stringToSign = this.#getStringToSign(headers['x-sdk-date'], canonicalRequest);
    const signature = this.#calculateSignature(stringToSign);

    headers['Authorization'] =
      'SDK-HMAC-SHA256 Access=' + this.Key +
      ', SignedHeaders=' + signedHeaders +
      ', Signature=' + signature;

    return headers;
  }

  /**
   * 构造规范请求 CanonicalRequest。
   * 规范请求 = Method + \n + CanonicalURI + \n + CanonicalQueryString + \n + CanonicalHeaders + \n + SignedHeaders + \n + HashedRequestPayload
   */
  #getCanonicalRequest(r, headers) {
    const url = new URL(r.url);
    return [
      r.method.toUpperCase(),
      this.#getCanonicalURI(url),
      this.#getCanonicalQueryString(url),
      this.#getCanonicalHeaders(headers),
      this.#getSignedHeaders(headers),
      this.#getHashedPayload(r.body)
    ].join('\n');
  }

  /** CanonicalURI：对 URL 路径逐段进行 RFC3986 编码后拼接。 */
  #getCanonicalURI(url) {
    const path = url.pathname || '/';
    const segments = path.split('/');
    return segments
      .map((seg) => encodeRfc3986(seg))
      .join('/');
  }

  /** CanonicalQueryString：查询参数按键名升序排序，键与值分别 RFC3986 编码，用 & 连接。 */
  #getCanonicalQueryString(url) {
    const params = url.searchParams;
    const items = [];
    for (const key of params.keys()) {
      const values = params.getAll(key);
      for (const value of values) {
        items.push([encodeRfc3986(key), encodeRfc3986(value)]);
      }
    }
    // 先按键排序，键相同再按值排序
    items.sort((a, b) => {
      if (a[0] !== b[0]) {
        return a[0] < b[0] ? -1 : 1;
      }
      return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
    });
    return items.map(([k, v]) => k + '=' + v).join('&');
  }

  /** CanonicalHeaders：对参与签名的请求头，按小写名升序拼接，格式 name:trimmed-value\n。 */
  #getCanonicalHeaders(headers) {
    const names = Object.keys(headers).sort();
    return names
      .map((name) => name.toLowerCase() + ':' + String(headers[name]).trim())
      .join('\n') + '\n';
  }

  /** SignedHeaders：参与签名的请求头小写名列表，用 ; 连接。 */
  #getSignedHeaders(headers) {
    return Object.keys(headers)
      .map((name) => name.toLowerCase())
      .sort()
      .join(';');
  }

  /** HashedRequestPayload：请求体内容的 SHA-256 摘要（十六进制小写）。 */
  #getHashedPayload(body) {
    if (!body) {
      return 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // sha256('')
    }
    return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  }

  /** 待签字符串。 */
  #getStringToSign(dateTime, canonicalRequest) {
    return [
      'SDK-HMAC-SHA256',
      dateTime,
      crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')
    ].join('\n');
  }

  /** 使用 SK 对待签字符串做 HMAC-SHA256 计算签名。 */
  #calculateSignature(stringToSign) {
    return crypto.createHmac('sha256', this.Secret).update(stringToSign, 'utf8').digest('hex');
  }

  /** 当前 GMT 时间，格式 YYYYMMDDTHHMMSSZ。 */
  #getTime() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return (
      d.getUTCFullYear() +
      pad(d.getUTCMonth() + 1) +
      pad(d.getUTCDate()) +
      'T' +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes()) +
      pad(d.getUTCSeconds()) +
      'Z'
    );
  }
}

module.exports = { Signer, HttpRequest };
