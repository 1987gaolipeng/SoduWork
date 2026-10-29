'use strict';
/**
 * Pure cloud request signing without network access. Based on AWS SigV4 documentation and
 * get-vanilla vectors, Tencent TC3 SDK sign.test.ts vectors, Alibaba ACS3 documentation,
 * Huawei SDK-HMAC-SHA256 documentation, and volc-sdk-python SignerV4. Sign only fixed
 * read-only queries; never include arbitrary SQL, commands, or URLs.
 */
const crypto = require('crypto');

const sha256hex = (data) => crypto.createHash('sha256').update(data, 'utf8').digest('hex');
const hmacBuf = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const hmacHex = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');
const pct = (value) => encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const uuid = () => crypto.randomUUID();

function assertSafe(host, region) {
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(host)) throw new Error('云端主机名格式无效');
  if (region && !/^[a-z0-9-]{2,30}$/.test(region)) throw new Error('云端区域格式无效');
}

/** Alibaba Cloud ACS3 signing; matches the official V3 reference vector. */
function aliyunHeaders({ accessKeyId, accessKeySecret, securityToken, method = 'GET', host, action, version,
  query = {}, body = '', now = Date.now(), nonce = uuid() }) {
  assertSafe(host);
  if (!accessKeyId || !accessKeySecret) throw new Error('阿里云凭据缺失');
  const headers = { host, 'x-acs-action': action, 'x-acs-version': version,
    'x-acs-date': new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    'x-acs-signature-nonce': nonce, 'x-acs-content-sha256': sha256hex(body) };
  if (securityToken) headers['x-acs-security-token'] = securityToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map(key => key + ':' + String(headers[key]).trim() + '\n').join('');
  const canonicalQuery = Object.keys(query).sort().map(key => pct(key) + '=' + pct(query[key])).join('&');
  const canonical = [method.toUpperCase(), '/', canonicalQuery, canonicalHeaders, names.join(';'), sha256hex(body)].join('\n');
  const signature = hmacHex(accessKeySecret, 'ACS3-HMAC-SHA256\n' + sha256hex(canonical));
  headers.authorization = 'ACS3-HMAC-SHA256 Credential=' + accessKeyId + ',SignedHeaders=' + names.join(';') + ',Signature=' + signature;
  headers.accept = 'application/json';
  return { headers };
}

/** AWS SigV4 for EC2 GET queries; sign host, x-amz-date, and x-amz-security-token. */
function sigV4Headers({ accessKey, secretKey, sessionToken, region, service, method, host, path, query, body = '', now = Date.now() }) {
  assertSafe(host, region);
  if (!accessKey || !secretKey) throw new Error('AWS 凭据缺失');
  const amzDate = new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const headers = { host, 'x-amz-date': amzDate };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((k) => k + ':' + headers[k] + '\n').join('');
  const canonicalQuery = Object.keys(query || {}).sort()
    .map((k) => pct(k) + '=' + pct(query[k]))
    .join('&');
  const canonicalRequest = [method.toUpperCase(), path || '/', canonicalQuery, canonicalHeaders, signedNames.join(';'), sha256hex(body)].join('\n');
  const date = amzDate.slice(0, 8);
  const scope = [date, region, service, 'aws4_request'].join('/');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  let key = hmacBuf('AWS4' + secretKey, date);
  key = hmacBuf(key, region);
  key = hmacBuf(key, service);
  key = hmacBuf(key, 'aws4_request');
  const signature = hmacHex(key, stringToSign);
  headers.authorization = 'AWS4-HMAC-SHA256 Credential=' + accessKey + '/' + scope + ', SignedHeaders=' + signedNames.join(';') + ', Signature=' + signature;
  return { headers, amzDate, scope };
}

/** Tencent TC3-HMAC-SHA256 for JSON POST requests, checked against official byte-level test vectors. */
function tc3Headers({ secretId, secretKey, token, service, host, body, timestamp }) {
  assertSafe(host);
  if (!secretId || !secretKey) throw new Error('腾讯云凭据缺失');
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const canonicalRequest = ['POST', '/', '', 'content-type:application/json', 'host:' + host, '', 'content-type;host', sha256hex(body)].join('\n');
  const stringToSign = ['TC3-HMAC-SHA256', String(ts), date + '/' + service + '/tc3_request', sha256hex(canonicalRequest)].join('\n');
  let key = hmacBuf('TC3' + secretKey, date);
  key = hmacBuf(key, service);
  key = hmacBuf(key, 'tc3_request');
  const signature = hmacHex(key, stringToSign);
  const headers = {
    'content-type': 'application/json',
    host,
    'x-tc-action': '',
    'x-tc-timestamp': String(ts),
    'x-tc-version': '',
    authorization: 'TC3-HMAC-SHA256 Credential=' + secretId + '/' + date + '/' + service + '/tc3_request, SignedHeaders=content-type;host, Signature=' + signature,
  };
  if (token) headers['x-tc-token'] = token;
  return { headers, timestamp: ts };
}

/** Huawei SDK-HMAC-SHA256 for GET requests; sign host, x-sdk-date, and x-security-token. */
function huaweiHeaders({ accessKey, secretKey, securityToken, method, host, path, query, body = '', now = Date.now() }) {
  assertSafe(host);
  if (!accessKey || !secretKey) throw new Error('华为云凭据缺失');
  const sdkDate = new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const headers = { host, 'x-sdk-date': sdkDate };
  if (securityToken) headers['x-security-token'] = securityToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((k) => k + ':' + headers[k] + '\n').join('');
  const canonicalQuery = Object.keys(query || {}).sort()
    .map((k) => pct(k) + '=' + pct(query[k]))
    .join('&');
  // Huawei canonical URI always ends with /; the transmitted path is unchanged.
  const canonicalPath = (path || '/').replace(/\/?$/, '/');
  const canonicalRequest = [method.toUpperCase(), canonicalPath, canonicalQuery, canonicalHeaders, names.join(';'), sha256hex(body)].join('\n');
  const stringToSign = 'SDK-HMAC-SHA256\n' + sdkDate + '\n' + sha256hex(canonicalRequest);
  const signature = hmacHex(secretKey, stringToSign);
  headers.authorization = 'SDK-HMAC-SHA256 Access=' + accessKey + ', SignedHeaders=' + names.join(';') + ', Signature=' + signature;
  return { headers, sdkDate };
}

/** Volcengine HMAC-SHA256 matching SignerV4 headers: X-Date, X-Content-Sha256, and X-Security-Token. */
function volcHeaders({ accessKey, secretKey, sessionToken, service, region, method, host, path, query, body = '', now = Date.now() }) {
  assertSafe(host, region);
  if (!accessKey || !secretKey) throw new Error('火山引擎凭据缺失');
  const xDate = new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const headers = { host, 'x-content-sha256': sha256hex(body), 'x-date': xDate };
  if (sessionToken) headers['x-security-token'] = sessionToken;
  const names = Object.keys(headers).sort();
  const signedStr = names.map((k) => k + ':' + headers[k] + '\n').join('');
  const normQuery = Object.keys(query || {}).sort()
    .map((k) => pct(k) + '=' + pct(query[k]))
    .join('&');
  const canonicalRequest = [method.toUpperCase(), path || '/', normQuery, signedStr, names.join(';'), sha256hex(body)].join('\n');
  const scope = [xDate.slice(0, 8), region, service, 'request'].join('/');
  const signingStr = ['HMAC-SHA256', xDate, scope, sha256hex(canonicalRequest)].join('\n');
  let key = hmacBuf(secretKey, xDate.slice(0, 8));
  key = hmacBuf(key, region);
  key = hmacBuf(key, service);
  key = hmacBuf(key, 'request');
  const signature = hmacHex(key, signingStr);
  headers.authorization = 'HMAC-SHA256 Credential=' + accessKey + '/' + scope + ', SignedHeaders=' + names.join(';') + ', Signature=' + signature;
  return { headers, xDate };
}

/** Build the form-encoded Azure client credentials request body. */
function azureTokenRequestBody({ clientId, clientSecret, scope }) {
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope });
  return form.toString();
}

/** Build a GCP service account RS256 JWT with a fixed read-only scope and one-hour expiry. */
function gcpJwt({ clientEmail, privateKeyPem, scope, now = Math.floor(Date.now() / 1000) }) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: clientEmail, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const unsigned = b64(header) + '.' + b64(claims);
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  return unsigned + '.' + signer.sign(privateKeyPem).toString('base64url');
}

module.exports = { sha256hex, hmacBuf, hmacHex, pct, aliyunHeaders, sigV4Headers, tc3Headers, huaweiHeaders, volcHeaders, azureTokenRequestBody, gcpJwt, uuid };
