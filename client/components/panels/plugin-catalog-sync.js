/* Quiet lifecycle sync for the employee plugin catalog. */
(function (global) {
  'use strict';

  function create(options) {
    const opts = options || {};
    const interval = Math.max(1000, Number(opts.interval || 15000));
    let timer = null;
    let running = null;
    let active = false;
    let revision = '';
    let policyPending = false;

    function clear() {
      if (timer !== null) global.clearTimeout(timer);
      timer = null;
    }

    function available() {
      return active && (!opts.isActive || opts.isActive());
    }

    function schedule() {
      clear();
      const shouldPoll = opts.pollWhenIdle || !opts.hasPending || opts.hasPending();
      if (!available() || !shouldPoll) return;
      timer = global.setTimeout(function () {
        timer = null;
        refresh({ quiet: true });
      }, interval);
    }

    async function refresh(meta) {
      const detail = meta || {};
      if (running) { policyPending = policyPending || Boolean(detail.policy); return running; }
      if (!available()) return null;
      if (opts.canRefresh && !opts.canRefresh()) {
        schedule();
        return null;
      }
      if (opts.onState) opts.onState(true, detail);
      const job = Promise.resolve().then(function () { return opts.load(); })
        .then(function (value) {
          const next = opts.revision ? String(opts.revision(value) || '') : '';
          const changed = !revision || next !== revision;
          revision = next;
          if (changed && opts.onUpdate) opts.onUpdate(value, detail);
          if (detail.manual && opts.onManualResult) opts.onManualResult(value, changed);
          return value;
        })
        .catch(function (error) {
          if (!detail.quiet && opts.onError) opts.onError(error);
          return null;
        })
        .finally(function () {
          running = null;
          if (opts.onState) opts.onState(false, detail);
          if (policyPending) {
            policyPending = false;
            refresh({ quiet: true, policy: true });
          } else schedule();
        });
      running = job;
      return job;
    }

    function start(seed) {
      active = true;
      if (seed !== undefined && opts.revision) revision = String(opts.revision(seed) || '');
      schedule();
    }

    function stop() {
      active = false;
      clear();
    }

    return { start, stop, refresh, isRunning: function () { return Boolean(running); } };
  }

  global.SoduWorkPluginCatalogSync = { create };
})(window);
