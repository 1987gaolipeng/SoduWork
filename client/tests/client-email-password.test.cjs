'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../components/client-auth/client-auth.js'), 'utf8');

class Element {
  constructor() {
    this.value = ''; this.textContent = ''; this.disabled = false; this.hidden = false;
    this.type = 'password'; this.style = {}; this.listeners = new Map(); this.nodes = new Map();
    const classes = new Set();
    this.classList = { add: value => classes.add(value), remove: value => classes.delete(value),
      contains: value => classes.has(value), toggle(value, on) { if (on) classes.add(value); else classes.delete(value); } };
  }
  querySelector(selector) { if (!this.nodes.has(selector)) this.nodes.set(selector, new Element()); return this.nodes.get(selector); }
  set innerHTML(html) {
    const title = /id="soduworkPwdTitle">([^<]+)/.exec(html);
    if (title) this.querySelector('#soduworkPwdTitle').textContent = title[1];
  }
  querySelectorAll() { return []; }
  closest(selector) { return this.querySelector('closest:' + selector); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  fire(name, extras) { return this.listeners.get(name)?.({ preventDefault() {}, ...extras }); }
  setAttribute() {}
  focus() { this.focused = true; }
  reset() {}
}

function deferred() {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(profile = {}) {
  let user = { id: 'alice', email: 'alice@example.test', emailVerified: true, hasPassword: true, ...profile };
  let hub = 'http://fixture.invalid', clientId = 'fixture-device';
  const timers = [], calls = [], events = new Map(), masks = [];
  const document = { readyState: 'loading', documentElement: new Element(), body: { appendChild: node => masks.push(node) },
    addEventListener() {}, getElementById: () => null, querySelectorAll: () => [],
    createElement: () => new Element() };
  const api = {
    hubBase: () => hub, clientAuthSnapshot: () => ({ user, clientId }),
    async clientChangePassword(payload) { calls.push({ operation: 'change', payload }); return { ok: true }; },
    async clientLogout() { calls.push({ operation: 'logout', owner: user?.id }); user = null; return { ok: true }; },
  };
  const window = { SoduWorkAPI: api, SoduWorkI18n: { translateText: String, t: (_key, fallback) => fallback },
    AccountVerification: { async verify(purpose, current) {
      calls.push({ operation: 'verify', purpose, owner: current.id }); return 'one-use-email-proof';
    } }, location: { reload() { calls.push({ operation: 'reload' }); } },
    addEventListener(name, callback) { if (!events.has(name)) events.set(name, []); events.get(name).push(callback); } };
  vm.runInNewContext(source, { window, document, Intl,
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.cancelled = true; } });
  const auth = window.ClientAuth;
  auth.updateIdentity(user);
  const open = () => { auth.changePassword(); return masks[0]; };
  open();
  const mask = masks[0];
  return { api, auth, calls, window, mask, open, timers,
    node: selector => mask.querySelector(selector),
    fill(password = 'New-password-2026', confirm = password) {
      mask.querySelector('#soduworkPwdNew').value = password; mask.querySelector('#soduworkPwdConfirm').value = confirm;
    },
    submit: () => mask.querySelector('form').fire('submit'),
    close: () => mask.querySelector('.soduwork-pwd-close').fire('click'),
    switchUser(id = 'bob') { user = { ...user, id }; },
    switchHub() { hub = 'http://second.invalid'; }, switchDevice() { clientId = 'second-device'; },
    async runSignOut() { for (const timer of timers.filter(row => row.delay === 1400 && !row.cancelled)) await timer.callback(); },
    event(name) { for (const callback of events.get(name) || []) callback({ detail: {} }); },
  };
}

test('verified-email accounts set a new password with email proof even when a password already exists', async () => {
  const f = fixture();
  assert.equal(f.node('[data-pwd-current]').hidden, true);
  assert.equal(f.node('#soduworkPwdCurrent').disabled, true);
  assert.equal(f.node('#soduworkPwdTitle').textContent, '设置新密码');
  f.fill(); await f.submit();
  assert.deepEqual(f.calls.map(row => row.operation), ['verify', 'change']);
  assert.equal(f.calls[0].purpose, 'change_password');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1].payload)), {
    newPassword: 'New-password-2026', verificationToken: 'one-use-email-proof',
  });
  assert.equal(f.node('.soduwork-pwd-formview').hidden, true);
  await f.runSignOut();
  assert.deepEqual(f.calls.map(row => row.operation), ['verify', 'change', 'logout', 'reload']);
});

test('passwordless email accounts use the same verified new-password path', async () => {
  const f = fixture({ hasPassword: false }); f.fill(); await f.submit();
  assert.deepEqual(f.calls.map(row => row.operation), ['verify', 'change']);
});

test('new-password validation runs before requesting an email identity proof', async () => {
  const f = fixture(); f.fill('short'); await f.submit();
  assert.equal(f.calls.length, 0); assert.match(f.node('.soduwork-pwd-msg').textContent, /至少/);
  f.fill('New-password-2026', 'Not-the-same-2026'); await f.submit();
  assert.equal(f.calls.length, 0); assert.match(f.node('.soduwork-pwd-msg').textContent, /不一致/);
});

for (const profile of [{ email: '' }, { emailVerified: false }, { emailVerified: undefined }]) {
  test('legacy accounts retain current-password verification: ' + JSON.stringify(profile), async () => {
    const f = fixture(profile); f.fill(); await f.submit();
    assert.equal(f.node('[data-pwd-current]').hidden, false);
    assert.equal(f.node('#soduworkPwdTitle').textContent, '修改密码');
    assert.equal(f.calls.length, 0); assert.match(f.node('.soduwork-pwd-msg').textContent, /当前密码/);
    f.node('#soduworkPwdCurrent').value = 'Old-password-2026'; await f.submit();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].operation, 'change');
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].payload)), {
      currentPassword: 'Old-password-2026', newPassword: 'New-password-2026',
    });
  });
}

for (const failure of ['cancel', 'proof', 'change']) {
  test(failure + ' failure retains the account and permits a retry', async () => {
    const f = fixture(); f.fill();
    if (failure === 'change') f.api.clientChangePassword = async () => { throw Error('服务暂不可用'); };
    else f.window.AccountVerification.verify = async () => { throw Object.assign(Error('身份验证失败'), { name: failure === 'cancel' ? 'AbortError' : 'Error' }); };
    await f.submit();
    assert.equal(f.api.clientAuthSnapshot().user.id, 'alice');
    assert.equal(f.node('.soduwork-pwd-submit').disabled, false);
    assert.equal(f.node('#soduworkPwdNew').value, 'New-password-2026');
    await f.runSignOut(); assert.equal(f.calls.some(row => row.operation === 'logout'), false);
    f.window.AccountVerification.verify = async () => 'retry-proof';
    f.api.clientChangePassword = async payload => { f.calls.push({ operation: 'change', payload }); return { ok: true }; };
    await f.submit(); assert.equal(f.calls.at(-1)?.payload?.verificationToken, 'retry-proof');
  });
}

test('duplicate submit cannot consume two proofs or issue two password changes', async () => {
  const f = fixture(), proof = deferred();
  f.window.AccountVerification.verify = () => proof.promise; f.fill();
  const first = f.submit(); await f.submit(); proof.resolve('single-proof'); await first;
  assert.equal(f.calls.filter(row => row.operation === 'change').length, 1);
});

for (const change of ['switchUser', 'switchHub', 'switchDevice', 'close']) {
  test('a proof finishing after ' + change + ' cannot submit a password change', async () => {
    const f = fixture(), proof = deferred(); let started = 0;
    f.window.AccountVerification.verify = () => { started++; return proof.promise; }; f.fill();
    const pending = f.submit(); assert.equal(started, 1);
    f[change](); proof.resolve('stale-proof'); await pending;
    assert.equal(f.calls.filter(row => row.operation === 'change').length, 0);
    await f.runSignOut(); assert.equal(f.calls.some(row => row.operation === 'logout'), false);
  });
}

test('an old verification failure cannot alter the reopened password dialog', async () => {
  const f = fixture(), proof = deferred(); let started = 0;
  f.window.AccountVerification.verify = () => { started++; return proof.promise; }; f.fill();
  const pending = f.submit(); assert.equal(started, 1);
  f.close(); f.open(); f.fill('Fresh-password-2026');
  proof.reject(Error('old request failed')); await pending;
  assert.equal(f.node('.soduwork-pwd-msg').textContent, '');
  assert.equal(f.node('#soduworkPwdNew').value, 'Fresh-password-2026');
});

test('a late password result cannot schedule logout of the replacement account', async () => {
  const f = fixture(), response = deferred(); let started = 0; f.fill();
  f.api.clientChangePassword = () => { started++; return response.promise; };
  const pending = f.submit(); await Promise.resolve(); await Promise.resolve();
  for (let n = 0; n < 10; n++) await Promise.resolve();
  assert.equal(started, 1);
  f.switchUser(); response.resolve({ ok: true }); await pending; await f.runSignOut();
  assert.equal(f.api.clientAuthSnapshot().user.id, 'bob');
  assert.equal(f.calls.some(row => row.operation === 'logout'), false);
});

test('delayed signout does not log out an account that replaced the successful change owner', async () => {
  const f = fixture(); f.fill(); await f.submit();
  assert.equal(f.timers.filter(row => row.delay === 1400).length, 1);
  f.switchUser(); await f.runSignOut();
  assert.equal(f.api.clientAuthSnapshot().user.id, 'bob');
  assert.equal(f.calls.some(row => row.operation === 'logout'), false);
});

test('a late logout response cannot reload a replacement account', async () => {
  const f = fixture(), response = deferred(); f.fill(); await f.submit();
  assert.equal(f.timers.filter(row => row.delay === 1400).length, 1);
  f.api.clientLogout = () => response.promise;
  const pending = f.runSignOut(); f.switchUser(); response.resolve({ ok: true }); await pending;
  assert.equal(f.calls.some(row => row.operation === 'reload'), false);
});

test('a detached or closed password form cannot restart a cancelled operation', async () => {
  const f = fixture(); f.fill(); f.close(); await f.submit();
  assert.equal(f.calls.length, 0);
});

test('its own logout scope event closes the password dialog and still returns to a fresh login page', async () => {
  const f = fixture(); f.fill(); await f.submit();
  const logout = f.api.clientLogout;
  f.api.clientLogout = async () => {
    const result = await logout(); f.event('soduwork-data-scope-changed'); return result;
  };
  await f.runSignOut();
  assert.equal(f.api.clientAuthSnapshot().user, null);
  assert.equal(f.mask.classList.contains('is-open'), false);
  assert.equal(f.calls.filter(row => row.operation === 'reload').length, 1,
    'Clearing the successfully changed account must not suppress its own login-page navigation');
});

for (const dismiss of ['close', 'reopen', 'scope-event']) {
  test('dismissing the successful dialog cannot cancel required signout: ' + dismiss, async () => {
    const f = fixture(); f.fill(); await f.submit();
    if (dismiss === 'scope-event') f.event('soduwork-data-scope-changed');
    else { f.close(); if (dismiss === 'reopen') f.open(); }
    await f.runSignOut();
    assert.equal(f.api.clientAuthSnapshot().user, null);
    assert.deepEqual(f.calls.slice(-2).map(row => row.operation), ['logout', 'reload']);
  });
}

test('a committed password response still signs out its owner after the dialog was dismissed', async () => {
  const f = fixture(), response = deferred(); f.fill();
  f.api.clientChangePassword = () => response.promise;
  const pending = f.submit();
  for (let n = 0; n < 10; n++) await Promise.resolve();
  f.close(); response.resolve({ ok: true }); await pending; await f.runSignOut();
  assert.equal(f.api.clientAuthSnapshot().user, null);
  assert.deepEqual(f.calls.slice(-2).map(row => row.operation), ['logout', 'reload']);
});

for (const replacement of ['switchHub', 'switchDevice']) {
  test('a required signout does not affect a replacement login scope: ' + replacement, async () => {
    const f = fixture(); f.fill(); await f.submit(); f.close(); f[replacement](); await f.runSignOut();
    assert.equal(f.api.clientAuthSnapshot().user.id, 'alice');
    assert.equal(f.calls.some(row => row.operation === 'logout'), false);
  });
}
