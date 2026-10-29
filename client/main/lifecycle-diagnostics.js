'use strict';

/* Best-effort, local-only lifecycle journal. No event in this module changes
   Electron or Node exit behavior, and no free-form error text is persisted. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 1024 * 1024;
const JOURNAL_NAME = 'lifecycle.jsonl';
const HEARTBEAT_MS = 60 * 1000;
const EVENTS = new Set([
  'start', 'ready', 'heartbeat', 'before-quit', 'will-quit', 'app-quit',
  'process-exit', 'exit-intent', 'uncaught-exception-monitor',
  'unhandled-rejection', 'child-process-gone', 'render-process-gone',
  'renderer-unresponsive', 'custom',
]);
const REASONS = new Set([
  'tray', 'app-menu', 'second-instance', 'update-install', 'update-force-exit',
  'crashed', 'killed', 'oom', 'launch-failed', 'clean-exit', 'unknown',
]);
const FIELDS = new Set([
  'runId', 'pid', 'ppid', 'version', 'reason', 'exitCode', 'signal',
  'exitIntent', 'completed', 'errorName', 'errorCode', 'stackLocation',
  'reasonType', 'listenerPresent', 'type', 'memoryRss', 'memoryHeapUsed',
  'eventLoopLagMs', 'webContentsId', 'cpuPercent', 'activeResourceCount',
]);

function text(value, max = 64) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}
function enumValue(value, values, fallback = 'unknown') {
  const candidate = text(value);
  return values.has(candidate) ? candidate : fallback;
}
function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? Math.round(result) : undefined;
}
function stackLocation(error) {
  const stack = error && typeof error.stack === 'string' ? error.stack : '';
  const lines = stack.split(/\r?\n/);
  for (let index = 1; index < lines.length; index += 1) {
    const match = lines[index].match(/((?:[A-Za-z]:[\\/]|\/)[^()\r\n]*):([0-9]+):([0-9]+)/);
    if (!match) continue;
    const file = match[1].split(/[\\/]/).pop() || 'unknown';
    return `${text(file.replace(/[^A-Za-z0-9._-]/g, '_'), 100)}:${match[2]}:${match[3]}`;
  }
  return '';
}
function errorData(error) {
  const name = text(error && error.name);
  const code = text(error && error.code);
  return {
    errorName: /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : 'Error',
    errorCode: /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : undefined,
    stackLocation: stackLocation(error) || undefined,
  };
}
function sanitize(data) {
  const output = {};
  if (!data || typeof data !== 'object') return output;
  for (const key of FIELDS) {
    const raw = data[key];
    if (raw === undefined) continue;
    if (['pid', 'ppid', 'exitCode', 'memoryRss', 'memoryHeapUsed', 'eventLoopLagMs', 'webContentsId', 'cpuPercent', 'activeResourceCount'].includes(key)) {
      const value = number(raw); if (value !== undefined) output[key] = value;
    } else if (['exitIntent', 'completed', 'listenerPresent'].includes(key)) {
      if (typeof raw === 'boolean') output[key] = raw;
    } else if (key === 'reason') {
      output[key] = enumValue(raw, REASONS);
    } else if (key === 'type') {
      output[key] = enumValue(raw, new Set(['utility', 'renderer', 'gpu', 'other', 'unknown']));
    } else if (key === 'errorName') {
      const value = text(raw); if (/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)) output[key] = value;
    } else if (key === 'errorCode') {
      const value = text(raw); if (/^[A-Za-z0-9_.-]{1,64}$/.test(value)) output[key] = value;
    } else if (key === 'stackLocation') {
      const value = text(raw); if (/^[A-Za-z0-9._-]+:[0-9]+:[0-9]+$/.test(value)) output[key] = value;
    } else if (key === 'reasonType') {
      const value = text(raw); if (/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(value)) output[key] = value;
    } else if (key === 'signal') {
      const value = text(raw, 32); if (/^[A-Za-z0-9_.-]+$/.test(value)) output[key] = value;
    } else if (key === 'version' || key === 'runId') {
      const value = text(raw, 80); if (value) output[key] = value;
    }
  }
  return output;
}

function install({ app, processRef = process, root } = {}) {
  if (!app) throw new TypeError('lifecycle diagnostics requires app');
  let directory = root || null;
  if (!directory) {
    try { directory = path.join(app.getPath('userData'), 'diagnostics'); } catch (_) { directory = null; }
  }
  const journal = directory ? path.join(directory, JOURNAL_NAME) : null;
  const runId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID() : `${Date.now()}-${processRef.pid || 0}`;
  let exitReason = '';
  let disposed = false;
  let heartbeatTimer = null;
  let lastTick = Date.now();
  let lastCpu = null;
  let lastCpuAt = performance.now();
  try { lastCpu = processRef.cpuUsage?.() || null; } catch (_) {}

  function rotateIfNeeded(nextBytes) {
    if (!journal) return false;
    try {
      const size = fs.existsSync(journal) ? fs.statSync(journal).size : 0;
      if (size + nextBytes <= MAX_BYTES) return true;
      const backup = `${journal}.1`;
      fs.rmSync(backup, { force: true });
      fs.renameSync(journal, backup);
      return true;
    } catch (_) { return false; }
  }
  function record(event, data = {}) {
    if (disposed || !journal) return false;
    try {
      const normalizedEvent = EVENTS.has(event) ? event : 'custom';
      const safe = sanitize(data);
      delete safe.runId;
      delete safe.pid;
      const pid = number(processRef.pid);
      const payload = {
        ts: new Date().toISOString(),
        event: normalizedEvent,
        runId,
        ...safe,
      };
      if (pid !== undefined) payload.pid = pid;
      const line = `${JSON.stringify(payload)}\n`;
      fs.mkdirSync(directory, { recursive: true });
      if (!rotateIfNeeded(Buffer.byteLength(line, 'utf8'))) return false;
      fs.appendFileSync(journal, line, { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch (_) { return false; }
  }
  function recordError(event, error) {
    try { return record(event, errorData(error)); } catch (_) { return false; }
  }
  record('start', {
    ppid: processRef.ppid,
    version: (() => { try { return app.getVersion(); } catch (_) { return undefined; } })(),
  });

  const listeners = [];
  const listen = (target, event, handler) => {
    if (!target || typeof target.on !== 'function') return;
    try { target.on(event, handler); listeners.push([target, event, handler]); } catch (_) {}
  };
  listen(app, 'before-quit', () => record('before-quit', { reason: exitReason || 'unknown', exitIntent: true, completed: false }));
  listen(app, 'will-quit', () => record('will-quit', { reason: exitReason || 'unknown', exitIntent: true, completed: false }));
  listen(app, 'quit', (_event, code) => record('app-quit', { reason: exitReason || 'unknown', exitIntent: true, exitCode: code, completed: true }));
  listen(processRef, 'exit', (code) => record('process-exit', { reason: exitReason || 'unknown', exitCode: code, completed: true }));
  listen(processRef, 'uncaughtExceptionMonitor', (error) => recordError('uncaught-exception-monitor', error));
  listen(app, 'child-process-gone', (_event, details = {}) => record('child-process-gone', {
    type: details.type, reason: details.reason, exitCode: details.exitCode,
  }));
  listen(app, 'web-contents-created', (_event, contents) => {
    if (!contents || typeof contents.on !== 'function') return;
    const id = number(contents.id);
    const gone = (_goneEvent, details = {}) => record('render-process-gone', {
      webContentsId: id, reason: details.reason, exitCode: details.exitCode,
    });
    const slow = () => record('renderer-unresponsive', { webContentsId: id });
    const cleanup = () => {
      try { contents.removeListener('render-process-gone', gone); contents.removeListener('unresponsive', slow); } catch (_) {}
    };
    try {
      contents.on('render-process-gone', gone);
      contents.on('unresponsive', slow);
      if (typeof contents.once === 'function') contents.once('destroyed', cleanup);
    } catch (_) {}
  });

  const tick = () => {
    const now = Date.now();
    const resource = {};
    // A native event-loop spin can consume a core while JS heap and event-loop
    // latency look healthy. Sample counters once per heartbeat; no shell probes,
    // stack dumps, resource names, URLs or conversation data enter the journal.
    try {
      const cpu = processRef.cpuUsage?.();
      const at = performance.now(), elapsed = at - lastCpuAt;
      if (cpu && lastCpu && elapsed > 0) {
        const used = cpu.user + cpu.system - lastCpu.user - lastCpu.system;
        if (used >= 0) resource.cpuPercent = used / elapsed / 10;
      }
      lastCpu = cpu || null; lastCpuAt = at;
    } catch (_) {}
    try { resource.activeResourceCount = processRef.getActiveResourcesInfo?.().length; } catch (_) {}
    record('heartbeat', {
      ...(() => { try { const value = processRef.memoryUsage(); return { memoryRss: value.rss, memoryHeapUsed: value.heapUsed }; } catch (_) { return {}; } })(),
      ...resource,
      eventLoopLagMs: Math.max(0, now - lastTick - HEARTBEAT_MS),
    });
    lastTick = now;
    heartbeatTimer = setTimeout(tick, HEARTBEAT_MS);
    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  };
  heartbeatTimer = setTimeout(tick, HEARTBEAT_MS);
  if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  if (typeof app.whenReady === 'function') {
    try { Promise.resolve(app.whenReady()).then(() => record('ready')).catch(() => {}); } catch (_) {}
  }
  function setExitReason(reason) {
    exitReason = enumValue(reason, REASONS);
    return record('exit-intent', { reason: exitReason, exitIntent: true, completed: false });
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    for (const [target, event, handler] of listeners) {
      try { if (typeof target.removeListener === 'function') target.removeListener(event, handler); } catch (_) {}
    }
  }
  return { record, recordError, setExitReason, dispose, journalPath: journal, runId };
}

module.exports = { install, MAX_BYTES, JOURNAL_NAME, _private: { sanitize, stackLocation, errorData } };



