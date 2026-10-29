'use strict';
// SoduWork-generated Azure/GCP token flows, reviewed for account isolation and bounded transport.
const crypto = require('node:crypto');
const { fetchBounded } = require('./special-transport.cjs');
const { azureTokenRequestBody, gcpJwt } = require('./cloud-signing.cjs');
const tokens = new Map();
async function bearer(kind, values, options = {}) {
  const now = options.now ?? Date.now();
  // Include the complete credential identity: a rotated key must never reuse a stale token.
  const key = crypto.createHash('sha256').update(kind + JSON.stringify(values)).digest('hex');
  const cached = tokens.get(key);
  if (!options.fetchImpl && cached?.until > now + 60000) return cached.token;
  let url, body;
  if (kind === 'azure') {
    url = 'https://login.microsoftonline.com/' + values.AZURE_TENANT_ID + '/oauth2/v2.0/token';
    body = azureTokenRequestBody({ clientId: values.AZURE_CLIENT_ID, clientSecret: values.AZURE_CLIENT_SECRET,
      scope: 'https://management.azure.com/.default' });
  } else {
    url = 'https://oauth2.googleapis.com/token';
    let jwt;
    try { jwt = gcpJwt({ clientEmail: values.GCP_CLIENT_EMAIL, privateKeyPem: values.GCP_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scope: 'https://www.googleapis.com/auth/compute.readonly', now: Math.floor(now / 1000) }); }
    catch { throw Error('Google Cloud 服务账号私钥格式无效'); }
    body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString();
  }
  let response;
  try { response = await fetchBounded({ url, method: 'POST', body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, { timeoutMs: 15000, ...options }); }
  catch (error) {
    // Official OAuth servers return HTTP 400 for invalid_client / invalid_grant.
    if ([400, 401, 403].includes(error.status))
      throw Object.assign(Error('云平台授权失败，请检查应用凭据及只读权限'), { code: 'AUTH_REQUIRED' });
    throw error;
  }
  let data;
  try { data = JSON.parse(response.bytes.toString('utf8')); } catch { throw Error('云平台授权响应格式无效'); }
  if (data.error || typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 16384
    || /[\x00-\x20\x7f]/.test(data.access_token))
    throw Object.assign(Error('云平台授权失败，请检查应用凭据及只读权限'), { code: 'AUTH_REQUIRED' });
  const ttl = Number(data.expires_in);
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 86400) throw Error('云平台令牌有效期无效');
  if (!options.fetchImpl) {
    for (const [id, value] of tokens) if (value.until <= now) tokens.delete(id);
    if (tokens.size >= 64) tokens.delete(tokens.keys().next().value);
    tokens.set(key, { token: data.access_token, until: now + ttl * 1000 });
  }
  return data.access_token;
}
module.exports = { bearer };
