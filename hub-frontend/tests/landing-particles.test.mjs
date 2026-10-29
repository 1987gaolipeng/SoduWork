import assert from 'node:assert/strict'
import test from 'node:test'
import { mountLandingParticles } from '../src/landing-particles.js'

function environment(t, reduced = false) {
  const original = new Map()
  const frames = new Map(), listeners = new Map(), hostListeners = new Map(), motionListeners = new Map()
  let frameId = 0, arcs = 0, transforms = [], observers = []
  const host = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1400, height: 1000 }),
    addEventListener: (key, fn) => hostListeners.set(key, fn), removeEventListener: key => hostListeners.delete(key),
  }
  const context = {
    setTransform: (...args) => transforms.push(args), clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
    arc() { arcs++ },
  }
  const canvas = { parentElement: host, getContext: () => context }
  const motion = { matches: reduced, addEventListener: (key, fn) => motionListeners.set(key, fn), removeEventListener: key => motionListeners.delete(key) }
  const doc = { hidden: false, addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) }
  class Observer {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this) }
    observe() {} disconnect() { this.disconnected = true }
  }
  for (const [key, value] of Object.entries({
    window: { devicePixelRatio: 3, matchMedia: () => motion }, document: doc,
    ResizeObserver: Observer, IntersectionObserver: Observer,
    requestAnimationFrame: fn => { const id = ++frameId; frames.set(id, fn); return id },
    cancelAnimationFrame: id => frames.delete(id), getComputedStyle: () => ({ getPropertyValue: () => '107, 92, 185' }),
  })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  t.after(() => { for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } })
  return { canvas, motion, doc, frames, listeners, hostListeners, motionListeners, observers, transforms, arcs: () => arcs,
    flush(time) { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(time)) } }
}

test('particle canvas caps density and resolution and throttles draws', t => {
  const env = environment(t), dispose = mountLandingParticles(env.canvas)
  assert.equal(env.canvas.width, 2100)
  assert.equal(env.canvas.height, 1500)
  assert.equal(env.transforms[0][0], 1.5)
  assert.equal(env.arcs(), 70)
  assert.equal(env.frames.size, 1)
  env.flush(10); assert.equal(env.arcs(), 70)
  env.flush(40); assert.equal(env.arcs(), 140)
  dispose()
})

test('reduced motion draws one static frame and responds to preference changes', t => {
  const env = environment(t, true), dispose = mountLandingParticles(env.canvas)
  assert.equal(env.arcs(), 70)
  assert.equal(env.frames.size, 0)
  env.motion.matches = false; env.motionListeners.get('change')()
  assert.equal(env.frames.size, 1)
  env.motion.matches = true; env.motionListeners.get('change')()
  assert.equal(env.frames.size, 0)
  dispose()
})

test('hidden and offscreen views suspend animation and unmount releases resources', t => {
  const env = environment(t), dispose = mountLandingParticles(env.canvas)
  env.doc.hidden = true; env.listeners.get('visibilitychange')(); assert.equal(env.frames.size, 0)
  env.doc.hidden = false; env.listeners.get('visibilitychange')(); assert.equal(env.frames.size, 1)
  env.observers[1].callback([{ isIntersecting: false }]); assert.equal(env.frames.size, 0)
  env.observers[0].callback(); assert.equal(env.frames.size, 0)
  env.observers[1].callback([{ isIntersecting: true }]); assert.equal(env.frames.size, 1)
  dispose()
  assert.equal(env.frames.size, 0)
  assert.equal(env.listeners.size + env.hostListeners.size + env.motionListeners.size, 0)
  assert.ok(env.observers.every(observer => observer.disconnected))
})

test('lack of a canvas context leaves all page controls usable', () => {
  assert.equal(typeof mountLandingParticles({ getContext: () => null }), 'function')
})
