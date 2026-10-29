'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const apiSource = fs.readFileSync(path.resolve(__dirname, '../api.js'), 'utf8');
const authSource = fs.readFileSync(path.resolve(__dirname, '../components/client-auth/client-auth.js'), 'utf8');

function fixture() {
  const values = new Map([['soduwork_work_hub_environment_v1', 'production'], ['soduwork_work_user_id', 'logout-device']]);
  const alerts = [], reloads = [];
  let notify, finishLogout, nextUser = 'alice';
  // The account-center security action is a plain text button (no nested span).
  // Keep the fixture shaped like the shipped markup so confirmation exercises
  // the real logout path instead of masking a null label lookup.
  const button = { disabled: false, textContent: '\u9000\u51fa\u767b\u5f55', querySelector: () => null };
  const window = {
    confirm: () => true, alert: message => alerts.push(message),
    location: { reload: () => reloads.push(true) }, dispatchEvent() {},
    soduWorkAPI: {
      deviceAuthLogin: async () => ({ ok: true, clientId: 'logout-device', session: 'test-' + nextUser,
        expiresIn: 600, user: { id: nextUser } }),
      deviceAuthLogout: () => new Promise(resolve => { finishLogout = resolve; }),
      deviceAuthClearSession: async () => ({ ok: true }),
      onAccountSessionChanged: callback => { notify = callback; },
      configureRunner: async () => ({ ok: true }),
      getAppVersion: async () => 'test', getSysInfo: async () => ({}),
    },
  };
  const context = vm.createContext({ window, URL, AbortController, setTimeout, clearTimeout, Intl, console,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    document: { readyState: 'loading', addEventListener() {},
      documentElement: { classList: { add() {} } }, querySelector: () => button },
  });
  vm.runInContext(apiSource, context); vm.runInContext(authSource, context);
  const api = window.SoduWorkAPI;
  return { api, auth: window.ClientAuth, alerts, reloads, button,
    async login(id) { nextUser = id; return api.clientLogin({ account: id, password: 'fixture-only' }); },
    notifyLogout() { notify({ hub: api.hubBase(), clientId: api.clientAuthSnapshot().clientId }); },
    finish(result) { finishLogout(result); },
  };
}

for (const result of [{ ok: true }, { ok: false, error: 'offline response' }]) {
  test('logout notification owns navigation before the late ' + (result.ok ? 'success' : 'failure'), async () => {
    const f = fixture(); await f.login('alice');
    const pending = f.auth.logout();
    f.notifyLogout();
    assert.equal(f.api.clientAuthSnapshot().user, null);
    assert.equal(f.reloads.length, 1);
    f.finish(result); await pending;
    assert.equal(f.alerts.length, 0, 'A stale response cannot block the pending reload with an alert');
    assert.equal(f.reloads.length, 1, 'The old request cannot navigate a second time');
  });
}

test('a late logout result cannot clear or reload the next signed-in account', async () => {
  const f = fixture(); await f.login('alice');
  const pending = f.auth.logout();
  f.notifyLogout(); await f.login('bob');
  const scope = f.api.taskStorageKey('ops');
  f.finish({ ok: true }); await pending;
  assert.equal(f.api.clientAuthSnapshot().user.id, 'bob');
  assert.equal(f.api.clientAuthSnapshot().state, 'active');
  assert.equal(f.api.taskStorageKey('ops'), scope);
  assert.equal(f.reloads.length, 1); assert.equal(f.alerts.length, 0);
});

test('an unchanged logout failure remains visible and restores the button', async () => {
  const f = fixture(); await f.login('alice');
  const pending = f.auth.logout(); f.finish({ ok: false, error: '服务暂不可用' }); await pending;
  assert.deepEqual(f.alerts, ['服务暂不可用']);
  assert.equal(f.button.disabled, false); assert.equal(f.reloads.length, 0);
  assert.equal(f.api.clientAuthSnapshot().user.id, 'alice');
});

test('a normal logout still clears its own identity and reloads', async () => {
  const f = fixture(); await f.login('alice');
  const pending = f.auth.logout(); f.finish({ ok: true }); await pending;
  assert.equal(f.api.clientAuthSnapshot().user, null);
  assert.equal(f.reloads.length, 1); assert.equal(f.alerts.length, 0);
});

test('logout asks through AccountUI.modal and only invokes clientLogout after confirmation', () => {
  assert.match(authSource, /AccountUI\.modal/);
  assert.match(authSource, /clientLogout\(\)/);
  assert.doesNotMatch(authSource, /global\.confirm\(/);
});
