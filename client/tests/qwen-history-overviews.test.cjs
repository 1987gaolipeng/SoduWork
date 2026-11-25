'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { recover } = require('../main/conversation/qwen-history-overviews.cjs');
const archive = require('../main/conversation/device-history-artifacts.cjs');
const versions = require('../main/conversation/artifact-versions.cjs');
const runtime = require('../main/conversation/artifact-runtime');
const segments = require('../main/conversation/runtime-segments');

async function fixture(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-turn-preview-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const name = 'chat-abcdef-1234', cwd = path.join(profile, 'temp', name), dispatch = 'chat:' + name + ':qwen';
  const id = require('../main/agent-runtime/runner-adapter').runnerRefForDispatch(dispatch);
  const app = { getPath: () => profile }, row = { id, cwd }, sid = crypto.randomUUID(), call = 'image', relative = 'p.png';
  await segments.save(app, { version: 1, id, cwd, segments: [], active: { sessionId: id, adapterId: 'qwen', started: true, nativeDispatchId: dispatch } });
  function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
  const meta = { ref: id, cli: 'qwen', ws: cwd, state: 'done', seq: 10, round: 1, cliSid: sid, taskId: name, eventDestination: 'local' };
  const root = path.join(profile, 'runner/data');
  const metaFile = path.join(root, 'local-runs', id, 'meta.json'); write(metaFile, JSON.stringify(meta));
  const sanitized = (process.platform === 'win32' ? cwd.toLowerCase() : cwd).replace(/[^A-Za-z0-9]/g, '-');
  const nativeFile = path.join(root, '.qwen/projects', sanitized, 'chats', sid + '.jsonl');
  const reply = ['```soduwork-media', JSON.stringify({ type: 'image', items: [{ url: relative }] }), '```'].join('\n');
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xd9]);
  const response = { id: call, name: 'read_file', response: { output: 'Image overview: 1x1; oriented source: 1x1.' },
    parts: [{ inlineData: { data: image.toString('base64'), mimeType: 'image/jpeg', displayName: relative } }] };
  const callPart = { id: call, name: 'read_file', args: { file_path: path.join(cwd, relative) } };
  const raw = [
    { type: 'system', subtype: 'session_model', provenance: 'system' },
    { type: 'user', provenance: 'real_user' },
    { type: 'assistant', provenance: 'assistant_output', message: { parts: [{ functionCall: callPart }] } },
    { type: 'tool_result', provenance: 'tool_result', message: { parts: [{ functionResponse: response }] },
      toolCallResult: { callId: call, status: 'success', executionStatus: 'success' } },
    { type: 'assistant', provenance: 'assistant_output', message: { parts: [{ text: reply }] } },
  ];
  function save() { write(nativeFile, raw.map((r, i) => JSON.stringify({ uuid: String(i + 1), parentUuid: i ? String(i) : null,
    timestamp: '2026-11-24T06:15:16Z', cwd, sessionId: sid, ...r })).join('\n')); }
  save();
  const data = { coverage: { complete: true, sources: [{ id, adapterId: 'qwen', revision: '10' }] },
    snapshot: { messages: [{ id: id + ':1', role: 'user' }, { id: id + ':1:1:say:s', role: 'assistant', done: true,
      sourceAgent: { agentId: 'qwen' }, blocks: [{ kind: 'text', text: reply }] }],
      tools: [{ id: id + ':' + id + ':2', after: 0, name: 'ReadFile', state: 'done', callId: call }] } };
  return { app, profile, row, data, relative, image, nativeFile, callPart, raw, save, response,
    collect: history => recover(app, row, data, history, () => {}, []) };
}
test('Qwen offers its full-frame JPEG as a turn-scoped preview even without a workspace, and cannot export it as the original', async t => {
  const f = await fixture(t), h = await f.collect(), v = h.archive.versions[0];
  assert.equal(v.metadata.previewOf, f.relative); assert.equal(v.metadata.name, 'p.jpg');
  assert.deepEqual(h.items, []); assert.deepEqual(versions.list(h.archive), []);
  fs.unlinkSync(f.nativeFile);
  assert.equal(await f.collect(h), h);
  const handle = { historyArtifacts: archive.archivedView(f.profile, f.row.id, f.row.cwd, h, () => {}, async () => {}) };
  runtime.bindTurnArchives(handle, () => versions.readers(f.profile, f.row.id, h.archive, () => {}));
  const [shown] = runtime.decorate('test', await runtime.viewSnapshotAsync(handle));
  assert.equal(shown.previewOf, f.relative); assert.equal(shown.userMessageIndex, 0);
  const result = await runtime.action(handle, 'test', shown.artifactId, 'image-full', {});
  assert.equal(result.mimeType, 'image/jpeg'); assert.deepEqual(Buffer.from(result.data, 'base64'), f.image);
  assert.deepEqual(await versions.exportTurn({ archive: h.archive, turnId: shown.turnId }), []);
  await assert.rejects(versions.exportCopy({ archive: h.archive, versionId: v.versionId }));
});
test('a late, verified Qwen PNG from the same segment supersedes its JPEG even after the native history disappears', async t => {
  const f = await fixture(t), jpeg = await f.collect();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=', 'base64');
  fs.mkdirSync(f.row.cwd, { recursive: true });
  const file = path.join(f.row.cwd, f.relative);
  fs.writeFileSync(file, png);
  const captured = await archive.capture({ row: { ...f.row, adapterId: 'qwen' }, journal: { cwd: f.row.cwd, turnId: 'legacy',
    files: [{ action: 'created', path: f.relative, after: { exists: true, path: f.relative, size: png.length,
      hash: crypto.createHash('sha256').update(png).digest('hex') } }] } });
  const saved = await require('../main/conversation/device-artifact-archive.cjs').preserve(f.profile, f.row.id, captured, jpeg, () => {});
  fs.unlinkSync(file); fs.unlinkSync(f.nativeFile);
  const foreign = { ...saved, items: saved.items.map(item => ({ ...item, source: { ...item.source, sessionId: crypto.randomUUID() } })) };
  assert.equal(await f.collect(foreign), foreign);
  const h = await f.collect(saved), [original] = versions.list(h.archive);
  assert.equal(original.relative, f.relative); assert.equal(original.turnId, jpeg.archive.versions[0].turnId);
  assert.equal(await f.collect(h), h);
  const handle = { historyArtifacts: archive.archivedView(f.profile, f.row.id, f.row.cwd, h, () => {}, async () => {}) };
  runtime.bindTurnArchives(handle, () => versions.readers(f.profile, f.row.id, h.archive, () => {}));
  const full = await runtime.action(handle, 'test', 'version:' + original.versionId, 'image-full', {});
  assert.equal(full.mimeType, 'image/png'); assert.deepEqual(Buffer.from(full.data, 'base64'), png);
  const [copy] = await versions.exportTurn({ profile: f.profile, id: f.row.id, archive: h.archive, turnId: original.turnId,
    workspace: f.row.cwd, workspaceKey: crypto.randomUUID(), guard: () => {} });
  assert.deepEqual(fs.readFileSync(copy.path), png);
  await assert.rejects(versions.exportCopy({ archive: h.archive, versionId: jpeg.archive.versions[0].versionId }));
});
test('zoomed, copied, wrong-turn or unconfirmed native responses cannot grant a preview', async t => {
  const f = await fixture(t);
  for (const change of [
    () => { f.response.name = 'zoom_image'; },
    () => { f.response.name = 'read_file'; f.raw[3].toolCallResult.status = 'error'; },
    () => { f.raw[3].toolCallResult.status = 'success'; f.raw[3].parentUuid = 'sibling'; },
    () => { delete f.raw[3].parentUuid; f.raw[3].sessionId = 'another-session'; },
    () => { delete f.raw[3].sessionId; f.raw[1].type = 'system'; },
    () => { f.raw[1].type = 'user'; f.raw[4].message.parts[0].text = 'another final reply'; },
  ]) {
    change(); f.save();
    assert.equal(await f.collect(), undefined);
  }
});
