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

test('old Pi scratch allocations recover shell-generated files only with the original local ref and terminal archive window', async t => {
  const f = fixture(t), id = 'pi-generated', archive = path.join(f.workRoot, 'pi-agent', 'sessions', id + '.jsonl');
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  const start = new Date(Date.now() - 50).toISOString();
  f.write('report.pdf', '%PDF-1.4');
  await delay(10);
  const end = new Date().toISOString();
  const entries = [
    { type: 'session', id, cwd: f.cwd, timestamp: start },
    { type: 'message', message: { role: 'user', content: 'make a PDF' }, timestamp: start },
    { type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'completed' }] }, timestamp: end },
  ];
  fs.writeFileSync(archive, entries.map(e => JSON.stringify(e)).join('\n'));
  const row = { id, ref: f.taskId, cwd: f.cwd, adapterId: 'pi' };
  const app = { getPath: () => f.workRoot }, session = { historyEntry: async () => ({ ok: true, entry: { ...row, path: archive } }) };
  async function recover(candidate) {
    const result = await native.read({ app, row: candidate, session, guard() {} });
    return project.capture({ row: candidate, workRoot: f.workRoot, workspace: result.localWorkspace });
  }
  const saved = await recover(row);
  assert.deepEqual(saved.items.map(item => item.metadata.relative), ['report.pdf']);
  assert.equal(await recover({ ...row, ref: 'different' }), null);
  entries.push({ type: 'message', message: { role: 'user', content: 'continue' } });
  fs.writeFileSync(archive, entries.map(e => JSON.stringify(e)).join('\n'));
  assert.equal(await recover(row), null);
});

test('first open migrates a legacy Pi write from the native archive and previews its verified bytes', async t => {
  let history;
  const f = fixture(t, () => history?.close()), app = { getPath: () => f.workRoot };
  const identity = require('./helpers/platform-session-fixture.cjs').identity();
  const id = 'old-pi', archive = path.join(f.workRoot, 'pi-agent', 'sessions', id + '.jsonl');
  const html = '<link rel="stylesheet" href="site.css">', css = 'body{}';
  const entries = [{ type: 'session', id, cwd: f.cwd }, { type: 'message', message: { role: 'user', content: 'make a website' } }];
  const push = message => entries.push({ type: 'message', message });
  function write(target, content, result = {}) {
    const callId = 'call-' + entries.length;
    push({ role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: callId, name: 'write', arguments: { path: target, content } }] });
    push({ role: 'toolResult', toolCallId: callId, toolName: 'write', isError: false, content: [], ...result });
  }
  f.write('index.html', html); write('@index.html', html);
  f.write('site.css', css); write(path.join(f.cwd, 'site.css'), css);
  f.write('changed.md', 'new'); write('changed.md', 'old');
  f.write('failed.md', 'failed'); write('failed.md', 'failed', { isError: true });
  f.write('cancelled.md', 'cancelled'); write('cancelled.md', 'cancelled', { details: { soduWorkAccessChange: { state: 'cancelled' } } });
  const unrelated = f.write('other.md', 'other');
  fs.symlinkSync(unrelated, path.join(f.cwd, 'linked.md')); write('linked.md', 'other');
  write('../' + f.taskId + '/other.md', 'other');
  const published = '会话成果/' + crypto.randomUUID() + '/sibling.md';
  f.write(published, 'sibling'); write(published, 'sibling');
  push({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'index.html is ready. other.md' }] });
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, entries.map(e => JSON.stringify(e)).join('\n'));
  const row = { id, cwd: f.cwd, adapterId: 'pi', path: archive, count: entries.length - 1,
    workOwner: require('../main/platform-connections/runtime.cjs').scope(identity), creator: { account: 'one', hub: identity.hub } };
  const session = { historyEntry: async () => ({ ok: true, entry: row }), archivedConversation: async () => null, findBySessionId: () => null };
  const store = require('../main/conversation/replica-store.cjs').create(path.join(f.workRoot, 'history.sqlite'));
  history = require('../main/conversation/shared-history.cjs').create({ app, session, store, identityOf: () => identity, workRoot: () => f.workRoot });
  const [registered] = await history.register([row]);
  const { snapshot, coverage } = await native.read({ app, session, row, guard() {} });
  delete coverage.sources[0].artifactEvidenceVersion;
  const guard = { expectedRevision: registered.replicaRevision, expectedCatalogRevision: registered.revision };
  await store.saveDeviceHistory(id, { snapshot, coverage }, guard);
  await store.saveConversationTranscript(id, snapshot.messages, guard);
  const view = await history.open(id, { historyPreview: true });
  const index = await runtime.snapshotAsync(view);
  assert.deepEqual(index.items.map(i => i.relative), ['index.html']);
  // The recovered backup still opens after the original directory is gone.
  fs.rmSync(f.cwd, { recursive: true });
  const opened = await runtime.preview(view, view.ref, index.items[0].artifactId);
  try {
    assert.equal(opened.ok, true);
    assert.equal(await (await fetch(opened.url)).text(), html);
    assert.equal(await (await fetch(new URL('site.css', opened.url))).text(), css);
    assert.equal((await fetch(new URL('other.md', opened.url))).status, 404);
  } finally { runtime.closeRef(view.ref); await view.close(); }
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
  const previousStat = fs.statSync(target);
  f.write(name, 'different result');
  assert.equal(await project.capture({ ...f, journal }), null);
  // Equal-length writes can share a timestamp on Windows. Explicitly change
  // the version stamp for the retained-file check after rejecting the old hash.
  fs.utimesSync(target, previousStat.atime, new Date(previousStat.mtimeMs + 2000));
  assert.deepEqual(project.view(f.cwd, kept, () => {}).snapshot().items, []);
  const nextBytes = fs.readFileSync(target);
  const next = await project.capture({ ...f, journal: { ...journal, turnId: 'two', files: [{ ...journal.files[0],
    after: { ...journal.files[0].after, size: nextBytes.length, hash: crypto.createHash('sha256').update(nextBytes).digest('hex') } }] } });
  const updated = await project.capture({ ...f, previous: index, retained: next });
  assert.equal(project.view(f.cwd, updated, () => {}).snapshot().items.length, 1);
});

test('selected transfer outputs larger than a workspace journal entry receive a fresh local file receipt', async t => {
  const f = fixture(t), name = 'large.pdf', target = f.write(name, '');
  const block = Buffer.alloc(1024 * 1024), size = 32 * block.length + 1;
  fs.truncateSync(target, size);
  const hash = crypto.createHash('sha256');
  for (let i = 0; i < 32; i++) hash.update(block);
  const journal = { cwd: f.cwd, turnId: 'peer-transfer', files: [{ path: name, action: 'created',
    after: { path: name, exists: true, hash: hash.update(block.subarray(0, 1)).digest('hex'), size } }] };
  assert.equal(await project.capture({ ...f, journal }), null);
  const received = await project.capture({ ...f, journal, verifiedTransfer: true });
  assert.deepEqual(received.items.map(item => item.metadata.relative), [name]);
  journal.files[0].after.hash = 'a'.repeat(64);
  assert.equal(await project.capture({ ...f, journal, verifiedTransfer: true }), null);
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
  assert.equal(local.archive.files.length, 1);
  assert.equal(JSON.stringify(await history.exportPortable(row.id)).includes('localArtifactHistory'), false);
  // Simulate an upgrade from a receipts-only replica after native history cleanup.
  const stored = await store.deviceHistory(row.id), catalog = await store.get(row.id);
  const { archive: formerArchive, ...legacy } = stored.localArtifactHistory;
  const { digest: formerDigest, savedAt, ...prior } = stored;
  await store.saveDeviceHistory(row.id, { ...prior, localArtifactHistory: legacy }, {
    expectedRevision: catalog.replicaRevision, expectedHistoryDigest: formerDigest });
  await require('../main/conversation/device-artifact-archive.cjs').discard(f.workRoot, row.id, formerArchive.generation);
  fs.unlinkSync(archive); current = b;
  await history.projectRows([]);
  const deadline = Date.now() + 5000;
  while (!(await store.deviceHistory(row.id)).localArtifactHistory.archive && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok((await store.deviceHistory(row.id)).localArtifactHistory.archive, 'Opening the history list upgrades old receipts');
  fs.rmSync(f.cwd, { recursive: true });
  const view = await history.open(row.id, { historyPreview: true, allowContinuation: true });
  assert.equal(view.cwd, undefined);
  const index = await runtime.snapshotAsync(view), id = index.items[0].artifactId;
  assert.equal((await runtime.action(view, view.ref, id, 'read', {})).text, 'result');
  const recovery = await history.prepareContinuation(row.id);
  assert.equal(recovery.artifactHistory.items[0].metadata.relative, name);
  // A continued segment may have a fresh workspace after the original was cleaned.
  const nextCwd = path.join(f.workRoot, 'new-workspace');
  fs.mkdirSync(nextCwd);
  const currentFile = path.join(nextCwd, 'new.txt');
  fs.writeFileSync(currentFile, 'new result');
  const live = { cwd: nextCwd, outputs: () => [{ path: currentFile, name: 'new.txt', size: 10, at: Date.now() }] };
  history.bindContinuationArtifacts(live, recovery, () => {});
  const display = await runtime.viewSnapshotAsync(live);
  const old = display.items.find(item => item.artifactId === id);
  assert.equal(old.relative, name);
  assert.equal(old.primary, false);
  assert.equal(old.changedInTurn, false);
  assert.equal(runtime.decorate('active', { items: [old] })[0].archivedReadOnly, true);
  assert.equal(display.delivery.items.some(item => item.artifactId === id), false);
  assert.equal(display.got.files.some(item => item.path === old.path), false);
  assert.equal((await runtime.snapshotAsync(live)).items.some(item => item.artifactId === id), false);
  assert.equal((await runtime.action(live, 'active', id, 'read', {})).text, 'result');
  assert.equal((await runtime.action(live, 'active', id, 'share', {})).ok, false);
  assert.equal((await runtime.action(live, 'active', id, 'reveal', {})).ok, false);
  assert.equal((await runtime.resolveAsync(live, id)).ok, false);
  const newFile = display.items.find(item => item.relative === 'new.txt');
  assert.equal((await runtime.action(live, 'active', newFile.artifactId, 'read', {})).text, 'new result');
  const colliding = path.join(nextCwd, name);
  fs.writeFileSync(colliding, 'later');
  live.outputs = () => [{ path: colliding, name, size: 5, at: Date.now() }];
  assert.equal((await runtime.viewSnapshotAsync(live)).items.filter(item => item.artifactId === id).length, 1);
  assert.equal((await runtime.action(live, 'active', id, 'read', {})).text, 'later');
  live.outputs = () => [];
  assert.equal((await history.open(row.id)).historyArtifacts, undefined);
  current = a;
  await assert.rejects(runtime.action(live, 'active', id, 'read', {}), /账号|会话/);
  await assert.rejects(runtime.action(view, view.ref, id, 'read', {}), /账号|会话/);
  const next = await history.open(row.id, { historyPreview: true });
  assert.equal((await runtime.snapshotAsync(next)).items.length, 1);
  const saved = await store.deviceHistory(row.id), latest = await store.get(row.id);
  await store.saveDeviceHistory(row.id, { snapshot: saved.snapshot, coverage: saved.coverage, historyProtection: 'account' },
    { expectedRevision: latest.replicaRevision });
  await assert.rejects(runtime.snapshotAsync(next), /版本|归属/);
});

test('an older file inventory can add a package and its private resource receipts from the original journal', async t => {
  const f = fixture(t);
  const archive = 'export/example.soduwork-plugin', script = 'author/scripts/check.py';
  const files = [archive, script, 'report.md'].map(relative => {
    const bytes = Buffer.from('Synthetic fixture');
    f.write(relative, bytes);
    return { path: relative, action: 'created', after: { exists: true, path: relative, size: bytes.length,
      hash: crypto.createHash('sha256').update(bytes).digest('hex') } };
  });
  const journal = { cwd: f.cwd, turnId: 'done', files };
  const old = await project.capture({ ...f, journal: { ...journal, files: files.slice(2) } });
  delete old.packageRecordedUntil;
  delete old.packageTurnId;
  const unchanged = await project.capture({ ...f, previous: old });
  assert.deepEqual(unchanged.items.map(row => row.metadata.relative), ['report.md']);
  const updated = await project.capture({ ...f, previous: unchanged, journal });
  assert.ok(updated.items.some(row => row.metadata.relative === archive));
  assert.ok(updated.resources.some(row => row.metadata.relative === script));
  const reader = project.view(f.cwd, updated, () => {});
  assert.equal(reader.verify(path.join(f.cwd, script)), false);
  assert.equal(reader.snapshot().items.some(item => item.relative === script), false);
});

function archiveSetup(t) {
  const f = fixture(t), storage = require('../main/conversation/device-artifact-archive.cjs');
  const fileStamp = require('../main/conversation/runtime-artifacts.cjs').stamp;
  const row = (relative, content) => {
    const target = f.write(relative, content), stat = fs.lstatSync(target, { bigint: true });
    return { metadata: { relative, size: Number(stat.size) }, stamp: fileStamp(stat) };
  };
  const save = (items, previous, guard = () => {}) => storage.preserve(f.workRoot, f.row.id,
    { root: f.cwd, items, resources: [] }, previous, guard);
  const root = history => storage.projection(f.workRoot, f.row.id, history).root;
  return { ...f, row, save, root, storage };
}

for (const change of ['final timestamp', 'replaced file', 'modified bytes']) {
  test('archive verifies the closed writer after ' + change, async t => {
    const f = archiveSetup(t), row = f.row('result.txt', 'original');
    const promises = require('node:fs/promises'), open = promises.open.bind(promises);
    t.mock.method(promises, 'open', async (file, flags, ...args) => {
      const handle = await open(file, flags, ...args);
      if (flags !== 'wx' || path.basename(file) !== 'result.txt') return handle;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        if (change === 'replaced file') {
          await promises.rename(file, file + '.old');
          await promises.writeFile(file, 'original');
        }
        if (change === 'modified bytes') await promises.writeFile(file, 'tampered');
        // Windows can finalize the last-write timestamp when the writer closes.
        await promises.utimes(file, 1000, 1000);
      };
      return handle;
    });
    if (change !== 'final timestamp') {
      await assert.rejects(f.save([row]), /Artifact archive file changed/);
      return;
    }
    const history = await f.save([row]);
    const archived = history.archive.files[0], root = f.root(history);
    assert.equal((await f.storage.readVersion(root, archived.relative, archived.stamp))?.toString(), 'original');
  });
}

test('archived history uses the canonical profile path and rejects links inside the generation', async t => {
  const f = archiveSetup(t), source = f.row('result.txt', 'archived');
  const profile = path.join(f.workRoot, 'profile');
  fs.mkdirSync(profile);
  const saved = await f.storage.preserve(profile, 'one',
    { version: 1, root: f.cwd, items: [{ ...source, metadata: { ...source.metadata,
      artifactId: 'output', kind: 'document' } }], resources: [] }, null, () => {});
  fs.rmSync(f.cwd, { recursive: true });
  // TEMP on Windows can use an 8.3 spelling. A trusted ancestor alias exercises
  // the same distinction between a profile's spelling and its native realpath.
  const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-profile-alias-'));
  t.after(() => fs.rmSync(aliasRoot, { recursive: true, force: true }));
  const alias = path.join(aliasRoot, 'ancestor');
  fs.symlinkSync(f.workRoot, alias, 'junction');
  const throughAlias = path.join(alias, 'profile');
  const archived = project.archivedView(throughAlias, 'one', f.cwd, saved, () => {}, () => {});
  assert.deepEqual(archived.snapshot().items.map(item => fs.readFileSync(item.path, 'utf8')), ['archived']);
  const generation = f.storage.projection(profile, 'one', saved).root;
  fs.renameSync(generation, generation + '-outside');
  fs.symlinkSync(generation + '-outside', generation, 'junction');
  assert.equal(f.storage.projection(throughAlias, 'one', saved), null);
});

test('archive repairs missing and changed files from their exact workspace receipts', async t => {
  const f = archiveSetup(t), rows = [f.row('shots/menu.png', 'pixels'), f.row('index.html', 'site')];
  const first = await f.save(rows);
  fs.unlinkSync(path.join(f.root(first), 'shots/menu.png'));
  fs.writeFileSync(path.join(f.root(first), 'index.html'), 'oops');
  const restored = await f.save(rows, first);
  assert.notEqual(restored.archive.generation, first.archive.generation);
  assert.equal(fs.readFileSync(path.join(f.root(restored), 'shots/menu.png'), 'utf8'), 'pixels');
  assert.equal(fs.readFileSync(path.join(f.root(restored), 'index.html'), 'utf8'), 'site');
});

test('archive still consults the original when a previous receipt disappeared during extension', async t => {
  const f = archiveSetup(t), firstRow = f.row('a.txt', 'a');
  const first = await f.save([firstRow]);
  fs.unlinkSync(path.join(f.root(first), 'a.txt'));
  const restored = await f.save([firstRow, f.row('b.txt', 'b')], first);
  assert.deepEqual(restored.archive.files.map(row => row.relative), ['a.txt', 'b.txt']);
});

test('publication and cleanup refuse a replaced generation', async t => {
  const f = archiveSetup(t), rows = [f.row('a.txt', 'a')];
  const storage = path.join(f.workRoot, 'conversation-artifacts');
  let foreign;
  function swap() {
    if (foreign || !fs.existsSync(storage)) return;
    const base = path.join(storage, fs.readdirSync(storage)[0]);
    const name = fs.readdirSync(base)[0];
    if (!name) return;
    const current = path.join(base, name);
    if (!fs.existsSync(path.join(current, 'a.txt'))) return;
    fs.renameSync(current, current + '.replaced');
    fs.mkdirSync(current);
    foreign = path.join(current, 'foreign.txt');
    fs.writeFileSync(foreign, 'preserve replacement');
  }
  await assert.rejects(f.save(rows, null, swap));
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'preserve replacement');
});

test('archive limits use actual recorded bytes even when a metadata size is stale', async t => {
  const f = archiveSetup(t), wrong = f.row('wrong.txt', '123456');
  wrong.metadata.size = 0;
  const archived = await f.save([wrong, f.row('right.txt', 'ok')]);
  assert.deepEqual(archived.archive.files.map(row => row.relative), ['right.txt']);
  assert.equal(archived.archive.omitted, 1);
});

test('archive keeps committed output when another file has disappeared from both sources', async t => {
  const f = archiveSetup(t), rows = [f.row('shots/menu.png', 'image'), f.row('index.html', 'site')];
  const prior = await f.save(rows), old = f.root(prior);
  fs.unlinkSync(path.join(f.cwd, 'shots/menu.png'));
  fs.unlinkSync(path.join(old, 'shots/menu.png'));
  fs.unlinkSync(path.join(f.cwd, 'index.html'));
  const recovered = await f.save(rows, prior);
  assert.equal(recovered.archive.omitted, 1);
  assert.equal(recovered.archive.generation, prior.archive.generation);
  assert.equal(recovered.archivePending, true);
  assert.deepEqual(recovered.archive.files.filter(row => fs.existsSync(path.join(old, row.relative))).map(row => row.relative), ['index.html']);
  assert.equal(recovered.archive.files.find(row => row.relative === 'shots/menu.png').sha256,
    prior.archive.files.find(row => row.relative === 'shots/menu.png').sha256);
  assert.equal(fs.readFileSync(path.join(f.root(recovered), 'index.html'), 'utf8'), 'site');
});

test('a directory flush failure cannot publish or delete a previous generation', { skip: process.platform === 'win32' }, async t => {
  const f = archiveSetup(t), row = f.row('a.txt', 'a'), prior = await f.save([row]);
  const old = f.root(prior);
  const promises = require('node:fs/promises'), open = promises.open.bind(promises);
  t.mock.method(promises, 'open', async (...args) => {
    if (typeof args[1] === 'number' && (args[1] & fs.constants.O_DIRECTORY))
      return { sync: async () => { throw Error('simulated directory flush failure'); }, close: async () => {} };
    return open(...args);
  });
  await assert.rejects(f.save([row, f.row('nested/b.txt', 'b')], prior), /simulated directory flush failure/);
  assert.equal(fs.readFileSync(path.join(old, 'a.txt'), 'utf8'), 'a');
  assert.deepEqual(fs.readdirSync(path.dirname(old)), [prior.archive.generation]);
});

test('cleanup failures preserve the original scope or storage error', async t => {
  const f = archiveSetup(t), row = f.row('a.txt', 'a');
  const promises = require('node:fs/promises');
  const denial = Object.assign(Error('account changed'), { historyAccessFailure: true });
  t.mock.method(promises, 'rm', async () => { throw Object.assign(Error('busy'), { code: 'EBUSY' }); });
  await assert.rejects(f.save([row], null, () => {
    if (fs.existsSync(path.join(f.workRoot, 'conversation-artifacts'))) throw denial;
  }), error => {
    assert.equal(error, denial);
    assert.equal(error.cleanupFailure, 'EBUSY');
    return true;
  });
});

test('moving to a new work directory preserves old archived outputs without granting access there', async t => {
  const f = fixture(t), archive = require('../main/conversation/device-artifact-archive.cjs');
  const next = path.join(f.workRoot, 'another-project');
  fs.mkdirSync(next);
  async function capture(cwd, relative, data, previous) {
    fs.writeFileSync(path.join(cwd, relative), data);
    const journal = { cwd, turnId: crypto.randomUUID(), files: [{ action: 'created', path: relative,
      after: { exists: true, path: relative, size: Buffer.byteLength(data), hash: crypto.createHash('sha256').update(data).digest('hex') } }] };
    const current = await project.capture({ row: { ...f.row, cwd }, journal, previous });
    return archive.preserve(f.workRoot, f.row.id, archive.retain(previous, current), previous, () => {});
  }
  const first = await capture(f.cwd, 'history.txt', 'first');
  fs.rmSync(f.cwd, { recursive: true });
  fs.writeFileSync(path.join(next, 'history.txt'), 'other project file');
  const latest = await capture(next, 'second.txt', 'second', first);
  const live = project.view(next, latest, () => {});
  assert.equal(live.verify(path.join(next, 'history.txt')), false);
  const archived = project.archivedView(f.workRoot, f.row.id, next, latest, () => {}, () => {});
  assert.deepEqual(archived.snapshot().items.map(item => fs.readFileSync(item.path, 'utf8')).sort(), ['first', 'second']);
});

test('a continued website serves only verified historical resources and revokes its running preview on scope change', async t => {
  const f = fixture(t), storage = require('../main/conversation/device-artifact-archive.cjs');
  const files = [['site/index.html', '<link rel="stylesheet" href="style.css">'], ['site/style.css', 'body{}'],
    ['site/shot.png', Buffer.from([137, 80, 78, 71])]].map(([name, content]) => {
    const bytes = Buffer.from(content);
    f.write(name, bytes);
    return { action: 'created', path: name, after: { exists: true, path: name, size: bytes.length,
      hash: crypto.createHash('sha256').update(bytes).digest('hex') } };
  });
  const indexed = await project.capture({ ...f, journal: { cwd: f.cwd, turnId: 'previous', files } });
  const archived = await storage.preserve(f.workRoot, f.row.id, indexed, null, () => {});
  const saved = storage.projection(f.workRoot, f.row.id, archived);
  let active = true;
  const guard = () => { if (!active) throw Error('scope changed'); };
  const reader = project.view(saved.root, saved, guard);
  fs.rmSync(f.cwd, { recursive: true });
  fs.writeFileSync(path.join(saved.root, 'site', 'not-recorded.txt'), 'private');
  const replacement = path.join(f.workRoot, 'next');
  fs.mkdirSync(replacement);
  const handle = { cwd: replacement, outputs: () => [] };
  runtime.bindContinuationArchive(handle, async () => reader);
  const result = await runtime.viewSnapshotAsync(handle);
  assert.equal(result.delivery.items.length, 0);
  const website = result.items.find(item => item.kind === 'website');
  const shot = result.items.find(item => item.kind === 'image');
  assert.equal((await runtime.decorateForSharing('stable', { items: [website] }))[0].websiteDirectoryId, undefined);
  assert.equal((await runtime.action(handle, 'stable', shot.artifactId, 'image-full', {})).data, 'iVBORw==');
  const ref = 'active-history-archive'; t.after(() => runtime.closeRef(ref));
  const preview = await runtime.preview(handle, ref, website.artifactId);
  assert.equal(preview.ok, true);
  assert.equal(await (await fetch(new URL('style.css', preview.url))).text(), 'body{}');
  assert.equal((await fetch(new URL('not-recorded.txt', preview.url))).status, 404);
  assert.equal((await runtime.action(handle, ref, website.artifactId, 'share-related', {})).ok, false);
  active = false;
  assert.equal((await fetch(preview.url)).status, 404);
});

test('deleting an archived chat detaches only its files and reclaims interrupted deletions', async t => {
  const f = fixture(t), storage = require('../main/conversation/device-artifact-archive.cjs');
  const first = archiveSetup(t), previous = await first.save([first.row('notes.txt', 'keep')]);
  const keep = first.root(previous);
  const store = path.join(f.workRoot, 'conversation-artifacts');
  const session = 'deleted-chat';
  const directory = path.join(store, crypto.createHash('sha256').update(session).digest('hex'));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'synthetic'), '');
  const interrupted = path.join(store, 'removed-' + crypto.randomUUID());
  fs.mkdirSync(interrupted);
  await storage.detach(f.workRoot, session);
  assert.equal(fs.existsSync(directory), false);
  await storage.reclaim(f.workRoot);
  assert.equal(fs.existsSync(interrupted), false);
  assert.ok(fs.existsSync(path.join(keep, 'notes.txt')));
});

test('existing recoverable bytes take priority over later receipts at the file-count limit', async t => {
  const f = archiveSetup(t), old = f.row('last.txt', 'saved'), prior = await f.save([old]);
  fs.unlinkSync(path.join(f.cwd, 'last.txt'));
  const newRows = Array.from({ length: 4000 }, (_, i) => ({ ...old,
    metadata: { ...old.metadata, relative: 'new-' + i + '.txt' } }));
  const after = await f.save([...newRows, old], prior);
  assert.equal(after.archive.generation, prior.archive.generation);
  assert.equal(after.archive.omitted, 4000);
  assert.equal(fs.readFileSync(path.join(f.root(after), 'last.txt'), 'utf8'), 'saved');
});

test('a missing replacement keeps its older archived revision and can later publish the new bytes', async t => {
  const f = archiveSetup(t), old = f.row('result.txt', 'old saved bytes'), prior = await f.save([old]);
  const updated = f.row('result.txt', 'new bytes'), held = path.join(f.cwd, 'held.txt');
  fs.renameSync(path.join(f.cwd, 'result.txt'), held);
  const missing = await f.save([updated, f.row('other.txt', 'other')], prior);
  assert.equal(missing.archive.omitted, 1);
  assert.equal(fs.readFileSync(path.join(f.root(missing), 'result.txt'), 'utf8'), 'old saved bytes');
  assert.ok(missing.items.some(row => row.archiveOnly && row.metadata.relative === 'result.txt'));
  assert.ok(missing.items.some(row => !row.archiveOnly && row.metadata.relative === 'result.txt'));
  const back = f.row('result.txt', 'restored version'), recovered = await f.save([back], missing);
  assert.equal(recovered.archive.omitted, 0);
  assert.ok(!recovered.items.some(row => row.archiveOnly && row.metadata.relative === 'result.txt'));
  assert.equal(fs.readFileSync(path.join(f.root(recovered), 'result.txt'), 'utf8'), 'restored version');
});

test('an unchanged unavailable source keeps the current generation until more bytes are verifiable', async t => {
  const f = archiveSetup(t);
  const rows = [f.row('report.txt', 'report'), f.row('missing.txt', 'missing')];
  fs.unlinkSync(path.join(f.cwd, 'missing.txt'));
  const first = await f.save(rows);
  const second = await f.save(rows, first);
  assert.equal(second.archive.generation, first.archive.generation);
  assert.equal(second.archive.omitted, 1);
  const latest = await f.save([rows[0], f.row('missing.txt', 'replacement')], second);
  assert.notEqual(latest.archive.generation, first.archive.generation);
  assert.equal(latest.archive.omitted, 0);
});

test('four retained sparse 128 MiB files reserve the byte budget ahead of a new one-byte output', async t => {
  const f = archiveSetup(t), initial = await f.save([f.row('stub.txt', 'stub')]);
  const copyRoot = f.root(initial), rows = [], files = [], size = 128 * 1024 * 1024;
  const stamp = require('../main/conversation/runtime-artifacts.cjs').stamp;
  const hash = crypto.createHash('sha256'), block = Buffer.alloc(1024 * 1024);
  for (let n = 0; n < 128; n++) hash.update(block);
  const sha256 = hash.digest('hex');
  for (let n = 0; n < 4; n++) {
    const relative = 'archived-' + n + '.txt';
    const file = path.join(copyRoot, relative), original = path.join(f.cwd, relative);
    for (const target of [file, original]) {
      const fd = fs.openSync(target, 'wx');
      try { fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); }
    }
    const sourceStamp = stamp(fs.statSync(original, { bigint: true }));
    files.push({ relative, sha256, sourceStamp, stamp: stamp(fs.statSync(file, { bigint: true })) });
    rows.push({ metadata: { relative, size }, stamp: sourceStamp, archiveOnly: true });
    fs.unlinkSync(original);
  }
  const prior = { ...initial, items: rows, archive: { ...initial.archive, files } };
  const fresh = f.row('new.txt', 'x');
  const latest = await f.save([fresh, ...rows], prior);
  assert.equal(latest.archive.generation, prior.archive.generation);
  assert.deepEqual(latest.archive.files.map(row => row.relative), files.map(row => row.relative));
  assert.equal(latest.archive.omitted, 1);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'new.txt'), 'utf8'), 'x');
  fs.unlinkSync(path.join(copyRoot, files[0].relative));
  const offline = await f.save([fresh, ...rows], latest);
  assert.equal(offline.archive.generation, prior.archive.generation);
  assert.equal(offline.archivePending, true);
  assert.equal(offline.archive.omitted, 2);
});

test('a partial legacy archive can finish after restart when the original receipt becomes readable again', async t => {
  let history;
  const f = fixture(t, () => history?.close()), app = { getPath: () => f.workRoot };
  const identity = require('./helpers/platform-session-fixture.cjs').identity();
  const row = { id: 'legacy-partial', adapterId: 'pi', cwd: f.cwd, count: 1,
    workOwner: require('../main/platform-connections/runtime.cjs').scope(identity),
    creator: { account: 'one', hub: identity.hub } };
  const open = () => require('../main/conversation/shared-history.cjs').create({ app, identityOf: () => identity,
    session: { historyEntry: async () => ({ ok: false, notFound: true }), archivedConversation: async () => null,
      findBySessionId: () => null }, store: require('../main/conversation/replica-store.cjs')
      .createWorker(path.join(f.workRoot, 'conversation-replicas', 'history.sqlite')) });
  const names = ['first.md', 'volume/second.md'];
  const files = names.map(name => {
    f.write(name, name);
    return { action: 'created', path: name, after: { exists: true, path: name, size: Buffer.byteLength(name),
      hash: crypto.createHash('sha256').update(name).digest('hex') } };
  });
  const receipts = await project.capture({ row, journal: { cwd: f.cwd, turnId: 'legacy-turn', files } });
  history = open();
  const [entry] = await history.register([row]);
  await history.store.saveDeviceHistory(row.id, { localArtifactHistory: receipts,
    snapshot: { messages: [{ role: 'user', text: 'Keep my outputs' }], tools: [] }, coverage: { complete: true, sources: [] } },
  { expectedRevision: entry.replicaRevision });
  const mounted = path.join(f.cwd, 'volume'), unmounted = path.join(f.workRoot, 'disconnected');
  fs.renameSync(mounted, unmounted);
  async function awaitArchived(count) {
    const end = Date.now() + 5000;
    let files;
    do {
      files = (await history.store.deviceHistory(row.id)).localArtifactHistory.archive?.files || [];
      if (files.length === count) break;
      await delay(10);
    } while (Date.now() < end);
    return files.map(item => item.relative).sort();
  }
  await history.projectRows([]);
  assert.deepEqual(await awaitArchived(1), [names[0]]);
  await history.close();
  fs.renameSync(unmounted, mounted);
  fs.unlinkSync(path.join(f.cwd, names[0]));
  history = open();
  await history.projectRows([]);
  assert.deepEqual(await awaitArchived(2), names);
  fs.rmSync(f.cwd, { recursive: true });
  const view = await history.open(row.id, { historyPreview: true });
  const result = await runtime.snapshotAsync(view);
  for (const name of names) {
    const item = result.items.find(item => item.relative === name);
    assert.equal((await runtime.action(view, view.ref, item.artifactId, 'read', {})).text, name);
  }
  await view.close();
});

test('new progress retains an unavailable prior generation until its original bytes can be authenticated again', async t => {
  const f = archiveSetup(t), store = require('../main/conversation/device-artifact-archive.cjs');
  const a = f.row('first.txt', 'first'), b = f.row('missing.txt', 'recoverable');
  const prior = await f.save([a, b]), old = f.root(prior), missing = path.join(old, b.metadata.relative);
  fs.unlinkSync(missing);
  fs.unlinkSync(path.join(f.cwd, b.metadata.relative));
  const added = f.row('later.txt', 'new'), next = await f.save([a, b, added], prior);
  assert.notEqual(next.archive.generation, prior.archive.generation);
  assert.equal(next.archive.pendingFiles[0].generation, prior.archive.generation);
  assert.equal(next.archive.pendingFiles[0].sha256, prior.archive.files.find(file => file.relative === b.metadata.relative).sha256);
  await store.retire(f.workRoot, 'runner-native-ref', prior.archive, next.archive, true);
  assert.ok(fs.existsSync(old));
  fs.rmSync(f.cwd, { recursive: true });
  fs.writeFileSync(missing, 'untrusted!!');
  const stale = await store.preserve(f.workRoot, 'runner-native-ref', next, next, () => {}, { readWorkspace: false });
  assert.equal(stale.archive.generation, next.archive.generation);
  fs.writeFileSync(missing, 'recoverable');
  const fixed = await store.preserve(f.workRoot, 'runner-native-ref', next, next, () => {}, { readWorkspace: false });
  assert.equal(fixed.archive.omitted, 0);
  assert.equal(fixed.archive.pendingFiles, undefined);
  assert.equal(fs.readFileSync(path.join(f.root(fixed), b.metadata.relative), 'utf8'), 'recoverable');
  await store.retire(f.workRoot, 'runner-native-ref', next.archive, fixed.archive, true);
  assert.ok(!fs.existsSync(old));
  assert.ok(!fs.existsSync(f.root(next)));
  assert.ok(fs.existsSync(f.root(fixed)));
});
