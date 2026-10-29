'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const outputs = require('../main/pi-session/outputs');
const runtime = require('../main/conversation/artifact-runtime');

test('closing a preview releases connections with unfinished request headers', { timeout: 5000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-preview-close-'));
  const entry = path.join(root, 'index.html');
  fs.writeFileSync(entry, '<h1>Preview cleanup</h1>');
  let socket;
  t.after(() => { socket?.destroy(); runtime.closeAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const result = await runtime.previewInput({ cwd: root }, 'closing-preview', entry);
  assert.equal(result.ok, true);
  const url = new URL(result.url);
  socket = require('node:net').connect({ host: '127.0.0.1', port: Number(url.port) });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write('GET / HTTP/1.1\r\n');
  const closed = new Promise(resolve => socket.once('close', resolve));
  runtime.closeRef('closing-preview');
  await closed;
  assert.equal(runtime._records.size, 0);
});

function request(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });
}

test('typed artifacts hide absolute paths and keep stable opaque ids', () => {
  const root = path.join(os.tmpdir(), 'soduwork-artifact-id');
  const first = {
    path: path.join(root, 'site', 'index.html'),
    relative: 'site/index.html', name: 'index.html', size: 10, at: 10,
  };
  const second = { ...first, at: 99, size: 20 };
  const a = require('../main/conversation/delivery-contract').infer([first]).items[0];
  const b = require('../main/conversation/delivery-contract').infer([second]).items[0];
  assert.equal(a.artifactId, b.artifactId);
  const publicRows = runtime.decorate('chat-1', { items: [a] });
  assert.equal(publicRows[0].artifactId, a.artifactId);
  assert.equal(Object.hasOwn(publicRows[0], 'path'), false);
  assert.deepEqual(publicRows[0].actions, ['preview', 'open', 'reveal']);
});

test('explicit input HTML uses the bounded HTTP runtime without scanning or publishing deliverables', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-input-runtime-'));
  try {
    const folder = path.join(root, 'page'); fs.mkdirSync(folder);
    const entry = path.join(folder, 'input & page.html');
    fs.writeFileSync(entry, '<h1>Original input</h1>');
    fs.writeFileSync(path.join(folder, 'module.mjs'), 'export const ready = true;');
    fs.writeFileSync(path.join(root, 'private.txt'), 'Outside the selected page directory');
    const session = { cwd: root, outputSnapshot() { throw Error('Input preview must not scan outputs'); } };
    const first = await runtime.previewInput(session, 'input-a', entry);
    assert.equal(first.ok, true); assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\//);
    assert.match((await request(first.url)).body, /Original input/);
    assert.match((await request(new URL('module.mjs', first.url).href)).headers['content-type'], /javascript/);
    assert.equal((await request(new URL('/%2e%2e%2fprivate.txt', first.url).href)).status, 404);
    assert.equal((await runtime.previewInput(session, 'input-a', entry)).url, first.url);
    assert.notEqual((await runtime.previewInput(session, 'input-b', entry)).url, first.url);
    fs.writeFileSync(entry, '<h1>Changed input content</h1>');
    const changed = await runtime.previewInput(session, 'input-a', entry);
    assert.match((await request(changed.url)).body, /Changed input content/);
    assert.equal(fs.existsSync(path.join(root, '.soduwork')), false);
    fs.unlinkSync(entry);
    assert.equal((await request(new URL('/route-without-extension', changed.url).href)).status, 404);
  } finally { runtime.closeAll(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('input preview rejects foreign paths, directories, unsupported files and junction escapes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-input-boundary-'));
  try {
    const cwd = path.join(root, 'workspace'), outside = path.join(root, 'outside');
    fs.mkdirSync(cwd); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.html'), '<h1>Outside</h1>');
    fs.writeFileSync(path.join(cwd, 'notes.txt'), 'Plain input');
    fs.symlinkSync(outside, path.join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const session = { cwd };
    for (const target of [outside, path.join(outside, 'secret.html'), cwd,
      path.join(cwd, 'notes.txt'), path.join(cwd, 'linked/secret.html'), path.join(cwd, 'missing.html')]) {
      assert.equal((await runtime.previewInput(session, 'input-boundary', target)).ok, false, target);
    }
    assert.equal([...runtime._records.values()].some(record => record.ref === 'input-boundary'), false);
  } finally { runtime.closeAll(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('closing a conversation during input HTTP startup cannot leave a serving record behind', { timeout: 5000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-input-close-'));
  try {
    const entry = path.join(root, 'input.html'); fs.writeFileSync(entry, '<h1>Input</h1>');
    const opening = runtime.previewInput({ cwd: root }, 'closing-input', entry);
    runtime.closeRef('closing-input');
    assert.equal((await opening).ok, false);
    assert.equal([...runtime._records.values()].some(record => record.ref === 'closing-input'), false);
    assert.equal((await runtime.previewInput({ cwd: root }, 'next-input', entry)).ok, true);
  } finally { runtime.closeAll(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('managed website runtime serves a complete package, supports SPA routes and blocks traversal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-artifact-runtime-'));
  try {
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'index.html'),
      '<!doctype html><script src="assets/app.js"></script><h1>SoduWork artifact</h1>');
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'window.SODUWORK_ARTIFACT_OK=true;');
    const snapshot = outputs.scan(root, 0, Date.now() - 5000);
    const session = { cwd: root, outputSnapshot: () => snapshot };
    const artifact = snapshot.delivery.items.find((item) => item.kind === 'website');
    assert.ok(artifact && artifact.artifactId);

    const launched = await runtime.preview(session, 'chat-managed', artifact.artifactId);
    assert.equal(launched.ok, true);
    assert.match(launched.url, /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/);
    const page = await request(launched.url);
    assert.equal(page.status, 200);
    assert.match(page.body, /SoduWork artifact/);
    assert.equal(page.headers['cache-control'], 'no-store');

    const base = new URL(launched.url);
    const asset = await request(new URL('/assets/app.js', base).href);
    assert.equal(asset.status, 200);
    assert.match(asset.body, /SODUWORK_ARTIFACT_OK/);
    const route = await request(new URL('/orders/42', base).href);
    assert.equal(route.status, 200);
    assert.match(route.body, /SoduWork artifact/);
    const escaped = await request(new URL('/%2e%2e%2foutside.txt', base).href);
    assert.equal(escaped.status, 404);

    const status = await runtime.action(session, 'chat-managed', artifact.artifactId, 'status', {});
    assert.equal(status.status, 'running');
  } finally {
    runtime.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('website runtimes are isolated per conversation and restart when the artifact changes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-artifact-isolation-'));
  try {
    fs.writeFileSync(path.join(root, 'index.html'), '<h1>version one</h1>');
    let snapshot = outputs.scan(root, 0, Date.now() - 5000);
    const session = { cwd: root, outputSnapshot: () => snapshot };
    const artifactId = snapshot.delivery.items[0].artifactId;

    const first = await runtime.preview(session, 'chat-a', artifactId);
    const parallel = await runtime.preview(session, 'chat-b', artifactId);
    assert.equal(first.ok, true);
    assert.equal(parallel.ok, true);
    assert.notEqual(first.url, parallel.url);

    runtime.closeRef('chat-a');
    const stoppedA = await runtime.action(session, 'chat-a', artifactId, 'status', {});
    const runningB = await runtime.action(session, 'chat-b', artifactId, 'status', {});
    assert.equal(stoppedA.status, 'stopped');
    assert.equal(runningB.status, 'running');

    fs.writeFileSync(path.join(root, 'index.html'), '<h1>version two is longer</h1>');
    snapshot = outputs.scan(root, 0, Date.now() - 5000);
    const restarted = await runtime.preview(session, 'chat-b', artifactId);
    const updated = await request(restarted.url);
    assert.match(updated.body, /version two is longer/);

    fs.unlinkSync(path.join(root, 'index.html'));
    const stoppedAfterDelete = await runtime.action(session, 'chat-b', artifactId, 'stop', {});
    assert.equal(stoppedAfterDelete.status, 'stopped');
  } finally {
    runtime.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('video artifacts stream from an opaque loopback URL and honor byte ranges', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-video-runtime-'));
  try {
    const bytes = Buffer.from('0123456789abcdef');
    fs.writeFileSync(path.join(root, 'demo.mp4'), bytes);
    const snapshot = outputs.scan(root, 0, Date.now() - 5000);
    const session = { cwd: root, outputSnapshot: () => snapshot };
    const artifact = snapshot.delivery.items.find((item) => item.kind === 'video');
    assert.ok(artifact && artifact.artifactId);
    const launched = await runtime.preview(session, 'chat-video', artifact.artifactId);
    assert.equal(launched.ok, true);
    assert.match(launched.url, /^http:\/\/127\.0\.0\.1:\d+\/demo\.mp4$/);
    const ranged = await new Promise((resolve, reject) => {
      const req = http.get(launched.url, { headers: { Range: 'bytes=4-8' } }, (response) => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers['content-range'], 'bytes 4-8/16');
    assert.equal(ranged.headers['accept-ranges'], 'bytes');
    assert.equal(ranged.headers['content-type'], 'video/mp4');
    assert.equal(ranged.body.toString(), '45678');
  } finally { runtime.closeAll(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('output snapshots identify files changed in the active turn', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-artifact-turn-'));
  try {
    fs.writeFileSync(path.join(root, 'index.html'), '<h1>now</h1>');
    const current = outputs.scan(root, 0, Date.now() - 5000);
    const old = outputs.scan(root, 0, Date.now() + 5000);
    assert.equal(current.delivery.items[0].changedInTurn, true);
    assert.equal(old.delivery.items[0].changedInTurn, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary images have a readable index without being promoted to primary deliverables', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-image-index-'));
  try {
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    for (const name of ['图标-透明底.png', '截图.png']) fs.writeFileSync(path.join(root, name), bytes);
    fs.writeFileSync(path.join(root, 'report.md'), '# Primary result');
    let scans = 0;
    const session = { cwd: root, outputSnapshot: () => { scans++; return outputs.scan(root, 0, 0); } };
    const snapshot = runtime.snapshot(session);
    assert.equal(scans, 1, 'listing must not rescan once per image');
    assert.equal(snapshot.delivery.items.length, 1, 'delivery acceptance is unchanged');
    const images = snapshot.items.filter(file => file.kind === 'image');
    assert.equal(images.length, 2);
    for (const item of images) {
      assert.equal(item.primary, false);
      const publicRow = runtime.decorate('image-index', { items: [item] })[0];
      assert.ok(publicRow.artifactId);
      assert.equal(Object.hasOwn(publicRow, 'path'), false);
      const full = await runtime.action(session, 'image-index', item.artifactId, 'image-full', {});
      assert.equal(full.ok, true);
      assert.deepEqual(Buffer.from(full.data, 'base64'), bytes);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('command screenshots stay available as process evidence without becoming deliverables', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-process-image-'));
  try {
    const image = path.join(root, '04-command-output.png');
    fs.writeFileSync(image, 'fixture');
    const session = { cwd: root, outputSnapshot: () => outputs.scan(root, 0, 0) };
    const snapshot = runtime.snapshot(session);
    assert.equal(snapshot.delivery.items.length, 0);
    assert.equal(snapshot.items.length, 1);
    assert.equal(snapshot.items[0].primary, false);
    assert.equal(snapshot.items[0].processEvidence, true);
    assert.equal(runtime.decorate('process-image', { items: snapshot.items })[0].processEvidence, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a declared image stays primary and is not duplicated by the scanned image index', () => {
  const root = path.join(os.tmpdir(), 'soduwork-declared-image');
  const file = { name: 'preview.png', path: path.join(root, 'preview.png'), relative: 'preview.png', size: 10, at: 4 };
  const declared = { ...file, artifactId: 'declared-image', primary: true, kind: 'image' };
  const snapshot = runtime.snapshot({ cwd: root, outputSnapshot: () => ({ files: [file], delivery: { items: [declared] } }) });
  assert.deepEqual(snapshot.items, [declared]);
  assert.deepEqual(snapshot.delivery.items, [declared]);
  const legacy = runtime.snapshot({ cwd: root, outputs: () => [file] });
  assert.equal(legacy.items.length, 1);
  assert.ok(legacy.items[0].artifactId);
});

test('numbered verification shots stay evidence beside the HTML result, while declared images remain primary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-verification-images-'));
  try {
    const names = ['verify-shot1.png', 'verify-shot2.png', 'verification-shot-3.png', 'verify-chart.png'];
    fs.writeFileSync(path.join(root, 'pelican-bicycle.html'), '<!doctype html><title>Pelican</title>');
    for (const name of names) fs.writeFileSync(path.join(root, name), 'fixture');
    const session = { cwd: root, outputSnapshot: () => outputs.scan(root, 0, 0) };
    const snapshot = runtime.snapshot(session);
    assert.deepEqual(snapshot.delivery.items.map(file => file.name), ['pelican-bicycle.html']);
    for (const name of names.slice(0, 3)) {
      const item = snapshot.items.find(file => file.name === name);
      assert.equal(item.processEvidence, true, name);
      assert.equal(item.primary, false, name);
      assert.equal(runtime.decorate('verification', { items: [item] })[0].processEvidence, true);
    }
    assert.equal(snapshot.items.find(file => file.name === 'verify-chart.png').processEvidence, false);
    fs.mkdirSync(path.join(root, '.soduwork'));
    fs.writeFileSync(path.join(root, '.soduwork', 'delivery.json'), JSON.stringify({
      schemaVersion: 1, deliverables: [{ path: 'verify-shot1.png', kind: 'image', title: 'Requested screenshot' }],
    }));
    const declared = runtime.snapshot(session).items.find(file => file.name === 'verify-shot1.png');
    assert.notEqual(declared.primary, false, 'explicit screenshot deliverables must still work');
    assert.notEqual(declared.processEvidence, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the image index still rejects unlisted, deleted and out-of-workspace files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-image-boundary-'));
  try {
    const work = path.join(root, 'work'); fs.mkdirSync(work);
    const file = path.join(work, '图标.png'), outside = path.join(root, 'outside.png');
    fs.writeFileSync(file, 'fixture'); fs.writeFileSync(outside, 'private');
    const snapshot = outputs.scan(work, 0, 0);
    const session = { cwd: work, outputSnapshot: () => snapshot };
    const id = runtime.snapshot(session).items[0].artifactId;
    assert.equal((await runtime.action(session, 'scope', 'not-listed', 'image-full', {})).ok, false);
    const other = { cwd: root, outputSnapshot: () => ({ files: [], delivery: { items: [] } }) };
    assert.equal((await runtime.action(other, 'other-scope', id, 'image-full', {})).ok, false);
    snapshot.files.push({ path: outside, name: 'outside.png', relative: '../outside.png' });
    const escaped = runtime.snapshot(session).items.find(item => item.name === 'outside.png');
    assert.equal((await runtime.action(session, 'scope', escaped.artifactId, 'image-full', {})).ok, false);
    fs.unlinkSync(file);
    assert.equal((await runtime.action(session, 'scope', id, 'image-full', {})).ok, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
