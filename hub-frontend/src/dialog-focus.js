const documents = new WeakMap()
const scrollLocks = new WeakMap()
const INTERACTIVE = 'button, a[href], area[href], input, select, textarea, summary, iframe, [tabindex], [contenteditable="true"]'
const FORM_CONTROL = 'input, select, textarea, [contenteditable="true"], [role="combobox"]'

// Shared with the detail drawer so either parent/child cleanup order is safe.
export function lockDialogScroll(document) {
  const style = document?.body?.style
  if (!style) return () => {}
  let lock = scrollLocks.get(document)
  if (!lock) {
    lock = { count: 0, overflow: style.overflow }
    scrollLocks.set(document, lock)
  }
  lock.count++
  style.overflow = 'hidden'
  let released = false
  return () => {
    if (released) return
    released = true
    if (--lock.count === 0) {
      style.overflow = lock.overflow
      scrollLocks.delete(document)
    }
  }
}

function available(element) {
  if (!element?.isConnected || element.matches(':disabled') || element.getAttribute('type') === 'hidden') return false
  if (element.closest('[hidden], [inert]') || !element.getClientRects().length) return false
  const visibility = element.ownerDocument.defaultView?.getComputedStyle(element).visibility
  return visibility !== 'hidden' && visibility !== 'collapse'
}

function tabStops(root) {
  return [...root.querySelectorAll(INTERACTIVE)]
    .filter((element) => element.tabIndex >= 0 && available(element))
    // Positive tabindex values precede the natural DOM order, as in native Tab.
    .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity))
}

function focus(element) { element?.focus({ preventScroll: true }) }

function initialTarget(entry) {
  const { root, initialFocus } = entry
  const autofocus = [...root.querySelectorAll('[autofocus]')].find(available)
  if (autofocus) return autofocus
  // React autoFocus may focus a control without retaining an autofocus attribute.
  if (root.contains(initialFocus) && available(initialFocus)) return initialFocus
  const elements = tabStops(root)
  return elements.find((element) => element.matches(FORM_CONTROL)) || elements[0] || root
}

function install(document) {
  const state = { entries: [], redirecting: false }
  const top = () => state.entries.at(-1)

  function focusin(event) {
    const entry = top()
    if (!entry?.root || state.redirecting) return
    if (entry.root.contains(event.target)) { entry.lastFocus = event.target; return }
    state.redirecting = true
    try { focus(available(entry.lastFocus) ? entry.lastFocus : initialTarget(entry)) }
    finally { state.redirecting = false }
  }

  function keydown(event) {
    const entry = top()
    if (!entry || event.isComposing) return
    if (event.key === 'Escape') {
      // Let a child widget consume Escape before it reaches this document listener.
      event.stopPropagation()
      if (!event.defaultPrevented) { event.preventDefault(); entry.onClose() }
      return
    }
    if (event.key !== 'Tab' || !entry.root) return
    // PluginDetailDrawer's existing suspended trap listens on window. Only the
    // current modal may move focus; otherwise the two traps wrap the same key twice.
    event.stopPropagation()
    if (event.defaultPrevented) return
    const elements = tabStops(entry.root), first = elements[0], last = elements.at(-1)
    const active = document.activeElement
    if (!first) { event.preventDefault(); focus(entry.root); return }
    if (event.shiftKey && (active === first || active === entry.root || !entry.root.contains(active))) {
      event.preventDefault(); focus(last)
    } else if (!event.shiftKey && (active === last || active === entry.root || !entry.root.contains(active))) {
      event.preventDefault(); focus(first)
    }
  }

  document.addEventListener('keydown', keydown)
  document.addEventListener('focusin', focusin)
  state.dispose = () => {
    document.removeEventListener('keydown', keydown)
    document.removeEventListener('focusin', focusin)
    documents.delete(document)
  }
  documents.set(document, state)
  return state
}

// Escape-only callers use the same stack without acquiring a focus boundary.
// A single registration lives for the component lifetime; callback refs in React
// keep onClose current without re-registering when form state changes.
export function registerDialogLayer({ id, ancestors = [], root = null, onClose, returnFocus,
  ownerDocument = root?.ownerDocument || globalThis.document }) {
  if (!ownerDocument) return () => {}
  const state = documents.get(ownerDocument) || install(ownerDocument)
  const active = ownerDocument.activeElement
  const releaseScroll = root ? lockDialogScroll(ownerDocument) : () => {}
  const entry = { id, ancestors, root, onClose, returnFocus: returnFocus === undefined ? active : returnFocus,
    initialFocus: root?.contains(active) ? active : null, lastFocus: null }
  // Child effects run before their parent's on an initial nested React mount.
  // Portals are DOM siblings. React ancestry preserves child-first effect order
  // within this same keyboard/focus stack.
  const childIndex = root ? state.entries.findIndex((other) =>
    (id && other.ancestors.includes(id)) || (other.root && root.contains(other.root))) : -1
  if (childIndex < 0) state.entries.push(entry)
  else state.entries.splice(childIndex, 0, entry)
  let removed = false
  queueMicrotask(() => {
    if (!removed && root && state.entries.at(-1) === entry) focus(initialTarget(entry))
  })
  return () => {
    if (removed) return
    removed = true
    releaseScroll()
    const wasTop = state.entries.at(-1) === entry
    state.entries.splice(state.entries.indexOf(entry), 1)
    // If an outer layer unmounts first, do not leave descendants with a dead trigger.
    for (const other of state.entries) {
      if (root?.contains(other.returnFocus)) other.returnFocus = entry.returnFocus
    }
    if (!state.entries.length) state.dispose()
    if (!root || !wasTop) return
    // Wait for React cleanup (including the drawer's inert removal) before return.
    queueMicrotask(() => {
      const current = documents.get(ownerDocument)?.entries.at(-1)
      if (available(entry.returnFocus) && (!current?.root || current.root.contains(entry.returnFocus))) {
        focus(entry.returnFocus)
      } else if (current?.root && !current.root.contains(ownerDocument.activeElement)) {
        focus(available(current.lastFocus) ? current.lastFocus : initialTarget(current))
      }
    })
  }
}
