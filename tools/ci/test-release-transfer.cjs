'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { concurrency, transferAll, verifyDownload } = require('./release-transfer.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('bounded transfers preserve input order and report actual completion', async () => {
  let active = 0, peak = 0; const events = [];
  const result = await transferAll([30, 5, 1], async value => {
    peak = Math.max(peak, ++active); await pause(value); active--; return value * 2;
  }, { limit: 2, emit: event => events.push(event) });
  assert.equal(peak, 2); assert.deepEqual(result, [60, 10, 2]);
  assert.equal(events.at(-1).completed, 3);
  assert.equal(events.filter(event => event.status === 'started').length, 3);
  for (const value of ['0', '5', '2.5', '01', '2oops', '']) assert.throws(() => concurrency({ SODUWORK_RELEASE_TRANSFER_CONCURRENCY: value }));
});
test('failure stops pending transfers and awaits in-flight completion before rejecting', async () => {
  const started = [], completed = [], events = [];
  await assert.rejects(transferAll([0, 1, 2, 3], async index => {
    started.push(index);
    if (!index) { await pause(5); throw Error('fixture failed'); }
    await pause(30); completed.push(index);
  }, { limit: 2, emit: event => events.push(event) }), /fixture failed/);
  assert.deepEqual(started, [0, 1]); assert.deepEqual(completed, [1]);
  assert.equal(events.filter(event => event.status === 'failed').length, 1);
});
test('full download verifies bytes, rejects truncation, wrong digest, oversized data and transport failure', async () => {
  const bytes = Buffer.from('accepted installer'), item = { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  const fetcher = async (url, options) => { assert.equal(options.redirect, 'error'); assert.ok(options.signal); return new Response(bytes); };
  assert.equal((await verifyDownload('https://fixture.invalid/release', item, { fetcher })).size, bytes.length);
  for (const body of [bytes.subarray(1), Buffer.alloc(bytes.length), Buffer.concat([bytes, bytes])])
    await assert.rejects(verifyDownload('https://fixture.invalid', item, { fetcher: async () => new Response(body) }));
  await assert.rejects(verifyDownload('https://fixture.invalid', item, { fetcher: async () => { throw Error('offline'); } }), /offline/);
  await assert.rejects(verifyDownload('https://fixture.invalid', item, { fetcher: async () => new Response(null, { status: 503 }) }), /download failed/);
});
