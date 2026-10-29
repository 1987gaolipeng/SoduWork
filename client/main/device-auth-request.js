'use strict';

/*
 * Device sessions intentionally expire.  Long-lived conversations can still
 * hold the original identity object after that happens, so every authenticated
 * request may renew once through the main process's trusted identity resolver.
 * A rejected account session must never fall back to a bare device credential:
 * that installation may now belong to a different account.
 */
let identityRefresher = null;
function setIdentityRefresher(refresh) { identityRefresher = typeof refresh === 'function' ? refresh : null; }
function accountId(identity) {
  // Provenance only: tokens here came from Hub through trusted main-process
  // code. Expired tokens still identify the account; Hub verifies signatures.
  try {
    const claims = JSON.parse(Buffer.from(String(identity?.session || '').split('.')[0], 'base64url'));
    return claims.typ === 'device' && claims.cid === identity.clientId && typeof claims.uid === 'string'
      ? claims.uid.trim() : '';
  } catch (_) { return ''; }
}
function accountScopeKey(identity) {
  const account = accountId(identity);
  if (account) return 'account:' + account;
  return identity?.session ? 'session:' + require('node:crypto').createHash('sha256')
    .update(String(identity.session)).digest('hex') : '';
}
async function refreshIdentity(identity, signal, refresh = identityRefresher) {
  if (!refresh || !accountId(identity)) return null;
  signal?.throwIfAborted();
  let abort;
  try {
    const renewal = Promise.resolve().then(() => refresh(Object.freeze({ ...identity })));
    const refreshed = signal ? await Promise.race([renewal, new Promise((_, reject) => {
      abort = () => reject(signal.reason || Error('Request aborted'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]) : await renewal;
    return refreshed && refreshed.hub === identity.hub && refreshed.clientId === identity.clientId &&
      refreshed.session && accountId(refreshed) === accountId(identity) ? refreshed : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}
function authHeaders(identity, preferSecret = false) {
  const id = identity || {};
  if (!preferSecret && id.session) return { Authorization: 'Device ' + id.session };
  return {
    'X-Soduwork-Device': String(id.clientId || ''),
    'X-Soduwork-Secret': String(id.secret || ''),
  };
}

function mergeHeaders(options, identity, preferSecret) {
  const current = (options && options.headers) || {};
  const merged = {};
  if (current && typeof current.forEach === 'function') {
    current.forEach((value, key) => { merged[key] = value; });
  } else Object.assign(merged, current);
  // Do not leave an expired Authorization header beside the secret fallback.
  for (const key of Object.keys(merged)) {
    if (/^(authorization|x-soduwork-device|x-soduwork-secret)$/i.test(key)) delete merged[key];
  }
  return { ...merged, ...authHeaders(identity, preferSecret) };
}

async function fetchWithDeviceAuthRetry(identity, url, options = {}, fetchImpl = global.fetch) {
  const context = require('./agent-runtime/process-context').current();
  if (context) return context.authFetch(identity, url, options);
  const original = { ...identity };
  const send = current => fetchImpl(url, {
    ...options,
    headers: mergeHeaders(options, current, false),
  });
  let response = await send(original);
  if (response && Number(response.status) === 401 && original.session) {
    const refreshed = await refreshIdentity(original, options.signal);
    if (refreshed) {
      await response.body?.cancel?.().catch(() => {});
      options.signal?.throwIfAborted();
      response = await send(refreshed);
    }
  }
  return response;
}

module.exports = { authHeaders, fetchWithDeviceAuthRetry, setIdentityRefresher, accountId, accountScopeKey,
  refreshAccountIdentity: refreshIdentity };
