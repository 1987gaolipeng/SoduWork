/*
 * Shared trace lifecycle: manage caching, events, visibility, and mounting.
 * task-trace-view.js owns rendering across requirement, execution, and review surfaces.
 */
(function () {
  'use strict';

  const api = window.TaskExecutionJourney;
  if (!api) return;

  const mounts = new WeakMap();
  const cache = new Map();
  const CACHE_MS = 1800;

  function disclosureState(root) {
    return new Map([...root.querySelectorAll('details[data-tfd-open]')]
      .map((item) => [item.getAttribute('data-tfd-open'), item.open]));
  }

  function restoreDisclosure(root, states) {
    if (!states || !states.size) return;
    root.querySelectorAll('details[data-tfd-open]').forEach((item) => {
      const key = item.getAttribute('data-tfd-open');
      if (states.has(key)) item.open = states.get(key);
    });
  }

  async function fetchTrace(taskId, force) {
    const old = cache.get(taskId);
    if (old && old.promise) {
      if (!force) return old.promise;
      // A task change may replace a mounted view while an older request is pending.
      if (!old.followup) old.followup = old.promise.catch(() => null).then(() => fetchTrace(taskId, true));
      return old.followup;
    }
    if (!force && old && old.value && Date.now() - old.at < CACHE_MS) return old.value;
    const previous = old && old.value;
    const promise = Promise.resolve(SoduWorkAPI.taskTrace(taskId)).then((value) => {
      cache.set(taskId, { value, at: Date.now() });
      return value;
    }).catch((error) => {
      if (previous) cache.set(taskId, { value: previous, at: old.at || 0 });
      else cache.delete(taskId);
      throw error;
    });
    cache.set(taskId, { value: previous, promise, at: (old && old.at) || 0 });
    return promise;
  }

  function normalizeArgs(value, opts) {
    return value && typeof value === 'object'
      ? Object.assign({}, value)
      : Object.assign({}, opts || {}, { taskId: String(value || '') });
  }

  function unmount(container) {
    const old = mounts.get(container);
    if (!old) return;
    clearTimeout(old.timer);
    old.queued = false;
    old.disposed = true;
    if (old.onEvent) window.removeEventListener('soduwork-work-execution', old.onEvent);
    if (old.onTaskEvent) window.removeEventListener('soduwork-work-task-change', old.onTaskEvent);
    if (old.onVisibility) document.removeEventListener('visibilitychange', old.onVisibility);
    mounts.delete(container);
  }

  async function mount(container, taskOrOpts, maybeOpts) {
    if (!container) return null;
    const opts = Object.assign(
      { variant: 'task' }, normalizeArgs(taskOrOpts, maybeOpts));
    const taskId = String(opts.taskId
      || (((opts.trace || {}).task || {}).id)
      || (((opts.trace || {}).card || {}).taskId) || '');
    if (!taskId && !opts.trace) return null;
    opts.taskId = taskId;
    const existing = mounts.get(container);
    if (existing && !existing.disposed && existing.opts.taskId === taskId
        && Object.keys(opts).every(key => key === 'force' || existing.opts[key] === opts[key])) {
      if (opts.force) return existing.refresh(true);
      return existing.inFlight || existing.trace;
    }
    unmount(container);

    const state = {
      opts, trace: opts.trace || null, timer: null, signature: '',
      onEvent: null, onTaskEvent: null, onVisibility: null,
      refresh: null, inFlight: null, queued: false, disposed: false, seq: 0,
    };
    mounts.set(container, state);

    const refreshNow = async (force) => {
      if (!container.isConnected || mounts.get(container) !== state) {
        unmount(container);
        return null;
      }
      const seq = ++state.seq;
      const disclosures = disclosureState(container);
      if (!state.trace && !container.firstElementChild) {
        container.innerHTML = '<div class="tfd-skeleton"><i></i><i></i><i></i>' +
          '<span>正在整理需求全链路…</span></div>';
      }
      let next = state.trace;
      try {
        if (!next || force || !opts.trace) next = await fetchTrace(taskId, !!force);
      } catch (error) {
        if (!container.isConnected || mounts.get(container) !== state
            || seq !== state.seq) return null;
        state.signature = '';
        const fallback = '全链路暂时没有加载成功';
        const reason = typeof _humanErr === 'function'
          ? _humanErr(error, fallback) : fallback;
        container.innerHTML = '<div class="tfd-shell tfd-empty"><b>'
          + api.esc(reason)
          + '</b><span>当前页面会保留，连接恢复后可以直接重试。</span>'
          + '<button class="tfd-retry">重新加载</button></div>';
        container.querySelector('.tfd-retry')
          .addEventListener('click', () => state.refresh(true));
        return null;
      }
      if (!container.isConnected || mounts.get(container) !== state
          || seq !== state.seq) return null;
      if (!next) {
        state.signature = '';
        container.innerHTML = '<div class="tfd-shell tfd-empty">'
          + '<b>全链路暂时没有加载成功</b><span>请检查连接后刷新。</span></div>';
        return null;
      }

      state.trace = next;
      const rendered = api.html(next, opts);
      if (rendered !== state.signature) {
        container.innerHTML = rendered;
        state.signature = rendered;
        restoreDisclosure(container, disclosures);
        api.bind(container, next, opts, state);
      }
      clearTimeout(state.timer);
      const runs = next.runs || [];
      const run = runs.find((item) => api.isLive(item.state)) || runs[0] || null;
      const liveSessions = (((next.execution || {}).sessions) || next.ai || [])
        .some((item) => api.isLive(item.status));
      const liveDeployments = (next.deployments || [])
        .some((item) => api.isLive(item.state));
      const live = (run && api.isLive(run.state)) || liveSessions || liveDeployments;
      const refreshMs = Number(opts.refreshMs == null
        ? (opts.variant === 'approval' ? 0 : 8000) : opts.refreshMs);
      if (live && refreshMs > 0) {
        state.timer = setTimeout(() => state.refresh(true), refreshMs);
      }
      return next;
    };

    state.refresh = async (force) => {
      if (!container.isConnected || mounts.get(container) !== state || state.disposed) {
        unmount(container);
        return null;
      }
      if (document.visibilityState === 'hidden') {
        if (force) state.queued = true;
        return state.trace;
      }
      if (state.inFlight) {
        if (force) state.queued = true;
        return state.inFlight;
      }
      const promise = refreshNow(force);
      state.inFlight = promise;
      try {
        return await promise;
      } finally {
        if (state.inFlight === promise) state.inFlight = null;
        if (state.queued && !state.disposed && container.isConnected
            && mounts.get(container) === state
            && document.visibilityState !== 'hidden') {
          state.queued = false;
          clearTimeout(state.timer);
          state.timer = setTimeout(() => state.refresh(true), 140);
        }
      }
    };

    const queueEvent = (event, all) => {
      const detail = ((event || {}).detail) || {};
      if (!(all && detail.all) && String(detail.taskId || '') !== taskId) return;
      if (opts.trace && opts.variant === 'approval') {
        if (typeof opts.onRefresh === 'function') opts.onRefresh(taskId);
        return;
      }
      if (document.visibilityState === 'hidden' || state.inFlight) {
        state.queued = true;
        return;
      }
      clearTimeout(state.timer);
      state.timer = setTimeout(() => state.refresh(true), 140);
    };
    state.onEvent = (event) => queueEvent(event, false);
    state.onTaskEvent = (event) => queueEvent(event, true);
    state.onVisibility = () => {
      clearTimeout(state.timer);
      if (document.visibilityState === 'visible') {
        state.queued = false;
        state.timer = setTimeout(() => state.refresh(true), 0);
      } else {
        state.queued = true;
      }
    };
    window.addEventListener('soduwork-work-execution', state.onEvent);
    window.addEventListener('soduwork-work-task-change', state.onTaskEvent);
    document.addEventListener('visibilitychange', state.onVisibility);
    return state.refresh(!!opts.force);
  }

  api.mount = mount;
  api.unmount = unmount;
})();
