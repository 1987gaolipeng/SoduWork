'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const history = require('../main/conversation/runtime-artifacts.cjs');
const runtime = require('../main/conversation/artifact-runtime');
const outputs = require('../main/pi-session/outputs');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-retained-artifacts-'));
  const cwd = path.join(base, 'workspace'); fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }));
  const session = { cwd, snapshot: () => ({ messages: [], tools: [] }),
    outputSnapshot: () => outputs.scan(cwd, 1, 0) };
  const source = { sessionId: 'original-segment', adapterId: 'dsh' };
  return { cwd, base, session,
    write(name, text = 'Original content') { const file = path.join(cwd, name); fs.writeFileSync(file, text); return file; },
    retain() { return history.capture(cwd, runtime.snapshot(session), source); },
    switched(artifactHistory) { return { ...session, artifactHistory,
      outputSnapshot: () => ({ files: [], delivery: { source: 'legacy', items: [] } }) }; } };
}

test('retained artifacts exclude unrelated old files and never enter delivery or scan output', async t => {
  const f = fixture(t), since = Date.now() - 1000;
  const unrelated = f.write('unrelated.txt'); fs.utimesSync(unrelated, 1, 1);
  f.write('金鱼.txt');
  f.session.outputSnapshot = () => outputs.scan(f.cwd, since, since);
  const saved = f.retain();
  assert.deepEqual(saved.items.map(row => row.metadata.name), ['金鱼.txt']);
  assert.equal(Object.hasOwn(saved.items[0].metadata, 'path'), false);
  const active = f.switched(saved), view = runtime.snapshot(active);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].historical, true);
  assert.equal(view.items[0].primary, false);
  assert.equal(view.items[0].changedInTurn, false);
  assert.deepEqual(view.got.files, []);
  assert.deepEqual(view.delivery.items, []);
  const read = await runtime.action(active, 'conversation', view.items[0].artifactId, 'read', {});
  assert.equal(read.text, 'Original content');
  assert.deepEqual(history.restore(f.cwd, undefined), []);
});

test('unchanged retained versions stay historical even if a resumed runtime scans them again', t => {
  const f = fixture(t); f.write('saved.txt');
  const saved = f.retain();
  const view = runtime.snapshot({ ...f.session, artifactHistory: saved });
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].historical, true);
  assert.equal(view.got.files.length, 0);
  assert.equal(view.delivery.items.length, 0);
});

test('a completed reply in the active segment can explicitly deliver an unchanged historical file again', t => {
  const f = fixture(t); f.write('saved.txt');
  const saved = f.retain();
  const oldAnswer = { messages: [{ role: 'user', text: 'Original request' },
    { role: 'assistant', text: '[Saved file](saved.txt)', done: true }] };
  const active = { ...f.switched(saved), snapshot: () => oldAnswer, artifactState: { messages: [] } };
  assert.equal(runtime.snapshot(active).delivery.items.length, 0, 'the old segment reply is not a new delivery');
  active.artifactState = { messages: [{ role: 'user', text: 'Deliver the saved file again' },
    { role: 'assistant', text: '[Saved file](saved.txt)', done: true }] };
  const view = runtime.snapshot(active);
  assert.ok(view.delivery.items.some(row => row.relative === 'saved.txt'));
  assert.equal(view.delivery.items.find(row => row.relative === 'saved.txt').changedInTurn, false);
});

test('deleted, replaced and same-sized overwritten versions never authorize old artifact reads', async t => {
  const f = fixture(t), file = f.write('saved.txt', 'version-one');
  const saved = f.retain(), id = saved.items[0].metadata.artifactId;
  const before = fs.statSync(file);
  fs.writeFileSync(file, 'version-two');
  fs.utimesSync(file, before.atime, before.mtime);
  assert.equal(fs.statSync(file).size, before.size);
  assert.deepEqual(history.restore(f.cwd, saved), []);
  assert.equal((await runtime.action(f.switched(saved), 'conversation', id, 'read', {})).ok, false);
  fs.unlinkSync(file);
  assert.deepEqual(history.restore(f.cwd, saved), []);
  fs.writeFileSync(file, 'version-one'); fs.utimesSync(file, before.atime, before.mtime);
  assert.deepEqual(history.restore(f.cwd, saved), []);
});

test('a new trusted scan may publish an updated version while history cannot supply its bytes', async t => {
  const f = fixture(t), file = f.write('saved.txt');
  const saved = f.retain(), id = saved.items[0].metadata.artifactId;
  fs.writeFileSync(file, 'Updated current result');
  const active = { ...f.session, artifactHistory: saved };
  const view = runtime.snapshot(active);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].artifactId, id);
  assert.notEqual(view.items[0].historical, true);
  assert.equal((await runtime.action(active, 'conversation', id, 'read', {})).text, 'Updated current result');
});

test('retained paths reject escapes and links to both foreign and same-workspace files', t => {
  const f = fixture(t), folder = path.join(f.cwd, 'saved'); fs.mkdirSync(folder);
  f.write('saved/result.txt');
  const saved = f.retain(), outside = path.join(f.base, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'result.txt'), 'Foreign content');
  fs.rmSync(folder, { recursive: true });
  fs.symlinkSync(outside, folder, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(history.restore(f.cwd, saved), []);
  fs.unlinkSync(folder);
  const inside = path.join(f.cwd, 'another'); fs.mkdirSync(inside);
  f.write('another/result.txt'); fs.symlinkSync(inside, folder, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(history.restore(f.cwd, saved), []);
  for (const relative of ['../outside.txt', outside, './another.txt', 'child/../another.txt']) {
    const forged = structuredClone(saved); forged.items[0].metadata.relative = relative;
    assert.deepEqual(history.restore(f.cwd, forged), []);
  }
});

test('moving a retained index to a different workspace never authorizes same-named files', t => {
  const f = fixture(t); f.write('saved.txt');
  const saved = f.retain(), other = path.join(f.base, 'other');
  fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'saved.txt'), 'Foreign content');
  assert.deepEqual(history.restore(other, saved), []);
});

test('capturing another switch cannot silently renew a historical version changed after projection', t => {
  const f = fixture(t), file = f.write('saved.txt', 'version-one');
  const saved = f.retain(), projected = runtime.snapshot(f.switched(saved));
  const before = fs.statSync(file);
  fs.writeFileSync(file, 'version-two'); fs.utimesSync(file, before.atime, before.mtime);
  assert.equal(history.capture(f.cwd, projected, { sessionId: 'next' }).items.length, 0);
});

test('an asynchronous source change returns its dedicated retry code without publishing a mixed index', async t => {
  const f = fixture(t); f.write('saved.txt');
  let release;
  f.session.outputSnapshotAsync = () => new Promise(resolve => { release = () => resolve(outputs.scan(f.cwd, 1)); });
  const reading = runtime.snapshotAsync(f.session);
  f.session.artifactHistory = { version: 1, root: f.cwd, items: [] };
  release();
  await assert.rejects(reading, { code: 'ARTIFACT_SOURCE_CHANGED' });
});

test('historical plugin drafts revalidate resources instead of retaining stale install readiness', async t => {
  const f = fixture(t), cache = require('../main/app-resource-cache.cjs');
  t.after(() => cache.close());
  fs.mkdirSync(path.join(f.cwd, 'references'));
  f.write('references/reference.txt', 'Original reference');
  f.write('soduwork-plugin-draft.json', JSON.stringify({ template: 'method', key: 'retained-plugin',
    name: 'Retained plugin', version: '1.0.0', description: 'Synthetic historical plugin',
    instructions: 'Read the supplied material.', resources: [{ path: 'references/reference.txt', kind: 'reference' }] }));
  const initial = await runtime.snapshotAsync(f.session);
  const draft = initial.items.find(item => item.pluginDraft);
  assert.equal(draft.pluginValidation.state, 'ready');
  const saved = history.capture(f.cwd, initial, { sessionId: 'original' });
  const active = f.switched(saved);
  const retained = (await runtime.snapshotAsync(active)).items.find(item => item.pluginDraft);
  assert.equal(retained.pluginValidation.state, 'ready');
  assert.equal(runtime.decorate('conversation', { items: [retained] })[0].pluginInstallable, true);
  fs.unlinkSync(path.join(f.cwd, 'references/reference.txt'));
  const changed = (await runtime.snapshotAsync(active)).items.find(item => item.pluginDraft);
  assert.notEqual(changed.pluginRevision, retained.pluginRevision);
  assert.equal(changed.pluginValidation.state, 'invalid');
  assert.equal(runtime.decorate('conversation', { items: [changed] })[0].pluginInstallable, false);
  assert.equal((await runtime.snapshotAsync(active)).delivery.items.length, 0);
});

for (const packaged of [false, true]) {
  test('historical ' + (packaged ? 'archive' : 'draft') + ' resolves to the same plugin latest manifest across segments', async t => {
    const f = fixture(t), drafts = require('../main/pi-session/plugin-draft');
    t.after(() => require('../main/app-resource-cache.cjs').close());
    const body = { template: 'method', key: 'stable-plugin', name: 'Reusable workflow',
      description: 'Synthetic fixture', instructions: 'Summarize supplied text.', version: '1.0.0' };
    fs.mkdirSync(path.join(f.cwd, 'old'));
    let original;
    if (packaged) {
      const personal = require('../main/personal-plugins'), app = { getPath: () => path.join(f.base, 'source') };
      const made = personal.create(app, body).plugin;
      original = path.join(f.cwd, 'old/workflow.soduwork-plugin');
      await personal.exportToFile(app, { showSaveDialog: async () => ({ canceled: false, filePath: original }) }, made.pluginId);
    } else original = f.write('old/soduwork-plugin-draft.json', JSON.stringify(body));
    fs.utimesSync(original, 1600000000, 1600000000);
    const initial = await runtime.snapshotAsync(f.session), old = initial.items.find(item => item.pluginDraft);
    assert.equal(old.pluginValidation.state, 'ready');
    const retained = history.capture(f.cwd, initial, { sessionId: 'first' });
    const boundary = Date.now() - 1000, folder = packaged ? 'old' : 'new';
    if (!packaged) fs.mkdirSync(path.join(f.cwd, folder));
    f.write(folder + '/soduwork-plugin-draft.json', JSON.stringify({ ...body, version: '2.0.0' }));
    const active = { ...f.session, artifactHistory: retained, artifactState: { messages: [] },
      outputSnapshot: () => outputs.scan(f.cwd, boundary, boundary) };
    const view = await runtime.snapshotAsync(active);
    const installable = view.items.filter(item => item.pluginDraft && !item.pluginSuperseded);
    assert.equal(installable.length, 1, 'retained cards must not revive a superseded draft or merged archive');
    assert.equal(installable[0].pluginVersion, '2.0.0');
    const read = await drafts.readSessionAsync(active, old.artifactId);
    assert.equal(read.ok, true, read.reason);
    assert.equal(read.source.relative, folder + '/soduwork-plugin-draft.json');
    assert.equal(read.body.version, '2.0.0');
  });
}

test('same-named historical and current plugins with distinct keys remain separate', async t => {
  const f = fixture(t), drafts = require('../main/pi-session/plugin-draft');
  t.after(() => require('../main/app-resource-cache.cjs').close());
  const body = { template: 'method', key: 'original-plugin', name: 'Reusable workflow',
    description: 'Synthetic fixture', instructions: 'Summarize supplied text.', version: '1.0.0' };
  fs.mkdirSync(path.join(f.cwd, 'old')); fs.mkdirSync(path.join(f.cwd, 'new'));
  const original = f.write('old/soduwork-plugin-draft.json', JSON.stringify(body));
  fs.utimesSync(original, 1600000000, 1600000000);
  const initial = await runtime.snapshotAsync(f.session), old = initial.items.find(item => item.pluginDraft);
  const retained = history.capture(f.cwd, initial, { sessionId: 'first' }), boundary = Date.now() - 1000;
  f.write('new/soduwork-plugin-draft.json', JSON.stringify({ ...body, key: 'other-plugin', version: '2.0.0' }));
  const active = { ...f.session, artifactHistory: retained,
    outputSnapshot: () => outputs.scan(f.cwd, boundary, boundary) };
  const view = await runtime.snapshotAsync(active);
  assert.equal(view.items.filter(item => item.pluginDraft && !item.pluginSuperseded).length, 2);
  const read = await drafts.readSessionAsync(active, old.artifactId);
  assert.equal(read.ok, true, read.reason);
  assert.equal(read.body.key, 'original-plugin');
  assert.equal(read.body.version, '1.0.0');
});
