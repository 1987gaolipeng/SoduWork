'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/compose-execution.js'), 'utf8');
function fixture(send) {
  const messages = [], inputs = [], opened = [];
  let runtime = 'pi';
  const ctx = { window: null, crypto: { randomUUID: () => 'request1' }, petSay: text => messages.push(text),
    ComposeRuntime: { ready: async () => true, value: () => runtime },
    ComposeModelPicker: { ready: async () => true, value: () => ({ modelName: 'model' }) },
    soduWorkAPI: { conversationSession: { cloud: { start: async input => { inputs.push(input); return send(input); } } } },
    NativeChat: { enter: async (...args) => { opened.push(args); return true; } } };
  ctx.window = ctx; vm.runInNewContext(source, ctx);
  return { start: ctx.ComposeExecution.start, messages, inputs, opened, ctx,
    setRuntime: value => { runtime = value; } };
}
const input = { text: 'Make a report', attachments: [], skills: [], plugins: [] };
test('retry retains the first request identity and opens the remote chat without sending the prompt twice', async () => {
  let count = 0;
  const f = fixture(() => ++count === 1 ? { ok: false, reason: 'network' } : { ok: true, sessionId: 'cloud1' });
  assert.equal(await f.start(input), false); assert.equal(await f.start(input), true);
  assert.equal(f.inputs[0].requestId, f.inputs[1].requestId);
  assert.deepEqual(f.opened, [['', 'cloud1']]);
});
test('double-clicking while sending cannot create two cloud tasks', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const first = f.start(input);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(await f.start(input), false); assert.equal(f.inputs.length, 1);
  finish({ ok: true, sessionId: 'cloud1' }); assert.equal(await first, true);
});
test('unsupported local selections remain unsent and a completed request cannot steal another open conversation', async () => {
  const f = fixture(() => ({ ok: true, sessionId: 'cloud1' }));
  assert.equal(await f.start({ ...input, skills: ['local'] }), false);
  assert.equal(f.inputs.length, 0);
  assert.equal(await f.start({ ...input, isCurrent: () => false }), false);
  assert.equal(f.opened.length, 0); assert.equal(f.inputs.length, 0);
  let current = true;
  const other = fixture(() => { current = false; return { ok: true, sessionId: 'cloud1' }; });
  assert.equal(await other.start({ ...input, isCurrent: () => current }), false);
  assert.equal(other.opened.length, 0); assert.match(other.messages.at(-1), /历史会话/);
});

test('preparation and availability changes are checked before dispatching captured text', async () => {
  const f = fixture(() => ({ ok: true, sessionId: 'cloud1' }));
  let available = false, probes = 0, current = true;
  f.ctx.ComposeRuntime.refreshAccess = async () => { probes++; };
  f.ctx.ComposeRuntime.ready = async () => available;
  assert.equal(await f.start(input), false); available = true;
  assert.equal(await f.start(input), true); assert.equal(probes, 2);
  assert.equal(await f.start({ ...input, isCurrent: () => current, prepare: async () => { current = false; return input; } }), false);
  assert.equal(f.inputs.length, 1);
  current = true;
  assert.equal(await f.start({ ...input, prepare: async () => ({ ...input, plugins: ['pending-plugin'] }) }), false);
  assert.equal(f.inputs.length, 1);
});

test('cloud Harness auto-selection during availability probing is sent with the effective Harness', async () => {
  const f = fixture(() => ({ ok: true, sessionId: 'cloud-qwen' }));
  f.ctx.ComposeRuntime.setLocation = () => {};
  f.setRuntime('pi');
  f.ctx.ComposeRuntime.refreshAccess = async () => {
    await Promise.resolve();
    f.setRuntime('qwen');
  };
  f.ctx.ComposeRuntime.ready = async () => true;
  // Drive the public location control so the test covers the same path as the
  // composer instead of mutating a private execution variable. The runtime
  // changes only when the availability probe below resolves.
  let clicked;
  const menu = { addEventListener: (_kind, callback) => { clicked = callback; }, querySelectorAll: () => [], querySelector: () => null, classList: { remove() {} } };
  const host = { addEventListener: (_kind, callback) => { clicked = callback; }, querySelectorAll: () => [], contains: () => true, querySelector: selector => selector === '#cpMorePop' ? menu : selector === '.cp-box' ? {} : null };
  f.ctx.document = { createElement: () => host };
  f.ctx.ComposeExecution.bind(host, () => {});
  clicked({ target: { closest: selector => selector === '[data-execution]' ? { dataset: { execution: 'cloud' } } : null } });
  assert.equal(f.ctx.ComposeExecution.value(), 'cloud');
  assert.equal(await f.start(input), true);
  assert.equal(f.inputs[0].agentId, 'qwen');
});

test('cloud unavailability keeps its actionable diagnostic instead of replacing it with a generic error', async () => {
  const f = fixture(() => ({ ok: true, sessionId: 'cloud1' }));
  f.ctx.ComposeRuntime.ready = async () => false;
  f.ctx.ComposeRuntime.availability = () => ({ ok: false, reason: '执行机已暂停接单，请管理员恢复接单' });
  assert.equal(await f.start(input), false);
  assert.match(f.messages.at(-1), /暂停接单/);
  assert.equal(f.inputs.length, 0);
});

test('switching account during preparation never dispatches the old draft as the new account', async () => {
  const f = fixture(() => ({ ok: true, sessionId: 'cloud1' })); let owner = 'account-a';
  f.ctx.SoduWorkAPI = { taskStorageKey: () => owner };
  assert.equal(await f.start({ ...input, prepare: async () => { owner = 'account-b'; return input; } }), false);
  assert.equal(f.inputs.length, 0); assert.equal(f.opened.length, 0);
});

test('a receipt from the previous account cannot open a view in the new account or block its next request', async () => {
  let finish, owner = 'account-a', serial = 0;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.ctx.SoduWorkAPI = { taskStorageKey: () => owner };
  f.ctx.crypto.randomUUID = () => 'request-' + ++serial;
  const first = f.start(input);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  owner = 'account-b'; finish({ ok: true, sessionId: 'cloud-a' });
  assert.equal(await first, false); assert.equal(f.opened.length, 0);
  assert.match(f.messages.at(-1), /原账号/);
  const second = f.start(input);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.notEqual(f.inputs[0].requestId, f.inputs[1].requestId);
  finish({ ok: true, sessionId: 'cloud-b' }); assert.equal(await second, true);
  assert.deepEqual(f.opened, [['', 'cloud-b']]);
});

test('real location controls version selection changes including local-cloud-local and resetting the draft', () => {
  const f = fixture(() => ({ ok: true, sessionId: 'cloud1' }));
  let clicked;
  const menu = { addEventListener: (_kind, callback) => { clicked = callback; }, querySelectorAll: () => [], querySelector: () => null, classList: { remove() {} } };
  const host = { addEventListener: (_kind, callback) => { clicked = callback; }, querySelectorAll: () => [], contains: () => true, querySelector: selector => selector === '#cpMorePop' ? menu : selector === '.cp-box' ? {} : null };
  f.ctx.document = { createElement: () => host };
  f.ctx.ComposeExecution.bind(host, () => {});
  const select = value => clicked({ target: { closest: selector => selector === '[data-execution]' ? { dataset: { execution: value } } : null } });
  const revision = f.ctx.ComposeExecution.revision();
  assert.equal(f.ctx.ComposeExecution.value(), 'local');
  select('local'); assert.equal(f.ctx.ComposeExecution.revision(), revision);
  select('cloud'); assert.equal(f.ctx.ComposeExecution.value(), 'cloud');
  select('cloud'); assert.equal(f.ctx.ComposeExecution.value(), 'cloud');
  assert.equal(f.ctx.ComposeExecution.revision(), revision + 1);
  select('local'); assert.equal(f.ctx.ComposeExecution.value(), 'local');
  assert.equal(f.ctx.ComposeExecution.revision(), revision + 2);
  f.ctx.ComposeExecution.reset(); assert.equal(f.ctx.ComposeExecution.revision(), revision + 3);
});
