'use strict';

const { RuntimeContractError } = require('./contract');

const EVENT_SCHEMA = 'soduwork.agent-runtime.event/v1';

const EVENT_TYPES = Object.freeze([
  'runtime.ready', 'runtime.unavailable',
  'session.created', 'session.resumed', 'session.disposed',
  'turn.queued', 'turn.started', 'turn.paused', 'turn.completed',
  'turn.failed', 'turn.cancelled',
  'message.delta', 'message.completed',
  'tool.started', 'tool.progress', 'tool.completed', 'tool.failed',
  'artifact.produced',
  'approval.requested', 'approval.resolved',
  'state.changed', 'native.event',
]);

const SOURCES = Object.freeze(['user', 'agent', 'runtime', 'framework', 'tool']);
const TYPE_SET = new Set(EVENT_TYPES);
const SOURCE_SET = new Set(SOURCES);

function _record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeContractError('INVALID_EVENT', label + ' must be an object');
  }
  return value;
}

function validateRuntimeEvent(event, previousSequence) {
  _record(event, 'event');
  if (event.schema !== EVENT_SCHEMA) {
    throw new RuntimeContractError('INVALID_EVENT_SCHEMA', 'unsupported event schema',
      { schema: event.schema });
  }
  if (!String(event.id || '') || !String(event.adapterId || '') || !String(event.sessionId || '')) {
    throw new RuntimeContractError('INVALID_EVENT_IDENTITY',
      'event needs id, adapterId and sessionId');
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    throw new RuntimeContractError('INVALID_EVENT_SEQUENCE', 'event sequence must be a positive integer');
  }
  if (previousSequence === undefined && event.sequence !== 1) {
    throw new RuntimeContractError('EVENT_GAP',
      'the first event in a session must start at sequence 1', {
        sequence: event.sequence, sessionId: event.sessionId,
      });
  }
  if (Number.isSafeInteger(previousSequence) && event.sequence !== previousSequence + 1) {
    throw new RuntimeContractError(event.sequence <= previousSequence
      ? 'OUT_OF_ORDER_EVENT' : 'EVENT_GAP',
    'event sequence must be contiguous and monotonic', {
        previousSequence, sequence: event.sequence, sessionId: event.sessionId,
      });
  }
  if (!TYPE_SET.has(event.type)) {
    throw new RuntimeContractError('INVALID_EVENT_TYPE', 'unsupported event type: ' + event.type);
  }
  if (!SOURCE_SET.has(event.source)) {
    throw new RuntimeContractError('INVALID_EVENT_SOURCE', 'unsupported event source: ' + event.source);
  }
  _record(event.payload, 'event payload');
  if (!Number.isFinite(Date.parse(event.at))) {
    throw new RuntimeContractError('INVALID_EVENT_TIME', 'event time must be ISO-8601');
  }
  if (event.native !== undefined) {
    _record(event.native, 'native event');
    if (!String(event.native.namespace || '') || !String(event.native.type || '')) {
      throw new RuntimeContractError('INVALID_NATIVE_EVENT',
        'native event needs namespace and type');
    }
  }
  return event;
}

function createEventFactory(options) {
  const opts = _record(options, 'event factory options');
  const adapterId = String(opts.adapterId || '');
  const sessionId = String(opts.sessionId || '');
  const runtimeId = String(opts.runtimeId || 'local');
  if (!adapterId || !sessionId) {
    throw new RuntimeContractError('INVALID_EVENT_FACTORY',
      'event factory needs adapterId and sessionId');
  }
  const clock = typeof opts.clock === 'function' ? opts.clock : () => new Date();
  const idFactory = typeof opts.idFactory === 'function'
    ? opts.idFactory : (sequence) => sessionId + ':' + sequence;
  let sequence = Math.max(0, Number(opts.sequence || 0) || 0);

  return function event(type, payload, extra) {
    sequence += 1;
    const meta = extra || {};
    const value = {
      schema: EVENT_SCHEMA,
      id: String(idFactory(sequence)),
      sequence,
      runtimeId,
      adapterId,
      sessionId,
      turnId: meta.turnId ? String(meta.turnId) : '',
      type: String(type || ''),
      source: String(meta.source || 'runtime'),
      at: new Date(clock()).toISOString(),
      payload: payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload : {},
    };
    if (meta.native !== undefined) value.native = meta.native;
    validateRuntimeEvent(value, sequence - 1 || undefined);
    return Object.freeze(value);
  };
}

class RuntimeEventJournal {
  constructor() {
    this._sequences = new Map();
    this._ids = new Set();
  }

  append(event) {
    if (this._ids.has(event && event.id)) {
      throw new RuntimeContractError('DUPLICATE_EVENT', 'duplicate event id: ' + event.id);
    }
    const key = String((event && event.adapterId) || '') + ':' +
      String((event && event.sessionId) || '');
    const previous = this._sequences.get(key);
    validateRuntimeEvent(event, previous);
    this._ids.add(event.id);
    this._sequences.set(key, event.sequence);
    return event;
  }

  cursor(adapterId, sessionId) {
    return this._sequences.get(String(adapterId) + ':' + String(sessionId)) || 0;
  }
}

module.exports = {
  EVENT_SCHEMA,
  EVENT_TYPES,
  SOURCES,
  createEventFactory,
  validateRuntimeEvent,
  RuntimeEventJournal,
};
