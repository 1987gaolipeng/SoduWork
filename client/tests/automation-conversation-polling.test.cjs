'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPoller, POLL_INTERVAL_MS, MAX_IDLE_INTERVAL_MS,
  ACTIVE_INTERVAL_MS, MAX_ERROR_INTERVAL_MS,
} = require('../main/automation-conversation-polling.cjs');

const flush = () => new Promise(resolve => setImmediate(resolve));
const result = (state = 'idle', scope = 'hub-a+device-a', extra = {}) => ({ state, scope, ...extra });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeClock() {
  let time = 0, sequence = 0;
  const timers = new Map();
  const next = () => [...timers.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
  return {
    now: () => time,
    setTimeout(callback, delay) {
      assert.ok(Number.isFinite(delay) && delay >= 0, `invalid timer delay: ${delay}`);
      const timer = { id: ++sequence, at: time + delay, callback, unref() {} };
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer.id); },
    delay: () => next() ? next().at - time : null,
    pending: () => timers.size,
    async advance(duration) {
      const target = time + duration;
      let iterations = 0;
      await flush();
      while (next() && next().at <= target) {
        assert.ok(++iterations < 10_000, 'timer loop did not make progress');
        const timer = next();
        time = timer.at;
        timers.delete(timer.id);
        // Deliberately do not await the callback: a network request can stay in flight.
        timer.callback();
        await flush();
      }
      time = target;
      await flush();
    },
  };
}

function harness(tick = () => result(), random = () => 1) {
  const clock = fakeClock();
  const calls = [];
  const poller = createPoller({
    tick: () => { calls.push(clock.now()); return tick(calls.length); },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, random,
  });
  return { clock, calls, poller };
}

test('polling constants expose the intended bounded intervals', () => {
  assert.equal(POLL_INTERVAL_MS, 5_000);
  assert.equal(MAX_IDLE_INTERVAL_MS, 30_000);
  assert.equal(ACTIVE_INTERVAL_MS, 15_000);
  assert.equal(MAX_ERROR_INTERVAL_MS, 60_000);
});

test('startup is staggered and repeated start does not duplicate requests', async () => {
  const { clock, calls, poller } = harness(undefined, () => 0.5);
  poller.start();
  poller.start();
  assert.equal(clock.delay(), 2_500);
  assert.equal(clock.pending(), 1);
  await clock.advance(2_499);
  assert.equal(calls.length, 0);
  await clock.advance(1);
  assert.deepEqual(calls, [2_500]);
  poller.stop();
});

test('idle polling backs off to 30 seconds and stays below 45 requests in 20 minutes without early jitter', async () => {
  const { clock, calls, poller } = harness();
  poller.start();
  await clock.advance(5_000);
  for (const delay of [5_000, 10_000, 20_000, 30_000, 30_000]) {
    assert.equal(clock.delay(), delay);
    await clock.advance(delay);
  }
  await clock.advance(20 * 60_000 - clock.now());
  assert.ok(calls.length <= 45, `20-minute idle calls: ${calls.length}; old 250 ms polling made 4800`);
  assert.ok(calls.length >= 40, 'polling should continue while idle');
  poller.stop();
});

test('even the shortest idle jitter avoids a high-frequency idle loop', async () => {
  const { clock, calls, poller } = harness(undefined, () => 0);
  poller.start();
  await clock.advance(20 * 60_000);
  assert.ok(calls.length <= 54, `20-minute idle calls with shortest jitter: ${calls.length}`);
  assert.equal(clock.pending(), 1);
  poller.stop();
});

test('active work polls every 15 seconds and resets idle backoff', async () => {
  let state = 'idle';
  const { clock, calls, poller } = harness(() => result(state));
  poller.start();
  await clock.advance(20_000);
  assert.equal(clock.delay(), 20_000);
  state = 'active';
  await clock.advance(20_000);
  assert.equal(clock.delay(), 15_000);
  await clock.advance(30_000);
  assert.deepEqual(calls.slice(-3), [40_000, 55_000, 70_000]);
  state = 'idle';
  await clock.advance(15_000);
  assert.equal(clock.delay(), 5_000);
  poller.stop();
});

test('errors back off to 60 seconds and a successful result resets failure history', async () => {
  let state = 'error';
  const { clock, poller } = harness(() => result(state));
  poller.start();
  await clock.advance(5_000);
  for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
    assert.equal(clock.delay(), delay);
    await clock.advance(delay);
  }
  state = 'idle';
  await clock.advance(clock.delay());
  assert.equal(clock.delay(), 5_000);
  state = 'error';
  await clock.advance(5_000);
  assert.equal(clock.delay(), 5_000);
  poller.stop();
});

test('rejected requests use error backoff and resume after recovery', async () => {
  let fail = true;
  const { clock, poller } = harness(() => {
    if (fail) return Promise.reject(new Error('temporary network failure'));
    return result();
  });
  poller.start();
  await clock.advance(5_000);
  assert.equal(clock.delay(), 5_000);
  await clock.advance(5_000);
  assert.equal(clock.delay(), 10_000);
  fail = false;
  await clock.advance(10_000);
  assert.equal(clock.delay(), 5_000);
  poller.stop();
});

for (const random of [0, 1]) {
  test(`ordinary polling jitter respects its ${random ? 'upper' : 'lower'} bound`, async () => {
    for (const [state, interval] of [['idle', 5_000], ['active', 15_000], ['error', 5_000]]) {
      const { clock, poller } = harness(() => result(state), () => random);
      poller.start();
      assert.equal(clock.delay(), random * 5_000);
      await clock.advance(random * 5_000);
      assert.equal(clock.delay(), interval * (0.8 + 0.2 * random), state);
      poller.stop();
    }
  });
}

test('changing Hub/device scope resets idle and error backoff', async () => {
  for (const state of ['idle', 'error']) {
    let scope = 'hub-a+device-a';
    const { clock, poller } = harness(() => result(state, scope));
    poller.start();
    await clock.advance(40_000);
    assert.ok(clock.delay() >= 30_000);
    scope = 'hub-b+device-b';
    await clock.advance(clock.delay());
    assert.equal(clock.delay(), 5_000, state);
    poller.stop();
  }
});

test('blocked results honor retry-after and default to 60 seconds without early jitter', async () => {
  for (const retryAfterMs of [undefined, 90_000]) {
    const { clock, calls, poller } = harness(() => result('blocked', undefined, { retryAfterMs }), () => 0);
    poller.start();
    await clock.advance(0);
    const expected = retryAfterMs ?? 60_000;
    assert.equal(clock.delay(), expected);
    await clock.advance(expected - 1);
    assert.equal(calls.length, 1);
    await clock.advance(1);
    assert.equal(calls.length, 2);
    poller.stop();
  }
});

test('slow requests never overlap and next polling interval begins after completion', async () => {
  const request = deferred();
  const { clock, calls, poller } = harness(() => request.promise);
  poller.start();
  await clock.advance(5_000);
  await clock.advance(120_000);
  assert.equal(calls.length, 1);
  assert.equal(clock.pending(), 0);
  request.resolve(result());
  await flush();
  assert.equal(clock.delay(), 5_000);
  await clock.advance(4_999);
  assert.equal(calls.length, 1);
  poller.stop();
});

test('manual wake cancels idle delay, coalesces a burst, and limits repeated wake requests to once per second', async () => {
  const { clock, calls, poller } = harness();
  poller.start();
  await clock.advance(40_000);
  assert.equal(clock.delay(), 30_000);
  for (let i = 0; i < 20; i++) poller.wake();
  assert.equal(clock.pending(), 1);
  await clock.advance(0);
  assert.equal(calls.at(-1), 40_000);
  const before = calls.length;
  for (let i = 0; i < 20; i++) poller.wake();
  await clock.advance(999);
  assert.equal(calls.length, before);
  await clock.advance(1);
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1), 41_000);
  assert.equal(clock.pending(), 1);
  poller.stop();
});

test('wake arriving during an in-flight request is retained exactly once without overlap', async () => {
  const request = deferred();
  const { clock, calls, poller } = harness(count => count === 1 ? request.promise : result());
  poller.start();
  poller.wake();
  await clock.advance(0);
  assert.deepEqual(calls, [0]);
  await clock.advance(300);
  for (let i = 0; i < 10; i++) poller.wake();
  assert.equal(clock.pending(), 0);
  request.resolve(result());
  await flush();
  assert.equal(clock.delay(), 700);
  await clock.advance(699);
  assert.equal(calls.length, 1);
  await clock.advance(1);
  assert.deepEqual(calls, [0, 1_000]);
  assert.equal(clock.delay(), 10_000);
  poller.stop();
});

test('queued manual wake cannot bypass an error or blocked response delay', async () => {
  for (const [state, expected] of [['error', 5_000], ['blocked', 60_000]]) {
    const request = deferred();
    const { clock, calls, poller } = harness(() => request.promise);
    poller.start();
    poller.wake();
    await clock.advance(0);
    poller.wake();
    poller.wake();
    request.resolve(result(state));
    await flush();
    assert.equal(clock.delay(), expected, state);
    await clock.advance(expected - 1);
    assert.equal(calls.length, 1, state);
    poller.stop();
  }
});

test('stop clears pending timers and start/wake cannot restart the stopped poller', async () => {
  const { clock, calls, poller } = harness();
  poller.wake();
  assert.equal(clock.pending(), 0);
  poller.start();
  poller.stop();
  poller.stop();
  poller.start();
  poller.wake();
  await clock.advance(120_000);
  assert.equal(clock.pending(), 0);
  assert.equal(calls.length, 0);
});

test('stopping an in-flight poll prevents a queued wake or completion from rescheduling', async () => {
  const request = deferred();
  const { clock, calls, poller } = harness(() => request.promise);
  poller.start();
  await clock.advance(5_000);
  poller.wake();
  poller.stop();
  request.resolve(result());
  await flush();
  await clock.advance(120_000);
  assert.equal(calls.length, 1);
  assert.equal(clock.pending(), 0);
});

test('confirmed push reduces twenty-minute idle polling while lost events still converge', async () => {
  for (const random of [0, 1]) {
    let confirmed = true;
    const { clock, calls, poller } = harness(() => result('idle', 'alice', { pushConfirmed: confirmed }), () => random);
    poller.start(); await clock.advance(20 * 60_000);
    assert.ok(calls.length <= 30, `idle discovery requests: ${calls.length}`);
    assert.ok(calls.length >= 20, 'a lost event still has bounded HTTP reconciliation');
    confirmed = false; poller.wake(); await clock.advance(1000);
    assert.ok(clock.delay() <= 30_000, 'capability loss restores legacy polling');
    poller.stop();
  }
});

test('confirmed push never slows active conversation leases', async () => {
  const { clock, calls, poller } = harness(() => result('active', 'alice', { pushConfirmed: true }));
  poller.start(); await clock.advance(305_000);
  assert.equal(calls.length, 21);
  assert.equal(clock.delay(), 15_000);
  poller.stop();
});

test('push storms after a completed error or authentication rejection cannot erase backoff', async () => {
  for (const [state, duration] of [['error', 5_000], ['blocked', 60_000]]) {
    const { clock, calls, poller } = harness(() => result(state));
    poller.start(); await clock.advance(5_000);
    for (let i = 0; i < 20; i++) { poller.wake(); await clock.advance((duration - 100) / 20); }
    assert.equal(calls.length, 1, state);
    assert.ok(clock.delay() >= 99, state);
    await clock.advance(101); assert.equal(calls.length, 2, state);
    poller.stop();
  }
});
