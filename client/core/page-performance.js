/* Local, bounded timing evidence. Never collect content, URLs or identities. */
(function (global) {
  'use strict';
  const LIMIT = 200, WINDOW_MS = 10 * 60 * 1000;
  const views = new Set(['settings', 'shortcuts', 'skin', 'history', 'aidesk', 'create', 'apps', 'skills',
    'library', 'models', 'agents', 'codeacct', 'cloud', 'usage', 'notices', 'briefs', 'team', 'inbox', 'memory', 'schedules', 'archive']);
  const paths = new Set(['/team/capability', '/plugins/catalog', '/capabilities', '/skills', '/skills/refresh',
    '/mcp-servers', '/my-models', '/my-git', '/library', '/library/storage/status', '/agent-setup']);
  const clock = () => global.performance?.now?.() ?? Date.now();
  const ms = value => Math.round(Math.max(0, Math.min(3600000, Number(value) || 0)) * 10) / 10;
  let events = [], epoch = 0, serial = 0, clearedAt = 0, input = null, frames = [], scheduled = false;
  function trim() { const cutoff = Date.now() - WINDOW_MS; events = events.filter(row => row.at >= cutoff).slice(-LIMIT); }
  function record(row, generation = epoch) { if (generation !== epoch) return; events.push(row); trim(); }
  function frame() {
    if (scheduled || typeof global.requestAnimationFrame !== 'function') return;
    scheduled = true;
    global.requestAnimationFrame(() => global.requestAnimationFrame(() => {
      scheduled = false;
      const pending = frames; frames = [];
      for (const { row, start, generation } of pending) {
        if (generation !== epoch) continue;
        row.firstFrameMs = ms(clock() - start);
        row.background = global.document?.visibilityState === 'hidden';
      }
    }));
  }
  function navigate(name, open) {
    if (!views.has(name)) return open();
    const start = clock(), generation = epoch;
    const row = { kind: 'navigation', name, at: Date.now(), handlerMs: 0, firstFrameMs: null, ok: false };
    if (input?.name === name && start >= input.at && start - input.at < 60000) row.inputDelayMs = ms(start - input.at);
    input = null;
    try { const result = open(); row.ok = true; return result; }
    finally {
      try {
        row.handlerMs = ms(clock() - start); record(row, generation);
        frames.push({ row, start, generation }); frames = frames.slice(-LIMIT); frame();
      } catch (_) { scheduled = false; /* Diagnostics cannot interrupt navigation. */ }
    }
  }
  function beginRequest(path, method) {
    const name = String(path || '').split(/[?#]/, 1)[0];
    if (!paths.has(name)) return null;
    const generation = epoch, start = clock();
    const requestId = global.crypto?.randomUUID?.() || 'page-' + Date.now().toString(36) + '-' + (++serial) + '-' + Math.random().toString(36).slice(2, 10);
    const row = { kind: 'request', name, at: Date.now(), requestId, attempts: 0, status: 0,
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? method : 'GET', correlated: false };
    let finished = false;
    return {
      requestId,
      response(response) {
        row.attempts++;
        const status = Number(response?.status);
        row.status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
        // Only retain our generated ID, never arbitrary server-supplied text.
        row.correlated = response?.headers?.get?.('x-request-id') === requestId;
        const timing = String(response?.headers?.get?.('server-timing') || '').slice(0, 2048);
        row.server = {};
        for (const field of ['app', 'db-acquire', 'db-sql', 'db-hold']) {
          const match = timing.match(new RegExp('(?:^|,)\\s*' + field + ';\\s*dur=([0-9]+(?:\\.[0-9]+)?)'));
          if (match && Number.isFinite(Number(match[1]))) row.server[field] = ms(match[1]);
        }
      },
      finish(ok) {
        if (finished) return; finished = true;
        row.durationMs = ms(clock() - start); row.ok = Boolean(ok); record(row, generation);
      },
    };
  }
  function clear() {
    epoch++; events = []; frames = []; input = null; clearedAt = clock();
    try { global.soduWorkAPI?.pagePerformance?.clear?.(); } catch (_) {}
  }
  async function snapshot() {
    const generation = epoch;
    trim();
    let ipc = { available: false, events: [] };
    try {
      const value = await global.soduWorkAPI?.pagePerformance?.snapshot?.();
      if (value) ipc = value;
    } catch (_) {}
    if (generation !== epoch) ipc = { available: Boolean(ipc.available), events: [] };
    return { version: 1, capturedAt: Date.now(), maxEntries: LIMIT, windowMs: WINDOW_MS,
      events: generation === epoch ? events.map(row => ({ ...row, ...(row.server ? { server: { ...row.server } } : {}) })) : [], ipc };
  }
  global.document?.addEventListener?.('click', event => {
    const target = event.target?.closest?.('[data-view],[data-rail-view],#wsRailMine');
    const name = target?.dataset?.view || target?.dataset?.railView || (target?.id === 'wsRailMine' ? 'settings' : '');
    if (views.has(name) && Number.isFinite(event.timeStamp)) input = { name, at: event.timeStamp };
  }, true);
  try {
    if (global.PerformanceObserver) {
      new global.PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (entry.startTime < clearedAt || !Number.isFinite(entry.duration) || entry.duration < 50) continue;
          record({ kind: 'longtask', name: 'renderer', at: Date.now() - Math.max(0, clock() - entry.startTime), durationMs: ms(entry.duration) });
        }
      }).observe({ type: 'longtask', buffered: true });
    }
  } catch (_) { /* Unsupported observers cannot affect navigation. */ }
  global.addEventListener?.('soduwork-data-scope-changed', clear);
  global.SoduWorkPagePerformance = Object.freeze({ navigate, beginRequest, snapshot, clear });
})(typeof window === 'undefined' ? globalThis : window);
