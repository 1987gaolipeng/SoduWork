'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeImage } = require('../main/conversation/image-clipboard');
const png = Buffer.from('decoded PNG fixture');
const image = { isEmpty: () => false, toPNG: () => png };
class Item {
  constructor(data) { this.data = data; }
}

test('Electron 44 copies an image/png Blob, not the removed writeImage API', async () => {
  let items;
  await writeImage(image, { ClipboardItem: Item, clipboard: { write: async value => { items = value; } } });
  assert.equal(items.length, 1);
  assert.deepEqual(Object.keys(items[0].data), ['image/png']);
  assert.equal(items[0].data['image/png'].type, 'image/png');
  assert.deepEqual(Buffer.from(await items[0].data['image/png'].arrayBuffer()), png);
});

test('copy completion waits for the operating system write', async () => {
  let resolveWrite, settled = false;
  const job = writeImage(image, { ClipboardItem: Item, clipboard: {
    write: () => new Promise(resolve => { resolveWrite = resolve; }),
  } }).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  resolveWrite(); await job; assert.equal(settled, true);
});

test('modern clipboard failure propagates and never falls back to a false success', async () => {
  let legacyCalled = false;
  await assert.rejects(writeImage(image, { ClipboardItem: Item, clipboard: {
    write: async () => { throw new Error('OS clipboard busy'); },
    writeImage: () => { legacyCalled = true; },
  } }), /OS clipboard busy/);
  assert.equal(legacyCalled, false);
});

test('pre-44 clients keep their existing native image copy path', async () => {
  let copied;
  await writeImage(image, { clipboard: { writeImage: value => { copied = value; } } });
  assert.equal(copied, image);
});

test('legacy clipboard errors also propagate', async () => {
  await assert.rejects(writeImage(image, { clipboard: {
    writeImage: () => { throw new Error('clipboard unavailable'); },
  } }), /clipboard unavailable/);
});

test('empty or corrupt images cannot replace clipboard contents', async () => {
  const runtime = { ClipboardItem: Item, clipboard: { write: () => assert.fail('must not write') } };
  await assert.rejects(writeImage(null, runtime), /图片内容无法识别/);
  await assert.rejects(writeImage({ isEmpty: () => true }, runtime), /图片内容无法识别/);
  await assert.rejects(writeImage({ isEmpty: () => false, toPNG: () => Buffer.alloc(0) }, runtime), /图片转换失败/);
});

test('missing clipboard support reports an actionable error', async () => {
  await assert.rejects(writeImage(image, { clipboard: {} }), /请更新客户端/);
});
