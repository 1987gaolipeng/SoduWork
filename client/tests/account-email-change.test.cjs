'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/client-auth/account-center.js'), 'utf8');
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
function element() {
  const children = new Map(), events = new Map();
  return { value: '', textContent: '', disabled: false, dataset: {}, setAttribute() {}, focus() {},
    querySelector(selector) { if (!children.has(selector)) children.set(selector, element()); return children.get(selector); },
    querySelectorAll() { return []; }, addEventListener(name, callback) { events.set(name, callback); },
    fire(name) { return events.get(name)?.({ preventDefault() {} }); } };
}
async function fixture() {
  let user = { id: 'email-owner', username: 'original@example.test', email: 'original@example.test', emailVerified: true, hasPassword: true };
  let hub = 'http://fixture.invalid', finishProof, failProof, finishChange, failChange;
  const dialogs = [], calls = [], reloads = [];
  const api = { hubBase: () => hub, clientAuthSnapshot: () => ({ user }), clientAuthMe: async () => ({ user }),
    async clientAccountRequest(operation, payload) {
      calls.push({ operation, payload });
      if (operation === 'challenge') return { challengeId: 'new-mailbox-challenge', retryAfter: 60 };
      if (operation === 'email') return new Promise((resolve, reject) => { finishChange = resolve; failChange = reject; });
      throw Error('Unexpected operation ' + operation);
    },
    async clientLogout() { calls.push({ operation: 'logout' }); user = null; return { ok: true }; } };
  const window = { SoduWorkAPI: api,
    AccountUI: { esc: String, email: value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value), code: value => /^\d{6}$/.test(value),
      check(result) { if (result.ok === false) throw Error(result.error); return result; }, error: error => error.message,
      modal(_parent, _title, _html, className) { const mask = element(); let active = true;
        const dialog = { mask, className, active: () => active, close() { active = false; mask.fire('ac-close'); } };
        dialogs.push(dialog); return dialog; } },
    AccountVerification: { verify(purpose) { calls.push({ operation: 'verify', purpose }); return new Promise((resolve, reject) => { finishProof = resolve; failProof = reject; }); } },
    addEventListener() {}, removeEventListener() {}, location: { reload: () => reloads.push(true) } };
  vm.runInNewContext(source, { window, document: { body: {}, getElementById: () => null, querySelector: () => null },
    setInterval: () => 1, clearInterval() {} });
  window.AccountCenter.open('security'); await flush();
  dialogs[0].mask.querySelector('.ac-center-content').querySelector('[data-email-change]').onclick();
  const child = dialogs.at(-1), form = child.mask.querySelector('form');
  const email = form.querySelector('[name="email"]'), code = form.querySelector('[name="code"]');
  const send = form.querySelector('[data-send]'), button = form.querySelector('[type="submit"]');
  async function prepare() { email.value = 'new@example.test'; await send.onclick(); code.value = '123456'; }
  return { calls, reloads, child, form, email, code, send, button, prepare,
    submit: () => form.onsubmit({ preventDefault() {} }), proof: () => finishProof('email-change-grant'),
    cancelProof: () => failProof(Object.assign(Error('Cancelled'), { name: 'AbortError' })),
    finish: () => finishChange({ ok: true, logoutRequired: true }), reject: () => failChange(Error('Code rejected')),
    closeCenter: () => dialogs[0].close(), changeOwner: () => { user = { id: 'replacement-owner' }; },
    changeHub: () => { hub = 'http://replacement.invalid'; },
    status: () => form.querySelector('.ac-status').textContent };
}
test('email replacement requires a challenge for the exact submitted new address', async () => {
  const f = await fixture(); f.email.value = 'invalid'; await f.send.onclick();
  assert.equal(f.calls.length, 0); await f.prepare(); f.email.value = 'other@example.test'; await f.submit();
  assert.equal(f.calls.some(call => call.operation === 'verify'), false);
});
test('email replacement sends both the new-mailbox code and current-account proof', async () => {
  const f = await fixture(); await f.prepare(); const pending = f.submit(); f.proof(); await flush();
  const change = f.calls.find(call => call.operation === 'email');
  assert.deepEqual(JSON.parse(JSON.stringify(change.payload)), { email: 'new@example.test', code: '123456', challengeId: 'new-mailbox-challenge', verificationToken: 'email-change-grant' });
  assert.equal(f.calls.find(call => call.operation === 'verify').purpose, 'change_email');
  f.finish(); await pending; assert.equal(f.reloads.length, 1);
});
test('closing email replacement before identity verification cannot send the mutation', async () => {
  const f = await fixture(); await f.prepare(); const pending = f.submit(); f.child.close(); f.proof(); await pending;
  assert.equal(f.calls.some(call => call.operation === 'email'), false);
});
test('rejected email replacement preserves the session and an editable dialog', async () => {
  const f = await fixture(); await f.prepare(); const pending = f.submit(); f.proof(); await flush(); f.reject(); await pending;
  assert.equal(f.child.active(), true); assert.equal(f.button.disabled, false); assert.match(f.status(), /Code rejected/);
  assert.equal(f.calls.some(call => call.operation === 'logout'), false); assert.equal(f.reloads.length, 0);
});
test('a committed email replacement still signs out when the account page closes during HTTP', async () => {
  const f = await fixture(); await f.prepare(); const pending = f.submit(); f.proof(); await flush();
  f.closeCenter(); f.finish(); await pending;
  assert.equal(f.calls.filter(call => call.operation === 'logout').length, 1); assert.equal(f.reloads.length, 1);
});
for (const change of ['changeOwner', 'changeHub']) test('a late email replacement never signs out a new scope after ' + change, async () => {
  const f = await fixture(); await f.prepare(); const pending = f.submit(); f.proof(); await flush(); f[change](); f.finish(); await pending;
  assert.equal(f.calls.some(call => call.operation === 'logout'), false); assert.equal(f.reloads.length, 0);
});
