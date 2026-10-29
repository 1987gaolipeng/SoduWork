'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { create } = require('../main/work-preview-sessions.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture({ blocked, failed, cleanupTimeoutMs } = {}) {
  const created = [], errors = [], calls = [];
  const pool = create({ session: { fromPartition(partition) {
    const value = { partition,
      async closeAllConnections() { calls.push([partition, 'connections']); },
      async clearData() { calls.push([partition, 'data']); if (blocked) await blocked.promise; if (failed === 'data') throw Error('clear failed'); },
      async clearAuthCache() { calls.push([partition, 'auth']); if (failed === 'auth') throw Error('auth failed'); },
    }; created.push(value); return value;
  } }, cleanupTimeoutMs, onError: error => errors.push(error.message) });
  return { pool, created, errors, calls };
}
test('concurrent owners have exclusive in-memory sessions; completed cleanup permits reuse', async () => {
  const f = fixture(), a = f.pool.acquire(), b = f.pool.acquire();
  assert.notEqual(a.partition, b.partition); assert.notEqual(a.session, b.session);
  assert.ok(!a.partition.startsWith('persist:'));
  assert.equal(await a.release(), true);
  const next = f.pool.acquire(); assert.equal(next.session, a.session); assert.notEqual(next.session, b.session);
  assert.deepEqual(f.calls.map(row => row[1]), ['connections', 'data', 'auth', 'connections']);
  assert.equal(f.created.length, 2);
});
test('an opening owner waits for all asynchronous cleanup and cannot see old credentials', async () => {
  const blocked = deferred(), f = fixture({ blocked }); const first = f.pool.acquire();
  const cleaning = first.release(); let assigned = false;
  const waiting = Promise.resolve(f.pool.acquire()).then(value => { assigned = true; return value; });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(assigned, false); assert.equal(f.created.length, 1);
  assert.deepEqual(f.calls.map(row => row[1]), ['connections', 'data']);
  blocked.resolve(); assert.equal(await cleaning, true);
  assert.equal((await waiting).session, first.session);
  assert.deepEqual(f.calls.map(row => row[1]), ['connections', 'data', 'auth', 'connections']);
});
for (const failed of ['data', 'auth']) test('failed ' + failed + ' cleanup quarantines the old partition', async () => {
  const f = fixture({ failed }), old = f.pool.acquire();
  assert.equal(await old.release(), false);
  const next = f.pool.acquire(); assert.notEqual(next.partition, old.partition); assert.notEqual(next.session, old.session);
  assert.equal(f.errors.length, 1);
});
test('waiting concurrent owners cannot claim the same cleaned slot', async () => {
  const blocked = deferred(), f = fixture({ blocked }); const first = f.pool.acquire(); first.release();
  const a = f.pool.acquire(), b = f.pool.acquire(); blocked.resolve();
  const [one, two] = await Promise.all([a, b]);
  assert.notEqual(one.partition, two.partition); assert.equal(f.created.length, 2);
});
test('releasing an old lease twice never releases a newer owner', async () => {
  const f = fixture(), first = f.pool.acquire(); await first.release();
  const second = f.pool.acquire(); await first.release(); const third = f.pool.acquire();
  assert.notEqual(second.partition, third.partition); assert.equal(f.calls.length, 4);
});

test('abandoned waiters do not allocate sessions when cleanup completes', async () => {
  const blocked = deferred(), f = fixture({ blocked }); const first = f.pool.acquire(); first.release();
  let active = true;
  const abandoned = Array.from({ length: 200 }, () => f.pool.acquire(() => active));
  active = false;
  const waiting = f.pool.acquire(); blocked.resolve();
  assert.deepEqual(await Promise.all(abandoned), Array(200).fill(null));
  assert.equal((await waiting).session, first.session); assert.equal(f.created.length, 1);
});

test('hung cleanup is quarantined within a bounded wait and late success never makes it reusable', async () => {
  const blocked = deferred(), f = fixture({ blocked, cleanupTimeoutMs: 30 });
  const old = f.pool.acquire(); const cleaning = old.release(); const waiting = f.pool.acquire();
  assert.equal(await cleaning, false);
  const next = await waiting; assert.notEqual(next.session, old.session);
  assert.match(f.errors[0], /timed out/);
  blocked.resolve(); await new Promise(resolve => setImmediate(resolve));
  const later = f.pool.acquire(); assert.notEqual(later.session, old.session);
});
