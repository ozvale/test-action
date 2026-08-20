'use strict';

/**
 * APIG V11-HMAC-SHA256 签名模块（严格复刻华为云官方 APIG Python SDK 的 V11 算法）。
 * 仅适用于 APIG 网关接口，签名作用域服务名固定为 apic。
 */

const crypto = require('crypto');

const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const APIC_SERVICE = 'apic';

// 与官方 noEscape 一致的字符表：不可编码字符（字母数字和 - _ . ~）为 1
const noEscape = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0,
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1,
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0
];

const hexTable = [];
for (let i = 0; i < 256; ++i) {
  hexTable[i] = '%' + ((i < 16 ? '0' : '') + i.toString(16)).toUpperCase();
}

/** 官方 urlencode 实现（quote(str, safe='~')）。 */
function urlEncode(str) {
  if (typeof str !== 'string') {
    str = str == null ? '' : String(str);
  }
  let out = '';
  let lastPos = 0;
  for (let i = 0; i < str.length; ++i) {
    const c = str.charCodeAt(i);
    if (c < 0x80) {
      if (noEscape[c] === 1) continue;
      if (lastPos < i) out += str.slice(lastPos, i);
      lastPos = i + 1;
      out += hexTable[c];
      continue;
    }
    if (lastPos < i) out += str.slice(lastPos, i);
    if (c < 0x800) {
      lastPos = i + 1;
      out += hexTable[0xC0 | (c >> 6)] + hexTable[0x80 | (c & 0x3F)];
      continue;
    }
    if (c < 0xD800 || c >= 0xE000) {
      lastPos = i + 1;
      out += hexTable[0xE0 | (c >> 12)] +
        hexTable[0x80 | ((c >> 6) & 0x3F)] +
        hexTable[0x80 | (c & 0x3F)];
      continue;
    }
    ++i;
    if (i >= str.length) throw new Error('ERR_INVALID_URI');
    const c2 = str.charCodeAt(i) & 0x3FF;
    lastPos = i + 1;
    const cFull = 0x10000 + (((c & 0x3FF) << 10) | c2);
    out += hexTable[0xF0 | (cFull >> 18)] +
      hexTable[0x80 | ((cFull >> 12) & 0x3F)] +
      hexTable[0x80 | ((cFull >> 6) & 0x3F)] +
      hexTable[0x80 | (cFull & 0x3F)];
  }
  if (lastPos === 0) return str;
  if (lastPos < str.length) return out + str.slice(lastPos);
  return out;
}

/** CanonicalURI：路径按 '/' 分段逐段编码后拼接，末尾补 '/'。 */
function canonicalURI(pathname) {
  const input = pathname || '';
  const uriList = input.split('/');
  const uri = uriList.map((seg) => urlEncode(seg));
  let urlpath = uri.join('/');
  if (urlpath[urlpath.length - 1] !== '/') {
    urlpath = urlpath + '/';
  }
  return urlpath;
}

/** CanonicalQueryString：查询参数按键排序，值排序后拼接。 */
function canonicalQueryString(searchParams) {
  const keys = [];
  for (const key of searchParams.keys()) keys.push(key);
  keys.sort();
  const arr = [];
  for (const key of keys) {
    const ke = urlEncode(key);
    const values = searchParams.getAll(key);
    values.sort();
    for (const v of values) {
      arr.push(ke + '=' + urlEncode(v));
    }
  }
  return arr.join('&');
}

/**
 * CanonicalHeaders：按 signed headers 顺序，name:value\n（value 去首尾空格）。
 * 注意：allHeaders 的 key 可能保留原始大小写，因此先构建小写 key 的查找表，
 * 否则会取到 undefined，导致规范请求错误、签名不匹配（表现为 APIG.0602 等）。
 */
function canonicalHeaders(allHeaders, signedHeaders) {
  const normalized = {};
  for (const k of Object.keys(allHeaders)) {
    normalized[k.toLowerCase()] = allHeaders[k];
  }
  const arr = [];
  for (const k of signedHeaders) {
    arr.push(k + ':' + String(normalized[k]).trim());
  }
  return arr.join('\n') + '\n';
}

/** sha256 hex。 */
function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/** hmac-sha256 hex。 */
function hmacSha256Hex(key, str) {
  return crypto.createHmac('sha256', key).update(str, 'utf8').digest('hex');
}

/**
 * HKDF-SHA256 派生密钥，返回 hex 字符串。
 * 严格对齐官方 signer_v11.py 的 _hkdf：salt = AK，ikm = SK，info = credential_scope。
 */
function hkdfGetDerKeySha256(accessKey, secretKey, credentialScope) {
  const salt = Buffer.from(accessKey, 'utf8');
  const ikm = Buffer.from(secretKey, 'utf8');
  const info = Buffer.from(credentialScope, 'utf8');
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  let okm = Buffer.alloc(0);
  let t = Buffer.alloc(0);
  const length = 32;
  const rounds = Math.ceil((length + 32) / 32);
  for (let i = 1; i <= rounds; ++i) {
    const newInfo = Buffer.concat([t, info, Buffer.from([i])]);
    t = crypto.createHmac('sha256', prk).update(newInfo).digest();
    okm = Buffer.concat([okm, t], okm.length + t.length);
  }
  return okm.slice(0, length).toString('hex').toLowerCase();
}

/** 当前 GMT 时间，格式 YYYYMMDDTHHMMSSZ。 */
function getTime() {
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

/**
 * V11Signer：使用 AK/SK 对 APIG 请求做 V11-HMAC-SHA256 签名。
 * 仅适用于 APIG 网关接口（签名作用域服务名固定为 apic）。
 */
class V11Signer {
  constructor(options = {}) {
    this.Key = '';
    this.Secret = '';
    this.region = options.region || '';
  }

  /**
   * 对请求签名，返回签名后的完整请求头（含 Authorization / x-sdk-date / host）。
   * @param {string} method   HTTP 方法（如 GET/POST）
   * @param {string} url      完整 URL（https://{apig-host}{path}[?query]）
   * @param {Object} [headers] 请求头
   * @param {string} [body]    请求体（字符串）
   * @returns {Object} 签名后的请求头
   */
  sign(method, url, headers = {}, body = '') {
    const parsedUrl = new URL(url);

    const allHeaders = {};
    for (const k of Object.keys(headers)) allHeaders[k] = headers[k];
    if (!Object.keys(allHeaders).some((k) => k.toLowerCase() === 'x-sdk-date')) {
      allHeaders['x-sdk-date'] = getTime();
    }
    if (!Object.keys(allHeaders).some((k) => k.toLowerCase() === 'host')) {
      allHeaders['host'] = parsedUrl.host;
    }

    const signedHeaders = Object.keys(allHeaders)
      .map((k) => k.toLowerCase())
      .sort();

    const canonicalURIStr = canonicalURI(parsedUrl.pathname);
    const canonicalQueryStringStr = canonicalQueryString(parsedUrl.searchParams);
    const canonicalHeadersStr = canonicalHeaders(allHeaders, signedHeaders);
    const payloadHash = body ? sha256Hex(body) : EMPTY_BODY_SHA256;

    const canonicalRequest = [
      method.toUpperCase(),
      canonicalURIStr,
      canonicalQueryStringStr,
      canonicalHeadersStr,
      signedHeaders.join(';'),
      payloadHash
    ].join('\n');

    const canonicalRequestHash = sha256Hex(canonicalRequest);

    const time = allHeaders['x-sdk-date'];
    const formattedDate = time.substring(0, 8);
    const credentialScope = formattedDate + '/' + this.region + '/' + APIC_SERVICE;

    const stringToSign =
      'V11-HMAC-SHA256\n' +
      time + '\n' +
      credentialScope + '\n' +
      canonicalRequestHash;

    const realUseSecret = hkdfGetDerKeySha256(this.Key, this.Secret, credentialScope);
    const signature = hmacSha256Hex(realUseSecret, stringToSign);

    allHeaders['Authorization'] =
      'V11-HMAC-SHA256 Credential=' + this.Key + '/' + credentialScope +
      ', SignedHeaders=' + signedHeaders.join(';') +
      ', Signature=' + signature;

    return allHeaders;
  }
}

module.exports = { V11Signer };
