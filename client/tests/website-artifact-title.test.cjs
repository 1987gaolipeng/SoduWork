'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const outputs = require('../main/pi-session/outputs');
const runtime = require('../main/conversation/artifact-runtime');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-website-title-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (relative, text) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    return target;
  };
  return { root, put, session: { cwd: root, outputSnapshot: () => outputs.scan(root, 0, 1) } };
}

test('website delivery and public artifact use the actual HTML title while retaining file identity', t => {
  const f = fixture(t);
  f.put('index.html', '<!doctype html><html><head><title>方寸山 · 山中书院</title></head><body>Ready</body></html>');
  const scanned = outputs.scan(f.root, 0, 1);
  assert.equal(scanned.delivery.items[0].title, '方寸山 · 山中书院');
  const snapshot = runtime.snapshot(f.session);
  const row = runtime.decorate('site-a', { items: snapshot.items })[0];
  assert.equal(row.title, '方寸山 · 山中书院');
  assert.equal(snapshot.got.files[0].title, '方寸山 · 山中书院');
  assert.equal(row.name, 'index.html');
  assert.equal(row.relative, 'index.html');
  assert.equal(row.artifactId, scanned.delivery.items[0].artifactId);
  assert.equal(Object.hasOwn(row, 'path'), false);
});

test('explicit delivery title stays authoritative while untitled manifest entries use document metadata', t => {
  const f = fixture(t);
  f.put('index.html', '<title>HTML 自动标题</title>');
  f.put('.soduwork/delivery.json', JSON.stringify({ schemaVersion: 1, deliverables: [
    { path: 'index.html', title: '人工交付名称' },
  ] }));
  assert.equal(runtime.snapshot(f.session).delivery.items[0].title, '人工交付名称');
  f.put('.soduwork/delivery.json', JSON.stringify({ schemaVersion: 1, deliverables: [{ path: 'index.html' }] }));
  assert.equal(runtime.snapshot(f.session).delivery.items[0].title, 'HTML 自动标题');
});

test('supporting and materialized website metadata stay tied to the actual file without promotion', t => {
  const f = fixture(t);
  f.put('package.json', '{}');
  const target = f.put('index.html', '<title>工程预览</title>');
  const snapshot = runtime.snapshot(f.session);
  assert.equal(snapshot.delivery.items.length, 0);
  const supporting = snapshot.items.find(row => row.name === 'index.html');
  assert.equal(supporting.title, '工程预览');
  assert.equal(supporting.primary, false);
  const file = { path: target, name: 'index.html', relative: 'index.html', kind: 'website', artifactId: 'remote-artifact',
    remoteMaterialized: true, cloudTaskId: 'task-a', size: fs.statSync(target).size, at: Date.now() };
  const cloud = runtime.snapshot({ cwd: f.root, outputSnapshot: () => ({ files: [file],
    delivery: { source: 'manifest', items: [file] } }) });
  assert.equal(cloud.delivery.items[0].title, '工程预览');
  assert.equal(cloud.items[0].artifactId, 'remote-artifact');
  assert.equal(cloud.items[0].cloudTaskId, 'task-a');
});

test('HTML title uses text entities and ignores executable, commented and foreign title lookalikes', t => {
  const f = fixture(t);
  f.put('index.html', '<!doctype html><head><!-- <title>Comment</title> -->' +
    '<script>const fake = "<title>Script</title>";</script><style>/*<title>Style</title>*/</style>' +
    '<template><title>Template</title></template><svg><title>Icon</title></svg>' +
    '<TITLE data-note=">">  方寸山 &amp; &#x4e66;&#38498; &lt;山&gt; &constructor;\n </TITLE></head>');
  assert.equal(outputs.scan(f.root, 0, 1).delivery.items[0].title, '方寸山 & 书院 <山> &constructor;');
});

test('missing, blank, body-only and oversized head titles keep the existing fallback', t => {
  const f = fixture(t);
  for (const html of ['<h1>Visible content</h1>', '<title> \n </title>',
    '<body><title>Wrong body metadata</title></body>', '<!-- <title>unfinished comment</title>',
    '<head><script>"<title>unfinished script</title>"', '<head>' + ' '.repeat(70 * 1024) + '<title>Too late</title>']) {
    f.put('index.html', html);
    assert.equal(outputs.scan(f.root, 0, 1).delivery.items[0].title, '网站预览');
  }
});

test('website title reads are bounded, cached by file version and refreshed without changing artifact id', t => {
  const f = fixture(t);
  const target = f.put('index.html', '<title>First title</title>' + 'x'.repeat(100 * 1024));
  const read = fs.readSync;
  const lengths = [];
  fs.readSync = function(fd, buffer, offset, length, position) {
    lengths.push(length);
    return read.call(this, fd, buffer, offset, length, position);
  };
  try {
    const first = runtime.snapshot(f.session);
    const readsAfterFirst = lengths.length;
    assert.ok(readsAfterFirst > 0);
    assert.ok(lengths.every(length => length <= 64 * 1024));
    runtime.snapshot(f.session);
    assert.equal(lengths.length, readsAfterFirst, 'unchanged files reuse bounded metadata');
    f.put('index.html', '<title>Updated website title</title>');
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(target, later, later);
    const changed = runtime.snapshot(f.session);
    assert.equal(changed.delivery.items[0].title, 'Updated website title');
    assert.equal(changed.items[0].artifactId, first.items[0].artifactId);
    assert.ok(lengths.length > readsAfterFirst);
  } finally { fs.readSync = read; }
});

test('website metadata never reads titles through a workspace escape', t => {
  const f = fixture(t), foreign = fixture(t);
  foreign.put('index.html', '<title>Private unrelated project</title>');
  fs.symlinkSync(foreign.root, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  f.put('.soduwork/delivery.json', JSON.stringify({ schemaVersion: 1,
    deliverables: [{ path: 'linked/index.html' }] }));
  assert.equal(runtime.snapshot(f.session).delivery.items[0].title, 'index.html');
  const bad = { path: path.join(foreign.root, 'index.html'), name: 'index.html', relative: 'index.html', kind: 'website' };
  const snapshot = runtime.snapshot({ cwd: f.root, outputSnapshot: () => ({ files: [bad] }) });
  assert.ok(snapshot.items.every(row => row.title !== 'Private unrelated project'));
});
