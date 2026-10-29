'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const rules = require('../main/access-control/policy');
const { create } = require('../main/access-control/pi-transition');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let n = 0; n < 300; n++) { const value = check(); if (value) return value; await delay(10); } throw Error('Timed out'); }

test('permission change IPC enforces owner, revision, full consent and cancellation', async () => {
  let current = null, next = null, response = 0, consent = 0, writes = 0, duringDialog;
  const handle = { cwd: os.tmpdir(), attachedWindow: { webContents: { id: 2 } },
    snapshot: () => ({ accessPolicy: current, nextAccessPolicy: next,
      accessControl: { supported: true, schema: rules.SCHEMA, modes: [...rules.MODES], canChangeDuringSession: true } }),
    setAccessPolicy(value, expected) { rules.next(value.mode, this.cwd, next || current, expected); next = value; writes++; return { ok: true }; } };
  const change = require('../main/access-control/ipc').changeHandler({ session: { get: () => handle },
    BrowserWindow: { fromWebContents: () => handle.attachedWindow },
    confirmFullAccess: async () => { consent++; await duringDialog?.(); return response === 1; } });
  assert.equal((await change({ sender: { id: 3 } }, 'chat', 'standard', 0)).ok, false);
  assert.equal((await change({}, 'chat', 'standard', 0)).ok, false);
  assert.equal((await change({ sender: { id: 2 } }, 'chat', 'full', 0)).cancelled, true);
  assert.equal(writes, 0);
  response = 1;
  let result = await change({ sender: { id: 2 } }, 'chat', 'full', 0);
  assert.equal(result.effective, 'next-turn'); assert.equal(result.accessPolicy, null);
  assert.equal(result.nextAccessPolicy.mode, 'full'); assert.equal(next.revision, 1);
  assert.equal((await change({ sender: { id: 2 } }, 'chat', 'readonly', 0)).ok, false);
  assert.equal((await change({ sender: { id: 2 } }, 'chat', 'readonly', 1)).ok, true);
  duringDialog = () => { next = rules.next('standard', handle.cwd, next, 2); };
  result = await change({ sender: { id: 2 } }, 'chat', 'full', 2);
  assert.equal(result.ok, false); assert.equal(next.mode, 'standard'); assert.equal(writes, 2);
  assert.equal(consent, 3);
  duringDialog = () => { handle.attachedWindow = null; };
  assert.equal((await change({ sender: { id: 2 } }, 'chat', 'full', 3)).ok, false);
});

test('real Pi SDK transitions keep history, defer an active turn, enforce downgrade and retire old approvals', { timeout: 40000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-access-transition-'));
  const fixture = await require('../e2e/fixtures/access-sdk.cjs').create(root, 'standard', () => {}, { persist: true });
  let live = { session: fixture.session, access: fixture.access, policy: fixture.access.policy };
  const remembered = [];
  const transitions = create({ cwd: fixture.workspace, current: () => live,
    prepare: (policy, previous) => fixture.rebuild(policy, previous), commit: next => { live = next; },
    rememberDefault: mode => remembered.push(mode) });
  t.after(async () => { transitions.close(); live.access.broker.close(); await live.session.abort(); live.session.dispose(); await fixture.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const send = (tool, args) => live.session.prompt(JSON.stringify({ tool, args }));
  const sid = live.session.sessionId, manager = live.session.sessionManager;
  await send('write', { path: 'first.txt', content: 'history' });
  const firstHistoryCount = live.session.state.messages.length;
  const outside = path.join(root, 'outside.txt');
  const oldAccess = live.access;
  const active = send('write', { path: outside, content: 'current turn' });
  const request = await until(() => oldAccess.broker.pending()[0]);
  const readonly = rules.next('readonly', fixture.workspace, live.policy, 1);
  transitions.schedule(readonly, 1);
  assert.equal(live.policy.mode, 'standard'); assert.equal(oldAccess.broker.pending().length, 1);
  oldAccess.broker.answer({ ...request, decision: 'deny' }); await active;
  assert.equal(fs.existsSync(outside), false);
  await transitions.apply();
  assert.deepEqual(remembered, ['readonly']);
  assert.equal(live.session.sessionId, sid); assert.equal(live.session.sessionManager, manager);
  assert.ok(live.session.state.messages.length > firstHistoryCount);
  assert.equal(live.policy.mode, 'readonly'); assert.equal(transitions.pending(), null);
  assert.equal(oldAccess.broker.answer({ ...request, decision: 'once' }).ok, false);
  await send('write', { path: 'blocked.txt', content: 'must not write' });
  assert.equal(fs.existsSync(path.join(fixture.workspace, 'blocked.txt')), false);
  const extensionCalls = path.join(root, 'extension-calls.txt');
  fs.mkdirSync(path.join(root, 'extensions'));
  fs.writeFileSync(path.join(root, 'extensions', 'fixture.ts'),
    'import fs from "node:fs"; export default function(pi){ pi.on("tool_call",()=>{fs.appendFileSync(' + JSON.stringify(extensionCalls) + ',"called\\n");}); }');
  const full = rules.next('full', fixture.workspace, live.policy, 2);
  transitions.schedule(full, 2); await transitions.apply();
  assert.deepEqual(remembered, ['readonly', 'full']);
  await send('write', { path: outside, content: 'full consent' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'full consent');
  assert.ok(live.resources.resourceLoader.getExtensions().extensions.length > 0);
  const callsBeforeDowngrade = fs.readFileSync(extensionCalls, 'utf8');
  const standard = rules.next('standard', fixture.workspace, live.policy, 3);
  transitions.schedule(standard, 3); await transitions.apply();
  assert.deepEqual(remembered, ['readonly', 'full', 'standard']);
  assert.deepEqual(live.resources.resourceLoader.getExtensions().extensions
    .filter(extension => !extension.hidden || extension.path !== '<inline:soduwork-tool-context>'), [],
  'only the SoduWork-owned context hook remains; disk extensions stay unloaded');
  const waiting = send('write', { path: outside, content: 'new approval required' });
  const fresh = await until(() => live.access.broker.pending()[0]);
  assert.equal(fresh.policyRevision, 4);
  live.access.broker.answer({ ...fresh, decision: 'deny' }); await waiting;
  assert.equal(fs.readFileSync(outside, 'utf8'), 'full consent');
  await send('write', { path: 'last.txt', content: 'normal again' });
  assert.equal(fs.readFileSync(path.join(fixture.workspace, 'last.txt'), 'utf8'), 'normal again');
  assert.equal(fs.readFileSync(extensionCalls, 'utf8'), callsBeforeDowngrade, 'full-mode extension hooks must not survive a downgrade');
  const reopen = fixture.sdk.SessionManager.open(manager.getSessionFile());
  const persisted = reopen.getEntries().filter(row => row.type === 'custom' && row.customType === 'soduwork.access.policy').at(-1).data;
  assert.equal(persisted.mode, 'standard'); assert.equal(persisted.revision, 4);
  assert.ok(reopen.getEntries().filter(row => row.type === 'message').length >= firstHistoryCount);
  transitions.schedule(rules.next('full', fixture.workspace, live.policy, 4), 4);
  const pending = fixture.sdk.SessionManager.open(manager.getSessionFile()).getEntries().filter(row => row.customType === 'soduwork.access.pending').at(-1).data;
  assert.equal(rules.restore(pending, fixture.workspace).mode, 'full');
  assert.equal(rules.restore(pending, fixture.workspace).revision, 5);
});

test('failed preparation keeps old permissions and queued choice; closing prevents replacement', async () => {
  const policy = rules.create('standard', os.tmpdir()), manager = { appendCustomEntry() {} };
  let disposed = 0, commits = 0, release;
  const live = { policy, session: { sessionManager: manager }, access: { broker: { close() {} } } };
  const transitions = create({ cwd: os.tmpdir(), current: () => live,
    prepare: () => Promise.reject(Error('resource unavailable')), commit() { commits++; } });
  transitions.schedule(rules.next('readonly', os.tmpdir(), policy, 1), 1);
  await assert.rejects(transitions.apply(), /resource unavailable/);
  assert.equal(live.policy.mode, 'standard'); assert.equal(transitions.pending().mode, 'readonly'); assert.equal(commits, 0);
  const closing = create({ cwd: os.tmpdir(), current: () => live,
    prepare: () => new Promise(resolve => { release = resolve; }), commit() { commits++; } });
  closing.schedule(rules.next('readonly', os.tmpdir(), policy, 1), 1);
  const running = closing.apply();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, 'function'); closing.close();
  release({ session: { sessionManager: manager, dispose() { disposed++; } } });
  await assert.rejects(running, /关闭/); assert.equal(disposed, 1); assert.equal(commits, 0);
});

test('reopening full access preserves a stricter pending readonly choice without a revision collision', () => {
  const full = rules.create('full', os.tmpdir());
  const pending = rules.next('readonly', os.tmpdir(), full, 1);
  const restored = rules.restoreState(full, pending, os.tmpdir());
  assert.equal(restored.accessPolicy.mode, 'full'); assert.equal(restored.accessPolicy.revision, 1);
  assert.equal(restored.nextAccessPolicy.mode, 'readonly'); assert.equal(restored.nextAccessPolicy.revision, 2);
  const reopenedAgain = rules.restoreState(restored.accessPolicy, restored.nextAccessPolicy, os.tmpdir());
  assert.deepEqual(reopenedAgain, restored);
});

test('a legacy Pi session can explicitly opt into standard without losing the conversation', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-access-legacy-'));
  const fixture = await require('../e2e/fixtures/access-sdk.cjs').create(root, null);
  let live = { session: fixture.session, access: null, policy: null };
  const transitions = create({ cwd: fixture.workspace, current: () => live, prepare: (p, s) => fixture.rebuild(p, s), commit: next => { live = next; } });
  t.after(async () => { live.access?.broker.close(); live.session.dispose(); await fixture.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await fixture.send('write', { path: 'legacy.txt', content: 'before upgrade' });
  transitions.schedule(rules.next('standard', fixture.workspace, null, 0), 0); await transitions.apply();
  assert.equal(live.policy.revision, 1); assert.equal(live.session.sessionManager, fixture.session.sessionManager);
  await live.session.prompt(JSON.stringify({ tool: 'read', args: { path: 'legacy.txt' } }));
  assert.ok(live.session.state.messages.some(row => row.role === 'toolResult' && JSON.stringify(row).includes('before upgrade')));
});
