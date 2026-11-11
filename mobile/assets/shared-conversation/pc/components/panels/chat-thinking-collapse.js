/* Fold live reasoning in place; the shared scroll follower owns the viewport. */
(function (global) {
  'use strict';
  const states = new WeakMap();
  function reset(list) {
    const state = list && states.get(list);
    if (!state) return;
    state.cleanups.forEach(finish => finish());
    states.delete(list);
  }
  function keyOf(card) {
    const head = card.querySelector('[data-think]');
    if (head) return 'message:' + head.getAttribute('data-think');
    const task = card.closest('[data-task-stream]');
    return task && card.dataset.dksNode ? 'task:' + task.dataset.taskStream + ':' + card.dataset.dksNode : '';
  }
  function fold(card, before, state) {
    const body = card.querySelector('.nthink-body');
    // A newer completion can arrive before the previous fold has finished.
    // Restore its original styles before capturing the next animation baseline.
    if (body) state.folds.get(body)?.();
    if (!body || typeof body.animate !== 'function' || global.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const saved = { display: body.style.display, overflow: body.style.overflow };
    body.style.display = 'block'; body.style.overflow = 'hidden';
    const animation = body.animate([
      { height: before.height + 'px', paddingTop: before.top, paddingBottom: before.bottom, opacity: 1 },
      { height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0 }
    ], { duration: 220, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'both' });
    const head = card.querySelector('.nthink-head');
    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      animation.cancel();
      body.style.display = saved.display; body.style.overflow = saved.overflow;
      head?.removeEventListener('click', finish);
      state.cleanups.delete(finish);
      state.folds.delete(body);
    }
    state.cleanups.add(finish);
    state.folds.set(body, finish);
    head?.addEventListener('click', finish, { once: true });
    animation.finished.then(finish, finish);
  }
  function capture(list, scroll, scope) {
    if (!list || !scroll) return () => {};
    let state = states.get(list);
    if (state && state.scope !== scope) { reset(list); state = null; }
    if (!state) {
      state = { scope, cleanups: new Set(), folds: new WeakMap() };
      states.set(list, state);
    }
    // Readers inspecting history keep the existing reading-anchor behavior.
    // Only the live tail animates; opening history must never animate.
    if (scroll.__soduworkScrollFollow?.follow === false || scroll.dataset.scrollFollow === 'paused') return () => {};
    const active = [...list.querySelectorAll('.nthink.is-live.open')].at(-1);
    const key = active && keyOf(active), body = active?.querySelector('.nthink-body');
    if (!key || !body || (active.checkVisibility && !active.checkVisibility({ contentVisibilityAuto: true }))) return () => {};
    const height = body.getBoundingClientRect().height;
    if (height <= 0) return () => {};
    const style = global.getComputedStyle(body);
    const before = { height, top: style.paddingTop, bottom: style.paddingBottom };
    return function commit() {
      if (!list.isConnected || states.get(list) !== state) return;
      const next = [...list.querySelectorAll('.nthink')].find(card => keyOf(card) === key);
      if (!next || next.classList.contains('is-live') || next.classList.contains('open')) return;
      // Animate only the body. A floor measured from the whole list retains
      // virtualized estimates and pruned history, leaving an ever-growing
      // blank tail. Natural layout plus the existing RAF follower keeps the
      // latest output anchored without any persistent height reservation.
      fold(next, before, state);
    };
  }
  global.ChatThinkingCollapse = { capture, reset };
})(typeof window !== 'undefined' ? window : globalThis);
