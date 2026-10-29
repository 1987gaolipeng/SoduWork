'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/client-auth/account-center.js'), 'utf8');
const flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
function node() {
  const children = new Map(), events = new Map();
  return { value: '', textContent: '', disabled: false, dataset: {}, setAttribute() {}, focus() {},
    querySelector(selector) { if (!children.has(selector)) children.set(selector, node()); return children.get(selector); },
    querySelectorAll() { return []; },
    addEventListener(name, fn) { events.set(name, fn); },
    fire(name) { return events.get(name)?.({ preventDefault() {} }); } };
}
async function fixture() {
  let user = { id: 'alice', username: 'alice', hasPassword: true }, hub = 'http://fixture.invalid';
  const dialogs = [], calls = [], reloads = [];
  let resolveProof, rejectProof, resolveLogout;
  const api = { hubBase: () => hub, clientAuthSnapshot: () => ({ user }), clientAuthMe: async () => ({ user }),
    clientAccountRequest: async (action, payload) => { calls.push({ action, payload }); return { ok: true }; },
    clientLogout: () => { calls.push({ action: 'logout' }); return new Promise(resolve => { resolveLogout = resolve; }); } };
  const ui = { esc: String, check(value) { if (value.ok === false) throw Error(value.error); return value; }, error: e => e.message,
    modal(_parent, _title, html, className) {
      const mask = node(); let active = true;
      const dialog = { mask, className, html, active: () => active, close() { active = false; mask.fire('ac-close'); } };
      dialogs.push(dialog); return dialog;
    } };
  const window = { SoduWorkAPI: api, AccountUI: ui,
    AccountVerification: { verify: () => { calls.push({ action: 'verify' }); return new Promise((resolve, reject) => { resolveProof = resolve; rejectProof = reject; }); } },
    addEventListener() {}, removeEventListener() {}, location: { reload: () => reloads.push(true) } };
  vm.runInNewContext(source, { window, document: { body: {}, getElementById: () => null, querySelector: () => null }, setTimeout, clearTimeout });
  window.AccountCenter.open('privacy'); await flush();
  const content = dialogs[0].mask.querySelector('.ac-center-content');
  content.querySelector('[data-delete]').onclick();
  const child = dialogs.at(-1), form = child.mask.querySelector('form');
  const input = form.querySelector('input'); input.value = '注销账号';
  // Both selectors refer to the real form's submit action.
  const query = form.querySelector.bind(form), submitButton = query('[type="submit"]');
  form.querySelector = selector => selector === 'button' ? submitButton : query(selector);
  return { api, calls, reloads, child, form, input, submitButton, content, closeCenter: () => dialogs[0].close(),
    submit: () => form.onsubmit({ preventDefault() {} }),
    proof: () => resolveProof('one-use-delete-token'), cancelProof: () => rejectProof(Object.assign(Error('已取消'), { name: 'AbortError' })),
    finishLogout: result => resolveLogout(result), switchUser: () => { user = { id: 'bob' }; }, switchHub: () => { hub = 'http://second.invalid'; } };
}

test('deletion requires exact confirmation and prevents duplicate verification submissions', async () => {
  const f = await fixture(); f.input.value = '错误确认'; await f.submit();
  assert.equal(f.calls.some(c => c.action === 'verify'), false);
  f.input.value = '注销账号'; const first = f.submit(); const second = f.submit();
  assert.equal(f.calls.filter(c => c.action === 'verify').length, 1);
  f.cancelProof(); await Promise.all([first, second]);
  assert.equal(f.submitButton.disabled, false);
  assert.equal(f.calls.some(c => c.action === 'deletion'), false);
});
test('closing the confirmation while identity proof is pending cannot delete the account', async () => {
  const f = await fixture(), pending = f.submit(); f.child.close(); f.proof(); await pending;
  assert.equal(f.calls.some(c => c.action === 'deletion'), false);
});
test('server rejection leaves confirmation editable and makes the reason visible for retry', async () => {
  const f = await fixture(); f.api.clientAccountRequest = async () => ({ ok: false, error: '请先停止或移交正在执行的任务' });
  const pending = f.submit(); f.proof(); await pending;
  assert.match(f.form.querySelector('.ac-status').textContent, /移交/);
  assert.equal(f.submitButton.disabled, false); assert.equal(f.input.disabled, false);
  assert.equal(f.child.active(), true); assert.equal(f.calls.some(c => c.action === 'logout'), false);
});
for (const change of ['switchUser', 'switchHub']) test('late deletion signout never reloads a new scope after ' + change, async () => {
  const f = await fixture(), pending = f.submit(); f.proof(); await flush();
  assert.equal(f.calls.filter(c => c.action === 'deletion').length, 1);
  assert.equal(f.calls.filter(c => c.action === 'logout').length, 1);
  f[change](); f.finishLogout({ ok: true }); await pending;
  assert.equal(f.reloads.length, 0);
});
test('accepted deletion clears its own session and returns to login', async () => {
  const f = await fixture(), pending = f.submit(); f.proof(); await flush();
  f.finishLogout({ ok: true }); await pending;
  assert.equal(f.reloads.length, 1); assert.equal(f.child.active(), false);
});
test('an accepted deletion still signs out when the account page closes during the HTTP request', async () => {
  const f = await fixture(); let finishDeletion;
  f.api.clientAccountRequest = () => new Promise(resolve => { finishDeletion = resolve; });
  const pending = f.submit(); f.proof(); await flush();
  f.closeCenter(); finishDeletion({ ok: true, logoutRequired: true }); await flush();
  assert.equal(f.calls.filter(c => c.action === 'logout').length, 1);
  f.finishLogout({ ok: true }); await pending; assert.equal(f.reloads.length, 1);
});
