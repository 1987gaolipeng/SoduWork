'use strict';
const crypto = require('node:crypto');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(String(value)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// Tencent Meeting requires Base64 of the hexadecimal digest, not the binary digest.
// https://meeting.tencent.com/support/topic/510/
function tencentSignature({ secretId, secretKey, method, uri, body = '', timestamp, nonce }) {
  const canonical = method + '\nX-TC-Key=' + secretId + '&X-TC-Nonce=' + nonce
    + '&X-TC-Timestamp=' + timestamp + '\n' + uri + '\n' + body;
  return Buffer.from(hmac(secretKey, canonical).toString('hex'), 'utf8').toString('base64');
}

// Kling AK/SK signing follows the legacy contract and is not interchangeable with API Key authentication.
function klingToken(accessKey, secretKey, now = Date.now()) {
  const seconds = Math.floor(now / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: accessKey, exp: seconds + 1800, nbf: seconds - 5 })).toString('base64url');
  return header + '.' + payload + '.' + hmac(secretKey, header + '.' + payload).toString('base64url');
}

function canonicalQuery(params) {
  return [...params].map(([key, value]) => [encode(key), encode(value)])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
    .map(([key, value]) => key + '=' + value).join('&');
}

// Preserve repeated slashes in S3 object keys; avoid URL normalization and double encoding.
// https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
function signS3({ url, method, body = '', headers = {}, accessKey, secretKey, sessionToken, region, now = Date.now() }) {
  const stamp = new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = stamp.slice(0, 8), payloadHash = sha256(body);
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (name !== 'authorization') result[name] = String(value).trim().replace(/[ \t]+/g, ' ');
  }
  result.host = url.host;
  result['x-amz-date'] = stamp;
  result['x-amz-content-sha256'] = payloadHash;
  if (sessionToken) result['x-amz-security-token'] = sessionToken;
  const names = Object.keys(result).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map(name => name + ':' + result[name] + '\n').join('');
  const query = canonicalQuery(url.searchParams);
  url.search = query;
  const canonical = [method, url.pathname, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = date + '/' + region + '/s3/aws4_request';
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + secretKey, date), region), 's3'), 'aws4_request');
  const signature = hmac(signingKey, ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n')).toString('hex');
  result.authorization = 'AWS4-HMAC-SHA256 Credential=' + accessKey + '/' + scope
    + ',SignedHeaders=' + signedHeaders + ',Signature=' + signature;
  return result;
}

module.exports = { tencentSignature, klingToken, signS3, canonicalQuery, encode, sha256 };
