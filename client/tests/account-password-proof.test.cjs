'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs'), path = require('node:path'), vm = require('node:vm');
const authSource = fs.readFileSync(path.join(__dirname, '../components/client-auth/account-verification.js'), 'utf8');
const apiSource = fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8');

function node(dataset = {}) {
  const listeners = new Map();
  return { dataset, value: '', hidden: false, disabled: false, textContent: '',
    focus() {}, setAttribute() {}, addEventListener(name, fn) { listeners.set(name, fn); },
    fire(name) { return listeners.get(name)?.({ preventDefault() {}, target: this }); } };
}
function proofFixture(purpose) {
  const password = node(), code = node(), send = node(), status = node();
  const passwordPanel = node(), codePanel = node(), segments = node();
  const modes = ['password', 'code'].map(proofMode => node({ proofMode }));
  const selectors = new Map([['[name="password"]', password], ['[name="code"]', code],
    ['[data-proof-password]', passwordPanel], ['[data-proof-code]', codePanel],
    ['[data-proof-send]', send], ['.ac-status', status], ['.ac-segments', segments]]);
  const form = node(); form.querySelector = selector => selectors.get(selector);
  form.querySelectorAll = selector => selector === '[data-proof-mode]' ? modes
    : selector === 'input' ? [password, code] : [password, code, send, ...modes];
  const mask = node(); mask.querySelector = () => form;
  let active = true;
  const calls = [];
  const user = { id: 'proof-owner', email: 'fixture@example.test', emailVerified: true, hasPassword: true };
  const window = {
    AccountUI: { esc: String, code: value => /^\d{6}$/.test(value), check: value => value, error: error => error.message,
      modal(_parent, _title, html) {
        passwordPanel.hidden = /data-proof-password[^>]*\bhidden\b/.test(html);
        codePanel.hidden = /data-proof-code[^>]*\bhidden\b/.test(html);
        segments.hidden = /class="ac-segments"[^>]*\bhidden\b/.test(html);
        return { mask, active: () => active, close() { active = false; mask.fire('ac-close'); } };
      } },
    SoduWorkAPI: { clientAuthSnapshot: () => ({ user }), hubBase: () => 'http://fixture.invalid',
      async clientAccountRequest(operation, payload) {
        calls.push({ operation, payload });
        return operation === 'challenge' ? { challengeId: 'fixture-challenge', retryAfter: 60 }
          : { verificationToken: 'fixture-purpose-bound-proof' };
      } },
    addEventListener() {}, removeEventListener() {},
  };
  vm.runInNewContext(authSource, { window, document: { body: {} }, setInterval: () => 1, clearInterval() {} });
  const proof = window.AccountVerification.verify(purpose, user);
  return { password, code, send, form, passwordPanel, codePanel, segments, calls, proof };
}

test('password setting proof opens email verification without exposing current-password controls', () => {
  const f = proofFixture('change_password');
  assert.equal(f.passwordPanel.hidden, true);
  assert.equal(f.segments.hidden, true);
  assert.equal(f.codePanel.hidden, false);
});
test('password setting consumes email proof with the dedicated change_password purpose', async () => {
  const f = proofFixture('change_password');
  await f.send.fire('click'); f.code.value = '123456'; await f.form.fire('submit');
  assert.equal(f.calls.length, 2, 'No current password should be required to verify the email code');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1])), { operation: 'verification', payload: {
    purpose: 'change_password', challengeId: 'fixture-challenge', code: '123456' } });
  assert.equal(await f.proof, 'fixture-purpose-bound-proof');
});
test('existing account operations retain password verification', async () => {
  const f = proofFixture('devices'); f.password.value = 'Fixture-password-123'; await f.form.fire('submit');
  assert.equal(f.passwordPanel.hidden, false);
  assert.equal(f.calls[0].payload.password, 'Fixture-password-123');
  assert.equal(await f.proof, 'fixture-purpose-bound-proof');
});

async function passwordRequest(payload) {
  const requests = [], values = new Map(), window = {};
  vm.runInNewContext(apiSource, { window,
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) },
    User: { id: 'fixture-user' }, navigator: { platform: 'test' }, console: { log() {}, error() {} },
    AbortController: class { constructor() { this.signal = {}; } abort() {} }, FormData: class {},
    WebSocket: class {}, setTimeout: () => 0, clearTimeout() {},
    fetch: async (url, options) => { requests.push({ url, options });
      return { ok: true, status: 200, text: async () => '{"ok":true,"logoutRequired":true}' }; },
  });
  await window.SoduWorkAPI.clientChangePassword(payload);
  assert.equal(requests.length, 1); assert.match(requests[0].url, /\/client-auth\/change-password$/);
  return JSON.parse(requests[0].options.body);
}
test('password change sends the email verification token without an empty current password', async () => {
  const payload = { verificationToken: 'fixture-purpose-bound-proof', newPassword: 'New-password-123', extra: 'omit' };
  assert.deepEqual(await passwordRequest(payload), { verificationToken: payload.verificationToken, newPassword: payload.newPassword });
  assert.equal(payload.extra, 'omit');
});
test('legacy password change preserves its current-password request contract', async () => {
  assert.deepEqual(await passwordRequest({ currentPassword: 'Old-password-123', newPassword: 'New-password-123' }),
    { currentPassword: 'Old-password-123', newPassword: 'New-password-123' });
});
test('ambiguous password proofs remain explicit for the server to reject', async () => {
  const payload = { currentPassword: 'Old-password-123', verificationToken: 'fixture-proof', newPassword: 'New-password-123' };
  assert.deepEqual(await passwordRequest(payload), payload);
});

test('a password change awaiting Hub restoration cannot send the old proof after a pending login replaces its owner', async () => {
  const requests = [], values = new Map();
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const login = deferred(), restoration = deferred(); let loginStarted = false, restorationStarted = false;
  const session = owner => ({ ok: true, clientId: 'scope-device', session: 'fixture-' + owner,
    expiresIn: 600, user: { id: owner } });
  const bridge = {
    getAppVersion: async () => 'fixture', getSysInfo: async () => ({}), configureRunner: async () => ({ ok: true }),
    deviceAuthLogin: async payload => {
      if (payload.account === 'bob') { loginStarted = true; return login.promise; }
      return session('alice');
    },
  };
  const window = { soduWorkAPI: bridge, dispatchEvent() {} };
  vm.runInNewContext(apiSource, { window, URL, AbortController, setTimeout, clearTimeout,
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) },
    CustomEvent: class {}, console: { log() {}, error() {} },
    fetch: async (url, options) => { requests.push({ url, options });
      return { ok: true, status: 200, text: async () => '{"ok":true,"logoutRequired":true}' }; },
  });
  const api = window.SoduWorkAPI;
  await api.clientLogin({ account: 'alice', password: 'same-fixture-password' });
  const replacing = api.clientLogin({ account: 'bob', password: 'same-fixture-password' });
  for (let n = 0; n < 30; n++) await Promise.resolve();
  assert.equal(loginStarted, true);
  // The original account remains visible until the other login completes.
  assert.equal(api.clientAuthSnapshot().user.id, 'alice');
  bridge.getHubConnection = () => { restorationStarted = true; return restoration.promise; };
  const pending = api.clientChangePassword({ currentPassword: 'same-fixture-password', newPassword: 'New-password-2026' });
  const rejected = assert.rejects(pending, { code: 'STALE_TASK_SCOPE' });
  for (let n = 0; n < 30; n++) await Promise.resolve();
  assert.equal(restorationStarted, true);
  login.resolve(session('bob')); await replacing;
  assert.equal(api.clientAuthSnapshot().user.id, 'bob');
  restoration.resolve({ hub: api.hubBase(), editable: true }); await rejected;
  assert.equal(requests.length, 0, 'The stale password proof must be rejected before an authenticated HTTP write');
});
