import assert from 'node:assert/strict'
import test from 'node:test'
import { availableListHeight, observeViewportHeight } from '../src/viewport-height.js'

test('short audit viewport reserves its filters, pagination and bottom spacing', () => {
  const height = availableListHeight({ viewport: 768, top: 290, tail: 68 })
  assert.equal(290 + height + 68, 768)
  assert.ok(height < 768 * .62, 'a fixed 62vh table would overflow this layout')
})

test('wrapped filters and expanded footer reduce the list without adding page height', () => {
  const normal = availableListHeight({ viewport: 900, top: 280, tail: 60 })
  const wrapped = availableListHeight({ viewport: 900, top: 350, tail: 94 })
  assert.equal(normal - wrapped, 70 + 34)
  assert.equal(350 + wrapped + 94, 900)
})

test('overview reserves the lower row of cards instead of imposing a 360px main row', () => {
  const height = availableListHeight({ viewport: 768, top: 210, tail: 330 })
  assert.equal(height, 228)
  assert.equal(210 + height + 330, 768)
})

test('document scroll does not change the list budget', () => {
  const before = availableListHeight({ viewport: 800, top: 260, tail: 50 })
  const after = availableListHeight({ viewport: 800, top: (260 - 150) + 150, tail: 50 })
  assert.equal(before, after)
})

test('genuinely tall pages retain a usable scroll region and natural document overflow', () => {
  assert.equal(availableListHeight({ viewport: 400, top: 360, tail: 100 }), 160)
  assert.equal(availableListHeight({ viewport: 900, top: 200, tail: -10 }), 700)
})

// Synthetic geometry exercises resize/observer behavior; this is not a browser
// rendering test. Content height changes with the list, like the admin shell.
function layoutFixture(t) {
  const dimensions = { top: 290, tail: 68, content: 1200, visible: true }
  const props = new Map(), frames = new Map(), listeners = new Map(), visualListeners = new Map()
  let observer, sequence = 0, writes = 0
  const viewport = { innerHeight: 768, scrollY: 0,
    visualViewport: {
      height: 768, scale: 1,
      addEventListener: (key, handler) => visualListeners.set(key, handler),
      removeEventListener: (key, handler) => { if (visualListeners.get(key) === handler) visualListeners.delete(key) },
    },
    addEventListener: (key, handler) => listeners.set(key, handler),
    removeEventListener: (key, handler) => { if (listeners.get(key) === handler) listeners.delete(key) },
  }
  const content = { getBoundingClientRect: () => ({ bottom: element.getBoundingClientRect().bottom + dimensions.tail }) }
  const page = { parentElement: content }
  const element = {
    isConnected: true, parentElement: page,
    closest: () => content,
    getClientRects: () => dimensions.visible ? [{}] : [],
    getBoundingClientRect: () => {
      const top = dimensions.top - viewport.scrollY
      const height = Math.min(dimensions.content, parseInt(props.get('--viewport-list-height')) || Infinity)
      return { top, bottom: top + height }
    },
    style: {
      getPropertyValue: (key) => props.get(key),
      setProperty: (key, value) => { writes++; props.set(key, value) },
      removeProperty: (key) => props.delete(key),
    },
  }
  const globals = {
    window: viewport,
    requestAnimationFrame: (callback) => { frames.set(++sequence, callback); return sequence },
    cancelAnimationFrame: (id) => frames.delete(id),
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.nodes = []; observer = this }
      observe(node) { this.nodes.push(node) }
      disconnect() { this.nodes = [] }
    },
  }
  const restore = []
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    restore.push(() => original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key])
  }
  const stop = observeViewportHeight(element)
  t.after(() => { stop(); restore.forEach((fn) => fn()) })
  return {
    dimensions, viewport, element, props, frames, listeners, visualListeners, observer, stop,
    writes: () => writes,
    flush: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()) },
  }
}

test('observer reserves new pagination and wrapped filters, then settles without feedback writes', (t) => {
  const f = layoutFixture(t)
  assert.equal(f.props.get('--viewport-list-height'), '410px')
  assert.equal(f.observer.nodes.length, 3, 'watch list, page and content for async layout changes')
  f.dimensions.top += 44
  f.dimensions.tail += 34
  f.observer.callback(); f.observer.callback()
  assert.equal(f.frames.size, 1)
  f.flush()
  assert.equal(f.props.get('--viewport-list-height'), '332px')
  const writes = f.writes()
  f.observer.callback(); f.flush()
  assert.equal(f.writes(), writes, 'resizing the list itself must settle')
})

test('window resize works after document scrolling and hidden regions wait until visible', (t) => {
  const f = layoutFixture(t)
  f.viewport.scrollY = 180
  f.viewport.innerHeight = 900
  f.viewport.visualViewport.height = 900
  f.listeners.get('resize')(); f.flush()
  assert.equal(f.props.get('--viewport-list-height'), '542px')
  f.dimensions.visible = false
  f.dimensions.top += 40
  f.observer.callback(); f.flush()
  assert.equal(f.props.get('--viewport-list-height'), '542px')
  f.dimensions.visible = true
  f.observer.callback(); f.flush()
  assert.equal(f.props.get('--viewport-list-height'), '502px')
})

test('leaving a page removes observers, resize listeners, pending work and its height override', (t) => {
  const f = layoutFixture(t)
  f.observer.callback()
  assert.equal(f.frames.size, 1)
  f.stop()
  assert.equal(f.frames.size, 0)
  assert.equal(f.observer.nodes.length, 0)
  assert.equal(f.listeners.size, 0)
  assert.equal(f.visualListeners.size, 0)
  assert.equal(f.props.size, 0)
})

test('moving between small and large monitors recalculates the full available CSS height', (t) => {
  const f = layoutFixture(t)
  for (const height of [1080, 1919, 900, 768]) {
    f.viewport.innerHeight = height
    f.viewport.visualViewport.height = height
    f.listeners.get('resize')(); f.flush()
    assert.equal(f.props.get('--viewport-list-height'), `${height - 358}px`)
  }
})

test('visual viewport changes resize content even without a window resize event', (t) => {
  const f = layoutFixture(t)
  f.viewport.visualViewport.height = 640
  f.visualListeners.get('resize')?.(); f.flush()
  assert.equal(f.props.get('--viewport-list-height'), '282px')
  f.viewport.visualViewport.height = 768
  f.visualListeners.get('resize')?.(); f.flush()
  assert.equal(f.props.get('--viewport-list-height'), '410px')
})

test('pinch zoom does not relayout the page under the magnified viewport', (t) => {
  const f = layoutFixture(t)
  f.viewport.visualViewport.height = 384
  f.viewport.visualViewport.scale = 2
  f.visualListeners.get('resize')?.(); f.flush()
  assert.equal(f.props.get('--viewport-list-height'), '410px')
})
