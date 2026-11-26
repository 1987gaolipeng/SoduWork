'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readMaterials } = require('../main/conversation/material-reader.cjs');

let directory, file, digest;
const bytes = 48 * 1024 * 1024;
before(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'material-text-'));
  file = path.join(directory, 'application.log');
  const chunk = Buffer.from('ordinary application log entry\n'.repeat(4096));
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'w');
  try {
    for (let written = 0; written < bytes;) {
      const part = chunk.subarray(0, Math.min(chunk.length, bytes - written));
      let offset = 0;
      while (offset < part.length) offset += fs.writeSync(fd, part, offset, part.length - offset);
      hash.update(part); written += part.length;
    }
  } finally { fs.closeSync(fd); }
  digest = hash.digest('hex');
});
after(() => fs.rmSync(directory, { recursive: true, force: true }));

for (const mode of ['async', 'sync']) {
  test(`${mode} turn preparation bounds memory for a large text attachment`, t => {
    // Each process measures its own retained JavaScript heap after collection;
    // fixture buffers and unrelated test-runner allocations are not counted.
    const script = `
      const prep = require(process.argv[1]);
      (async () => {
        global.gc(); const before = process.memoryUsage().heapUsed;
        const peakBefore = process.resourceUsage().maxRSS;
        const files = [{ name: 'application.log', path: process.argv[2] }];
        const result = process.argv[3] === 'sync'
          ? prep.prepareSync({ files }) : await prep.prepare({ files });
        await new Promise(resolve => setImmediate(resolve));
        global.gc();
        process.stdout.write(JSON.stringify({
          retained: process.memoryUsage().heapUsed - before,
          peakGrowth: (process.resourceUsage().maxRSS - peakBefore) * 1024,
          excerpt: result.rows[0].excerpt,
          material: result.materials && {
            status: result.materials[0].status, bytes: result.materials[0].bytes,
            hash: result.materials[0].hash, length: result.materials[0].text.length,
          },
        }));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const result = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '-e', script,
      require.resolve('../main/conversation/conversation-input-preparation.cjs'), file, mode], { encoding: 'utf8' }));
    t.diagnostic(`${mode}: ${result.retained} retained heap bytes, ${result.peakGrowth} peak RSS growth bytes`);
    assert.equal(result.excerpt.length, 12000);
    assert.ok(result.excerpt.startsWith('ordinary application log entry\n'));
    if (mode === 'async') assert.deepEqual(result.material, {
      status: 'partial', bytes, hash: digest, length: 240000,
    });
    assert.ok(result.retained < 6 * 1024 * 1024,
      `${mode} preparation retained ${result.retained} heap bytes for a small prefix`);
    assert.ok(result.peakGrowth < 80 * 1024 * 1024,
      `${mode} preparation grew peak RSS by ${result.peakGrowth} bytes for a small prefix`);
  });
}

test('streamed text preserves byte limits, complete source hashes, and Unicode ranges', async () => {
  const data = Buffer.from('\uFEFF规则🙂\n'.repeat(20));
  const source = path.join(directory, 'rules.txt');
  fs.writeFileSync(source, data);
  const out = await readMaterials([{ name: 'rules.txt', stagedPath: source }], { maxFileBytes: 17, maxTotalText: 10 });
  const item = out.materials[0];
  const expected = data.subarray(0, 17).toString('utf8').replace(/^\uFEFF/, '').slice(0, 10);
  assert.equal(item.status, 'partial');
  assert.equal(item.text, expected);
  assert.equal(item.bytes, data.length);
  assert.equal(item.hash, crypto.createHash('sha256').update(data).digest('hex'));
  assert.equal(out.totalText, expected.length);
  assert.equal(item.sourceRanges.at(-1).end, expected.length);
});

test('an exhausted aggregate budget still identifies and hashes nonempty BOM-prefixed text', async () => {
  const source = path.join(directory, 'bom.txt');
  const data = Buffer.from('\uFEFFcontent');
  fs.writeFileSync(source, data);
  const out = await readMaterials([{ name: 'bom.txt', stagedPath: source }], { maxTotalText: 0 });
  assert.equal(out.materials[0].status, 'partial');
  assert.equal(out.materials[0].text, '');
  assert.equal(out.materials[0].bytes, data.length);
  assert.equal(out.materials[0].hash, crypto.createHash('sha256').update(data).digest('hex'));
});

test('UTF-8 characters crossing read chunks preserve the existing async and sync snippets', async () => {
  const source = path.join(directory, 'unicode.log');
  const text = '\uFEFF中文🙂\n'.repeat(20000);
  fs.writeFileSync(source, text);
  const prep = require('../main/conversation/conversation-input-preparation.cjs');
  const files = [{ name: 'unicode.log', path: source }];
  const streamed = await prep.prepare({ files });
  assert.equal(streamed.materials[0].text, text.replace(/^\uFEFF/, ''));
  assert.equal(streamed.materials[0].status, 'read');
  assert.equal(streamed.materials[0].hash, crypto.createHash('sha256').update(text).digest('hex'));
  assert.equal(prep.prepareSync({ files }).rows[0].excerpt, text.slice(0, prep.MAX_SNIPPET).trim());
});

test('cancelling material preparation interrupts an active large text read', async () => {
  const controller = new AbortController();
  const reading = readMaterials([{ name: 'application.log', stagedPath: file }], { signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(reading, /Material read aborted/);
});
