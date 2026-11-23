'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const packages = require('../main/conversation/delivery-package');
const runtime = require('../main/conversation/artifact-runtime');
const outputs = require('../main/pi-session/outputs');

function unzip(bytes) {
  const files = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26);
    const start = offset + 30 + length + bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + length).toString('utf8');
    const data = bytes.subarray(start, start + size);
    files.set(name, bytes.readUInt16LE(offset + 8) === 8 ? zlib.inflateRawSync(data) : data);
    offset = start + size;
  }
  return files;
}

async function fixture(t, attributes) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-media-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, 'source');
  const files = {
    'index.html': Buffer.from('<!doctype html><title>Demo</title><video controls ' + attributes + '></video>'),
    'media/demo.mp4': Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 1]),
    'media/poster.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'),
  };
  for (const [name, bytes] of Object.entries(files)) {
    const file = path.join(cwd, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  const handle = { cwd, sessionId: 'media-session', outputSnapshot: () => outputs.scan(cwd, 0, 1),
    snapshot: () => ({ status: 'idle' }) };
  const ids = runtime.snapshot(handle).items.filter(file => file.relative === 'index.html').map(file => file.artifactId);
  const handlers = new Map(), frame = {};
  const event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false,
    getURL: () => pathToFileURL(path.resolve(__dirname, '../desk.html')).href } };
  const target = path.join(directory, 'download.zip');
  let dialogs = 0;
  require('../main/conversation/delivery-package-ipc').install({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    session: { get: ref => ref === 'session' ? handle : null },
    BrowserWindow: { fromWebContents: () => ({}) },
    dialog: { showSaveDialog: async () => { dialogs++; return { filePath: target }; } },
  });
  return { cwd, files, target, dialogs: () => dialogs,
    call: action => handlers.get('conversation-delivery-' + action)(event, 'session', ids) };
}

for (const [order, attributes, second] of [
  ['src first', 'src="media/demo.mp4" poster="media/poster.svg"', 'media/poster.svg'],
  ['poster first', "poster='media/poster.svg' src='media/demo.mp4'", 'media/demo.mp4'],
]) {
  test('delivery IPC packages both video resources with ' + order, async t => {
    const f = await fixture(t, attributes);
    const inspected = await f.call('inspect');
    assert.equal(inspected.ok, true, inspected.reason);
    assert.deepEqual(inspected.manifest.files.map(file => file.path), Object.keys(f.files).sort());
    const prepared = await f.call('prepare');
    assert.equal(prepared.ok, true, prepared.reason);
    const preparedFiles = unzip(Buffer.from(prepared.data, 'base64'));
    for (const [name, bytes] of Object.entries(f.files)) assert.deepEqual(preparedFiles.get(name), bytes, name);
    const saved = await f.call('save');
    assert.equal(saved.ok, true, saved.reason);
    const savedFiles = unzip(await fs.readFile(f.target));
    assert.deepEqual([...savedFiles.keys()], Object.keys(f.files).sort());
    for (const [name, bytes] of Object.entries(f.files)) assert.deepEqual(savedFiles.get(name), bytes, name);
    assert.equal(f.dialogs(), 1);
  });

  test('delivery IPC refuses a missing second video resource with ' + order, async t => {
    const f = await fixture(t, attributes);
    await fs.unlink(path.join(f.cwd, second));
    for (const action of ['prepare', 'save']) {
      const result = await f.call(action);
      assert.equal(result.ok, false, action + ' must not publish an incomplete website');
      assert.equal(result.code, 'DELIVERY_LOCAL_UNAVAILABLE');
      assert.ok(result.reason.includes(second), result.reason);
    }
    assert.equal(f.dialogs(), 0, 'the save dialog cannot precede complete dependency capture');
    await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  });
}

test('resource scanning consumes complete attributes without mistaking values or data attributes for URLs', () => {
  const html = `<video controls muted data-src="unused.mp4" data-poster="unused.svg"
    title="a > b; src='example.mp4' poster='example.svg'"
    poster='media/poster.svg' src="media/demo.mp4"></video>`;
  assert.deepEqual(packages.references(html, '.html'), ['media/poster.svg', 'media/demo.mp4']);
  assert.deepEqual(packages.references(html, '.htm'), ['media/poster.svg', 'media/demo.mp4']);
});

test('resource scanning retains quoted SVG hrefs and existing tag, protocol and unquoted-value boundaries', () => {
  const svg = '<image xlink:href="poster.svg"/><use href="icons.svg#play"/>';
  assert.deepEqual(packages.references(svg, '.svg'), ['poster.svg', 'icons.svg#play']);
  const html = `<video SRC="https://example.test/demo.mp4" POSTER='poster.svg'></video>
    <object data="other.bin"></object><img src=unquoted.png><div src="ignored.png"></div>`;
  assert.deepEqual(packages.references(html, '.html'), ['poster.svg']);
  assert.deepEqual(packages.references(html, '.html', true), ['https://example.test/demo.mp4', 'poster.svg']);
});

test('later duplicate attributes do not invent dependencies the browser ignores', () => {
  assert.deepEqual(packages.references('<img src="first.svg" SRC="unused.svg">', '.html'), ['first.svg']);
});

test('delivery IPC records remote video sources while retaining local posters', async t => {
  const f = await fixture(t, 'src="https://example.test/demo.mp4" poster="media/poster.svg"');
  const result = await f.call('prepare');
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.manifest.externalDependencies, ['https://example.test/demo.mp4']);
  assert.deepEqual(result.manifest.files.map(file => file.path), ['index.html', 'media/poster.svg']);
  const files = unzip(Buffer.from(result.data, 'base64'));
  assert.deepEqual(files.get('index.html'), f.files['index.html']);
  assert.deepEqual(files.get('media/poster.svg'), f.files['media/poster.svg']);
});
