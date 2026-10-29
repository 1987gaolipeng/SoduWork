'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const vision = require('../main/pi-session/vision');
const reader = require('../main/pi-session/vision-read-tool');
const png = 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAKklEQVR4nGP8z0AdwEQlcxhGDSIMRsOIMBgNI8JgNIwIg9EwIgwGXxgBAHuqAS9ARg1/AAAAAElFTkSuQmCC';

test('real SDK file reads preserve native pixels and use real observations for text-only models, including model switches', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-vision-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sdk = await import(pathToFileURL(path.resolve(__dirname, '../node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  fs.writeFileSync(path.join(root, 'picture.png'), Buffer.from(png, 'base64'));
  fs.writeFileSync(path.join(root, 'notes.txt'), 'Ordinary text');
  let model = { imageRouting: 'native', input: ['text', 'image'] }, calls = 0;
  const original = vision.analyze;
  t.after(() => { vision.analyze = original; });
  vision.analyze = async (_identity, images, _prompt, _timeout, _fetch, options) => {
    calls++;
    assert.equal(images.length, 1);
    assert.equal(images[0].mimeType, 'image/png');
    assert.ok(options.signal);
    return { ok: true, model: 'configured-vision', imageCount: 1, observation: { summary: 'Image observed' } };
  };
  const tool = reader.create(sdk, root, {}, () => model);
  const read = file => tool.execute('read-' + file, { path: file }, new AbortController().signal, undefined, { model });
  const native = await read('picture.png');
  assert.equal(calls, 0);
  assert.equal(native.content.filter(x => x.type === 'image').length, 1);
  assert.doesNotMatch(JSON.stringify(native), /does not support images/);
  model = { imageRouting: 'vision-fallback', input: ['text'] };
  const text = await read('notes.txt');
  assert.equal(calls, 0);
  assert.match(text.content[0].text, /Ordinary text/);
  for (const capabilities of [{ input: ['text'] }, { input: ['text', 'image'] },
    { imageRouting: 'vision-fallback', input: ['text'], visionFallbackAvailable: false }]) {
    model = capabilities;
    await assert.rejects(read('picture.png'), /原图已保留.*未自动更换模型/);
    assert.equal(calls, 0, 'unconfigured adapter must never be called');
  }
  model = { imageRouting: 'vision-fallback', input: ['text'], visionFallbackAvailable: true };
  const fallback = await read('picture.png');
  assert.equal(calls, 1);
  assert.equal(fallback.content.filter(x => x.type === 'image').length, 0);
  assert.match(fallback.content[0].text, /configured-vision/);
  assert.match(fallback.content[0].text, /Image observed/);
  assert.doesNotMatch(fallback.content[0].text, /does not support images|omitted/);
  vision.analyze = async () => ({ ok: false, reason: 'Vision service unavailable' });
  await assert.rejects(read('picture.png'), /Vision service unavailable/);
  model = { imageRouting: 'native', input: ['text', 'image'] };
  assert.equal((await read('picture.png')).content.filter(x => x.type === 'image').length, 1);
});

test('cancelling image observation cancels its network request and does not send later batches', async () => {
  const abort = new AbortController();
  let calls = 0;
  const pending = vision.analyze({ hub: 'http://fixture', clientId: 'fixture', session: 'fixture' },
    Array.from({ length: 5 }, () => ({ mimeType: 'image/png', data: png })), '', 3000,
    async (_url, options) => {
      calls++;
      assert.equal(options.signal.aborted, false);
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }, { signal: abort.signal });
  abort.abort();
  assert.equal((await pending).ok, false);
  assert.equal(calls, 1);
});
