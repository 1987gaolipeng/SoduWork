'use strict';

// Legacy stdio MCP extensions sometimes ignore Pi's AbortSignal entirely.
// Own cancellation at the transport boundary, without detaching an unfinished
// tool promise or claiming its side effects were rolled back.
const { AsyncLocalStorage } = require('node:async_hooks');
const { StringDecoder } = require('node:string_decoder');
const cp = require('node:child_process');
const path = require('node:path');
const scope = new AsyncLocalStorage();
const observed = new WeakSet();
const backgroundServices = new Map();
const CANCEL_GRACE_MS = 750;
const MAX_FRAME = 16 * 1024 * 1024;

function frames(consume) {
  const decoder = new StringDecoder('utf8');
  let buffer = '', skipping = false;
  return chunk => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!skipping && line.length <= MAX_FRAME) {
        try { consume(JSON.parse(line)); } catch (_) { /* Not a JSON-RPC frame. */ }
      }
      skipping = false;
    }
    if (buffer.length > MAX_FRAME) { buffer = ''; skipping = true; }
  };
}

function terminateTree(child) {
  if (!Number.isInteger(child.pid) || child.pid <= 0 || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      cp.execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }, error => {
          if (error && child.exitCode === null && child.signalCode === null) reject(error);
          else resolve();
        });
      return;
    }
    // These children were started by SoduWork but need not lead a process group.
    // Take a parent/child snapshot; never signal the host's own process group.
    cp.execFile('ps', ['-eo', 'pid=,ppid='], { timeout: 3000 }, (error, stdout) => {
      if (error) { reject(error); return; }
      const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      const pids = [child.pid];
      for (let i = 0; i < pids.length; i++) {
        for (const [pid, parent] of rows) if (parent === pids[i] && pid > 1 && pid !== process.pid && !pids.includes(pid)) pids.push(pid);
      }
      try {
        for (const pid of pids.reverse()) {
          try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        resolve();
      } catch (error) { reject(error); }
    });
  });
}

function observe(child) {
  if (!child?.stdin?.write || !child.stdout?.on || observed.has(child)) return child;
  observed.add(child);
  const pending = new Map();
  let killing = null, closed = false, timer = null, resolveClose, hasBackgroundWork = false;
  let contextBackgroundOnly = true;
  let identified = false;
  const close = new Promise(resolve => { resolveClose = resolve; });
  const originalWrite = child.stdin.write;
  const originalEmit = child.stdout.emit;
  function clear(row) { row.owner?.signal?.removeEventListener('abort', row.abort); }
  function considerKill() {
    if (closed || killing || !pending.size || ![...pending.values()].every(row => row.owner?.signal?.aborted)) return;
    clearTimeout(timer);
    const rows = [...pending.values()];
    // Only the known context-mode execution tools create one sandbox child
    // per foreground invocation. Generic MCP services may schedule background
    // jobs later; their child creation time does not establish ownership.
    if (hasBackgroundWork && (!contextBackgroundOnly || rows.some(row => !row.contextExecution))) return;
    const earliest = rows.reduce((a, b) => a.startedAt <= b.startedAt ? a : b);
    const baseline = earliest.owner?.before?.get(child);
    // A concurrent background request may have completed since the snapshot.
    // Its workers are not owned by the cancelled foreground invocation.
    if (hasBackgroundWork && (!baseline || baseline.revision !== backgroundServices.get(child))) return;
    // Attach this barrier BEFORE taskkill can make the bridge reject on exit.
    // Native tool/queue settlement must also wait for descendants and pipes.
    killing = hasBackgroundWork
      ? Promise.resolve().then(() => require('./mcp-process-tree').stopAfter(child,
        Math.min(...rows.map(row => row.startedAt)), terminateTree,
        baseline?.rows))
      : Promise.resolve().then(() => terminateTree(child)).then(() => close);
    if (hasBackgroundWork) killing.finally(() => { killing = null; }).catch(() => {});
    killing.catch(() => {});
    for (const row of rows) row.owner.barriers.add(killing);
  }
  function aborted(row) {
    if (closed || pending.get(row.id) !== row) return;
    try {
      originalWrite.call(child.stdin, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled',
        params: { requestId: row.id, reason: 'The user or SoduWork execution limit cancelled this tool.' } }) + '\n', () => {});
    } catch (_) { /* Exit/error is handled by the original bridge. */ }
    clearTimeout(timer);
    timer = setTimeout(considerKill, CANCEL_GRACE_MS);
    timer.unref?.();
  }
  const outgoing = frames(frame => {
    if (frame?.jsonrpc !== '2.0' || !['string', 'number'].includes(typeof frame.id) || typeof frame.method !== 'string') return;
    identified = true;
    const owner = frame.method === 'tools/call' ? scope.getStore() : undefined;
    const previous = pending.get(frame.id); if (previous) clear(previous);
    const row = { id: frame.id, owner, abort: null, startedAt: Date.now(),
      contextExecution: frame.method === 'tools/call' && /^ctx_execute(?:_file)?$/.test(frame.params?.name || ''),
      background: frame.method === 'tools/call' &&
        (frame.params?.arguments?.background === true || frame.params?.arguments?.background === 'true') };
    row.abort = () => aborted(row); pending.set(row.id, row);
    owner?.signal?.addEventListener('abort', row.abort, { once: true });
    if (owner?.signal?.aborted) queueMicrotask(row.abort);
  });
  const incoming = frames(frame => {
    if (frame?.jsonrpc !== '2.0' || frame.method || !('result' in frame || 'error' in frame)) return;
    const row = pending.get(frame.id);
    if (row?.background && !frame.error && !frame.result?.isError) {
      hasBackgroundWork = true;
      backgroundServices.set(child, (backgroundServices.get(child) || 0) + 1);
      contextBackgroundOnly = contextBackgroundOnly && row.contextExecution;
    }
    if (row) { clear(row); pending.delete(frame.id); }
    // Another request can finish while this cancelled one is still waiting.
    if ([...pending.values()].some(row => row.owner?.signal?.aborted)) {
      clearTimeout(timer); timer = setTimeout(considerKill, CANCEL_GRACE_MS); timer.unref?.();
    } else { clearTimeout(timer); timer = null; }
  });
  const write = child.stdin.write = function (chunk, ...args) {
    if (killing) throw Error('MCP service is stopping; no new request was sent');
    if (scope.getStore()?.signal?.aborted) {
      // Do not let a late async continuation submit business work after stop.
      let frame;
      try { frame = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)); } catch (_) {}
      if ((identified || frame?.jsonrpc === '2.0' && frame.method === 'tools/call') &&
          frame?.method !== 'notifications/cancelled') {
        throw Object.assign(Error('Tool call was cancelled before dispatch'), { name: 'AbortError' });
      }
    }
    outgoing(chunk);
    return originalWrite.call(this, chunk, ...args);
  };
  // Adding a data listener here would put a previously paused stdout into
  // flowing mode and consume output before its real tool attaches a reader.
  const emit = child.stdout.emit = function (event, ...args) {
    if (event === 'data') incoming(args[0]);
    return originalEmit.call(this, event, ...args);
  };
  child.once('close', () => {
    backgroundServices.delete(child);
    closed = true; clearTimeout(timer);
    for (const row of pending.values()) clear(row);
    pending.clear();
    if (child.stdout.emit === emit) child.stdout.emit = originalEmit;
    if (child.stdin.write === write) child.stdin.write = originalWrite;
    resolveClose();
  });
  return child;
}

async function run(signal, operation) {
  if (signal?.aborted) throw Object.assign(Error('Tool call was cancelled before execution'), { name: 'AbortError' });
  const before = new Map();
  if (backgroundServices.size) {
    const { snapshot } = require('./mcp-process-tree');
    // Capture ownership before the tool can send a new request. Never infer
    // that a pre-existing daemon belongs to a later foreground invocation.
    const revisions = new Map(backgroundServices);
    const rows = await snapshot().catch(() => null);
    for (const [child, revision] of revisions) before.set(child, { rows, revision });
  }
  if (signal?.aborted) throw Object.assign(Error('Tool call was cancelled before execution'), { name: 'AbortError' });
  const owner = { signal, barriers: new Set(), before };
  return scope.run(owner, async () => {
    try { return await operation(); }
    finally { await Promise.all(owner.barriers); }
  });
}

module.exports = { observe, run, CANCEL_GRACE_MS };
