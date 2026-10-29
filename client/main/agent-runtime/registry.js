'use strict';

const {
  RuntimeContractError,
  validateAdapter,
  validateConsumer,
  validateSession,
} = require('./contract');

class AgentRuntimeRegistry {
  constructor() {
    this._adapters = new Map();
    this._descriptors = new Map();
    this._sessions = new Map();
  }

  register(adapter) {
    const descriptor = validateAdapter(adapter);
    if (this._adapters.has(descriptor.id)) {
      throw new RuntimeContractError('DUPLICATE_ADAPTER',
        'adapter already registered: ' + descriptor.id, { id: descriptor.id });
    }
    this._adapters.set(descriptor.id, adapter);
    this._descriptors.set(descriptor.id, descriptor);
    let disposed = false;
    return () => {
      if (disposed) return false;
      const active = [...this._sessions.values()].some((item) => item.adapterId === descriptor.id);
      if (active) {
        throw new RuntimeContractError('ADAPTER_IN_USE',
          'cannot unregister adapter with live sessions: ' + descriptor.id);
      }
      disposed = true;
      this._adapters.delete(descriptor.id);
      this._descriptors.delete(descriptor.id);
      return true;
    };
  }

  get(id) {
    return this._adapters.get(String(id || '')) || null;
  }

  describe(id) {
    return this._descriptors.get(String(id || '')) || null;
  }

  list() {
    return [...this._descriptors.values()];
  }

  acquire(id, consumer) {
    const adapterId = String(id || '');
    const adapter = this.get(adapterId);
    if (!adapter) {
      throw new RuntimeContractError('ADAPTER_NOT_FOUND',
        'agent runtime adapter is not registered: ' + adapterId, { id: adapterId });
    }
    return Object.freeze({
      adapter,
      descriptor: this.describe(adapterId),
      consumer: validateConsumer(consumer),
    });
  }

  async detect(id, context) {
    const adapter = this.get(id);
    if (!adapter) {
      throw new RuntimeContractError('ADAPTER_NOT_FOUND',
        'agent runtime adapter is not registered: ' + id, { id });
    }
    return adapter.detect(context || {});
  }

  async createSession(request) {
    return this._open('createSession', request);
  }

  async resumeSession(request) {
    return this._open('resumeSession', request);
  }

  async _open(method, request) {
    const value = request || {};
    const lease = this.acquire(value.adapterId, value.consumer);
    if (typeof lease.adapter[method] !== 'function') {
      throw new RuntimeContractError('CAPABILITY_UNAVAILABLE',
        lease.descriptor.displayName + ' does not support ' + method, {
          adapterId: lease.descriptor.id, method,
        });
    }
    let session;
    try {
      session = await lease.adapter[method](value);
      validateSession(session, lease.descriptor);
      const key = lease.descriptor.id + ':' + session.id;
      if (this._sessions.has(key)) {
        throw new RuntimeContractError('DUPLICATE_SESSION',
          'runtime session already exists: ' + key, { key });
      }
    } catch (error) {
      if (session && typeof session.dispose === 'function') {
        try { await session.dispose(); } catch (cleanupError) { /* preserve the contract failure */ }
      }
      throw error;
    }
    const key = lease.descriptor.id + ':' + session.id;
    const record = Object.freeze({
      adapterId: lease.descriptor.id,
      consumer: lease.consumer,
      descriptor: lease.descriptor,
      session,
    });
    this._sessions.set(key, record);
    return record;
  }

  session(adapterId, sessionId) {
    return this._sessions.get(String(adapterId) + ':' + String(sessionId)) || null;
  }

  async disposeSession(adapterId, sessionId) {
    const key = String(adapterId) + ':' + String(sessionId);
    const record = this._sessions.get(key);
    if (!record) return false;
    await record.session.dispose();
    this._sessions.delete(key);
    return true;
  }

  async dispose() {
    const rows = [...this._sessions.entries()];
    this._sessions.clear();
    await Promise.allSettled(rows.map(([, record]) => record.session.dispose()));
    this._adapters.clear();
    this._descriptors.clear();
  }
}

module.exports = { AgentRuntimeRegistry };
