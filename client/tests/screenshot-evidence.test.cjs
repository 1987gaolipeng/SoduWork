'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const outputs = require('../main/pi-session/outputs');
const runtime = require('../main/conversation/artifact-runtime');
const delivery = require('../main/conversation/delivery-contract');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const base = fs.mkdtempSync(path.join(parent, 'SoduWork-screenshot-evidence-'));
  t.after(() => { assert.equal(path.dirname(base), parent); fs.rmSync(base, { recursive: true, force: true }); });
  const cwd = path.join(base, 'workspace'); fs.mkdirSync(cwd);
  function put(relative, bytes = PNG, at = 4000) {
    const file = path.join(cwd, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes); fs.utimesSync(file, at / 1000, at / 1000); return file;
  }
  function session(since = 0, turnSince = 0) {
    return { cwd, outputSnapshot: () => outputs.scan(cwd, since, turnSince), snapshot: () => ({ tools: [] }) };
  }
  return { base, cwd, put, session };
}

test('dedicated screenshot evidence becomes an authorized image without changing delivery or hidden-file scanning', async t => {
  const f = fixture(t), relative = '.soduwork/evidence/website-final.png';
  f.put('index.html', '<!doctype html><title>Website</title>'); f.put(relative);
  const session = f.session(1000, 3000), scanned = outputs.scan(f.cwd, 1000, 3000);
  assert.deepEqual(scanned.files.map(file => file.relative), ['index.html']);
  const snapshot = runtime.snapshot(session), item = snapshot.items.find(file => file.relative === relative);
  assert.ok(item, 'the instructed screenshot directory must be reachable in the trusted artifact index');
  assert.equal(item.kind, 'image'); assert.equal(item.primary, false); assert.equal(item.processEvidence, true);
  assert.equal(item.changedInTurn, true); assert.equal(item.preview, true);
  assert.deepEqual(snapshot.delivery.items.map(file => file.relative), ['index.html']);
  assert.deepEqual(snapshot.got.files.map(file => file.relative), ['index.html']);
  const visible = runtime.decorate('screenshot-chat', { items: [item] })[0];
  assert.equal(visible.processEvidence, true); assert.equal(visible.primary, false);
  assert.equal(Object.hasOwn(visible, 'path'), false);
  const image = await runtime.action(session, 'screenshot-chat', item.artifactId, 'image-full', {});
  assert.equal(image.ok, true); assert.equal(image.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(image.data, 'base64'), PNG);
});

test('screenshot discovery respects the session time boundary without truncating earlier turns after six images', t => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) f.put('.soduwork/evidence/frame-' + i + '.png', PNG, 2000 + i * 1000);
  f.put('.soduwork/evidence/old.png', PNG, 1000);
  f.put('.soduwork/evidence/future.png', PNG, Date.now() + 3600000);
  const rows = runtime.snapshot(f.session(2000, 9000)).items;
  assert.deepEqual(rows.map(file => file.name), Array.from({ length: 10 }, (_, i) => 'frame-' + (9 - i) + '.png'));
  assert.deepEqual(rows.filter(file => file.changedInTurn).map(file => file.name), ['frame-9.png', 'frame-8.png', 'frame-7.png']);
  const fallback = { cwd: f.cwd, outputSince: 10000, outputs: () => [] };
  assert.deepEqual(runtime.snapshot(fallback).items.map(file => file.name), ['frame-9.png', 'frame-8.png']);
});

test('only direct raster files in the dedicated namespace are indexed, with a bounded file size', t => {
  const f = fixture(t);
  f.put('.soduwork/evidence/screenshot.png');
  for (const relative of ['.soduwork/private.png', '.other/evidence/shot.png', '.soduwork/evidence/nested/shot.png',
    '.soduwork/evidence/vector.svg', '.soduwork/evidence/record.json', '.soduwork/evidence/image.png.tmp']) f.put(relative);
  f.put('.soduwork/evidence/fake.png', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  f.put('.soduwork/evidence/wrong-type.jpg');
  const huge = f.put('.soduwork/evidence/oversized.png'); fs.truncateSync(huge, 20 * 1024 * 1024 + 1);
  fs.mkdirSync(path.join(f.cwd, '.soduwork/evidence/directory.png'));
  assert.deepEqual(runtime.snapshot(f.session()).items.map(file => file.relative), ['.soduwork/evidence/screenshot.png']);
});

test('linked evidence directories cannot publish images from outside the conversation workspace', t => {
  for (const segment of ['.soduwork', '.soduwork/evidence']) {
    const f = fixture(t), outside = path.join(f.base, 'external'); fs.mkdirSync(outside);
    if (segment === '.soduwork') fs.mkdirSync(path.join(outside, 'evidence'));
    fs.writeFileSync(path.join(outside, segment === '.soduwork' ? 'evidence/private.png' : 'private.png'), PNG);
    const link = path.join(f.cwd, segment); fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.deepEqual(runtime.snapshot(f.session()).items, [], segment);
  }
});

test('an indexed screenshot cannot authorize deleted, unknown, private or another workspace image', async t => {
  const f = fixture(t), relative = '.soduwork/evidence/website.png', target = f.put(relative);
  f.put('.soduwork/private.png');
  const session = f.session(), item = runtime.snapshot(session).items.find(file => file.relative === relative);
  assert.ok(item);
  const other = fixture(t);
  assert.equal((await runtime.action(other.session(), 'other-chat', item.artifactId, 'image-full', {})).ok, false);
  for (const name of ['unknown.png', '.soduwork/private.png', '../outside.png']) {
    const id = delivery._artifactId('image', name);
    assert.equal((await runtime.action(session, 'screenshot-chat', id, 'image-full', {})).ok, false, name);
  }
  fs.unlinkSync(target);
  assert.equal((await runtime.action(session, 'screenshot-chat', item.artifactId, 'image-full', {})).ok, false);
  assert.equal(fs.existsSync(target), false);
});

test('a summary-only delivery retains evidence access while an explicit image declaration keeps its original role', t => {
  const f = fixture(t), relative = '.soduwork/evidence/website.png'; f.put(relative);
  const manifest = data => fs.writeFileSync(path.join(f.cwd, '.soduwork/delivery.json'), JSON.stringify(data));
  manifest({ schemaVersion: 1, presentation: 'summary', deliverables: [] });
  const summary = runtime.snapshot(f.session());
  assert.equal(summary.delivery.items.length, 0); assert.equal(summary.items.length, 1);
  assert.equal(summary.items[0].primary, false); assert.equal(summary.items[0].processEvidence, true);
  manifest({ schemaVersion: 1, deliverables: [{ path: relative, kind: 'image', primary: true }] });
  const explicit = runtime.snapshot(f.session());
  assert.equal(explicit.items.length, 1); assert.equal(explicit.items[0].primary, true);
  assert.notEqual(explicit.items[0].processEvidence, true); assert.equal(explicit.delivery.items.length, 1);
});

test('evidence discovery bounds header reads even when the dedicated directory is oversized', t => {
  const f = fixture(t);
  for (let i = 0; i < 180; i++) f.put('.soduwork/evidence/frame-' + String(i).padStart(3, '0') + '.png');
  const originalRead = fs.readSync; let reads = 0, snapshot;
  try {
    fs.readSync = (...args) => { reads++; return originalRead(...args); };
    snapshot = runtime.snapshot(f.session());
  } finally { fs.readSync = originalRead; }
  assert.equal(snapshot.items.length, 60);
  assert.ok(reads > 0 && reads <= 128, `bounded header reads: ${reads}`);
});

test('a screenshot index cannot follow file links or a directory replaced after listing', async t => {
  const f = fixture(t), relative = '.soduwork/evidence/website.png'; f.put(relative);
  const session = f.session(), item = runtime.snapshot(session).items[0]; assert.ok(item);
  const outside = path.join(f.base, 'external'); fs.mkdirSync(outside);
  const privateImage = path.join(outside, 'website.png'); fs.writeFileSync(privateImage, PNG);
  fs.symlinkSync(privateImage, path.join(f.cwd, '.soduwork/evidence/linked.png'), 'file');
  assert.deepEqual(runtime.snapshot(session).items.map(file => file.relative), [relative]);
  const dir = path.join(f.cwd, '.soduwork/evidence');
  fs.renameSync(dir, path.join(f.cwd, '.soduwork/previous-evidence'));
  fs.symlinkSync(outside, dir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await runtime.action(session, 'screenshot-chat', item.artifactId, 'image-full', {})).ok, false);
  assert.deepEqual(runtime.snapshot(session).items, []);
});

test('a seventh captured image does not revoke the first screenshot referenced by an earlier turn', async t => {
  const f = fixture(t), first = '.soduwork/evidence/first-turn.png'; f.put(first);
  const session = f.session(1000, 3000), item = runtime.snapshot(session).items[0]; assert.ok(item);
  for (let i = 0; i < 6; i++) f.put('.soduwork/evidence/later-' + i + '.png', PNG, 5000 + i * 1000);
  const listed = runtime.snapshot(session).items;
  assert.equal(listed.length, 7);
  assert.equal(listed.find(file => file.relative === first)?.artifactId, item.artifactId);
  const image = await runtime.action(session, 'screenshot-chat', item.artifactId, 'image-full', {});
  assert.equal(image.ok, true); assert.deepEqual(Buffer.from(image.data, 'base64'), PNG);
});
