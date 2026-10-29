'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { create } = require('../main/conversation/cloud-handoff');
const { connectionScope: scope } = require('../main/platform-connections/runtime.cjs');

async function fixture(t, phase) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-handoff-recovery-'));
  const app = { getPath: () => root }, dir = path.join(root, 'conversation-handoffs');
  await fs.mkdir(dir);
  let identity = { hub: 'http://127.0.0.1:18989', clientId: 'desktop', session: Buffer.from(JSON.stringify({
    typ: 'device', uid: 'alice', cid: 'desktop', iat: Math.floor(Date.now() / 1000) - 10,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url') + '.' + 'a'.repeat(64) };
  const record = { sessionId: 'original-chat', transferId: crypto.randomUUID(), phase, owner: scope(identity),
    title: 'Preserved history', sha256: 'a'.repeat(64), target: { id: 'runner:remote:pi', agentId: 'pi' },
    taskId: phase === 'uploading' ? '' : 'fixed-task', ref: phase === 'committed' ? 'fixed-run' : '',
    options: { model: 'fixture' } };
  const saved = { cwd: root, adapterId: 'unavailable-old-runtime', model: { id: 'removed-model' },
    snapshot: { messages: [{ role: 'user', text: 'Finish the report' }], tools: [], status: 'idle' } };
  const file = path.join(dir, crypto.createHash('sha256').update(record.sessionId).digest('hex') + '.json');
  await fs.writeFile(file, JSON.stringify(record));
  if (phase !== 'preparing') await fs.writeFile(path.join(dir, record.transferId + '.view.json'), JSON.stringify(saved));
  let starts = 0, calls = [], remotePhase = phase === 'committing' ? 'committed' : 'prepared';
  const request = async (_identity, route) => {
    calls.push(route);
    if (route.includes('/ai-session')) return { ok: true, ref: 'fixed-run', status: 'running', last: 0, items: [] };
    if (route.endsWith('/commit')) { if (remotePhase !== 'committed') starts++; remotePhase = 'committed'; }
    if (route.endsWith('/abort')) remotePhase = 'aborted';
    return { ok: true, ...record, phase: remotePhase, taskId: 'fixed-task', ref: remotePhase === 'committed' ? 'fixed-run' : '' };
  };
  const handles = [];
  t.after(async () => { handles.forEach(handle => handle.close()); await fs.rm(root, { force: true, recursive: true }); });
  const controller = create({ app, identityOf: async () => identity, request, interval: 60000 });
  return { app, controller, record, file, calls, handles, get starts() { return starts; },
    get identity() { return identity; }, set identity(value) { identity = value; }, request };
}

for (const phase of ['uploading', 'prepared', 'committing']) {
  test(`a restarted ${phase} handoff opens without a local runtime and recovers the fixed task`, async t => {
    const f = await fixture(t, phase);
    const handle = await f.controller.reopen(f.record.sessionId, 'passive-view');
    assert.ok(handle, 'an uncertain transfer must open before attempting a local SDK/model');
    f.handles.push(handle);
    assert.equal(handle.snapshot().messages[0].text, 'Finish the report');
    assert.equal((await handle.bindTask('unrelated-task')).ok, false);
    assert.equal(handle.submit('must not run').accepted, false);
    const got = await f.controller.recover(handle);
    assert.equal(got.handoff.taskId, 'fixed-task');
    assert.equal(got.handoff.phase, 'committed');
    assert.equal(handle.taskRef, 'fixed-task');
    assert.equal(handle.snapshot().cloudHandoff.phase, 'committed');
    await f.controller.recover(handle);
    assert.equal(f.starts, phase === 'committing' ? 0 : 1, 'retry must never dispatch a second task');
  });
}

test('a pre-upload crash clears only its local fence without contacting the cloud', async t => {
  const f = await fixture(t, 'preparing');
  assert.equal(await f.controller.reopen(f.record.sessionId, 'unused'), null);
  assert.equal(JSON.parse(await fs.readFile(f.file)).phase, 'aborted');
  assert.equal(f.calls.length, 0);
});

test('reopening an uncertain handoff under another connection cannot reveal its snapshot', async t => {
  const f = await fixture(t, 'uploading');
  f.identity = { ...f.identity, hub: 'http://127.0.0.1:19999' };
  await assert.rejects(f.controller.reopen(f.record.sessionId, 'blocked'), /其他账号或服务/);
  assert.equal(f.calls.length, 0);
});

test('the production IPC disposes a cancelled passive registry view before resuming locally', async t => {
  const f = await fixture(t, 'uploading');
  const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
  const noLocal = () => { throw Error('Local SDK must not open'); };
  const bridge = createPiSessionBridge({ sessionModule: { open: noLocal, probe: noLocal }, runnerAdapters: [] });
  const raw = await f.controller.reopen(f.record.sessionId, 'cloud-recovered');
  f.handles.push(raw);
  const active = bridge.attachView(raw), handlers = new Map();
  const filename = path.join(__dirname, '../main/conversation/cloud-handoff-ipc.js');
  const nativeRequire = createRequire(filename), sandbox = { module: { exports: {} }, require: name =>
    name === './cloud-handoff' ? { create: () => f.controller } : nativeRequire(name) };
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), sandbox, { filename });
  sandbox.module.exports.install({ app: f.app, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    session: bridge, identityOf: async () => f.identity });
  const frame = {}, event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false,
    getURL: () => pathToFileURL(path.join(__dirname, '../desk.html')).href } };
  const untrusted = await handlers.get('conversation-cloud-abort')({}, active.ref);
  assert.equal(untrusted.ok, false);
  assert.equal(bridge.get(active.ref), active);
  const result = await handlers.get('conversation-cloud-abort')(event, active.ref);
  assert.equal(result.ok, true);
  assert.equal(result.handoff.phase, 'aborted');
  assert.equal(result.reopenLocal, true);
  assert.equal(result.sessionId, f.record.sessionId);
  assert.equal(bridge.get(active.ref), null);
  assert.equal(bridge.findBySessionId(f.record.sessionId), null);
  assert.equal(await f.controller.reopen(f.record.sessionId, 'local-resume'), null);
});

test('a refused stop preserves the remote running view and reports the error', async t => {
  const f = await fixture(t, 'committed');
  const notices = [];
  const controller = create({ app: f.app, identityOf: async () => f.identity, interval: 60000,
    notify: (_handle, event) => notices.push(event), request: (identity, route, options) => {
      if (route.endsWith('/ai-stop')) throw Error('Remote process could not stop');
      return f.request(identity, route, options);
    } });
  const raw = await controller.reopen(f.record.sessionId, 'cloud-running'); f.handles.push(raw);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(raw.snapshot().status, 'streaming');
  assert.equal((await raw.cancel()).ok, false);
  assert.equal(raw.snapshot().status, 'streaming');
  assert.ok(notices.some(event => event.kind === 'error' && /could not stop/.test(event.reason)));
});
