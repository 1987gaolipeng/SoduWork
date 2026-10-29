'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../components/client-auth/account-center.js'), 'utf8');
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };

// Only the DOM and network boundaries are replaced; the production account
// center owns the click handlers, row removal and asynchronous rendering.
class Element {
  constructor(kind) {
    this.kind = kind; this.dataset = {}; this.children = [];
    this.selectors = new Map(); this.listeners = new Map();
    this.disabled = false; this.textContent = '';
  }
  set innerHTML(value) {
    this.children = []; this.selectors.clear();
    if (this.kind === 'content') {
      this.selectors.set('.ac-status', new Element('status'));
      if (value.includes('ac-device-list')) this.selectors.set('.ac-device-list', new Element('list'));
      for (const attribute of ['data-email-change', 'data-password-change', 'data-logout']) {
        if (value.includes(attribute)) this.selectors.set('[' + attribute + ']', new Element('button'));
      }
    }
    if (this.kind === 'row' && value.includes('data-device-remove')) {
      this.selectors.set('[data-device-remove]', new Element('button'));
    }
  }
  querySelector(selector) { return this.selectors.get(selector) || null; }
  querySelectorAll(selector) {
    const descendants = [...this.children, ...this.selectors.values()];
    return descendants.flatMap(child => [
      ...(selector === '[data-device-id]' && child.dataset.deviceId !== undefined ? [child] : []),
      ...(selector === '[data-tab]' && child.dataset.tab !== undefined ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  appendChild(child) { child.parent = this; this.children.push(child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute() {}
  addEventListener(name, listener) { this.listeners.set(name, listener); }
}

async function fixture({ delayedRemoval } = {}) {
  const content = new Element('content'), mask = new Element('mask');
  mask.selectors.set('.ac-center-content', content);
  const tabs = new Map(['security', 'devices', 'privacy'].map(tab => {
    const button = new Element('button'); button.dataset.tab = tab; mask.appendChild(button); return [tab, button];
  }));
  let user = { id: 'fixture-user', username: 'fixture', hasPassword: true };
  let devices = [
    { id: 'current', name: 'Current computer', platform: 'Windows', current: true, active: true },
    { id: 'first', name: 'First computer', platform: 'Windows', current: false, active: true },
    { id: 'second', name: 'Second computer', platform: 'macOS', current: false, active: true },
  ];
  let reads = 0;
  const refreshes = [];
  const pendingRemovals = new Map();
  const api = {
    clientAuthSnapshot: () => ({ user }), hubBase: () => 'http://fixture.invalid',
    clientAuthMe: async () => ({ user }),
    async clientAccountRequest(operation, payload) {
      if (operation === 'devices') {
        const items = devices.map(device => ({ ...device }));
        if (++reads === 1) return { items };
        return new Promise((resolve, reject) => refreshes.push({ resolve: () => resolve({ items }), reject }));
      }
      if (operation === 'revokeDevice') {
        assert.equal(payload.verificationToken, 'fixture-devices-token');
        if (payload.deviceId === delayedRemoval) {
          await new Promise(resolve => pendingRemovals.set(payload.deviceId, resolve));
        }
        devices = devices.filter(device => device.id !== payload.deviceId);
        return { ok: true, logoutRequired: false };
      }
      throw Error('Unexpected account operation: ' + operation);
    },
  };
  const window = {
    SoduWorkAPI: api,
    AccountUI: { esc: String, check: result => result, error: error => error.message,
      modal: () => ({ mask, active: () => true, close() {} }) },
    AccountVerification: { verify: async () => 'fixture-devices-token' },
    addEventListener() {}, removeEventListener() {},
  };
  vm.runInNewContext(source, {
    window, document: { body: {}, getElementById: () => null, createElement: () => new Element('row') },
  });
  window.AccountCenter.open('devices'); await flush();
  const rows = () => content.querySelector('.ac-device-list').children;
  return {
    refreshes,
    finishRemoval: id => pendingRemovals.get(id)(),
    changeTab: async tab => { tabs.get(tab).onclick(); await flush(); },
    switchAccount: () => { user = { id: 'another-fixture-user' }; },
    ids: () => rows().map(row => row.dataset.deviceId),
    status: () => content.querySelector('.ac-status').textContent,
    remove: id => rows().find(row => row.dataset.deviceId === id).querySelector('[data-device-remove]').onclick(),
  };
}

test('late device refresh cannot restore a second device deleted by a newer operation', async () => {
  const f = await fixture();
  const first = f.remove('first'); await flush();
  const second = f.remove('second'); await flush();
  assert.equal(f.refreshes.length, 2);
  f.refreshes[1].resolve(); await second;
  assert.deepEqual(f.ids(), ['current']);
  f.refreshes[0].resolve(); await first;
  assert.deepEqual(f.ids(), ['current'], 'Older list snapshot must not restore the deleted second device');
});

test('late device refresh failure cannot replace the successful newer deletion status', async () => {
  const f = await fixture();
  const first = f.remove('first'); await flush();
  const second = f.remove('second'); await flush();
  assert.equal(f.refreshes.length, 2);
  f.refreshes[1].resolve(); await second;
  const latestStatus = f.status();
  assert.match(latestStatus, /已删除/);
  f.refreshes[0].reject(Error('Older device refresh failed')); await first;
  assert.deepEqual(f.ids(), ['current']);
  assert.equal(f.status(), latestStatus, 'A superseded refresh failure must not overwrite the latest success');
});

test('confirmed deletion removes a row replaced by another refresh even if its own refresh fails', async () => {
  const f = await fixture({ delayedRemoval: 'second' });
  const first = f.remove('first'); await flush();
  const second = f.remove('second'); await flush();
  assert.equal(f.refreshes.length, 1, 'Second removal is still waiting for the server');
  f.refreshes[0].resolve(); await first;
  assert.deepEqual(f.ids(), ['current', 'second'], 'The earlier refresh replaced the original device rows');
  f.finishRemoval('second'); await flush();
  assert.equal(f.refreshes.length, 2);
  f.refreshes[1].reject(Error('Latest device refresh failed')); await second;
  assert.match(f.status(), /设备已删除，刷新列表失败/);
  assert.deepEqual(f.ids(), ['current'], 'A confirmed deletion must remove the visible replacement row');
});

test('device revocation sends the device only in the route and a strict verification body', async () => {
  const apiSource = require('./renderer-source.cjs').readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');
  const requests = [], values = new Map(), window = {};
  vm.runInNewContext(apiSource, {
    window,
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) },
    User: { id: 'fixture-user' }, navigator: { platform: 'test' }, console: { log() {}, error() {} },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    FormData: class { append() {} }, WebSocket: class {}, setTimeout: () => 0, clearTimeout() {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, text: async () => '{"ok":true,"logoutRequired":false}' };
    },
  });
  await window.SoduWorkAPI.clientAccountRequest('revokeDevice', {
    deviceId: 'device/with space', verificationToken: 'fixture-devices-token',
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/client-auth\/me\/devices\/device%2Fwith%20space$/);
  assert.equal(requests[0].options.method, 'DELETE');
  assert.deepEqual(JSON.parse(requests[0].options.body), { verificationToken: 'fixture-devices-token' });
});

test('confirmed deletion updates the device tab reopened while its request was pending', async () => {
  const f = await fixture({ delayedRemoval: 'second' });
  const pending = f.remove('second'); await flush();
  await f.changeTab('security'); await f.changeTab('devices');
  assert.equal(f.refreshes.length, 1);
  f.refreshes[0].resolve(); await flush();
  assert.deepEqual(f.ids(), ['current', 'first', 'second']);
  f.finishRemoval('second'); await flush();
  if (f.refreshes.length > 1) f.refreshes[1].resolve();
  await pending;
  assert.deepEqual(f.ids(), ['current', 'first'], 'Reopening the same account must not lose a confirmed deletion');
});

test('late deletion completion cannot mutate a replacement account scope', async () => {
  const f = await fixture({ delayedRemoval: 'second' });
  const pending = f.remove('second'); await flush();
  f.switchAccount(); f.finishRemoval('second'); await pending;
  assert.equal(f.refreshes.length, 0, 'Old deletion must not reload devices under the new account');
  assert.deepEqual(f.ids(), ['current', 'first', 'second'], 'Old deletion must not touch a replacement account view');
});
