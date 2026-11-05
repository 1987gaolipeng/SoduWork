import test from 'node:test'
import assert from 'node:assert/strict'
import { createRefreshLoop } from '../src/polling.js'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const flush = () => new Promise(resolve => setImmediate(resolve))
function environment() {
  let now = 0, id = 0
  const timers = new Map(), listeners = new Set()
  const doc = { hidden: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) }
  return {
    document: doc, timers: { setTimeout(fn, delay) { timers.set(++id, { fn, at: now + delay }); return id }, clearTimeout(id) { timers.delete(id) } },
    tick(ms) { now += ms; for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.fn() } },
    visibility(hidden) { doc.hidden = hidden; listeners.forEach(fn => fn()) },
    delays: () => [...timers.values()].map(timer => timer.at - now), listeners,
  }
}

test('slow calls stay single-flight and repeat from completion, manual refreshes coalesce', async () => {
  const env = environment(), calls = []
  const loop = createRefreshLoop(() => { const call = deferred(); calls.push(call); return call.promise }, { ...env, interval: 3000 })
  env.tick(30000); loop.refresh(); loop.refresh()
  assert.equal(calls.length, 1)
  calls[0].resolve(); await flush()
  assert.equal(calls.length, 2)
  calls[1].resolve(); await flush()
  assert.deepEqual(env.delays(), [3000])
  env.tick(2999); assert.equal(calls.length, 2)
  env.tick(1); assert.equal(calls.length, 3)
  loop.stop(); calls[2].resolve(); await flush()
  assert.deepEqual(env.delays(), [])
})

test('hidden tabs pause, discard late values, resume once and unmount never reschedules', async () => {
  const env = environment(), calls = [], accepted = []
  const loop = createRefreshLoop(async isCurrent => { const call = deferred(); calls.push(call); const value = await call.promise; if (isCurrent()) accepted.push(value) }, { ...env, interval: 3000 })
  env.visibility(true); env.tick(30000)
  assert.equal(calls.length, 1)
  env.visibility(false); env.visibility(true); env.visibility(false)
  assert.equal(calls.length, 1)
  calls[0].resolve('stale'); await flush()
  assert.deepEqual(accepted, []); assert.equal(calls.length, 2)
  calls[1].resolve('current'); await flush()
  assert.deepEqual(accepted, ['current'])
  env.visibility(true); assert.deepEqual(env.delays(), [])
  env.visibility(false); assert.equal(calls.length, 3)
  loop.stop(); calls[2].resolve('unmounted'); await flush()
  assert.deepEqual(accepted, ['current']); assert.equal(env.listeners.size, 0)
  assert.deepEqual(env.delays(), [])
})

test('failed requests back off to a bounded delay and successful retry resets it', async () => {
  const env = environment(); let fails = true, calls = 0
  const loop = createRefreshLoop(async () => { calls++; if (fails) throw Error('offline') }, { ...env, interval: 3000 })
  await flush(); assert.deepEqual(env.delays(), [6000])
  for (const delay of [12000, 24000, 48000, 60000, 60000]) {
    env.tick(60000); await flush(); assert.deepEqual(env.delays(), [delay])
  }
  fails = false; env.tick(60000); await flush()
  assert.deepEqual(env.delays(), [3000]); assert.equal(calls, 7)
  loop.stop()
})

test('a tab mounted hidden waits for visibility before its initial request', async () => {
  const env = environment(); env.document.hidden = true; let calls = 0
  const loop = createRefreshLoop(async () => { calls++ }, { ...env, interval: 15000 })
  await flush(); assert.equal(calls, 0)
  env.visibility(false); await flush(); assert.equal(calls, 1)
  loop.stop()
})
