'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const workspaces = require('../main/conversation/delivery-workspace.cjs');
const journal = require('../main/conversation/file-change-journal');
const versions = require('../main/conversation/artifact-versions.cjs');
const runtime = require('../main/conversation/artifact-runtime');
const packages = require('../main/conversation/delivery-package-worker');
const { create: createHistory } = require('../main/conversation/shared-history.cjs');
const { identity } = require('./helpers/platform-session-fixture.cjs');

test('overlapping desktop chats retain separate turn originals, exported copies and restart downloads', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-overlapping-artifacts-')));
  const cwd = path.join(root, 'project'), profile = path.join(root, 'profile');
  await Promise.all([fs.mkdir(cwd), fs.mkdir(profile)]);
  const app = { getPath: () => profile };
  const account = identity(), rows = new Map();
  const bridge = require('../main/agent-runtime/pi-session-bridge').createPiSessionBridge({
    sessionModule: require('../main/agent-runtime/process-session'), runnerAdapters: [] });
  const handoff = require('../main/conversation/cloud-handoff').create({ app, identityOf: () => account });
  const workbench = require('../main/conversation/cloud-output-cache');
  const session = { historyEntry: async () => ({ ok: false, notFound: true }),
    archivedConversation: async (_app, id) => rows.get(id) };
  const openHistory = () => createHistory({ app, session, identityOf: () => account });
  let history = openHistory();
  t.after(async () => { await history.close(); await fs.rm(root, { recursive: true, force: true }); });
  function chat(id) {
    const deliveryWorkspace = workspaces.allocate(cwd);
    const row = { id, cwd, adapterId: 'pi', count: 0, at: 1 };
    rows.set(id, row);
    const messages = [];
    const handle = { ref: 'ref-' + id, sessionId: id, cwd, deliveryWorkspace, snapshot: () => ({ messages, tools: [] }),
      historyRow: () => ({ ...row, count: messages.length }) };
    const facade = bridge.attachView(handle);
    history.observe(facade, account);
    return { handle: facade, messages, draft: workspaces.ensure(cwd, deliveryWorkspace) };
  }
  const a = chat('one'), b = chat('two');
  async function finish(c, before, turnId, text) {
    const changes = journal.compare(before, await journal.snapshot(c.draft, { includeEvidence: true }), { turnId });
    c.messages.push({ role: 'user', text: turnId }, { role: 'assistant', text, done: true });
    await c.handle.captureArtifactTurn(changes);
  }
  const aBefore = await journal.snapshot(a.draft), bBefore = await journal.snapshot(b.draft);
  await Promise.all([fs.writeFile(path.join(a.draft, 'report.md'), 'A1'), fs.writeFile(path.join(b.draft, 'report.md'), 'B1'),
    fs.writeFile(path.join(cwd, 'unrelated.md'), 'project source')]);
  await Promise.all([finish(a, aBefore, 'a-first', 'A1'), finish(b, bBefore, 'b-first', 'B1')]);
  const old = await journal.snapshot(a.draft);
  await fs.writeFile(path.join(a.draft, 'report.md'), 'A2');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/askAAAAASUVORK5CYII=', 'base64');
  await fs.mkdir(path.join(a.draft, '.soduwork', 'evidence'), { recursive: true });
  await fs.writeFile(path.join(a.draft, '.soduwork', 'evidence', 'result.png'), image);
  await finish(a, old, 'a-second', 'A2');

  for (const [chat, expected] of [[a, ['A1', 'A2']], [b, ['B1']]]) {
    const parent = path.join(cwd, '会话成果', chat.handle.deliveryWorkspace.key);
    const directories = await fs.readdir(parent);
    const copies = await Promise.all(directories.map(dir => fs.readFile(path.join(parent, dir, 'report.md'), 'utf8')));
    assert.deepEqual(copies.sort(), expected);
  }
  // Live capture binds on the registered facade, while preparing the package
  // consults the native handle. Both must reach the same verified turn.
  const native = await handoff.artifactSession(a.handle);
  const live = (await runtime.viewSnapshotAsync(a.handle)).items.find(item => item.turnId === 'a-first');
  assert.equal((await packages.prepare(native, [live.artifactId])).bytes.toString(), 'A1');
  await history.close();
  await fs.rm(cwd, { recursive: true });
  history = openHistory();
  for (const [id, outputs] of [['one', ['A1', 'A2']], ['two', ['B1']]]) {
    const row = await history.store.get(id);
    assert.equal(row.deliveryWorkspaceKey, (id === 'one' ? a : b).handle.deliveryWorkspace.key);
    const body = await history.store.deviceHistory(id);
    const entries = versions.list(body.localArtifactHistory.archive);
    const files = entries.filter(file => file.relative === 'report.md');
    assert.deepEqual(files.map(file => file.relative), outputs.map(() => 'report.md'));
    const reader = await history.open(id, { historyPreview: true });
    const view = bridge.attachView(reader, { historyPreview: true });
    // The artifact IPC indexes the native source. The right workbench looks up
    // the registered facade by ref, even when the writable chat is still open.
    const listed = await runtime.viewSnapshotAsync(await handoff.artifactSession(bridge.get(view.ref)));
    const canvas = await workbench.project(bridge.get(view.ref));
    assert.notEqual(canvas, reader);
    for (const [index, expected] of outputs.entries()) {
      const artifactId = 'version:' + files[index].versionId;
      assert.ok(listed.items.some(item => item.artifactId === artifactId));
      const result = await runtime.resolveView(canvas, artifactId);
      assert.equal(result.ok, true, result.reason);
      assert.equal(await fs.readFile(result.path, 'utf8'), expected);
      assert.equal((await runtime.resolveView(Object.create(canvas), artifactId)).ok, false);
      const saved = await packages.prepare(view, [artifactId]);
      assert.equal(saved.bytes.toString(), expected);
    }
    if (id === 'one') {
      const screenshot = entries.find(file => file.relative === '.soduwork/evidence/result.png');
      assert.ok(screenshot);
      const savedImage = await packages.prepare(view, ['version:' + screenshot.versionId]);
      assert.equal(savedImage.manifest.entryPath, 'result.png');
      assert.deepEqual(savedImage.bytes, image);
    }
    assert.ok(entries.every(file => file.relative === 'report.md' || file.relative === '.soduwork/evidence/result.png'));
    await view.close();
    assert.equal(bridge.get(view.ref), null);
    assert.equal((await runtime.resolveView(canvas, 'version:' + files[0].versionId)).ok, false);
  }
  await bridge.dispose();
});

test('a text-only handoff can capture a new local artifact after target ownership is established', async t => {
  const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-handoff-artifact-')));
  const app = { getPath: () => profile }, account = identity();
  const cwd = path.join(profile, 'project');
  await fs.mkdir(cwd);
  const session = { historyEntry: async () => ({ ok: false, notFound: true }), archivedConversation: async () => null };
  const history = createHistory({ app, session, identityOf: () => account });
  t.after(async () => { await history.close(); await fs.rm(profile, { recursive: true, force: true }); });
  const scope = require('../main/platform-connections/runtime.cjs').scope(account);
  const transferId = 'text-only';
  const row = { id: 'transferred', cwd, adapterId: 'pi', workOwner: scope, deviceTransferId: transferId,
    deviceTransferDigest: 'test-digest', creator: { hub: account.hub, account: require('../main/device-auth-request').accountId(account) } };
  const [indexed] = await history.register([row]);
  const snapshot = { messages: [{ role: 'user', text: 'Write a report' }], tools: [] };
  await history.store.saveDeviceHistory(row.id, { snapshot, coverage: { complete: true, sources: [] },
    imported: { transferId, sha256: row.deviceTransferDigest } }, { expectedRevision: indexed.replicaRevision });
  const workspace = workspaces.allocate(cwd), draft = workspaces.ensure(cwd, workspace);
  const before = await journal.snapshot(draft);
  await fs.writeFile(path.join(draft, 'report.txt'), 'local version');
  const changed = journal.compare(before, await journal.snapshot(draft), { turnId: 'local-turn' });
  const handle = { sessionId: row.id, cwd, deliveryWorkspace: workspace, snapshot: () => snapshot, historyRow: () => row };
  await history.capture(handle, account, { completedJournal: changed });
  assert.equal((await history.store.deviceHistory(row.id)).localArtifactHistory, undefined);
  await require('../main/conversation/runtime-segments').save(app, { version: 1, id: row.id, owner: scope,
    hub: account.hub, cwd, segments: [], active: { sessionId: 'target-segment', adapterId: 'pi' }, deviceTransferId: transferId });
  await history.capture(handle, account, { completedJournal: changed });
  const saved = (await history.store.deviceHistory(row.id)).localArtifactHistory;
  assert.equal(saved.transferId, transferId);
  assert.deepEqual(versions.list(saved.archive).map(file => file.relative), ['report.txt']);
});
