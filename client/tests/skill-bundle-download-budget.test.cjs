'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchBundle } = require('../main/conversation/skill-cache');

const LIMIT = 30 * 1024 * 1024;
const identity = { hub: 'https://fixture.invalid', clientId: 'fixture', secret: 'fixture' };
const download = response => fetchBundle(identity, ['fixture-skill'], 1000, async () => response);

for (const advertised of [null, '1']) {
  test(`stops an oversized bundle with ${advertised === null ? 'no' : 'understated'} Content-Length`, async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let pulls = 0, cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        if (pulls++ < 34) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const response = new Response(body, { headers: advertised === null ? {} : { 'Content-Length': advertised } });
    assert.deepEqual(await download(response), { ok: false, reason: 'Skill 包超过 30MB' });
    assert.equal(cancelled, true);
    assert.equal(pulls, 31);
    assert.equal(body.locked, false);
  });
}

test('cancels an advertised oversized bundle without consuming its body', async () => {
  let pulls = 0, cancelled = false;
  const body = new ReadableStream({
    pull() { pulls++; },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const result = await download(new Response(body, { headers: { 'Content-Length': String(LIMIT + 1) } }));
  assert.deepEqual(result, { ok: false, reason: 'Skill 包超过 30MB' });
  assert.equal(pulls, 0);
  assert.equal(cancelled, true);
});

test('preserves the exact downloaded bytes and checksum header', async () => {
  const chunks = [Buffer.from([0x50, 0x4b, 0, 0xff]), Buffer.from('fixture archive bytes')];
  const body = new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  } });
  const result = await download(new Response(body, { headers: { 'X-SoduWork-Skill-Sha256': 'fixture-digest' } }));
  assert.deepEqual(result, { ok: true, data: Buffer.concat(chunks), checksum: 'fixture-digest' });
});

test('accepts a chunked bundle at exactly the byte limit', async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(0x5a);
  let remaining = 30;
  const body = new ReadableStream({ pull(controller) {
    if (remaining-- > 0) controller.enqueue(chunk);
    else controller.close();
  } }, { highWaterMark: 0 });
  const result = await download(new Response(body));
  assert.equal(result.ok, true);
  assert.equal(result.data.length, LIMIT);
  assert.equal(result.data[0], 0x5a);
  assert.equal(result.data.at(-1), 0x5a);
});

test('a read failure retains the temporary synchronization error', async () => {
  const body = new ReadableStream({ pull(controller) { controller.error(Error('disconnected')); } });
  assert.deepEqual(await download(new Response(body)), { ok: false, reason: '暂时无法同步 Skill' });
});

test('a no-content response remains a successful empty synchronization', async () => {
  assert.deepEqual(await download(new Response(null, { status: 204 })), { ok: true, data: null, checksum: '' });
});
