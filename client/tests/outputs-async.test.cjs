'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const outputs = require('../main/pi-session/outputs');
const runtime = require('../main/conversation/artifact-runtime');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-output-async-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(cwd)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(cwd).startsWith('soduwork-output-async-'));
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const write = (name, at = Date.now(), text = 'result') => {
    const file = path.join(cwd, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    fs.utimesSync(file, at / 1000, at / 1000);
    return file;
  };
  return { cwd, write };
}

test('completed content changes retain an indexed edit despite timestamp precision drift', async t => {
  const { cwd, write } = fixture(t), turn = Date.now();
  const journal = require('../main/conversation/file-change-journal');
  write('report.md', turn - 2, 'before');
  write('unchanged.md', turn - 2, 'untouched');
  const before = await journal.snapshot(cwd);
  write('report.md', turn - 2, 'edited');
  const changes = journal.compare(before, await journal.snapshot(cwd), { turnId: 'completed' });
  const scanned = await outputs.scanAsync(cwd, turn - 1000, turn);
  assert.ok(scanned.files.every(file => !file.changedInTurn));
  const marked = outputs.withJournal(scanned, changes);
  assert.deepEqual(marked.files.filter(file => file.changedInTurn).map(file => file.name), ['report.md']);
  assert.equal(marked.delivery.items.find(file => file.name === 'report.md').changedInTurn, true);
  assert.ok(scanned.files.every(file => !file.changedInTurn), 'Keep the original scan immutable');
  for (const change of [{ size: 999 }, { mtimeMs: turn + 99 }, { path: '../outside.md' }, { exists: false }]) {
    const stale = structuredClone(changes); Object.assign(stale.files[0].after, change);
    assert.ok(outputs.withJournal(scanned, stale).files.every(file => !file.changedInTurn));
  }
});

test('inventory compares file and conversation boundaries at the same millisecond precision', async t => {
  const { cwd, write } = fixture(t), since = 1700000000123;
  for (const name of ['boundary.md', 'previous.md', 'next.md']) write(name, since);
  const times = { 'boundary.md': since - 0.001, 'previous.md': since - 1, 'next.md': since + 1 };
  const statSync = fs.statSync.bind(fs), statAsync = fs.promises.stat.bind(fs.promises);
  const withTime = (file, stat) => {
    const time = times[path.basename(String(file))];
    if (time !== undefined) stat.mtimeMs = time;
    return stat;
  };
  t.mock.method(fs, 'statSync', (file, ...args) => withTime(file, statSync(file, ...args)));
  t.mock.method(fs.promises, 'stat', async (file, ...args) => withTime(file, await statAsync(file, ...args)));
  for (const scan of [outputs.scan, outputs.scanAsync]) {
    const result = await scan(cwd, since, since);
    assert.deepEqual(result.files.map(file => [file.name, file.at, file.changedInTurn]),
      [['next.md', since + 1, true], ['boundary.md', since, true]]);
    assert.deepEqual((await scan(cwd, since + 1, since + 1)).files.map(file => file.name), ['next.md']);
  }
});

test('async inventory preserves time filters, depth, exclusions, ordering and the 60-file shortlist', async t => {
  const { cwd, write } = fixture(t), since = Date.now() - 10000;
  write('old.md', since - 1);
  write('report.md', since + 2000);
  write('one/two/three/deep.md', since + 1000);
  for (const name of ['one/two/three/four/too-deep.md', '.hidden.md', 'half.tmp',
    'node_modules/ignored.md', 'skills/ignored.md', '.pi/ignored.md']) write(name, since + 3000);
  const initial = await outputs.scanAsync(cwd, since, since + 1500);
  assert.deepEqual(initial, outputs.scan(cwd, since, since + 1500));
  assert.deepEqual(initial.files.map(file => [file.relative, file.changedInTurn]),
    [['report.md', true], ['one/two/three/deep.md', false]]);
  for (let i = 0; i < 70; i++) write('a-folder/' + String(i).padStart(3, '0') + '.txt', since + 5000 + i);
  const capped = await outputs.scanAsync(cwd, since, since + 1500);
  assert.deepEqual(capped, outputs.scan(cwd, since, since + 1500));
  assert.equal(capped.files.length, 60);
  assert.equal(capped.truncated, true);
  assert.ok(capped.files.some(file => file.relative === 'report.md'), 'root files keep traversal priority');
});

test('old workspaces yield to the event loop, merge matching requests and globally bound metadata IO', async t => {
  const a = fixture(t), b = fixture(t), since = Date.now() - 10000;
  for (const f of [a, b]) {
    for (let i = 0; i < 180; i++) f.write('old/' + i + '.txt', since - 1000);
    f.write('z-results/new.md', since + 1000);
  }
  const stat = fs.promises.stat.bind(fs.promises);
  let active = 0, peak = 0, count = 0, ticks = 0;
  t.mock.method(fs, 'readdirSync', () => { throw Error('synchronous traversal reached the event loop'); });
  t.mock.method(fs.promises, 'stat', async (...args) => {
    active++; peak = Math.max(peak, active); count++;
    try {
      await new Promise(resolve => setImmediate(() => { ticks++; resolve(); }));
      return await stat(...args);
    } finally { active--; }
  });
  const first = outputs.scanAsync(a.cwd, since, since);
  assert.equal(outputs.scanAsync(a.cwd, since, since), first);
  const [left, right] = await Promise.all([first, outputs.scanAsync(b.cwd, since, since)]);
  assert.deepEqual(left.files.map(file => file.relative), ['z-results/new.md']);
  assert.deepEqual(right.files.map(file => file.relative), ['z-results/new.md']);
  assert.equal(count, 362, 'two matching requests share a single inventory walk');
  assert.ok(peak > 1 && peak <= 16, 'all scans share the 16-operation IO bound: ' + peak);
  assert.ok(ticks >= 362, 'main-process callbacks run during inventory collection');
  t.mock.restoreAll();
});

test('different conversation time boundaries remain isolated and subsequent scans observe new files', async t => {
  const { cwd, write } = fixture(t), since = Date.now() - 10000;
  write('old.md', since - 1000); write('current.md', since + 1000);
  const [all, current] = await Promise.all([outputs.scanAsync(cwd, 0), outputs.scanAsync(cwd, since)]);
  assert.equal(all.files.length, 2); assert.equal(current.files.length, 1);
  write('later.md', since + 2000);
  assert.equal((await outputs.scanAsync(cwd, since)).files.length, 2);
  assert.deepEqual(await outputs.scanAsync('', 0), outputs.scan('', 0));
});

test('directory errors and rejected scans do not leave stale pending work or consume IO slots', async t => {
  const { cwd, write } = fixture(t); write('report.md');
  const readdir = fs.promises.readdir.bind(fs.promises);
  let unreadable = true;
  t.mock.method(fs.promises, 'readdir', (...args) => {
    if (unreadable) { unreadable = false; return Promise.reject(Object.assign(Error('unavailable'), { code: 'EACCES' })); }
    return readdir(...args);
  });
  assert.equal((await outputs.scanAsync(cwd, 0)).files.length, 0);
  assert.equal((await outputs.scanAsync(cwd, 0)).files.length, 1);
  const contract = require('../main/conversation/delivery-contract'), classify = contract.classify;
  let fail = true;
  t.mock.method(contract, 'classify', (...args) => {
    if (fail) { fail = false; throw Error('index failure'); }
    return classify(...args);
  });
  await assert.rejects(outputs.scanAsync(cwd, 0), /index failure/);
  assert.equal((await outputs.scanAsync(cwd, 0)).files.length, 1);
  t.mock.restoreAll();
});

test('artifact listing, opening and library export use async session inventory and retain path checks', async t => {
  const { cwd, write } = fixture(t); write('report.md', Date.now(), '# Report');
  let scans = 0;
  const session = { cwd, outputSnapshot() { assert.fail('legacy synchronous scan used'); },
    outputSnapshotAsync() { scans++; return outputs.scanAsync(cwd, 0); } };
  const index = await runtime.snapshotAsync(session), item = index.items.find(row => row.name === 'report.md');
  assert.ok(item?.artifactId);
  assert.equal((await runtime.resolveAsync(session, item.artifactId)).path,
    await fs.promises.realpath(path.join(cwd, 'report.md')));
  assert.equal((await runtime.action(session, 'async-report', item.artifactId, 'read', {})).text, '# Report');
  const uploaded = await require('../main/library-output.cjs').readAsync(session, { artifactId: item.artifactId });
  assert.equal(Buffer.from(uploaded.data, 'base64').toString(), '# Report');
  assert.equal(scans, 4);
  assert.equal((await runtime.resolveAsync(session, 'not-in-this-session')).ok, false);
  const handlers = new Map();
  require('../main/pi-session/artifact-ipc').install({ app: { getPath: () => cwd },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, BrowserWindow: {}, workDir: () => cwd,
    session: { get: ref => ref === 'async-report' ? session : null } });
  const listed = await handlers.get('pi-session-outputs')({}, 'async-report');
  assert.equal(listed.ok, true); assert.equal(listed.files[0].name, 'report.md');
  assert.equal(listed.artifacts[0].artifactId, item.artifactId);
  assert.equal((await handlers.get('pi-session-outputs')({}, 'missing')).ok, false);
});

test('closing a conversation while its async inventory loads cannot start a preview server later', async t => {
  const { cwd, write } = fixture(t); write('index.html', Date.now(), '<h1>Result</h1>');
  const inventory = outputs.scan(cwd, 0);
  const id = runtime.snapshot({ cwd, outputSnapshot: () => inventory }).items[0].artifactId;
  let release;
  const session = { cwd, outputSnapshotAsync: () => new Promise(resolve => { release = resolve; }) };
  const pending = runtime.preview(session, 'closed-during-scan', id);
  runtime.closeRef('closed-during-scan'); release(inventory);
  assert.equal((await pending).ok, false);
  assert.equal([...runtime._records.values()].some(record => record.ref === 'closed-during-scan'), false);
  const stopped = runtime.preview(session, 'stopped-during-scan', id);
  await runtime.action(session, 'stopped-during-scan', id, 'stop', {});
  release(inventory);
  assert.equal((await stopped).ok, false);
  assert.equal([...runtime._records.values()].some(record => record.ref === 'stopped-during-scan'), false);
});

test('plugin draft inspection uses async inventory without falling back to a synchronous workspace walk', async t => {
  const { cwd, write } = fixture(t), reader = require('../main/pi-session/plugin-draft');
  write(reader.DRAFT_NAME, Date.now(), JSON.stringify({ name: 'Async plugin' }));
  const session = { cwd, sessionId: 'async-plugin', outputSnapshot() { assert.fail('synchronous plugin scan'); },
    outputSnapshotAsync: () => outputs.scanAsync(cwd, 0) };
  const recent = await reader.readRecentAsync([session]);
  assert.equal(recent.ok, true); assert.equal(recent.body.name, 'Async plugin');
  const index = await runtime.snapshotAsync(session);
  const read = await reader.readSessionAsync(session, index.items.find(item => item.pluginDraft).artifactId);
  assert.equal(read.ok, true); assert.equal(read.body.name, 'Async plugin');
});

test('an in-flight index cannot be relabeled after cloud handoff, account or workspace changes', async t => {
  const { cwd, write } = fixture(t); write('report.md');
  const inventory = outputs.scan(cwd, 0);
  for (const change of [
    session => { session.outputSnapshotAsync = async () => ({ files: [] }); },
    session => { session.cwd = path.join(cwd, 'cloud'); },
    session => { session.deliveryOwner = 'new-owner'; },
  ]) {
    let release;
    const session = { cwd, sessionId: 'source-change', deliveryOwner: 'original-owner',
      outputSnapshotAsync: () => new Promise(resolve => { release = resolve; }) };
    const pending = runtime.snapshotAsync(session);
    change(session); release(inventory);
    await assert.rejects(pending, /来源已变化/);
  }
});

test('Pi and Runner runtime artifact contracts use async inventories while old Pi handles stay compatible', async t => {
  const { cwd, write } = fixture(t); write('report.md');
  const { createPiRuntimeAdapter } = require('../main/agent-runtime/pi-adapter');
  const handle = { sessionId: 'async-pi', on: () => () => {}, close() {},
    snapshot: () => ({ status: 'idle', messages: [], tools: [], execution: {} }),
    outputs() { assert.fail('runtime contract used the synchronous Pi inventory'); },
    outputSnapshotAsync: () => outputs.scanAsync(cwd, 0) };
  const pi = await createPiRuntimeAdapter({ sessionModule: { probe: () => ({ ok: true }),
    open: async () => ({ ok: true, session: handle }) } }).createSession({ workspace: { path: cwd } });
  t.after(() => pi.dispose());
  assert.equal((await pi.artifacts())[0].name, 'report.md');
  const legacy = { files: [{ name: 'legacy.md' }] };
  delete handle.outputSnapshotAsync; handle.outputs = () => legacy;
  assert.equal(pi.artifacts(), legacy);

  const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
  const app = { getPath: () => cwd };
  const runner = await createRunnerRuntimeAdapter({ app,
    runtimeSpec: require('../main/agent-runtime/runtime-catalog').runtime('opencode'),
    runnerRuntime: { rpc() { assert.fail('artifact listing must not invoke a model or Runner job'); } },
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture' } }) },
  }).createSession({ native: { runner: { openOptions: { app, cwd, ref: 'async-artifacts', identity: {} } } } });
  t.after(() => runner.dispose());
  const native = getRunnerSessionDetails(runner).handle;
  native.outputSnapshot = () => assert.fail('runtime contract used the synchronous Runner inventory');
  native.outputSnapshotAsync = () => outputs.scanAsync(cwd, 0);
  assert.ok((await runner.artifacts()).files.some(file => file.name === 'report.md'));
});
