'use strict';

const path = require('node:path');
const { createProcessHost } = require('./process-host');
const archiveState = require('../pi-session/archive-state');
const helpers = require('../pi-session/session-helpers');
const historyState = require('../pi-session/history-state');

function scope(identity) {
  if (!identity) return '';
  try { return require('../platform-connections/runtime.cjs').scope(identity) + '|' + identity.hub + '|' + identity.clientId; }
  catch (_) { return String(identity.hub || '') + '|' + String(identity.clientId || ''); }
}
function createProcessSession(options = {}) {
  const recoveryMaxAttempts = Math.max(1, Math.min(6, Number(options.recoveryMaxAttempts) || 3));
  const recoveryInitialDelayMs = Math.max(0, Math.min(5000,
    Number.isFinite(Number(options.recoveryRetryDelayMs)) ? Number(options.recoveryRetryDelayMs) : 100));
  const hosts = new Map();
  const retired = new Set();
  const retiredProfiles = new WeakMap();
  let lifecyclePowerMonitor = options.powerMonitor || null;
  let disposed = false;
  const recoveryPending = (cause, attempt = 0) => Object.assign(
    Error('上次执行的资源仍在回收，请确认回收完成后重试；本次操作未启动'),
    { code: 'RUNTIME_RECOVERY_PENDING', recoveryAttempt: attempt,
      ...(cause ? { cause } : {}) });
  function retire(row, key) {
    retired.add(row.host); retiredProfiles.set(row.host, key);
    void row.host.stop().catch(() => {});
  }
  async function waitForRetired(key) {
    const previous = [...retired].filter(value => retiredProfiles.get(value) === key);
    if (!previous.length) return;
    let timer;
    try {
      const result = await Promise.race([
        Promise.allSettled(previous.map(value => typeof value.retryCleanup === 'function' ? value.retryCleanup() : value.stop())),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(recoveryPending()), options.recoveryTimeoutMs || 5000); }),
      ]);
      const failure = result.find(row => row.status === 'rejected');
      const confirmed = value => {
        try {
          if (!value.isDead() || typeof value.maintenanceWorkloads !== 'function') return false;
          const work = value.maintenanceWorkloads(); return Array.isArray(work) && work.length === 0;
        } catch (_) { return false; }
      };
      // stop() can retain its original timeout rejection after the real tree
      // guard eventually confirms cleanup. The current maintenance evidence
      // is authoritative; an absent or failed provider remains closed.
      if (previous.some(value => !confirmed(value)))
        throw recoveryPending(failure?.reason);
      for (const value of previous) retired.delete(value);
    } finally { clearTimeout(timer); }
  }
  async function host(app, identity) {
    if (disposed) throw Error('Agent Runtime is closed');
    if (!app?.getPath) throw TypeError('Agent Runtime requires a trusted application context');
    const key = path.resolve(app.getPath('userData')), nextScope = scope(identity);
    for (;;) {
      let row = hosts.get(key);
      if (row && (row.host.isDead() || (nextScope && row.scope && nextScope !== row.scope))) {
        retire(row, key); hosts.delete(key);
      }
      await waitForRetired(key);
      if (disposed) throw Error('Agent Runtime is closed');
      if ([...retired].some(value => retiredProfiles.get(value) === key)) continue;
      // A concurrent request may have opened or retired a host while cleanup
      // was pending. Recheck before assigning this profile a new generation.
      row = hosts.get(key);
      if (row && (row.host.isDead() || (nextScope && row.scope && nextScope !== row.scope))) continue;
      if (!row) {
        // Host injection is constructor-only trusted test infrastructure;
        // renderer/open arguments never select a host factory or transport.
        row = { host: (options.hostFactory || createProcessHost)(app,
          lifecyclePowerMonitor ? { ...options, powerMonitor: lifecyclePowerMonitor } : options), app, scope: nextScope };
        hosts.set(key, row);
      } else if (nextScope) row.scope = nextScope;
      return row.host;
    }
  }
  const api = {
    async open(opts) {
      // Retry the retirement fence with bounded backoff. No new resource is
      // created before cleanup is confirmed.
      for (let attempt = 0; attempt < recoveryMaxAttempts; attempt++) {
        try {
          return await (await host(opts.app, opts.identity)).call('open', [opts], { timeoutMs: 45000 });
        } catch (error) {
          if (error?.code !== 'RUNTIME_RECOVERY_PENDING') throw error;
          if (attempt + 1 >= recoveryMaxAttempts) throw recoveryPending(error, attempt + 1);
          const delay = Math.min(5000, recoveryInitialDelayMs * (2 ** attempt));
          if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      throw recoveryPending(null, recoveryMaxAttempts);
    },
    get(ref) { for (const value of [...hosts.values()].map(row => row.host).concat([...retired])) {
      const found = value.handles.get(ref); if (found) return found.handle;
    } return null; },
    list() { return [...hosts.values()].map(row => row.host).concat([...retired])
      .flatMap(value => [...value.handles.values()].map(row => row.handle)); },
    findBySessionId(id) { return api.list().find(value => value.sessionId === id) || null; },
    closeAll() { for (const value of api.list()) value.close().catch(() => {}); },
    async reset(app) {
      const key = path.resolve(app.getPath('userData')), row = hosts.get(key);
      hosts.delete(key); if (row) { retire(row, key); await row.host.stop(); }
    },
    archiveRoot: app => path.resolve(app.getPath('userData'), 'pi-agent'),
    isArchived: (app, id) => archiveState.isArchived(api.archiveRoot(app), id),
    setArchived: (app, id, value) => archiveState.setArchived(api.archiveRoot(app), id, value),
    archiveState,
    diagnostics(app) { return hosts.get(path.resolve(app.getPath('userData')))?.host.diagnostics() || null; },
    maintenanceWorkloads() {
      const all = new Set([...hosts.values()].map(row => row.host).concat([...retired]));
      const items = [];
      for (const value of all) {
        const work = value.maintenanceWorkloads(); items.push(...work);
        if (!work.length && value.isDead()) retired.delete(value);
      }
      return items;
    },
    setLocale(value) { for (const row of hosts.values()) row.host.notify('locale', [value]); },
    invalidateModels() { for (const row of hosts.values()) row.host.notify('invalidateModels', []); },
    async dispose() {
      disposed = true;
      const all = new Set([...hosts.values()].map(row => row.host).concat([...retired]));
      const results = await Promise.allSettled([...all].map(value => value.stop()));
      hosts.clear(); retired.clear();
      const failed = results.filter(row => row.status === 'rejected').map(row => row.reason);
      if (failed.length) throw new AggregateError(failed, 'Agent Runtime shutdown failed');
    },
    async reserveArchive(app, cwd, title, owner) { return (await host(app)).call('storage', ['plan', [cwd, title, owner]]); },
    async commitArchive(app, plan) { return (await host(app)).call('storage', ['commit', [plan]]); },
    async abandonArchive(app, plan) { return (await host(app)).call('storage', ['abandon', [plan]]); },
    async prepareSkills(app, request) { return (await host(app)).call('prepareSkills', [request], { timeoutMs: 30000 }); },
    installLifecycle(app, powerMonitor) {
      if (powerMonitor) lifecyclePowerMonitor = powerMonitor;
      let finished = false, quitting = null;
      app.on('before-quit', event => {
        if (finished) return;
        event.preventDefault();
        if (!quitting) quitting = api.dispose().catch(error => console.error('[runtime] shutdown:', error.message))
          .finally(() => { finished = true; app.quit(); });
      });
    },
    _explain: helpers.explain, _title: helpers.title,
    _presenceState: historyState.presenceState, _mergeHistory: historyState.mergeHistory,
    _seed: require('../pi-session/history-seed').seed,
  };
  for (const method of ['history', 'archivedHistory', 'historyEntry', 'archiveHistory', 'restoreHistory',
    'permanentlyDeleteHistory', 'loadSdk', 'prewarm', 'prewarmResources', 'probe']) {
    api[method] = async (app, ...args) => (await host(app, method === 'prewarm' ? args[0] : undefined))
      .call('module', [method, [app, ...args]], { timeoutMs: ['prewarm', 'prewarmResources'].includes(method) ? 60000 : 30000 });
  }
  return api;
}
const session = createProcessSession();
module.exports = Object.assign(session, { createProcessSession });
