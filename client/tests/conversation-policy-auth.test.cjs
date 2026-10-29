const test = require('node:test');
const assert = require('node:assert/strict');

const capabilities = require('../main/conversation/capabilities');

test('conversation capability policy prefers the short device session', async () => {
  let request = null;
  const result = await capabilities.fetchPolicy({
    hub: 'http://127.0.0.1:8989', clientId: 'device-policy-1',
    secret: 'long-lived-key', session: 'short-device-session',
  }, 1000, async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ skills: [], enabled: [], revoked: [] }) };
  });
  assert.equal(result.ok, true);
  assert.equal(request.options.headers.Authorization, 'Device short-device-session');
  assert.equal(Object.prototype.hasOwnProperty.call(request.options.headers, 'X-Soduwork-Secret'), false);
});

test('conversation capability policy keeps the bounded legacy bridge', async () => {
  let request = null;
  await capabilities.fetchPolicy({
    hub: 'http://127.0.0.1:8989', clientId: 'device-policy-1', secret: 'legacy-key',
  }, 1000, async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ skills: [], enabled: [] }) };
  });
  assert.equal(request.options.headers['X-Soduwork-Device'], 'device-policy-1');
  assert.equal(request.options.headers['X-Soduwork-Secret'], 'legacy-key');
});
