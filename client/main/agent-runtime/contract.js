'use strict';

const ADAPTER_ID = /^[a-z][a-z0-9._-]{0,47}$/;

const CONSUMERS = Object.freeze(['chat', 'goal', 'task']);

const CAPABILITIES = Object.freeze({
  SESSION_RESUME: 'session.resume',
  TURN_QUEUE: 'turn.queue',
  TURN_CANCEL: 'turn.cancel',
  TURN_PAUSE: 'turn.pause',
  TURN_STEER: 'turn.steer',
  ARTIFACT_LIST: 'artifact.list',
  APPROVAL_RESPOND: 'approval.respond',
  GOAL_CONTROL: 'goal.control',
  ATTACHMENTS: 'input.attachments',
  MODEL_SELECT: 'model.select',
  SKILLS: 'skills',
  MCP: 'mcp',
  WORKSPACE: 'workspace',
  NATIVE_EVENTS: 'runtime.native-events',
});

const SESSION_METHOD_BY_CAPABILITY = Object.freeze({
  [CAPABILITIES.TURN_CANCEL]: 'cancel',
  [CAPABILITIES.TURN_PAUSE]: 'pause',
  [CAPABILITIES.TURN_STEER]: 'steer',
  [CAPABILITIES.ARTIFACT_LIST]: 'artifacts',
  [CAPABILITIES.APPROVAL_RESPOND]: 'respondApproval',
  [CAPABILITIES.GOAL_CONTROL]: 'controlGoal',
});

class RuntimeContractError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'RuntimeContractError';
    this.code = code;
    this.details = details || {};
  }
}

function _object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeContractError('INVALID_' + label.toUpperCase(), label + ' must be an object');
  }
  return value;
}

function _method(value, name, owner) {
  if (typeof value[name] !== 'function') {
    throw new RuntimeContractError(
      'MISSING_METHOD', owner + ' must implement ' + name + '()', { owner, method: name });
  }
}

function normalizeCapability(value) {
  const source = typeof value === 'string' ? { id: value } : _object(value, 'capability');
  const id = String(source.id || '').trim();
  if (!id || !/^[a-z][a-z0-9.-]{1,63}$/.test(id)) {
    throw new RuntimeContractError('INVALID_CAPABILITY', 'invalid capability id: ' + id, { id });
  }
  const level = String(source.level || 'native');
  if (!['native', 'emulated', 'delegated'].includes(level)) {
    throw new RuntimeContractError('INVALID_CAPABILITY_LEVEL', 'invalid capability level: ' + level,
      { id, level });
  }
  return Object.freeze({
    id,
    level,
    version: Math.max(1, Number(source.version || 1) || 1),
    detail: String(source.detail || ''),
    native: source.native && typeof source.native === 'object'
      ? Object.freeze({ ...source.native }) : undefined,
  });
}

function normalizeCapabilities(values) {
  const items = (Array.isArray(values) ? values : []).map(normalizeCapability);
  const seen = new Set();
  items.forEach((item) => {
    if (seen.has(item.id)) {
      throw new RuntimeContractError('DUPLICATE_CAPABILITY',
        'duplicate capability: ' + item.id, { id: item.id });
    }
    seen.add(item.id);
  });
  return Object.freeze(items);
}

function capabilityMap(values) {
  return new Map(normalizeCapabilities(values).map((item) => [item.id, item]));
}

function validateAdapter(adapter) {
  _object(adapter, 'adapter');
  const id = String(adapter.id || '').trim();
  if (!ADAPTER_ID.test(id)) {
    throw new RuntimeContractError('INVALID_ADAPTER_ID', 'invalid adapter id: ' + id, { id });
  }
  if (!String(adapter.displayName || '').trim()) {
    throw new RuntimeContractError('INVALID_ADAPTER_NAME', 'adapter ' + id + ' needs displayName');
  }
  _method(adapter, 'detect', 'adapter ' + id);
  _method(adapter, 'createSession', 'adapter ' + id);
  const capabilities = normalizeCapabilities(adapter.capabilities);
  const ids = new Set(capabilities.map((item) => item.id));
  if (ids.has(CAPABILITIES.SESSION_RESUME)) {
    _method(adapter, 'resumeSession', 'adapter ' + id);
  }
  return Object.freeze({
    id,
    displayName: String(adapter.displayName),
    version: String(adapter.version || '0'),
    capabilities,
  });
}

function validateSession(session, adapterDescriptor) {
  _object(session, 'session');
  const adapter = _object(adapterDescriptor, 'adapter descriptor');
  const id = String(session.id || '').trim();
  if (!id) throw new RuntimeContractError('INVALID_SESSION_ID', 'runtime session needs an id');
  ['send', 'subscribe', 'snapshot', 'dispose'].forEach((name) =>
    _method(session, name, 'session ' + id));
  const capabilities = normalizeCapabilities(adapter.capabilities);
  capabilities.forEach((item) => {
    const method = SESSION_METHOD_BY_CAPABILITY[item.id];
    if (method) _method(session, method, 'session ' + id + ' claiming ' + item.id);
  });
  return session;
}

function validateConsumer(consumer) {
  const value = String(consumer || '').trim();
  if (!CONSUMERS.includes(value)) {
    throw new RuntimeContractError('INVALID_CONSUMER',
      'consumer must be one of: ' + CONSUMERS.join(', '), { consumer: value });
  }
  return value;
}

function supports(capabilities, id) {
  return normalizeCapabilities(capabilities).some((item) => item.id === id);
}

module.exports = {
  CAPABILITIES,
  CONSUMERS,
  RuntimeContractError,
  normalizeCapability,
  normalizeCapabilities,
  capabilityMap,
  validateAdapter,
  validateSession,
  validateConsumer,
  supports,
};
