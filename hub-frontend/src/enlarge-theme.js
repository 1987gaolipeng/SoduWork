/*
 * Display-scale preference (issue #27) — persistence and application for the
 * font-size steps. Kept separate from the color theme: light/dark live in
 * `data-theme` (ui.jsx ThemeToggle), the scale level lives in `data-scale`
 * and is consumed by src/enlarge-theme.css.
 *
 * The preference is a step count rather than a boolean so the A+/A- controls
 * can step the text through several levels in either direction: the stored
 * value ranges from MIN_STEP to MAX_STEP, with 0 as the standard size.
 */

const KEY = 'soduwork-hub-scale'
const LEGACY_VALUE = 'enlarge'
const listeners = new Set()

/* Step bounds keep the layout readable: two steps out in each direction. */
export const MIN_STEP = -2
export const MAX_STEP = 2
export const DEFAULT_STEP = 0

function clampStep(step) {
  const value = Number(step)
  if (!Number.isFinite(value)) return DEFAULT_STEP
  return Math.min(MAX_STEP, Math.max(MIN_STEP, Math.round(value)))
}

export function readScaleStep() {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored == null) return DEFAULT_STEP
    /* Migrate the earlier boolean preference onto the first enlarged step. */
    if (stored === LEGACY_VALUE) return 1
    const parsed = Number(stored)
    return Number.isFinite(parsed) ? clampStep(parsed) : DEFAULT_STEP
  } catch (_e) { return DEFAULT_STEP }
}

function applyScaleStep(step) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  /* Test hosts and partial DOM shims may expose a documentElement without the
     attribute API; the preference still persists in that case. */
  if (!root || typeof root.setAttribute !== 'function') return
  if (step === DEFAULT_STEP) {
    if (typeof root.removeAttribute === 'function') root.removeAttribute('data-scale')
  } else root.setAttribute('data-scale', String(step))
}

export function setScaleStep(step) {
  const next = clampStep(step)
  try {
    if (next === DEFAULT_STEP) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, String(next))
  } catch (_e) { /* Private mode: keep the choice for this page view only. */ }
  applyScaleStep(next)
  listeners.forEach(notify => notify(next))
  return next
}

/* Step the current level by one position and return the new level. */
export function stepScale(delta) {
  return setScaleStep(readScaleStep() + (Number(delta) || 0))
}

export function subscribeScale(notify) {
  listeners.add(notify)
  return () => listeners.delete(notify)
}

/* Call once at startup so the saved preference applies before first paint. */
export function initScale() {
  applyScaleStep(readScaleStep())
  window.addEventListener('storage', event => {
    if (event.key === KEY) applyScaleStep(readScaleStep())
  })
}
