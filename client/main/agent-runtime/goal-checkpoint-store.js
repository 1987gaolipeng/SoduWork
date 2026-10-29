'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHECKPOINT_SCHEMA = 'soduwork.agent-runtime.goal-checkpoint/v1';
const LEASE_SCHEMA = 'soduwork.agent-runtime.goal-lease/v1';
const MAX_HISTORY = 64;
const DEFAULT_LEASE_TTL_MS = 60 * 1000;

function _text(value, limit) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function _number(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function _record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function _lastEvent(value) {
  const row = _record(value);
  return {
    id: _text(row.id, 180),
    sequence: _number(row.sequence),
    type: _text(row.type, 80),
    at: _text(row.at, 48),
  };
}

function _action(value) {
  const row = _record(value);
  return {
    name: _text(row.name, 32),
    state: _text(row.state, 32),
    reason: _text(row.reason, 600),
    at: _text(row.at, 48),
    key: _text(row.key, 180),
  };
}

function _recovery(value) {
  const row = _record(value);
  return {
    kind: _text(row.kind, 40) || 'fresh',
    fromEpoch: _text(row.fromEpoch, 120),
    fromRevision: _number(row.fromRevision),
    previousSafeBoundary: Boolean(row.previousSafeBoundary),
    interrupted: Boolean(row.interrupted),
    requiresResume: Boolean(row.requiresResume),
    at: _text(row.at, 48),
  };
}

function _goal(value) {
  const row = _record(value);
  return {
    configured: Boolean(row.configured),
    visible: Boolean(row.visible),
    active: Boolean(row.active),
    runId: _text(row.runId, 160),
    node: _text(row.node, 40),
    phase: _text(row.phase, 40),
    state: _text(row.state, 40),
    decision: _text(row.decision, 40),
    reason: _text(row.reason, 1000),
    iteration: _number(row.iteration),
    harnessRevision: _number(row.harnessRevision),
    qualityPhase: _text(row.qualityPhase, 40),
    qualityReason: _text(row.qualityReason, 1000),
    paused: Boolean(row.paused),
    pauseKind: _text(row.pauseKind, 40),
  };
}

function _historyRow(value) {
  const row = _record(value);
  return {
    revision: _number(row.revision),
    status: _text(row.status, 40),
    safeBoundary: Boolean(row.safeBoundary),
    boundaryType: _text(row.boundaryType, 80),
    goal: _goal(row.goal),
    action: _action(row.action),
    lastEvent: _lastEvent(row.lastEvent),
    at: _text(row.at, 48),
  };
}

function normalizeGoalCheckpoint(value) {
  const row = _record(value);
  const history = (Array.isArray(row.history) ? row.history : [])
    .slice(-MAX_HISTORY).map(_historyRow);
  return {
    schema: CHECKPOINT_SCHEMA,
    adapterId: _text(row.adapterId, 48),
    sessionId: _text(row.sessionId, 180),
    runtimeId: _text(row.runtimeId, 120) || 'local',
    epoch: _text(row.epoch, 120),
    revision: _number(row.revision),
    status: _text(row.status, 40),
    safeBoundary: Boolean(row.safeBoundary),
    boundaryType: _text(row.boundaryType, 80),
    recovery: _recovery(row.recovery),
    goal: _goal(row.goal),
    action: _action(row.action),
    lastEvent: _lastEvent(row.lastEvent),
    at: _text(row.at, 48),
    history,
  };
}

function checkpointKey(adapterId, sessionId) {
  return crypto.createHash('sha256')
    .update(_text(adapterId, 48) + '\n' + _text(sessionId, 180), 'utf8')
    .digest('hex');
}

function _leaseError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details || null;
  return error;
}

function _leaseOptions(base, overrides) {
  return { ..._record(base), ..._record(overrides) };
}

function _now(options) {
  const opts = _record(options);
  const value = typeof opts.clock === 'function' ? opts.clock() :
    (Object.prototype.hasOwnProperty.call(opts, 'now') ? opts.now : Date.now());
  return value instanceof Date ? value.getTime() : Number(value || Date.now());
}

function _lease(value) {
  const row = _record(value);
  return {
    schema: LEASE_SCHEMA,
    adapterId: _text(row.adapterId, 48),
    sessionId: _text(row.sessionId, 180),
    owner: _text(row.owner, 180),
    pid: _number(row.pid),
    host: _text(row.host, 160),
    acquiredAt: _number(row.acquiredAt),
    renewedAt: _number(row.renewedAt),
    expiresAt: _number(row.expiresAt),
  };
}

function _leaseValue(adapterId, sessionId, owner, options, previous) {
  const opts = _record(options);
  const at = _now(opts);
  const ttl = Math.min(5 * 60 * 1000, Math.max(5000,
    _number(opts.leaseTtlMs) || DEFAULT_LEASE_TTL_MS));
  const before = _lease(previous);
  return _lease({
    adapterId, sessionId, owner,
    pid: _number(opts.pid) || process.pid,
    host: _text(opts.host, 160) || os.hostname(),
    acquiredAt: before.owner === owner && before.acquiredAt ? before.acquiredAt : at,
    renewedAt: at,
    expiresAt: at + ttl,
  });
}

function _canTakeLease(current, owner, options) {
  const row = _lease(current);
  if (!row.owner || row.owner === owner) return true;
  const opts = _record(options);
  if (row.expiresAt <= _now(opts)) return true;
  const host = _text(opts.host, 160) || os.hostname();
  if (row.host && row.host === host && row.pid) {
    const alive = typeof opts.processAlive === 'function' ? opts.processAlive : (pid) => {
      if (pid === process.pid) return true;
      try { process.kill(pid, 0); return true; }
      catch (error) { return String(error && error.code || '') === 'EPERM'; }
    };
    if (!alive(row.pid)) return true;
  }
  return false;
}

class MemoryGoalCheckpointStore {
  constructor(options) {
    this._rows = new Map();
    this._leases = new Map();
    this.leaseOptions = _record(options);
  }

  load(adapterId, sessionId) {
    const row = this._rows.get(checkpointKey(adapterId, sessionId));
    return row ? normalizeGoalCheckpoint(row) : null;
  }

  list() {
    return [...this._rows.values()].map(normalizeGoalCheckpoint);
  }

  save(value, options) {
    const row = normalizeGoalCheckpoint(value);
    if (!row.adapterId || !row.sessionId) throw new Error('checkpoint identity is required');
    const owner = _text(_record(options).owner, 180);
    const held = this._leases.get(checkpointKey(row.adapterId, row.sessionId));
    if (owner && (!held || held.owner !== owner)) {
      throw _leaseError('GOAL_CHECKPOINT_LEASE_LOST', 'goal checkpoint lease is not owned', held);
    }
    this._rows.set(checkpointKey(row.adapterId, row.sessionId), row);
    return normalizeGoalCheckpoint(row);
  }

  claim(adapterId, sessionId, owner, options) {
    const identity = _text(owner, 180);
    if (!identity) throw _leaseError('GOAL_CHECKPOINT_OWNER_REQUIRED', 'checkpoint owner is required');
    const key = checkpointKey(adapterId, sessionId);
    const current = this._leases.get(key);
    const opts = _leaseOptions(this.leaseOptions, options);
    if (!_canTakeLease(current, identity, opts)) {
      throw _leaseError('GOAL_CHECKPOINT_LEASED', 'goal session is already owned', current);
    }
    const next = _leaseValue(adapterId, sessionId, identity, opts, current);
    this._leases.set(key, next);
    return _lease(next);
  }

  renew(adapterId, sessionId, owner, options) {
    const key = checkpointKey(adapterId, sessionId);
    const current = this._leases.get(key);
    if (!current || current.owner !== String(owner || '')) {
      throw _leaseError('GOAL_CHECKPOINT_LEASE_LOST', 'goal checkpoint lease was lost', current);
    }
    const next = _leaseValue(adapterId, sessionId, owner,
      _leaseOptions(this.leaseOptions, options), current);
    this._leases.set(key, next);
    return _lease(next);
  }

  release(adapterId, sessionId, owner) {
    const key = checkpointKey(adapterId, sessionId);
    const current = this._leases.get(key);
    if (!current || current.owner !== String(owner || '')) return false;
    this._leases.delete(key);
    return true;
  }
}

class FileGoalCheckpointStore {
  constructor(root, options) {
    const resolved = path.resolve(String(root || ''));
    if (!path.isAbsolute(resolved) || resolved === path.parse(resolved).root) {
      throw new Error('goal checkpoint root must be a dedicated absolute directory');
    }
    this.root = resolved;
    this.leaseOptions = _record(options);
  }

  _path(adapterId, sessionId) {
    return path.join(this.root, checkpointKey(adapterId, sessionId) + '.json');
  }

  _leaseDir(adapterId, sessionId) {
    return path.join(this.root, checkpointKey(adapterId, sessionId) + '.lease');
  }

  _leaseFile(adapterId, sessionId) {
    return path.join(this._leaseDir(adapterId, sessionId), 'owner.json');
  }

  _readLease(adapterId, sessionId) {
    try { return _lease(JSON.parse(fs.readFileSync(this._leaseFile(adapterId, sessionId), 'utf8'))); }
    catch (error) { return null; }
  }

  _writeLease(adapterId, sessionId, value) {
    fs.writeFileSync(this._leaseFile(adapterId, sessionId), JSON.stringify(_lease(value)),
      { encoding: 'utf8', mode: 0o600 });
  }

  load(adapterId, sessionId) {
    const target = this._path(adapterId, sessionId);
    for (const candidate of [target, target + '.bak']) {
      try {
        const row = normalizeGoalCheckpoint(JSON.parse(fs.readFileSync(candidate, 'utf8')));
        if (row.adapterId === String(adapterId || '') &&
            row.sessionId === String(sessionId || '')) return row;
      } catch (error) {
        /* A missing or incomplete newest file may still have a valid backup. */
      }
    }
    return null;
  }

  list() {
    let names = [];
    try { names = fs.readdirSync(this.root); } catch (error) { return []; }
    return names.filter((name) => /^[a-f0-9]{64}\.json$/i.test(name)).map((name) => {
      try { return normalizeGoalCheckpoint(JSON.parse(
        fs.readFileSync(path.join(this.root, name), 'utf8'))); }
      catch (error) { return null; }
    }).filter((row) => row && row.adapterId && row.sessionId);
  }

  claim(adapterId, sessionId, owner, options) {
    const identity = _text(owner, 180);
    if (!identity) throw _leaseError('GOAL_CHECKPOINT_OWNER_REQUIRED', 'checkpoint owner is required');
    fs.mkdirSync(this.root, { recursive: true });
    const target = this._leaseDir(adapterId, sessionId);
    const opts = _leaseOptions(this.leaseOptions, options);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        fs.mkdirSync(target);
        const next = _leaseValue(adapterId, sessionId, identity, opts, null);
        try { this._writeLease(adapterId, sessionId, next); }
        catch (error) { fs.rmSync(target, { recursive: true, force: true }); throw error; }
        return next;
      } catch (error) {
        if (String(error && error.code || '') !== 'EEXIST') throw error;
      }
      const current = this._readLease(adapterId, sessionId);
      if (current && current.owner === identity) {
        const next = _leaseValue(adapterId, sessionId, identity, opts, current);
        this._writeLease(adapterId, sessionId, next);
        return next;
      }
      if (!current) {
        let age = 0;
        try { age = _now(opts) - fs.statSync(target).mtimeMs; } catch (error) { continue; }
        if (age < (_number(opts.leaseTtlMs) || DEFAULT_LEASE_TTL_MS)) {
          throw _leaseError('GOAL_CHECKPOINT_LEASED', 'goal session lease is being acquired');
        }
      } else if (!_canTakeLease(current, identity, opts)) {
        throw _leaseError('GOAL_CHECKPOINT_LEASED', 'goal session is already owned', current);
      }
      const stale = target + '.stale.' + process.pid + '.' + Date.now();
      try { fs.renameSync(target, stale); }
      catch (error) {
        if (!['ENOENT', 'EACCES', 'EPERM'].includes(String(error && error.code || ''))) throw error;
        continue;
      }
      try { fs.rmSync(stale, { recursive: true, force: true }); } catch (error) { /* best effort */ }
    }
    throw _leaseError('GOAL_CHECKPOINT_LEASE_RACE', 'goal checkpoint lease could not be claimed');
  }

  renew(adapterId, sessionId, owner, options) {
    const current = this._readLease(adapterId, sessionId);
    if (!current || current.owner !== String(owner || '')) {
      throw _leaseError('GOAL_CHECKPOINT_LEASE_LOST', 'goal checkpoint lease was lost', current);
    }
    const next = _leaseValue(adapterId, sessionId, owner,
      _leaseOptions(this.leaseOptions, options), current);
    this._writeLease(adapterId, sessionId, next);
    return next;
  }

  release(adapterId, sessionId, owner) {
    const current = this._readLease(adapterId, sessionId);
    if (!current || current.owner !== String(owner || '')) return false;
    fs.rmSync(this._leaseDir(adapterId, sessionId), { recursive: true, force: true });
    return true;
  }

  save(value, options) {
    const row = normalizeGoalCheckpoint(value);
    if (!row.adapterId || !row.sessionId) throw new Error('checkpoint identity is required');
    fs.mkdirSync(this.root, { recursive: true });
    const owner = _text(_record(options).owner, 180);
    const held = owner ? this._readLease(row.adapterId, row.sessionId) : null;
    if (owner && (!held || held.owner !== owner)) {
      throw _leaseError('GOAL_CHECKPOINT_LEASE_LOST', 'goal checkpoint lease is not owned', held);
    }
    const target = this._path(row.adapterId, row.sessionId);
    const temporary = target + '.' + process.pid + '.' + Date.now() + '.tmp';
    const backup = target + '.bak';
    try {
      fs.writeFileSync(temporary, JSON.stringify(row, null, 2), { encoding: 'utf8', mode: 0o600 });
      try {
        fs.renameSync(temporary, target);
      } catch (error) {
        if (!['EEXIST', 'EPERM'].includes(String(error && error.code || ''))) throw error;
        fs.rmSync(backup, { force: true });
        if (fs.existsSync(target)) fs.renameSync(target, backup);
        try {
          fs.renameSync(temporary, target);
          fs.rmSync(backup, { force: true });
        } catch (replaceError) {
          if (!fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target);
          throw replaceError;
        }
      }
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch (error) { /* best effort */ }
    }
    return normalizeGoalCheckpoint(row);
  }
}

module.exports = {
  CHECKPOINT_SCHEMA,
  LEASE_SCHEMA,
  DEFAULT_LEASE_TTL_MS,
  MAX_HISTORY,
  FileGoalCheckpointStore,
  MemoryGoalCheckpointStore,
  checkpointKey,
  normalizeGoalCheckpoint,
};
