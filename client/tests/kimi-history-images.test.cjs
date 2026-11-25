'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const history = require('../main/conversation/device-history.cjs');
const archive = require('../main/conversation/device-artifact-archive.cjs');
const artifacts = require('../main/conversation/artifact-runtime');
const versions = require('../main/conversation/artifact-versions.cjs');
const segments = require('../main/conversation/runtime-segments');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-history-')));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const taskId = 'chat-abcdef-1234', cwd = path.join(profile, 'workspaces', 'temp', taskId);
  const dispatch = 'chat:' + taskId + ':kimi', id = require('../main/agent-runtime/runner-adapter').runnerRefForDispatch(dispatch);
  const app = { getPath: () => profile }, row = { id, cwd, adapterId: 'kimi', replicaRevision: 1 };
  const part = { adapterId: 'kimi', sessionId: id, nativeDispatchId: dispatch, started: true, ref: taskId };
  await segments.save(app, { version: 1, id, cwd, segments: [], active: part });
  const cliSid = 'session_' + crypto.randomUUID(), project = 'wd_' + taskId + '_' + digest(cwd.split(path.sep).join('/')).slice(0, 12);
  const directory = path.join(profile, 'runner/data/.kimi-code/sessions', project, cliSid);
  function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX9sAAAAASUVORK5CYII=', 'base64');
  const key = 'f_' + crypto.createHash('sha256').update('image/png').update('\0').update(png).digest('hex');
  const relative = 'star.png', file = path.join(cwd, relative);
  const blocks = [{ type: 'text', text: '<image path="' + file.split(path.sep).join('/') + '">' },
    { type: 'image_url', imageUrl: { url: 'kimi-file://' + key } }, { type: 'text', text: '</image>' }];
  const reply = ['```soduwork-media', JSON.stringify({ type: 'image', items: [{ url: relative }] }), '```'].join('\n');
  const seq = [
    { kind: 'user', text: 'Draw the star' },
    { kind: 'do', tool: 'ReadMediaFile', callId: '0:call' },
    { kind: 'out', tool: 'ReadMediaFile', callId: '0:call', text: JSON.stringify(blocks) },
    { kind: 'say', text: reply, streamId: 'answer', done: true },
  ].map((event, index) => ({ ...event, seq: index + 1, seg: 1 }));
  const wire = [{ type: 'tool.call', turnId: '0', name: 'ReadMediaFile', toolCallId: 'call', uuid: 'uuid', args: { path: file } },
    { type: 'tool.result', toolCallId: 'call', parentUuid: 'uuid', result: { isError: false, output: blocks } },
    { type: 'content.part', turnId: '0', part: { type: 'text', text: reply } }]
    .map(event => ({ type: 'context.append_loop_event', agentId: 'main', event }));
  wire.push({ type: 'turn.ended', agentId: 'main', turnId: 0, reason: 'completed' });
  const wireFile = path.join(directory, 'agents/main/wire.jsonl');
  const writeWire = () => write(wireFile, wire.map(value => JSON.stringify(value)).join('\n') + '\n');
  writeWire();
  const metaPath = path.join(profile, 'runner/data/local-runs', id, 'meta.json');
  const meta = { ref: id, taskId, cliSid, cli: 'kimi', ws: cwd, seq: 4, eventDestination: 'local', state: 'done' };
  write(metaPath, JSON.stringify(meta));
  write(path.join(directory, 'state.json'), JSON.stringify({ id: cliSid, cwd }));
  write(path.join(directory, 'media/meta', key + '.json'), JSON.stringify({ version: 1, key: key + '.png', name: relative, mediaType: 'image/png' }));
  const media = path.join(directory, 'media', key + '.png'); write(media, png);
  let body, saves = 0;
  const store = { deviceHistory: async () => body, saveDeviceHistory: async (_id, value) => {
    const checksum = digest(JSON.stringify(value)); body = { ...value, digest: checksum }; saves++; return { ok: true, digest: checksum };
  }, markArchiveReviewed: async () => {} };
  const api = history.create({ app, store, resolve: async () => row, register: async () => {}, guard: () => () => {},
    allowsArtifacts: () => true, runtime: { rpc: async (op, options) => {
      assert.equal(op, 'job.session'); return { ok: true, data: { ref: id, seq: seq.length, items: seq.slice(options.since) } };
    } } });
  return { profile, row, app, api, store, png, file, relative, media, meta, metaPath, wire, writeWire, wireFile, write, seq,
    get saves() { return saves; }, seed(value) { body = value; } };
}

test('first native read recovers the exact private screenshot without its workspace and retains the first turn receipt', async t => {
  const f = await fixture(t);
  const data = await f.api.saved(f.row.id, { refresh: true });
  assert.equal(data.coverage.complete, true);
  assert.equal(f.saves, 1, 'original is committed in the same write as the fresh transcript');
  const recorded = data.localArtifactHistory, [version] = recorded.archive.versions;
  assert.equal(version.relative, f.relative);
  assert.equal(version.source.userMessageIndex, 0);
  assert.equal(version.sha256, digest(f.png));
  assert.deepEqual(recorded.items, [], 'the cache cannot grant workspace access');
  f.write(f.file, 'later workspace replacement');
  fs.unlinkSync(f.media); fs.unlinkSync(f.wireFile);
  const again = await f.api.saved(f.row.id);
  assert.equal(f.saves, 1);
  assert.deepEqual(again.localArtifactHistory.archive.versions, [version]);
  const handle = { historyArtifacts: require('../main/conversation/device-history-artifacts.cjs')
    .archivedView(f.profile, f.row.id, f.row.cwd, recorded, () => {}, async () => {}) };
  artifacts.bindTurnArchives(handle, () => versions.readers(f.profile, f.row.id, recorded.archive, () => {}));
  const result = await artifacts.action(handle, 'verified-native-media', 'version:' + version.versionId, 'image-full', {});
  assert.equal(result.ok, true);
  assert.deepEqual(Buffer.from(result.data, 'base64'), f.png);
});

test('a restored, completed Kimi segment archive wins over an earlier read of the same image in previews and exports', async t => {
  const f = await fixture(t);
  const data = await f.api.saved(f.row.id, { refresh: true });
  const initial = data.localArtifactHistory.archive.versions[0];
  const finalPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=', 'base64');
  f.write(f.file, finalPng);
  const receipts = require('../main/conversation/device-history-artifacts.cjs');
  const captured = await receipts.capture({ row: f.row, journal: { cwd: f.row.cwd, turnId: 'legacy-final',
    files: [{ action: 'modified', path: f.relative, after: { exists: true, path: f.relative, size: finalPng.length, hash: digest(finalPng) } }] } });
  assert.equal(captured.items[0].source.turnId, undefined);
  const last = await archive.preserve(f.profile, f.row.id, captured, null, () => {});
  fs.unlinkSync(f.file);
  // The original may already exist on the first open or return after a
  // previous open recovered an intermediate native image.
  for (const hadNative of [false, true]) {
    const prior = hadNative ? { ...last, archive: { ...last.archive, versions: [initial] } } : last;
    f.seed({ ...data, localArtifactHistory: prior });
    const saved = (await f.api.saved(f.row.id)).localArtifactHistory;
    const [version] = saved.archive.versions;
    assert.equal(saved.archive.versions.length, 1);
    assert.equal(version.sha256, digest(finalPng));
    assert.equal(version.generation, last.archive.generation);
    assert.equal(version.source.userMessageIndex, 0);
    const handle = { historyArtifacts: receipts.archivedView(f.profile, f.row.id, f.row.cwd, saved, () => {}, async () => {}) };
    artifacts.bindTurnArchives(handle, () => versions.readers(f.profile, f.row.id, saved.archive, () => {}));
    const result = await artifacts.action(handle, 'history', 'version:' + version.versionId, 'image-full', {});
    assert.deepEqual(Buffer.from(result.data, 'base64'), finalPng);
    const copy = await versions.exportCopy({ profile: f.profile, id: f.row.id, archive: saved.archive, versionId: version.versionId,
      workspace: f.row.cwd, workspaceKey: crypto.randomUUID(), guard: () => {} });
    assert.deepEqual(fs.readFileSync(copy.path), finalPng);
  }
  const foreign = { ...last, items: last.items.map(entry => ({ ...entry, source: { ...entry.source, sessionId: crypto.randomUUID() } })) };
  f.seed({ ...data, localArtifactHistory: foreign });
  const other = (await f.api.saved(f.row.id)).localArtifactHistory;
  assert.equal(other.archive.versions[0].sha256, digest(f.png), 'another segment cannot claim this turn by filename');
});

test('two Kimi turns reusing a path keep their own native bytes when a segment receipt cannot identify the final writer', async t => {
  const f = await fixture(t);
  const second = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=', 'base64');
  const key = 'f_' + crypto.createHash('sha256').update('image/png').update('\0').update(second).digest('hex');
  const blocks = JSON.parse(f.seq[2].text);
  blocks[1].imageUrl.url = 'kimi-file://' + key;
  f.seq.push({ ...f.seq[0], seq: 5, text: 'Redraw the star' }, { ...f.seq[1], seq: 6, callId: '1:second' },
    { ...f.seq[2], seq: 7, callId: '1:second', text: JSON.stringify(blocks) }, { ...f.seq[3], seq: 8, streamId: 'answer-2' });
  const secondWire = structuredClone(f.wire);
  Object.assign(secondWire[0].event, { turnId: '1', toolCallId: 'second', uuid: 'second-uuid' });
  Object.assign(secondWire[1].event, { toolCallId: 'second', parentUuid: 'second-uuid', result: { isError: false, output: blocks } });
  secondWire[2].event.turnId = '1'; secondWire[3].turnId = 1;
  f.wire.push(...secondWire); f.writeWire();
  f.meta.seq = 8; f.write(f.metaPath, JSON.stringify(f.meta));
  const mediaDir = path.dirname(f.media);
  f.write(path.join(mediaDir, key + '.png'), second);
  f.write(path.join(mediaDir, 'meta', key + '.json'), JSON.stringify({ version: 1, key: key + '.png', name: f.relative, mediaType: 'image/png' }));
  const data = await f.api.saved(f.row.id, { refresh: true });
  f.write(f.file, second);
  const receipts = require('../main/conversation/device-history-artifacts.cjs');
  const generic = await receipts.capture({ row: f.row, journal: { cwd: f.row.cwd, turnId: 'legacy',
    files: [{ action: 'modified', path: f.relative, after: { exists: true, path: f.relative, size: second.length, hash: digest(second) } }] } });
  f.seed({ ...data, localArtifactHistory: await archive.preserve(f.profile, f.row.id, generic, null, () => {}) });
  fs.unlinkSync(f.file);
  const saved = (await f.api.saved(f.row.id)).localArtifactHistory;
  const turns = saved.archive.versions;
  assert.deepEqual(turns.map(v => [v.source.userMessageIndex, v.sha256]), [[0, digest(f.png)], [2, digest(second)]]);
  assert.notEqual(turns[0].turnId, turns[1].turnId);
  for (const [i, v] of turns.entries()) {
    const copy = await versions.exportCopy({ profile: f.profile, id: f.row.id, archive: saved.archive, versionId: v.versionId,
      workspace: f.row.cwd, workspaceKey: crypto.randomUUID(), guard: () => {} });
    assert.deepEqual(fs.readFileSync(copy.path), i ? second : f.png);
  }
});

test('same-name files, missing native receipts or another session cannot supply a legacy image', async t => {
  const f = await fixture(t);
  f.write(f.file, f.png);
  for (const change of [
    ['foreign workspace', () => { f.meta.ws += '-other'; f.write(f.metaPath, JSON.stringify(f.meta)); }],
    ['wrong native turn', () => { f.meta.ws = f.row.cwd; f.write(f.metaPath, JSON.stringify(f.meta)); f.wire[2].event.turnId = '1'; f.writeWire(); }],
    ['reused call', () => { f.wire[2].event.turnId = '0'; f.wire.splice(1, 0, f.wire[0]); f.writeWire(); }],
    ['replaced cached bytes', () => { f.wire.splice(1, 1); f.writeWire(); f.write(f.media, 'different pixels'); }],
    ['deleted native media', () => fs.unlinkSync(f.media)],
  ]) {
    change[1](); f.seed(undefined);
    const opened = await f.api.saved(f.row.id, { refresh: true });
    assert.equal(opened.coverage.complete, true, change[0]);
    assert.equal(opened.localArtifactHistory?.archive?.versions, undefined, change[0]);
  }
});

test('a failed archive update retires only generations allocated by the losing writer', async t => {
  const f = await fixture(t), profile = f.profile, id = f.row.id;
  const gs = Array.from({ length: 4 }, () => crypto.randomUUID());
  const dir = generation => archive.location(profile, id, { version: 1, generation });
  for (const g of gs) fs.mkdirSync(dir(g), { recursive: true });
  const before = { generation: gs[0], versions: [{ generation: gs[1] }] };
  const after = { ...before, versions: [...before.versions, { generation: gs[2] }, { generation: gs[3] }] };
  await archive.retire(profile, id, before, after, false, [gs[3]]);
  assert.deepEqual(gs.map(g => fs.existsSync(dir(g))), [true, true, true, false]);
});
