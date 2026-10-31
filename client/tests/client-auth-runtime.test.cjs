'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.resolve(__dirname, '..', 'api.js'),
  'utf8',
);

function runtime(loginResult) {
  const requests = [];
  const values = new Map([
    ['soduwork_work_hub_environment_v1', 'production'],
    ['soduwork_work_user_id', 'client-auth-runtime'],
  ]);
  const events = [];
  let cleared = 0;
  let quotaExceeded;
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  class CustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options && options.detail;
    }
  }
  const window = {
    soduWorkAPI: {
      onDeviceAuthQuotaExceeded(callback) { quotaExceeded = callback; },
      async deviceAuthLogin() { return loginResult; },
      async deviceAuthClearSession() { cleared += 1; return { ok: true }; },
      async configureRunner() { return { ok: true }; },
      async getAppVersion() { return 'test'; },
      async getSysInfo() {
        return { username: 'employee', hostname: 'workstation',
          platform: 'win32', arch: 'x64' };
      },
    },
    dispatchEvent(event) { events.push(event); },
  };
  const context = {
    window,
    localStorage,
    CustomEvent,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
    fetch: async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify({ user: loginResult.user, quota: loginResult.quota })); },
  };
  vm.runInNewContext(source, context);
  return {
    api: window.SoduWorkAPI,
    events,
    requests,
    cleared: () => cleared,
    exceed: detail => quotaExceeded(detail),
  };
}

test('failed login requests the client auth gate without a scope error', async () => {
  const harness = runtime({
    ok: false,
    status: 401,
    code: 'ACCOUNT_OR_PASSWORD_INVALID',
    error: 'invalid account',
  });
  const result = await harness.api.clientLogin({
    account: 'employee',
    password: 'wrong password',
  });

  assert.equal(result.ok, false);
  assert.equal(harness.cleared(), 1);
  assert.equal(harness.events.at(-1).type, 'soduwork-client-auth-required');
  assert.equal(
    harness.events.at(-1).detail.code,
    'ACCOUNT_OR_PASSWORD_INVALID',
  );
});

test('quota exhaustion clears the short session and exposes quota state', async () => {
  const quota = { enabled: true, limit: 100, used: 100, exceeded: true };
  const harness = runtime({
    ok: false,
    status: 403,
    code: 'TOKEN_QUOTA_EXCEEDED',
    error: 'quota exhausted',
    quota,
  });
  const result = await harness.api.clientLogin({
    account: 'employee',
    password: 'password',
  });

  assert.equal(result.ok, false);
  assert.equal(harness.api.clientAuthSnapshot().state, 'quota');
  assert.equal(harness.api.clientAuthSnapshot().quota.used, 100);
  assert.equal(harness.events.at(-1).detail.state, 'quota');
});

test('successful login keeps only the short session and safe profile in renderer', async () => {
  const harness = runtime({
    ok: true,
    session: 'short-session',
    expiresIn: 1800,
    clientId: 'client-auth-runtime',
    user: { id: 'user-1', username: 'employee', displayName: 'Employee' },
    quota: { enabled: false },
  });
  const result = await harness.api.clientLogin({
    account: 'employee',
    password: 'password',
  });

  assert.equal(result.ok, true);
  assert.equal(harness.api.clientAuthSnapshot().state, 'active');
  assert.equal(harness.api.clientAuthSnapshot().user.id, 'user-1');
  assert.equal(harness.cleared(), 0);
});

test('exhaustion during an authenticated session preserves access to history', async () => {
  const harness = runtime({ ok: true, session: 'short-session', expiresIn: 1800,
    clientId: 'client-auth-runtime', user: { id: 'quota-user' }, quota: { enabled: false } });
  await harness.api.clientLogin({ account: 'employee', password: 'password' });
  harness.exceed({ quota: { enabled: true, limit: 0, used: 0, exceeded: true } });
  assert.equal(harness.cleared(), 0);
  assert.equal(harness.api.clientAuthSnapshot().state, 'active');
  assert.equal(harness.api.clientAuthSnapshot().quota.limit, 0);
  assert.equal(harness.events.at(-1).detail.code, 'TOKEN_QUOTA_EXCEEDED');
  assert.equal(harness.events.at(-1).detail.user.id, 'quota-user');
  const count = harness.events.length;
  harness.exceed({ hub: 'http://another-local-hub', clientId: 'other-device', quota: { enabled: true, limit: 50 } });
  assert.equal(harness.events.length, count);
  assert.equal(harness.api.clientAuthSnapshot().quota.limit, 0);
});
