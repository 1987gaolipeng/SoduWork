'use strict';

const { fetchWithDeviceAuthRetry } = require('../device-auth-request');

// Never reuse an authorization cache: a member may have moved organizations,
// or a shared work item may have been withdrawn since the last conversation.
async function context(identity, { fetchImpl = global.fetch, timeoutMs = 600 } = {}) {
  if (!identity?.hub || !identity.clientId || (!identity.session && !identity.secret)) return { prompt: '', items: [] };
  const controller = new AbortController();
  let timer;
  const empty = { prompt: '', items: [] };
  try {
    return await Promise.race([
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(empty); }, timeoutMs); }),
      (async () => {
        const response = await fetchWithDeviceAuthRetry(identity,
          String(identity.hub).replace(/\/+$/, '') + '/api/v1/memories/organization-context',
          { method: 'GET', redirect: 'error', signal: controller.signal }, fetchImpl);
        if (!response.ok) return empty;
        const data = await response.json();
        if (data?.ok !== true || typeof data.prompt !== 'string' || data.prompt.length > 16000) return empty;
        return { prompt: data.prompt, items: data.item ? [{ id: data.item.id, scope: 'org', title: data.item.title, revision: data.revision }] : [] };
      })().catch(() => empty),
    ]);
  } finally { clearTimeout(timer); controller.abort(); }
}
module.exports = { context };
