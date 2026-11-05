'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

function concurrency(env = process.env) {
  const value = env.SODUWORK_RELEASE_TRANSFER_CONCURRENCY ?? '2';
  assert.match(value, /^[1-4]$/, 'Release transfer concurrency must be 1–4');
  return Number(value);
}
// Stop starting new work after a failure, but await every in-flight operation
// before reporting failure or writing the final evidence.
async function transferAll(items, worker, { limit = concurrency(), emit = event => console.log(JSON.stringify(event)), phase = 'transfer' } = {}) {
  assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 4);
  let next = 0, completed = 0, failure;
  const results = new Array(items.length);
  async function consume() {
    while (!failure && next < items.length) {
      const index = next++, item = items[index], started = Date.now();
      const event = status => ({ phase, status, index: index + 1, total: items.length,
        completed, elapsedMs: Date.now() - started });
      const heartbeat = setInterval(() => emit(event('running')), 30000);
      heartbeat.unref();
      try {
        emit(event('started'));
        results[index] = await worker(item, index);
        completed++;
        emit(event('completed'));
      } catch (error) {
        failure ||= error;
        emit(event('failed'));
      } finally {
        clearInterval(heartbeat);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  if (failure) throw failure;
  return results;
}

async function verifyDownload(url, item, { fetcher = fetch, timeout = 15 * 60000 } = {}) {
  const started = Date.now();
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(timeout) });
  assert.ok(response.ok && response.body, 'Public installer download failed');
  let size = 0;
  const digest = crypto.createHash('sha256');
  for await (const bytes of response.body) {
    size += bytes.length;
    assert.ok(size <= item.size, 'Public installer exceeds the accepted size');
    digest.update(bytes);
  }
  assert.equal(size, item.size, 'Public installer size differs');
  assert.equal(digest.digest('hex'), item.sha256, 'Public installer SHA-256 differs');
  return { size, elapsedMs: Date.now() - started };
}
module.exports = { concurrency, transferAll, verifyDownload };
