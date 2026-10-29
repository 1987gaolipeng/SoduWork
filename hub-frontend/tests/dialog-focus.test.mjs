import assert from 'node:assert/strict'
import test from 'node:test'
import { lockDialogScroll, registerDialogLayer } from '../src/dialog-focus.js'

// A small DOM host exercises the production manager, including bubbling order.
// It does not substitute for browser focusability/layout or assistive technology QA.
class EventHost {
  listeners = new Map()
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }
  dispatch(type, event) { for (const listener of this.listeners.get(type) || []) listener(event) }
}

class Element {
  constructor(document, tag = 'div', attrs = {}, parent = document.body) {
    this.ownerDocument = document; this.tagName = tag.toUpperCase()
    this.attrs = { ...attrs }; this.children = []; this.parentElement = parent
    this.disabled = 'disabled' in attrs; this.focusCount = 0
    this.style = {}; this.isConnected = true
    parent?.children.push(this)
    const natural = ['button', 'input', 'select', 'textarea', 'summary'].includes(tag) || tag === 'a' && attrs.href
    this.tabIndex = attrs.tabindex === undefined ? (natural ? 0 : -1) : Number(attrs.tabindex)
  }
  getAttribute(name) { return this.attrs[name] ?? null }
  hasAttribute(name) { return name in this.attrs }
  contains(target) { return target === this || this.children.some((child) => child.contains(target)) }
  matches(selector) {
    return selector.split(',').some((part) => {
      let value = part.trim()
      if (value.includes(':not(:disabled)')) {
        if (this.disabled) return false
        value = value.replace(':not(:disabled)', '')
      }
      if (value.includes(':not([type="hidden"])')) {
        if (this.attrs.type === 'hidden') return false
        value = value.replace(':not([type="hidden"])', '')
      }
      if (value === ':disabled') return this.disabled || Boolean(this.closest('fieldset[disabled]'))
      const tag = value.match(/^[a-z]+/)?.[0]
      if (tag && this.tagName !== tag.toUpperCase()) return false
      const attributes = [...value.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)]
      return attributes.every(([, name, expected]) => this.hasAttribute(name) && (expected === undefined || this.attrs[name] === expected))
    })
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)])
  }
  getClientRects() { return this.closest('[hidden]') || this.style.display === 'none' ? [] : [{}] }
  focus() {
    if (!this.isConnected || this.disabled || this.closest('[inert]')) return
    this.focusCount++; this.ownerDocument.activeElement = this
    this.ownerDocument.dispatch('focusin', { target: this })
  }
}

function environment() {
  const document = new EventHost()
  document.defaultView = new EventHost()
  document.defaultView.getComputedStyle = (element) => ({ visibility: element.style.visibility || 'visible' })
  document.body = new Element(document, 'body', {}, null)
  document.activeElement = document.body
  const add = (tag, attrs, parent) => new Element(document, tag, attrs, parent)
  const key = (name, options = {}) => {
    const event = { key: name, target: document.activeElement, defaultPrevented: false, stopped: false, ...options,
      preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true } }
    document.dispatch('keydown', event)
    if (!event.stopped) document.defaultView.dispatch('keydown', event)
    return event
  }
  return { document, add, key }
}
const settle = () => new Promise((resolve) => queueMicrotask(resolve))

test('scroll locks share ownership across a drawer and modal and restore the original style once', async () => {
  const { document, add } = environment()
  document.body.style.overflow = 'auto'
  const releaseDrawer = lockDialogScroll(document)
  const root = add('div', { tabindex: '-1' })
  const releaseModal = registerDialogLayer({ root, onClose() {} })
  await settle()
  assert.equal(document.body.style.overflow, 'hidden')
  releaseDrawer()
  assert.equal(document.body.style.overflow, 'hidden', 'closing an owner first cannot unlock the remaining modal')
  releaseModal(); await settle()
  assert.equal(document.body.style.overflow, 'auto')
  releaseDrawer(); releaseModal()
  assert.equal(document.body.style.overflow, 'auto', 'cleanup is idempotent')
})

test('initial focus prefers autofocus, then form input, then interactive content and container', async () => {
  for (const kind of ['autofocus', 'input', 'button', 'empty']) {
    const { document, add } = environment()
    const trigger = add('button'); trigger.focus()
    const root = add('div', { tabindex: '-1' })
    let expected = root
    if (kind !== 'empty') expected = add('button', {}, root)
    if (['autofocus', 'input'].includes(kind)) expected = add('input', {}, root)
    if (kind === 'autofocus') expected = add('textarea', { autofocus: '' }, root)
    const release = registerDialogLayer({ root, onClose() {} })
    await settle()
    assert.equal(document.activeElement, expected, kind)
    release(); await settle()
    assert.equal(document.activeElement, trigger)
  }
})

test('Tab and Shift+Tab wrap, skip unavailable controls and contain external focus', async () => {
  const { document, add, key } = environment()
  const outside = add('button'), root = add('div', { tabindex: '-1' })
  add('button', { disabled: '' }, root)
  add('input', { type: 'hidden' }, root)
  const hidden = add('div', { hidden: '' }, root); add('input', {}, hidden)
  const inert = add('div', { inert: '' }, root); add('input', {}, inert)
  const invisible = add('input', {}, root); invisible.style.visibility = 'hidden'
  const disabledGroup = add('fieldset', { disabled: '' }, root); add('input', {}, disabledGroup)
  const first = add('button', {}, root), last = add('textarea', {}, root)
  const release = registerDialogLayer({ root, onClose() {} })
  await settle()
  assert.equal(document.activeElement, last)
  assert.equal(key('Tab').defaultPrevented, true)
  assert.equal(document.activeElement, first)
  assert.equal(key('Tab', { shiftKey: true }).defaultPrevented, true)
  assert.equal(document.activeElement, last)
  first.focus()
  assert.equal(key('Tab').defaultPrevented, false, 'native movement remains available inside the boundary')
  outside.focus()
  assert.equal(document.activeElement, first, 'restore last focus inside the dialog')
  release(); await settle()
})

test('empty dialog traps both Tab directions on its programmatically focusable container', async () => {
  const { document, add, key } = environment()
  const root = add('div', { tabindex: '-1' })
  const release = registerDialogLayer({ root, onClose() {} })
  await settle()
  for (const shiftKey of [false, true]) {
    assert.equal(key('Tab', { shiftKey }).defaultPrevented, true)
    assert.equal(document.activeElement, root)
  }
  release(); await settle()
})

test('nested layers only close the top, restore each trigger and release their listeners', async () => {
  const { document, add, key } = environment()
  const trigger = add('button'); trigger.focus()
  const outer = add('div', { tabindex: '-1' }), openChild = add('button', {}, outer)
  let outerCloses = 0, innerCloses = 0
  const closeOuter = registerDialogLayer({ root: outer, onClose() { outerCloses++ } })
  await settle()
  const inner = add('div', { tabindex: '-1' }, outer), field = add('input', {}, inner)
  const closeInner = registerDialogLayer({ root: inner, onClose() { innerCloses++ } })
  await settle()
  key('Escape')
  assert.deepEqual([outerCloses, innerCloses], [0, 1])
  assert.equal(document.activeElement, field)
  closeInner(); inner.isConnected = false; await settle()
  assert.equal(document.activeElement, openChild)
  key('Escape')
  assert.deepEqual([outerCloses, innerCloses], [1, 1])
  closeOuter(); outer.isConnected = false; await settle()
  assert.equal(document.activeElement, trigger)
  assert.equal(document.listeners.get('keydown')?.size, 0)
  assert.equal(document.listeners.get('focusin')?.size, 0)
})

test('nested child-first effect registration still gives the inner dialog keyboard ownership', async () => {
  const { document, add, key } = environment()
  const trigger = add('button'); trigger.focus()
  const outer = add('div', { tabindex: '-1' }), inner = add('div', { tabindex: '-1' }, outer)
  const input = add('input', {}, inner), closed = []
  const closeInner = registerDialogLayer({ root: inner, onClose: () => closed.push('inner'), returnFocus: trigger })
  const closeOuter = registerDialogLayer({ root: outer, onClose: () => closed.push('outer'), returnFocus: trigger })
  await settle()
  assert.equal(document.activeElement, input)
  key('Escape')
  assert.deepEqual(closed, ['inner'])
  closeInner(); closeOuter(); await settle()
})

test('Escape-only legacy dialogs participate without taking focus or closing their parent', async () => {
  const { document, add, key } = environment()
  let parentCloses = 0, childCloses = 0
  const closeParent = registerDialogLayer({ ownerDocument: document, onClose: () => parentCloses++ })
  const root = add('div', { tabindex: '-1' }); add('input', {}, root)
  const closeChild = registerDialogLayer({ root, onClose: () => childCloses++ })
  await settle()
  key('Escape')
  assert.deepEqual([parentCloses, childCloses], [0, 1])
  closeChild(); await settle()
  key('Escape')
  assert.equal(parentCloses, 1)
  closeParent(); await settle()
})

test('portal siblings retain logical nested ownership when child effects run first', async () => {
  const { document, add, key } = environment()
  const trigger = add('button'); trigger.focus()
  const outer = add('div', { tabindex: '-1' }), inner = add('div', { tabindex: '-1' })
  const outerButton = add('button', {}, outer), input = add('input', {}, inner), closed = []
  const closeInner = registerDialogLayer({ id: 'inner', ancestors: ['outer'], root: inner, onClose: () => closed.push('inner'), returnFocus: outerButton })
  const closeOuter = registerDialogLayer({ id: 'outer', ancestors: [], root: outer, onClose: () => closed.push('outer'), returnFocus: trigger })
  await settle()
  assert.equal(document.activeElement, input)
  key('Escape'); assert.deepEqual(closed, ['inner'])
  closeInner(); inner.isConnected = false; await settle()
  assert.equal(document.activeElement, outerButton)
  key('Escape'); assert.deepEqual(closed, ['inner', 'outer'])
  closeOuter(); await settle()
  assert.equal(document.activeElement, trigger)
})

test('dialog consumes Tab before suspended drawer window trap and honors handled Escape', async () => {
  const { document, add, key } = environment()
  const root = add('div', { tabindex: '-1' }), first = add('button', {}, root), last = add('input', {}, root)
  let drawerTrap = 0, closed = 0
  document.defaultView.addEventListener('keydown', () => drawerTrap++)
  const release = registerDialogLayer({ root, onClose: () => closed++ })
  // The legacy drawer effect focuses its first button after registering the child.
  first.focus(); await settle()
  assert.equal(document.activeElement, last, 'form focus wins after the legacy drawer effect finishes')
  last.focus(); key('Tab')
  assert.equal(document.activeElement, first)
  assert.equal(drawerTrap, 0)
  key('Escape', { defaultPrevented: true })
  assert.equal(closed, 0)
  key('Escape', { isComposing: true })
  assert.equal(closed, 0)
  release(); await settle()
})

test('focus already assigned by React autoFocus is preserved and removed triggers are not focused', async () => {
  const { document, add } = environment()
  const trigger = add('button'); trigger.focus()
  const root = add('div', { tabindex: '-1' }); add('input', {}, root)
  const selected = add('input', {}, root); selected.focus()
  const release = registerDialogLayer({ root, onClose() {}, returnFocus: trigger })
  await settle()
  assert.equal(document.activeElement, selected)
  trigger.isConnected = false
  const focused = trigger.focusCount
  release(); await settle()
  assert.equal(trigger.focusCount, focused)
})
