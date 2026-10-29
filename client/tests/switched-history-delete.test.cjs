'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const sessions = require('../main/pi-session/session');
const segments = require('../main/conversation/runtime-segments');
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
const { createRunnerRuntimeAdapter } = require('../main/agent-runtime/runner-adapter');
const catalog = require('../main/agent-runtime/runtime-catalog');
const historyIpc = require('../main/pi-session/history-ipc');

async function fixture(t, switched = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-switch-delete-'));
  const app = { getPath: () => root }, directory = path.join(root, 'pi-agent', 'sessions', 'workspace');
  const identity = require('./helpers/platform-session-fixture.cjs').identity();
  const auth = require('../main/device-auth'), saved = {};
  for (const key of ['identity', 'session', 'profiles', 'localOwner']) saved[key] = auth[key];
  auth.identity = () => identity; auth.session = () => identity.session; auth.profiles = () => [];
  auth.localOwner = () => require('../main/platform-connections/runtime.cjs').scope(identity);
  t.after(() => Object.assign(auth, saved));
  require('../main/conversation/session-memory').bind(app, 'original', identity, [], true);
  await fs.mkdir(directory, { recursive: true });
  const archive = async id => {
    const file = path.join(directory, id + '.jsonl');
    await fs.writeFile(file, [
      { type: 'session', version: 3, id, timestamp: '2026-10-15T00:00:00Z', cwd: root },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Retain my result' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    return file;
  };
  const first = await archive('original'), later = switched ? await archive('later-pi') : null;
  const output = path.join(root, 'delivery.txt'); await fs.writeFile(output, 'Keep this deliverable');
  const runs = new Map(switched ? ['opencode', 'qwen'].map(cli => ['runner-' + cli, {
    ref: 'runner-' + cli, taskId: 'chat-' + cli, cli, workDir: root, state: 'done', title: 'Continue', seq: 1,
  }]) : []);
  let failure = '', busy = false, live = true, race = false, archiveFailure = false;
  const calls = [], trashed = [];
  const runtime = { async rpc(op, input) {
    calls.push({ op, input });
    if (op === 'runtime.sessions') return { ok: true, data: { runs: [...runs.values()] } };
    if (op === 'runtime.session.forget') {
      if (input.ref === failure) return { ok: false, error: 'fixture deletion failed' };
      runs.delete(input.ref); return { ok: true, data: { ok: true } };
    }
    throw Error('Unexpected RPC ' + op);
  } };
  const bridge = createPiSessionBridge({ app, sessionModule: sessions,
    runnerAdapters: ['opencode', 'qwen'].map(id => createRunnerRuntimeAdapter({ app,
      runtimeSpec: catalog.runtime(id), runnerRuntime: runtime })) });
  bridge.attachView({ ref: 'chat-public', sessionId: 'original', inFlight: () => busy,
    close() { live = false; calls.push({ op: 'close' }); } });
  if (switched) await segments.save(app, { version: 1, id: 'original', owner: auth.localOwner(),
    title: 'One conversation', cwd: root, prefix: { messages: [], tools: [] },
    segments: [{ sessionId: 'original', adapterId: 'pi', path: first },
      { sessionId: 'runner-opencode', adapterId: 'opencode', path: 'runner-opencode' },
      { sessionId: 'later-pi', adapterId: 'pi', path: later }],
    active: { sessionId: 'runner-qwen', adapterId: 'qwen', path: 'runner-qwen', started: true } });
  const handlers = new Map();
  historyIpc.install({ app, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    session: { ...bridge, async archiveHistory(...args) {
      return archiveFailure ? { ok: false, reason: 'fixture archive failed' } : bridge.archiveHistory(...args);
    }, async historyEntry(...args) {
      /* Mark the conversation busy while its deletion confirmation is still open. */
      const found = await bridge.historyEntry(...args);
      if (race) busy = true;
      return found;
    } },
    BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
    shell: { async trashItem(file) { trashed.push(file); await fs.unlink(file); } },
    // Recycle preparation is tested with an isolated filesystem; do not modify
    // the host recycle bin while exercising conversation ownership here.
    trash: (shell, file) => shell.trashItem(file),
  });
  t.after(async () => { await bridge.dispose(); await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  return { app, bridge, first, later, output, runs, calls, trashed,
    remove: (id = 'original', options) => handlers.get('pi-session-history-delete')({ sender: {} }, id, options),
    get live() { return live; }, set busy(value) { busy = value; }, set race(value) { race = value; },
    set failure(value) { failure = value; }, set archiveFailure(value) { archiveFailure = value; } };
}

test('sidebar delete removes all native segments and manifest without deleting workspace results', async t => {
  const f = await fixture(t);
  assert.equal((await f.bridge.history(f.app)).chats.length, 1);
  /* The main process performs no deletion before application-dialog confirmation. */
  const asked = await f.remove();
  assert.equal(asked.ok, false); assert.equal(asked.needsConfirm, true);
  assert.equal(asked.confirm.title, '删除聊天');
  assert.match(asked.confirm.message, /One conversation/);
  assert.equal(asked.confirm.confirm, '删除会话');
  assert.match(asked.confirm.detail, /回收站/);
  assert.equal(f.live, true); assert.ok(segments.read(f.app, 'original'));
  const result = await f.remove('original', { confirmed: true }); assert.equal(result.ok, true, result.reason);
  assert.equal(f.live, false); assert.equal(f.runs.size, 0); assert.equal(f.trashed.length, 0);
  assert.equal(segments.read(f.app, 'original'), null);
  await assert.rejects(fs.stat(f.first), { code: 'ENOENT' });
  await assert.rejects(fs.stat(f.later), { code: 'ENOENT' });
  assert.equal(await fs.readFile(f.output, 'utf8'), 'Keep this deliverable');
  assert.equal((await f.bridge.history(f.app)).chats.length, 0);
  assert.equal((await f.bridge.archivedHistory(f.app)).chats.length, 0);
});

test('cancel and an in-flight conversation preserve every native segment', async t => {
  const f = await fixture(t);
  /* Cancellation omits the confirmed second request and leaves the conversation intact. */
  assert.equal((await f.remove()).needsConfirm, true);
  assert.equal(f.live, true); assert.equal(f.runs.size, 2); assert.ok(segments.read(f.app, 'original'));
  f.busy = true;
  const busy = await f.remove('original', { confirmed: true });
  assert.equal(busy.ok, false); assert.match(busy.reason, /还在执行/);
  assert.equal(f.runs.size, 2); assert.ok(segments.read(f.app, 'original'));
  assert.equal(f.calls.some(c => c.op === 'runtime.session.forget' || c.op === 'close'), false);
});

test('a conversation that starts running while the confirmation is open is not deleted', async t => {
  const f = await fixture(t, false);
  assert.equal((await f.remove()).needsConfirm, true);
  f.race = true;
  const raced = await f.remove('original', { confirmed: true });
  assert.equal(raced.ok, false); assert.match(raced.reason, /刚刚又开始执行/);
  assert.equal(f.live, true); await fs.stat(f.first);
  assert.equal(f.calls.some(c => c.op === 'runtime.session.forget' || c.op === 'close'), false);
});

test('archive failure performs no deletion; segment failure stays recoverable and retry cleans up', async t => {
  const f = await fixture(t); f.archiveFailure = true;
  assert.equal((await f.remove('original', { confirmed: true })).ok, false); assert.equal(f.runs.size, 2);
  assert.ok(segments.read(f.app, 'original')); await fs.stat(f.first);
  f.archiveFailure = false; f.failure = 'runner-opencode';
  const failed = await f.remove('original', { confirmed: true }); assert.equal(failed.ok, false); assert.match(failed.reason, /重试/);
  assert.equal(f.bridge.isArchived(f.app, 'original'), true); assert.ok(segments.read(f.app, 'original'));
  f.failure = ''; assert.equal((await f.remove('original', { confirmed: true })).ok, true);
  assert.equal(segments.read(f.app, 'original'), null); assert.equal(f.runs.size, 0);
});

test('ordinary Pi sidebar delete keeps the existing recycle-bin behavior', async t => {
  const f = await fixture(t, false);
  // Windows services can report TEMP while realpath resolves the same directory as Temp.
  const canonical = await fs.realpath(f.first);
  assert.equal((await f.remove('original', { confirmed: true })).ok, true); assert.deepEqual(f.trashed, [canonical]);
  assert.equal(await fs.readFile(f.output, 'utf8'), 'Keep this deliverable');
});
