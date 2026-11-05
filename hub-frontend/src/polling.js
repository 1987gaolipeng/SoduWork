/* Completion-based polling. Visibility changes invalidate late results without
 * starting a second request while the first is still in flight. */
export function createRefreshLoop(task, { interval, maxDelay = 60000, document: doc = globalThis.document, timers = globalThis } = {}) {
  let stopped = false, pending = false, queued = false, timer = null, generation = 0, failures = 0
  const visible = () => !doc?.hidden
  const clear = () => { if (timer !== null) timers.clearTimeout(timer); timer = null }
  const schedule = () => {
    if (!stopped && visible() && interval > 0) {
      timer = timers.setTimeout(refresh, Math.min(maxDelay, interval * 2 ** failures))
    }
  }
  async function refresh() {
    clear()
    if (stopped || !visible()) return
    if (pending) { queued = true; return }
    pending = true
    const current = generation
    const isCurrent = () => !stopped && visible() && current === generation
    try {
      const ok = await task(isCurrent)
      if (isCurrent()) failures = ok === false ? Math.min(failures + 1, 6) : 0
    } catch {
      if (isCurrent()) failures = Math.min(failures + 1, 6)
    } finally {
      pending = false
      if (!stopped && visible()) {
        if (queued) { queued = false; void refresh() }
        else schedule()
      }
    }
  }
  const onVisibility = () => {
    generation++
    clear()
    queued = false
    if (visible()) void refresh()
  }
  doc?.addEventListener('visibilitychange', onVisibility)
  void refresh()
  return {
    refresh,
    stop() { stopped = true; generation++; queued = false; clear(); doc?.removeEventListener('visibilitychange', onVisibility) },
  }
}
