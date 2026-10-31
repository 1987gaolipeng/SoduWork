'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), os = require('node:os');
const { createProcessSession } = require('./process-session');
const app = name => ({ getPath: () => path.join(os.tmpdir(), 'soduwork-recovery-fixture', name) });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {}); return { promise, resolve, reject }; }
function fixture(t) {
  const generations = [];
  const runtime = createProcessSession({ recoveryTimeoutMs: 50, hostFactory: (target, hostOptions) => {
    let dead = false, pending = false, failure = null, gate, cachedRejection;
    const operations = [], handles = new Map();
    const host = {
      handles, operations, target, hostOptions,
      isDead: () => dead,
      call: async (method, args) => { operations.push({ method, args }); return { ok: true }; },
      stop() {
        dead = true;
        if (cachedRejection) return cachedRejection;
        if (!gate) return failure ? Promise.reject(failure) : Promise.resolve();
        pending = true;
        return gate.promise.then(() => { pending = false; }, error => { pending = false; failure = error; throw error; });
      },
      maintenanceWorkloads: () => pending || failure ? [{ status: failure ? 'cleanup-failed' : 'cleaning' }] : [],
      diagnostics: () => ({ generation: generations.indexOf(host), dead }), notify() {},
      crash(cleanup = deferred()) { dead = true; gate = cleanup; return cleanup; },
      fail(error) { dead = true; failure = error; },
      clearFailure() { failure = null; gate = null; pending = false; cachedRejection = null; },
      timedOut(error) { dead = true; failure = error; cachedRejection = Promise.reject(error); cachedRejection.catch(() => {}); },
      confirmLateCleanup() { failure = null; pending = false; },
      pendingCallback() { dead = true; pending = true; },
      finishCallback() { pending = false; },
    };
    generations.push(host); return host;
  } });
  t.after(async () => { for (const host of generations) host.clearFailure(); await runtime.dispose(); });
  return { runtime, generations };
}

test('lifecycle installation forwards Electron power events to each new runtime host', async t => {
  const f = fixture(t), powerMonitor = {};
  f.runtime.installLifecycle({ on() {} }, powerMonitor);
  await f.runtime.open({ app: app('power-monitor') });
  assert.equal(f.generations[0].hostOptions.powerMonitor, powerMonitor);
});

test('replacement waits for verified cleanup and concurrent reopen creates one new generation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), profile = app('wait');
  await f.runtime.open({ app: profile });
  const gate = f.generations[0].crash();
  const reopening = Promise.all([f.runtime.open({ app: profile }), f.runtime.open({ app: profile })]);
  // Advance the recovery clock explicitly so Runner load cannot expire this
  // successful-cleanup scenario before its gate is released.
  t.mock.timers.tick(49);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.generations.length, 1);
  gate.resolve();
  await reopening;
  assert.equal(f.generations.length, 2);
  assert.equal(f.generations[1].operations.length, 2);
});

test('an open that races cleanup retries after the runtime confirms retirement', async t => {
  const f = fixture(t), profile = app('retry-after-cleanup');
  await f.runtime.open({ app: profile });
  const gate = f.generations[0].crash();
  setTimeout(() => gate.resolve(), 60);
  const opened = await f.runtime.open({ app: profile });
  assert.equal(opened.ok, true);
  assert.equal(f.generations.length, 2);
});

test('unconfirmed cleanup blocks execution, archive storage and skill parsing for that profile', async t => {
  const f = fixture(t), profile = app('blocked');
  await f.runtime.open({ app: profile });
  const gate = f.generations[0].crash();
  const requests = [f.runtime.open({ app: profile }), f.runtime.reserveArchive(profile, '/isolated', 'title', 'owner'),
    f.runtime.commitArchive(profile, {}), f.runtime.prepareSkills(profile, {})];
  await Promise.all(requests.map(value => assert.rejects(value, { code: 'RUNTIME_RECOVERY_PENDING' })));
  assert.equal(f.generations.length, 1);
  assert.equal(f.generations[0].operations.length, 1, 'blocked work never reaches a host');
  gate.resolve();
  await f.runtime.open({ app: profile });
  assert.equal(f.generations.length, 2);
});

test('reset retires the profile before asynchronous cleanup and another profile remains available', async t => {
  const f = fixture(t), selected = app('reset'), other = app('other');
  await f.runtime.open({ app: selected });
  const gate = f.generations[0].crash();
  const reset = f.runtime.reset(selected);
  await assert.rejects(f.runtime.open({ app: selected }), { code: 'RUNTIME_RECOVERY_PENDING' });
  assert.equal((await f.runtime.open({ app: other })).ok, true);
  assert.equal(f.generations.length, 2);
  gate.resolve(); await reset;
  await f.runtime.open({ app: selected });
  assert.equal(f.generations.length, 3);
});

test('cleanup failure and unfinished main callbacks block replacement without hiding cached projection', async t => {
  const f = fixture(t), selected = app('failed');
  await f.runtime.open({ app: selected });
  const first = f.generations[0], handle = { ref: 'still-readable', snapshot: () => ({ status: 'failed' }) };
  first.handles.set(handle.ref, { handle });
  first.fail(Error('verified child remains alive'));
  assert.equal(f.runtime.get(handle.ref).snapshot().status, 'failed');
  await assert.rejects(f.runtime.open({ app: selected }), { code: 'RUNTIME_RECOVERY_PENDING' });
  assert.equal(f.generations.length, 1);
  assert.equal(f.runtime.get(handle.ref).snapshot().status, 'failed', 'retired cached projections remain readable');
  first.clearFailure(); first.pendingCallback();
  await assert.rejects(f.runtime.open({ app: selected }), { code: 'RUNTIME_RECOVERY_PENDING' });
  first.finishCallback();
  await f.runtime.open({ app: selected });
  assert.equal(f.generations.length, 2);
});

test('a reset racing an ordinary open cannot bypass the retired-profile fence', async t => {
  const f = fixture(t), selected = app('race');
  await f.runtime.open({ app: selected });
  const gate = f.generations[0].crash();
  const reset = f.runtime.reset(selected);
  const opening = f.runtime.open({ app: selected });
  await assert.rejects(opening, { code: 'RUNTIME_RECOVERY_PENDING' });
  assert.equal(f.generations.length, 1);
  gate.resolve(); await reset;
});

test('late confirmed cleanup permits retry even when stop retains its old timeout rejection', async t => {
  const f = fixture(t), selected = app('late-confirmation');
  await f.runtime.open({ app: selected });
  const old = f.generations[0]; old.timedOut(Error('cached cleanup timeout'));
  await assert.rejects(f.runtime.open({ app: selected }), { code: 'RUNTIME_RECOVERY_PENDING' });
  old.confirmLateCleanup();
  await assert.rejects(old.stop(), /cached cleanup timeout/);
  assert.equal((await f.runtime.open({ app: selected })).ok, true);
  assert.equal(f.generations.length, 2);
});

test('a missing cleanup evidence provider cannot authorize a new generation', async t => {
  const f = fixture(t), selected = app('missing-evidence');
  await f.runtime.open({ app: selected });
  const old = f.generations[0]; old.fail(Error('cleanup could not be verified'));
  delete old.maintenanceWorkloads;
  await assert.rejects(f.runtime.open({ app: selected }), { code: 'RUNTIME_RECOVERY_PENDING' });
  assert.equal(f.generations.length, 1);
});

test('reopening rechecks a failed retired host and replaces it only after confirmation', async t => {
  const f = fixture(t), selected = app('retry-failed-retirement');
  await f.runtime.open({ app: selected });
  const old = f.generations[0]; old.timedOut(Error('stale snapshot failure'));
  let verified = false, retries = 0;
  old.retryCleanup = async () => { retries++; if (verified) old.confirmLateCleanup(); else throw Error('still unconfirmed'); };
  await assert.rejects(f.runtime.open({ app: selected }), { code: 'RUNTIME_RECOVERY_PENDING' });
  assert.equal(f.generations.length, 1);
  verified = true;
  assert.equal((await f.runtime.open({ app: selected })).ok, true);
  assert.equal(f.generations.length, 2);
  assert.ok(retries >= 2);
});
