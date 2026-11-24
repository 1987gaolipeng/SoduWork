'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const project = require('../main/conversation/device-history-artifacts.cjs');
const runtime = require('../main/conversation/artifact-runtime');
const native = require('../main/conversation/device-history-native.cjs');
const { setTimeout: delay } = require('node:timers/promises');

function fixture(t, close) {
  const workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'history-artifacts-')));
  const taskId = 'chat-abcdef-1234', cwd = path.join(workRoot, 'temp', taskId);
  fs.mkdirSync(cwd, { recursive: true });
  t.after(async () => {
    await close?.();
    fs.rmSync(workRoot, { recursive: true, force: true });
  });
  const row = { id: 'runner-native-ref', adapterId: 'opencode', cwd };
  const write = (name, bytes) => {
    const target = path.join(cwd, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    return target;
  };
  return { workRoot, row, write, cwd, taskId };
}

test('old Runner results recover from an allocated scratch window with no manifest or output events', async t => {
  const f = fixture(t), start = Date.now() - 50;
  const old = f.write('prior.txt', 'older');
  fs.utimesSync(old, 1, 1);
  f.write('index.html', '<link rel="stylesheet" href="site.css">');
  f.write('shots/example.png', Buffer.from([137,80,78,71]));
  f.write('site.css', 'body{}');
  f.write('credentials.json', 'excluded');
  fs.symlinkSync(old, path.join(f.cwd, 'linked.txt'));
  fs.linkSync(old, path.join(f.cwd, 'hard.txt'));
  await delay(6);
  const end = Date.now();
  const data = await native.read({ app: { getPath: () => f.workRoot }, row: f.row, session: {}, guard() {},
    runtime: { rpc: async () => ({ ok: true, data: { ok: true, seq: 1, ref: f.row.id, taskId: f.taskId, workDir: f.cwd,
      status: 'done', firstStarted: start / 1000, ended: end / 1000, items: [{ seq: 1, kind: 'say', text: 'complete' }] } }) } });
  assert.equal(data.localWorkspace.cwd, f.cwd);
  const args = { ...f, workspace: data.localWorkspace };
  const indexed = await project.capture(args);
  assert.deepEqual(indexed.items.map(row => row.metadata.relative).sort(), ['index.html', 'shots/example.png']);
  assert.deepEqual(indexed.resources.map(row => row.metadata.relative), ['site.css']);
  assert.equal(indexed.items.find(item => item.metadata.relative === 'index.html').metadata.primary, true);
  assert.equal(await project.capture({ ...args, workspace: { ...data.localWorkspace, taskId: 'different' } }), null);
  assert.equal(await project.capture({ ...args, workspace: { ...data.localWorkspace, id: 'different' } }), null);
  assert.equal(await project.capture({ ...args, workRoot: os.tmpdir() }), null);
  let active = true;
  const session = { historyArtifacts: project.view(f.cwd, indexed, () => { if (!active) throw Error('scope changed'); }) };
  const index = await runtime.snapshotAsync(session), artifact = index.items.find(row => row.kind === 'website');
  const image = index.items.find(row => row.kind === 'image');
  assert.equal(index.delivery.items.length, 1);
  assert.deepEqual(index.got.files, []);
  assert.equal((await runtime.action(session, 'history', image.artifactId, 'image-full', {})).data, 'iVBORw==');
  assert.equal((await runtime.action(session, 'history', artifact.artifactId, 'share-related', {})).ok, false);
  f.write('later.txt', 'unrelated');
  const ref = 'device-history-artifacts-test'; t.after(() => runtime.closeRef(ref));
  const opened = await runtime.preview(session, ref, artifact.artifactId);
  assert.equal(opened.ok, true);
  const get = relative => fetch(new URL(relative, opened.url));
  assert.equal(await (await get('site.css')).text(), 'body{}');
  assert.equal((await get('later.txt')).status, 404);
  assert.equal((await get('linked.txt')).status, 404);
  assert.equal((await get('credentials.json')).status, 404);
  f.write('site.css', 'new stuff');
  f.write('shots/example.png', 'replacement');
  assert.equal((await get('site.css')).status, 404);
  assert.equal((await runtime.action(session, ref, image.artifactId, 'image', {})).ok, false);
  const reloaded = await project.capture({ ...args, previous: indexed });
  assert.equal(project.view(f.cwd, reloaded, () => {}).snapshot().items.some(row => row.kind === 'image'), false);
  active = false;
  assert.equal((await get('index.html')).status, 404);
  await assert.rejects(runtime.snapshotAsync(session), /scope changed/);
});

test('explicit workspaces require a matching local change receipt or a retained file version', async t => {
  const f = fixture(t), name = 'report.md', target = f.write(name, 'completed result');
  f.write('notes.md', 'unrelated');
  const bytes = fs.readFileSync(target), digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const journal = { cwd: f.cwd, turnId: 'one', files: [{ path: name, action: 'created',
    after: { path: name, exists: true, hash: digest, size: bytes.length } }] };
  const index = await project.capture({ ...f, journal });
  assert.deepEqual(index.items.map(item => item.metadata.relative), [name]);
  const directorySpelling = await project.capture({ ...f, journal: { ...journal, cwd: f.cwd + path.sep } });
  assert.deepEqual(directorySpelling.items, index.items);
  const kept = await project.capture({ ...f, retained: index });
  assert.equal(kept.items.length, 1);
  const alias = path.join(f.workRoot, 'linked-temp');
  fs.symlinkSync(path.dirname(f.cwd), alias, 'junction');
  assert.equal(await project.capture({ ...f, journal: { ...journal, cwd: path.join(alias, f.taskId) } }), null);
  assert.equal(await project.capture({ ...f, journal: { ...journal, cwd: f.workRoot } }), null);
  assert.equal(await project.capture({ ...f, journal: { ...journal, truncated: true } }), null);
  f.write(name, 'different result');
  assert.equal(await project.capture({ ...f, journal }), null);
  assert.deepEqual(project.view(f.cwd, kept, () => {}).snapshot().items, []);
  const nextBytes = fs.readFileSync(target);
  const next = await project.capture({ ...f, journal: { ...journal, turnId: 'two', files: [{ ...journal.files[0],
    after: { ...journal.files[0].after, size: nextBytes.length, hash: crypto.createHash('sha256').update(nextBytes).digest('hex') } }] } });
  const updated = await project.capture({ ...f, previous: index, retained: next });
  assert.equal(project.view(f.cwd, updated, () => {}).snapshot().items.length, 1);
});

test('legacy receipts restore only the current verified skill revision as an installable card', async t => {
  const f = fixture(t);
  const bytes = require('../main/conversation/zip-archive').createEntriesSync([{ name: 'SKILL.md',
    bytes: Buffer.from('---\nname: history-example\ndescription: Local test skill\n---\n# Example\n') }]);
  const files = [];
  for (const [relative, content] of [['v1/demo.skill', bytes], ['v2/demo.skill', bytes],
    ['delivery/portable.zip', bytes], ['delivery/invalid.skill', Buffer.from('invalid')]]) {
    const target = f.write(relative, content);
    fs.utimesSync(target, 1000 + files.length, 1000 + files.length);
    files.push({ path: relative, action: 'created', after: { path: relative, exists: true, size: content.length,
      hash: crypto.createHash('sha256').update(content).digest('hex') } });
  }
  f.write('unrelated.skill', bytes);
  const saved = await project.capture({ ...f, journal: { cwd: f.cwd, turnId: 'finished', files } });
  assert.ok(saved.items.every(record => !record.metadata.pluginDraft));
  const view = project.view(f.cwd, saved, () => {});
  const results = runtime.decorate('preview', await view.snapshotAsync());
  const current = results.find(item => item.relative === 'v2/demo.skill');
  assert.equal(current.pluginName, 'history-example');
  assert.equal(current.pluginInstallable, true);
  assert.equal(current.pluginIdentity, 'skill:history-example');
  assert.equal(results.find(item => item.relative === 'v1/demo.skill').pluginSuperseded, true);
  assert.equal(results.find(item => item.relative.endsWith('.zip')).pluginDraft, undefined);
  assert.equal(results.find(item => item.relative.endsWith('invalid.skill')).pluginValidation.state, 'invalid');
  assert.equal(results.some(item => item.relative === 'unrelated.skill'), false);
  const resumed = { cwd: f.cwd, sessionId: 'resumed', outputSnapshot: () => ({ files: [] }),
    artifactHistory: require('../main/conversation/runtime-artifacts.cjs').forContinuation(f.cwd, saved) };
  const active = (await runtime.snapshotAsync(resumed)).items.filter(item => item.path === path.join(f.cwd, current.relative));
  assert.equal(active.length, 1);
  assert.equal(active[0].artifactId, current.artifactId);
  assert.equal(active[0].pluginValidation?.state, 'ready');
  f.write('v2/demo.skill', bytes);
  assert.ok(!(await view.snapshotAsync()).items.some(item => item.relative === 'v2/demo.skill'));
});

test('SQLite history opened by a second local account keeps verified outputs after native cleanup', async t => {
  let history;
  const f = fixture(t, () => history?.close()), app = { getPath: () => f.workRoot }, { identity } = require('./helpers/platform-session-fixture.cjs');
  const a = identity(), b = identity('two'); let current = a;
  const archive = path.join(f.workRoot, 'pi-agent', 'sessions', 'one.jsonl');
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, [
    { type: 'session', id: 'one', cwd: f.cwd },
    { type: 'message', message: { role: 'user', content: 'Synthetic task' } },
    { type: 'message', message: { role: 'assistant', content: 'Synthetic answer' } },
  ].map(entry => JSON.stringify(entry)).join('\n'));
  const row = { id: 'one', adapterId: 'pi', path: archive, cwd: f.cwd, count: 2,
    workOwner: require('../main/platform-connections/runtime.cjs').scope(a), creator: { account: 'one', hub: a.hub } };
  const session = { historyEntry: async () => fs.existsSync(archive) ? { ok: true, entry: row } : { ok: false, notFound: true },
    archivedConversation: async () => null, findBySessionId: () => null };
  const store = require('../main/conversation/replica-store.cjs').create(path.join(f.workRoot, 'history.sqlite'));
  history = require('../main/conversation/shared-history.cjs').create({ app, session, store, identityOf: () => current });
  await history.register([row]);
  const target = f.write('report.md', 'result'), name = path.basename(target), bytes = fs.readFileSync(target);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  await history.backfill(row.id, { journal: { cwd: f.cwd, turnId: 'one', files: [{ path: name, action: 'created',
    after: { path: name, exists: true, size: bytes.length, hash: digest } }] } });
  const local = (await store.deviceHistory(row.id)).localArtifactHistory;
  assert.equal(local.items.length, 1);
  assert.equal(JSON.stringify(await history.exportPortable(row.id)).includes('localArtifactHistory'), false);
  fs.unlinkSync(archive); current = b;
  const view = await history.open(row.id, { historyPreview: true, allowContinuation: true });
  assert.equal(view.cwd, undefined);
  const index = await runtime.snapshotAsync(view), id = index.items[0].artifactId;
  assert.equal((await runtime.action(view, view.ref, id, 'read', {})).text, 'result');
  assert.equal((await history.prepareContinuation(row.id)).artifactHistory.items[0].metadata.relative, name);
  assert.equal((await history.open(row.id)).historyArtifacts, undefined);
  current = a;
  await assert.rejects(runtime.action(view, view.ref, id, 'read', {}), /账号|会话/);
  const next = await history.open(row.id, { historyPreview: true });
  assert.equal((await runtime.snapshotAsync(next)).items.length, 1);
  const saved = await store.deviceHistory(row.id), latest = await store.get(row.id);
  await store.saveDeviceHistory(row.id, { snapshot: saved.snapshot, coverage: saved.coverage, historyProtection: 'account' },
    { expectedRevision: latest.replicaRevision });
  await assert.rejects(runtime.snapshotAsync(next), /版本|归属/);
});
