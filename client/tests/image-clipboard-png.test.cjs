'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { writePng, MAX_IMAGE_BYTES } = require('../main/conversation/image-clipboard');
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test('renderer PNG data is decoded then normalized before copying', async () => {
  let decoded, copied;
  const image = { isEmpty: () => false };
  await writePng(new Uint8Array(signature), {
    nativeImage: { createFromBuffer: data => { decoded = data; return image; } },
    clipboard: { writeImage: value => { copied = value; } },
  });
  assert.deepEqual(decoded, signature); assert.equal(copied, image);
});

test('arbitrary paths, URLs, objects and non-PNG bytes are rejected before decode', async () => {
  const runtime = { nativeImage: { createFromBuffer: () => assert.fail('must not decode') } };
  for (const value of [undefined, '', 'C:/secret.png', 'https://example.com/image.png', {},
      { 'text/uri-list': 'file:///secret' }, [], new Uint8Array(0), new Uint8Array(MAX_IMAGE_BYTES + 1)]) {
    await assert.rejects(writePng(value, runtime), /为空或超过/);
  }
  await assert.rejects(writePng(Buffer.from('not PNG'), runtime), /不是 PNG/);
});

test('a PNG signature alone is not enough: corrupt image data is rejected', async () => {
  await assert.rejects(writePng(signature, {
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
    clipboard: { writeImage: () => assert.fail('must not write') },
  }), /图片内容无法识别/);
});
