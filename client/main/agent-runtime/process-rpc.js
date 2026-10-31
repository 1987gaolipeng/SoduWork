'use strict';

const { randomBytes } = require('node:crypto');
const RPC_NAMESPACE = 'soduwork.agent-runtime.rpc/v1';
const DEFAULT_LIMITS = Object.freeze({ depth: 48, nodes: 20000, bytes: 16 * 1024 * 1024,
  pending: 256, incoming: 256, refs: 4096 });
const TYPES = Object.freeze({ Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
  Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView });

class RpcError extends Error {
  constructor(code, message) { super(message); this.name = 'RpcError'; this.code = code; }
}
const fail = (code, message) => new RpcError(code, message);
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9:-]{1,100}$/.test(value);
const validMethod = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A nested completion may settle before its owner attaches an observer.
  promise.catch(() => {});
  return { promise, resolve, reject };
}
function errorData(error) {
  const data = { name: String(error?.name || 'Error').slice(0, 100),
    code: String(error?.code || 'RPC_REMOTE_ERROR').slice(0, 100),
    message: String(error?.message || error || 'Remote operation failed').slice(0, 4000) };
  for (const key of ['status', 'statusCode', 'authRequired', 'permissionRequired', 'retryable', 'retrySafe', 'failureKind']) {
    if (['boolean', 'number'].includes(typeof error?.[key])) data[key] = error[key];
    else if (typeof error?.[key] === 'string') data[key] = error[key].slice(0, 100);
  }
  return data;
}
function remoteError(data) {
  const normalized = errorData(data);
  const error = fail(normalized.code, normalized.message);
  Object.assign(error, normalized);
  Object.defineProperty(error, 'remote', { value: true, enumerable: false });
  return error;
}

/**
 * Async, bidirectional RPC over an ordered structured-clone transport.
 * Hooks receive a property path array. Special data is recursively encoded.
 * Handlers run with `this.signal`; cancellation does not imply rollback.
 * Returned nested promises travel separately from the initial acceptance.
 * Call release(value) for long-lived callback capabilities once no longer used.
 */
function createRpcPeer(options) {
  const opts = options || {};
  if (typeof opts.send !== 'function') throw TypeError('RPC needs send(packet)');
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw TypeError('Invalid RPC limit: ' + key);
  }
  const timeoutMs = opts.timeoutMs === undefined ? 30000 : opts.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw TypeError('Invalid RPC timeout');
  const callbackTimeoutMs = opts.callbackTimeoutMs === undefined ? timeoutMs : opts.callbackTimeoutMs;
  if (!Number.isFinite(callbackTimeoutMs) || callbackTimeoutMs < 0) throw TypeError('Invalid RPC callback timeout');
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const scheduleTimeout = typeof opts.setTimeout === 'function' ? opts.setTimeout : setTimeout;
  const cancelTimeout = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : clearTimeout;
  const timerDriftToleranceMs = opts.timerDriftToleranceMs === undefined ? 1000 : opts.timerDriftToleranceMs;
  if (!Number.isFinite(timerDriftToleranceMs) || timerDriftToleranceMs < 0)
    throw TypeError('Invalid RPC timer drift tolerance');
  const handlers = opts.handlers || {};
  const prefix = randomBytes(6).toString('hex');
  const pending = new Map(), incoming = new Map(), exported = new Map(), early = new Map(), settled = new Set();
  const notifications = new Set();
  const exportedIds = new WeakMap(), functions = new Map(), promises = new Map();
  const importedIds = new WeakMap();
  let serial = 0, closed = null, timeoutsPaused = false;
  const nextId = () => prefix + ':' + (++serial);
  const refCount = () => exported.size + functions.size + promises.size;
  function room() {
    if (refCount() >= limits.refs) throw fail('RPC_REFERENCE_LIMIT', 'Runtime capability limit reached');
  }
  function report(error) { try { opts.onError?.(error); } catch (_) { /* diagnostics cannot stop RPC */ } }
  function clearRowTimer(row) {
    if (row?.timer == null) return;
    cancelTimeout(row.timer); row.timer = null;
  }
  function armRowTimer(row) {
    if (closed || timeoutsPaused || !(row?.remainingMs > 0) || typeof row.onTimeout !== 'function') return;
    row.armedDelayMs = row.remainingMs;
    row.deadlineAt = now() + row.remainingMs;
    row.timer = scheduleTimeout(() => {
      row.timer = null;
      const drift = now() - row.deadlineAt;
      if (drift > timerDriftToleranceMs) {
        // Timers resume after system sleep or a blocked event loop before IPC
        // can deliver a power-state event. Exclude that inactive interval and
        // give the request the budget it had when this timer was armed.
        row.remainingMs = row.armedDelayMs;
        armRowTimer(row);
        return;
      }
      row.remainingMs = 0; row.onTimeout();
    }, row.remainingMs);
    if (row.unref) row.timer?.unref?.();
  }
  function pauseTimeouts() {
    if (closed || timeoutsPaused) return false;
    timeoutsPaused = true;
    const sampledAt = now();
    for (const row of [...pending.values(), ...early.values()]) {
      if (row.timer == null) continue;
      row.remainingMs = Math.max(1, row.deadlineAt - sampledAt);
      clearRowTimer(row);
    }
    return true;
  }
  function resumeTimeouts() {
    if (closed || !timeoutsPaused) return false;
    timeoutsPaused = false;
    for (const row of [...pending.values(), ...early.values()]) armRowTimer(row);
    return true;
  }
  function send(packet) {
    if (closed) throw closed;
    try {
      const sent = opts.send({ namespace: RPC_NAMESPACE, ...packet });
      if (sent?.then) Promise.resolve(sent).catch(error => close(fail('RPC_TRANSPORT_CLOSED', String(error?.message || error))));
    } catch (error) {
      close(fail('RPC_TRANSPORT_CLOSED', String(error?.message || error))); throw closed;
    }
  }
  function cleanupPending(id) {
    const row = pending.get(id);
    if (row) { pending.delete(id); clearRowTimer(row); row.detach?.(); }
    return row;
  }
  function close(error) {
    if (closed) return false;
    closed = error instanceof Error ? error : fail('RPC_CLOSED', String(error || 'Runtime channel closed'));
    for (const id of pending.keys()) cleanupPending(id).reject(closed);
    for (const row of promises.values()) row.reject(closed);
    for (const controller of incoming.values()) controller.abort(closed);
    for (const controller of notifications) controller.abort(closed);
    for (const row of early.values()) clearRowTimer(row);
    pending.clear(); incoming.clear(); notifications.clear(); promises.clear(); functions.clear(); exported.clear();
    early.clear(); settled.clear();
    return true;
  }
  function budget() {
    let nodes = 0, bytes = 0;
    return (depth, size = 8) => {
      nodes++; bytes += size;
      if (depth > limits.depth || nodes > limits.nodes || bytes > limits.bytes)
        throw fail('RPC_MESSAGE_LIMIT', 'Runtime message exceeds its size or nesting limit');
    };
  }
  function encode(root, path = []) {
    const count = budget(), ancestors = new Set(), created = [];
    function reference(value, kind) {
      const old = exportedIds.get(value);
      if (old && exported.has(old)) return [kind, old];
      room(); const id = nextId();
      exported.set(id, { value, kind }); exportedIds.set(value, id); created.push(id);
      if (kind === 'promise') Promise.resolve(value).then(
        result => settle(id, true, result), error => settle(id, false, errorData(error)));
      return [kind, id];
    }
    function visit(value, at, depth, skipSpecial = false) {
      count(depth, typeof value === 'string' ? value.length * 2 : 8);
      if (!skipSpecial && opts.encodeSpecial) {
        const special = opts.encodeSpecial(value, at);
        if (special !== undefined) {
          if (!special || !validMethod(special.tag)) throw fail('RPC_SPECIAL_INVALID', 'Invalid runtime capability tag');
          return ['special', special.tag, visit(special.data, at.concat('$data'), depth + 1, true)];
        }
      }
      if (value === null || typeof value === 'boolean' || typeof value === 'string') return ['value', value];
      if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)];
      if (value === undefined) return ['undefined'];
      if (typeof value === 'bigint') return ['bigint', String(value)];
      if (typeof value === 'function') return reference(value, 'function');
      if (typeof value !== 'object') throw fail('RPC_VALUE_UNSUPPORTED', 'Unsupported runtime value');
      if (typeof value.then === 'function') return reference(value, 'promise');
      if (ancestors.has(value)) throw fail('RPC_CYCLE', 'Cyclic runtime messages are not supported');
      ancestors.add(value);
      try {
        if (value instanceof Error) return ['error', errorData(value)];
        if (value instanceof Date) return ['date', value.toISOString()];
        if (value instanceof RegExp) return ['regexp', value.source, value.flags];
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
          const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
          count(depth, bytes.byteLength);
          const kind = value instanceof ArrayBuffer ? 'ArrayBuffer' : Buffer.isBuffer(value) ? 'Buffer' : value.constructor.name;
          if (!['ArrayBuffer', 'Buffer'].includes(kind) && !Object.hasOwn(TYPES, kind)) throw fail('RPC_VALUE_UNSUPPORTED', 'Unsupported binary value');
          return ['binary', kind, bytes.slice()];
        }
        if ((Array.isArray(value) ? value.length : value instanceof Map || value instanceof Set ? value.size : 0) > limits.nodes)
          throw fail('RPC_MESSAGE_LIMIT', 'Runtime collection exceeds its size limit');
        if (value instanceof Map) return ['map', [...value].map(([key, item], index) =>
          [visit(key, at.concat(index, 'key'), depth + 1), visit(item, at.concat(index, 'value'), depth + 1)])];
        if (value instanceof Set) return ['set', [...value].map((item, index) => visit(item, at.concat(index), depth + 1))];
        if (Array.isArray(value)) return ['array', value.map((item, index) => visit(item, at.concat(index), depth + 1))];
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) throw fail('RPC_VALUE_UNSUPPORTED', 'Runtime class requires a special codec');
        const keys = Object.keys(value);
        if (keys.length > limits.nodes) throw fail('RPC_MESSAGE_LIMIT', 'Runtime object exceeds its size limit');
        return ['object', keys.map(key => {
          count(depth + 1, key.length * 2); return [key, visit(value[key], at.concat(key), depth + 1)];
        })];
      } finally { ancestors.delete(value); }
    }
    try { return visit(root, path, 0); }
    catch (error) {
      for (const id of created) { const row = exported.get(id); if (row) exportedIds.delete(row.value); exported.delete(id); }
      throw error;
    }
  }
  function decode(root) {
    const count = budget(), created = [], ancestors = new Set();
    function visit(node, depth) {
      count(depth);
      if (!Array.isArray(node) || typeof node[0] !== 'string' || ancestors.has(node))
        throw fail('RPC_MESSAGE_INVALID', 'Malformed runtime value');
      ancestors.add(node);
      try {
        const [kind, data] = node;
        if (kind === 'undefined' && node.length === 1) return undefined;
        if (kind === 'value' && node.length === 2 && (data === null || ['boolean', 'string'].includes(typeof data))) {
          if (typeof data === 'string') count(depth, data.length * 2); return data;
        }
        if (kind === 'number' && node.length === 2 && typeof data === 'string' && data.length < 100 &&
            /^(?:NaN|-?Infinity|-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i.test(data)) return Number(data);
        if (kind === 'bigint' && node.length === 2 && typeof data === 'string' && /^-?\d+$/.test(data)) {
          count(depth, data.length * 2); return BigInt(data);
        }
        if (kind === 'function' && node.length === 2 && validId(data)) {
          if (!functions.has(data)) {
            room(); const fn = (...args) => functions.get(data) === fn
              ? request({ callback: data }, args, { timeoutMs: callbackTimeoutMs })
              : Promise.reject(closed || fail('RPC_REFERENCE_RELEASED', 'Runtime callback was released'));
            functions.set(data, fn); importedIds.set(fn, { kind, id: data }); created.push({ kind, id: data });
          }
          return functions.get(data);
        }
        if (kind === 'promise' && node.length === 2 && validId(data)) {
          if (!promises.has(data)) {
            room(); const row = deferred(); promises.set(data, row);
            importedIds.set(row.promise, { kind, id: data }); created.push({ kind, id: data });
            const waiting = early.get(data);
            if (waiting) {
              early.delete(data); clearRowTimer(waiting);
              queueMicrotask(() => receive(waiting.packet));
            }
          }
          return promises.get(data).promise;
        }
        if (kind === 'special' && node.length === 3 && validMethod(data)) {
          if (!opts.decodeSpecial) throw fail('RPC_SPECIAL_UNSUPPORTED', 'Unsupported runtime capability: ' + data);
          return opts.decodeSpecial(data, visit(node[2], depth + 1));
        }
        if (kind === 'error' && node.length === 2 && data && typeof data === 'object') {
          count(depth, String(data.message || '').length * 2); return remoteError(data);
        }
        if (kind === 'date' && node.length === 2 && typeof data === 'string') {
          const date = new Date(data); if (!Number.isFinite(date.getTime())) throw fail('RPC_MESSAGE_INVALID', 'Invalid runtime date'); return date;
        }
        if (kind === 'regexp' && node.length === 3 && typeof data === 'string' && typeof node[2] === 'string') {
          count(depth, data.length * 2); return new RegExp(data, node[2]);
        }
        if (kind === 'binary' && node.length === 3 && node[2] instanceof Uint8Array) {
          count(depth, node[2].byteLength); const buffer = node[2].slice().buffer;
          if (data === 'ArrayBuffer') return buffer;
          if (data === 'Buffer') return Buffer.from(buffer);
          if (Object.hasOwn(TYPES, data)) return new TYPES[data](buffer);
        }
        if (['array', 'object', 'map', 'set'].includes(kind) && node.length === 2 && Array.isArray(data)) {
          if (data.length > limits.nodes) throw fail('RPC_MESSAGE_LIMIT', 'Runtime collection exceeds its size limit');
          if (kind === 'array') return data.map(item => visit(item, depth + 1));
          if (kind === 'set') return new Set(data.map(item => visit(item, depth + 1)));
          const output = kind === 'map' ? new Map() : {};
          for (const pair of data) {
            if (!Array.isArray(pair) || pair.length !== 2) throw fail('RPC_MESSAGE_INVALID', 'Invalid runtime entry');
            if (kind === 'map') output.set(visit(pair[0], depth + 1), visit(pair[1], depth + 1));
            else {
              if (typeof pair[0] !== 'string' || Object.hasOwn(output, pair[0])) throw fail('RPC_MESSAGE_INVALID', 'Invalid runtime object key');
              count(depth + 1, pair[0].length * 2);
              Object.defineProperty(output, pair[0], { value: visit(pair[1], depth + 1), enumerable: true, writable: true, configurable: true });
            }
          }
          return output;
        }
        throw fail('RPC_MESSAGE_INVALID', 'Unknown or malformed runtime value');
      } finally { ancestors.delete(node); }
    }
    try { return visit(root, 0); }
    catch (error) {
      for (const row of created) {
        if (row.kind === 'promise') { promises.get(row.id)?.reject(error); promises.delete(row.id); }
        else functions.delete(row.id);
      }
      throw error;
    }
  }
  function settle(id, ok, value) {
    if (closed || !exported.has(id)) return;
    const row = exported.get(id); exported.delete(id); exportedIds.delete(row.value);
    try { send({ type: 'settle', id, ok, value: encode(value, ['completion']) }); }
    catch (error) {
      if (!closed) try { send({ type: 'settle', id, ok: false, value: encode(errorData(error)) }); } catch (_) { /* closed */ }
    }
  }
  function request(target, args = [], callOptions = {}) {
    if (closed) return Promise.reject(closed);
    if (!Array.isArray(args)) return Promise.reject(fail('RPC_ARGUMENTS_INVALID', 'Runtime arguments must be an array'));
    if (callOptions.signal?.aborted) return Promise.reject(fail('RPC_ABORTED', 'Runtime request aborted'));
    if (pending.size >= limits.pending) return Promise.reject(fail('RPC_PENDING_LIMIT', 'Too many pending runtime requests'));
    const duration = callOptions.timeoutMs === undefined ? timeoutMs : callOptions.timeoutMs;
    if (!Number.isFinite(duration) || duration < 0) return Promise.reject(fail('RPC_TIMEOUT_INVALID', 'Invalid runtime timeout'));
    let encoded;
    try { encoded = encode(args, ['args']); } catch (error) { return Promise.reject(error); }
    const id = nextId(), row = deferred(); pending.set(id, row);
    const abandon = error => {
      if (!cleanupPending(id)) return;
      row.reject(error); if (!closed) try { send({ type: 'cancel', id }); } catch (_) { /* transport closed */ }
    };
    if (duration > 0) {
      row.remainingMs = duration;
      row.onTimeout = () => abandon(fail('RPC_TIMEOUT', 'Runtime request timed out'));
      armRowTimer(row);
    }
    if (callOptions.signal) {
      const aborted = () => abandon(fail('RPC_ABORTED', 'Runtime request aborted'));
      callOptions.signal.addEventListener('abort', aborted, { once: true });
      row.detach = () => callOptions.signal.removeEventListener('abort', aborted);
    }
    try { send({ type: 'request', id, ...target, args: encoded }); }
    catch (error) { cleanupPending(id)?.reject(error); }
    return row.promise;
  }
  function call(method, args = [], callOptions = {}) {
    if (!validMethod(method)) return Promise.reject(fail('RPC_METHOD_INVALID', 'Invalid runtime method'));
    return request({ method }, args, callOptions);
  }
  function notify(method, args = []) {
    if (closed) return false;
    if (!validMethod(method) || !Array.isArray(args)) throw fail('RPC_ARGUMENTS_INVALID', 'Invalid runtime notification');
    send({ type: 'notify', method, args: encode(args, ['args']) }); return true;
  }
  function rememberSettlement(id) {
    settled.add(id); if (settled.size > limits.refs) settled.delete(settled.values().next().value);
  }
  function bufferEarly(packet) {
    if (settled.has(packet.id) || early.has(packet.id)) return;
    if (early.size >= Math.min(limits.pending, limits.refs)) { report(fail('RPC_REFERENCE_LIMIT', 'Too many early runtime completions')); return; }
    // A transport normally preserves ordering. Bound even an unsolicited early
    // packet before retaining it, without creating callback capabilities yet.
    const count = budget(), seen = new Set();
    function inspect(value, depth = 0) {
      count(depth, typeof value === 'string' ? value.length * 2 : ArrayBuffer.isView(value) ? value.byteLength : 8);
      if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return;
      if (seen.has(value)) throw fail('RPC_MESSAGE_INVALID', 'Cyclic early completion');
      seen.add(value);
      for (const child of Object.values(value)) inspect(child, depth + 1);
      seen.delete(value);
    }
    try { inspect(packet.value); } catch (error) { report(error); return; }
    const row = { packet, remainingMs: timeoutMs || 30000, unref: true,
      onTimeout: () => early.delete(packet.id) };
    early.set(packet.id, row); armRowTimer(row);
  }
  function receive(packet) {
    if (!packet || packet.namespace !== RPC_NAMESPACE || closed) return false;
    const { type, id } = packet;
    if (type === 'response' || type === 'settle') {
      if (!validId(id) || typeof packet.ok !== 'boolean') return false;
      const row = type === 'response' ? cleanupPending(id) : promises.get(id);
      if (!row) { if (type === 'settle') bufferEarly(packet); return true; }
      if (type === 'settle') { promises.delete(id); rememberSettlement(id); }
      try { const value = decode(packet.value); packet.ok ? row.resolve(value) : row.reject(remoteError(value)); }
      catch (error) { row.reject(error); }
      return true;
    }
    if (type === 'cancel' && validId(id)) {
      const controller = incoming.get(id); incoming.delete(id);
      controller?.abort(fail('RPC_ABORTED', 'Runtime caller cancelled the request')); return true;
    }
    if (['release', 'revoke'].includes(type) && Array.isArray(packet.ids) && packet.ids.length <= limits.refs) {
      if (!packet.ids.every(validId)) return false;
      for (const key of packet.ids) {
        if (type === 'release') {
          const row = exported.get(key); if (row) { exportedIds.delete(row.value); exported.delete(key); }
        } else {
          functions.delete(key); promises.get(key)?.reject(fail('RPC_REFERENCE_RELEASED', 'Runtime capability was revoked'));
          promises.delete(key); rememberSettlement(key);
          const waiting = early.get(key); clearRowTimer(waiting); early.delete(key);
        }
      }
      return true;
    }
    if (!['request', 'notify'].includes(type) || type === 'request' && !validId(id)) return false;
    const notification = type === 'notify';
    const reply = (ok, value) => {
      if (notification || closed || !incoming.has(id)) return;
      try { send({ type: 'response', id, ok, value: encode(value, ['return']) }); }
      catch (error) { if (!closed && ok) reply(false, errorData(error)); }
    };
    if (incoming.size + notifications.size >= limits.incoming || !notification && incoming.has(id)) {
      if (!notification) try { send({ type: 'response', id, ok: false, value: encode(errorData(fail('RPC_INCOMING_LIMIT', 'Runtime is handling too many requests'))) }); }
      catch (error) { report(error); }
      return true;
    }
    const controller = new AbortController();
    if (notification) notifications.add(controller); else incoming.set(id, controller);
    Promise.resolve().then(() => {
      if (closed || controller.signal.aborted) return;
      const fn = validId(packet.callback) && !packet.method ? exported.get(packet.callback)?.value
        : validMethod(packet.method) && Object.hasOwn(handlers, packet.method) && handlers[packet.method];
      if (typeof fn !== 'function') throw fail('RPC_METHOD_NOT_FOUND', 'Unknown runtime method');
      const args = decode(packet.args);
      if (!Array.isArray(args)) throw fail('RPC_ARGUMENTS_INVALID', 'Runtime arguments must be an array');
      return fn.apply({ signal: controller.signal, method: packet.method, notification }, args);
    }).then(value => reply(true, value), error => { reply(false, errorData(error)); if (notification) report(error); })
      .finally(() => { if (notification) notifications.delete(controller); else if (incoming.get(id) === controller) incoming.delete(id); });
    return true;
  }
  function release(value) {
    const released = [], revoked = [], seen = new Set();
    function walk(item, depth = 0) {
      if (!item || !['object', 'function'].includes(typeof item) || seen.has(item) || depth > limits.depth || seen.size >= limits.nodes) return;
      seen.add(item);
      const imported = importedIds.get(item);
      if (imported) {
        importedIds.delete(item); released.push(imported.id); functions.delete(imported.id);
        promises.get(imported.id)?.reject(fail('RPC_REFERENCE_RELEASED', 'Runtime completion was released'));
        promises.delete(imported.id); rememberSettlement(imported.id); return;
      }
      const ownId = exportedIds.get(item);
      if (ownId) { exportedIds.delete(item); exported.delete(ownId); revoked.push(ownId); return; }
      if (item instanceof Map) for (const [key, child] of item) { walk(key, depth + 1); walk(child, depth + 1); }
      else if (item instanceof Set) for (const child of item) walk(child, depth + 1);
      else if (Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
        for (const child of Object.values(item)) walk(child, depth + 1);
    }
    walk(value);
    if (released.length && !closed) send({ type: 'release', ids: released });
    if (revoked.length && !closed) send({ type: 'revoke', ids: revoked });
    return released.length + revoked.length;
  }
  return { receive, call, notify, close, release, pauseTimeouts, resumeTimeouts,
    stats: () => ({ closed: Boolean(closed), pending: pending.size, incoming: incoming.size + notifications.size,
      exported: exported.size, functions: functions.size, promises: promises.size }) };
}

module.exports = { RPC_NAMESPACE, RpcError, createRpcPeer };
