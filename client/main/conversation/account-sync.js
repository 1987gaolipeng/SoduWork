'use strict';

const crypto = require('node:crypto');
const { fetchWithDeviceAuthRetry, accountScopeKey } = require('../device-auth-request');

const MAX_TEXT = 200000;
const MAX_MESSAGES = 1000;

function safeText(value, limit = MAX_TEXT) {
  return String(value == null ? '' : value).slice(0, limit);
}

function sourceMessage(sessionId, item, position) {
  const role = item && (item.role === 'assistant' || item.role === 'user') ? item.role : '';
  if (!role) return null;
  const text = safeText(item.text ?? item.content);
  const createdAt = Number(item.sentAt || item.createdAt || Date.now());
  const id = safeText(item.id || `${sessionId}:${position}:${role}`, 240);
  return { id, position, role, text, deleted: item.deleted === true, done: item.done === true,
    createdAt: Number.isFinite(createdAt) ? new Date(createdAt).toISOString() : new Date().toISOString() };
}

function snapshot(handle) {
  const sessionId = safeText(handle.sessionId, 180);
  const raw = typeof handle.snapshot === 'function' ? handle.snapshot() : {};
  const rows = Array.isArray(raw.messages) ? raw.messages.slice(0, MAX_MESSAGES) : [];
  const messages = rows.map((item, index) => sourceMessage(sessionId, item, index)).filter(Boolean);
  const history = typeof handle.historyRow === 'function' ? handle.historyRow(raw) : {};
  const title = safeText(history && history.title || raw.title || '本地会话', 200);
  const state = safeText(raw.status || history && history.state || 'idle', 24) || 'idle';
  return { sessionId, title, state, messages };
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function create({ app, identityOf, localIdentityOf, store, retryMs = 5000,
  fetch = fetchWithDeviceAuthRetry, now = () => Date.now(), realtime = false }) {
  const bound = new Map();
  let closed = false;
  let timer = null;
  let flushing = null;
  const accountIds = new Set();
  const listeners = new Set();
  let socket = null;
  let socketScope = '';
  let socketTimer = null;
  let socketAttempt = 0;
  let socketGeneration = 0;
  let reconcileTimer = null;

  function identityKey(identity) {
    try { return accountScopeKey(identity); } catch (_) { return ''; }
  }

  function endpoint(identity, route) {
    const hub = String(identity && identity.hub || '').replace(/\/+$/, '');
    if (!hub || !identity.clientId || !identity.session) throw Error('请先登录 SoduWork 后再同步本地会话');
    return hub + '/api/v1' + route;
  }

  function schedule() {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, retryMs);
    if (timer.unref) timer.unref();
  }

  function emitChanged(id) {
    for (const listener of listeners) {
      try { listener(String(id || '')); } catch (_) {}
    }
  }

  function stopRealtime() {
    ++socketGeneration;
    if (socketTimer) clearTimeout(socketTimer);
    socketTimer = null;
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = null;
    socketScope = '';
    const current = socket;
    socket = null;
    try { current?.close(); } catch (_) {}
  }

  function scheduleReconcile() {
    if (!realtime || closed || reconcileTimer) return;
    reconcileTimer = setTimeout(async () => {
      reconcileTimer = null;
      try { await history(); } catch (_) {}
      scheduleReconcile();
    }, 30000);
    reconcileTimer.unref?.();
  }

  function scheduleRealtime(identity, generation) {
    if (!realtime || closed || generation !== socketGeneration || socketTimer) return;
    const seconds = Math.min(30, Math.max(1, 1 << Math.min(socketAttempt, 5)));
    socketAttempt = Math.min(socketAttempt + 1, 8);
    socketTimer = setTimeout(() => {
      socketTimer = null;
      connectRealtime(identity).catch(() => {});
    }, seconds * 1000);
    socketTimer.unref?.();
  }

  async function connectRealtime(identity) {
    if (!realtime || closed || typeof WebSocket !== 'function') return;
    const scope = identityKey(identity) + ':' + String(identity?.clientId || '');
    if (!scope || (socket && socketScope === scope)) return;
    stopRealtime();
    const generation = socketGeneration;
    let url;
    try {
      url = new URL('/api/v1/ws', String(identity.hub));
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('device', String(identity.clientId || ''));
    } catch (_) { return; }
    let current;
    try { current = new WebSocket(url); } catch (_) { scheduleRealtime(identity, generation); return; }
    socket = current;
    socketScope = scope;
    current.onopen = () => {
      if (closed || generation !== socketGeneration || socket !== current) return;
      socketAttempt = 0;
      scheduleReconcile();
      current.send(JSON.stringify({ t: 'auth', device: identity.clientId, session: identity.session }));
    };
    current.onmessage = event => {
      if (closed || generation !== socketGeneration || socket !== current) return;
      let value;
      try { value = JSON.parse(String(event.data || '')); } catch (_) { return; }
      if (value?.type !== 'account-conversation') return;
      history().then(() => emitChanged(value.conversationId)).catch(() => {});
    };
    current.onerror = () => { try { current.close(); } catch (_) {} };
    current.onclose = () => {
      if (socket === current) socket = null;
      if (!closed && generation === socketGeneration) scheduleRealtime(identity, generation);
    };
  }

  function bind(handle, identity, options = {}) {
    if (!handle || !identity || closed) return null;
    const sourceSessionId = safeText(handle.sessionId, 180);
    if (!sourceSessionId) throw Error('本地会话标识无效');
    const ownerKey = identityKey(identity);
    if (!ownerKey) throw Error('当前账号身份无效');
    const key = ownerKey + ':' + sourceSessionId;
    const previous = store.session(key) || {};
    const state = { handle, identity: { ...identity }, key, ownerKey,
      sourceEpoch: safeText(previous.sourceEpoch || sourceSessionId + ':desktop', 180),
      sourceRevision: Number(previous.sourceRevision || 0), digest: previous.digest || '', dispose: null };
    bound.set(key, state);
    connectRealtime(state.identity).catch(() => {});
    scheduleReconcile();
    handle.accountSync = { state: 'pending', sourceSessionId, ownerKey };
    const record = () => {
      try { enqueue(state); } catch (error) { handle.accountSync = { ...handle.accountSync, state: 'error', reason: error.message }; }
    };
    if (typeof handle.on === 'function') {
      try { state.dispose = handle.on(() => { record(); schedule(); }); } catch (_) {}
    }
    record();
    return state;
  }

  function enqueue(state) {
    const view = snapshot(state.handle);
    const body = { sourceClientId: state.identity.clientId, sourceSessionId: view.sessionId,
      sourceEpoch: state.sourceEpoch, sourceRevision: state.sourceRevision + 1,
      title: view.title, state: view.state, archived: false, deleted: false, messages: view.messages };
    const nextDigest = digest(body);
    if (nextDigest === state.digest) return;
    state.sourceRevision = body.sourceRevision;
    state.digest = nextDigest;
    store.setSession(state.key, { sourceEpoch: state.sourceEpoch, sourceRevision: state.sourceRevision, digest: nextDigest,
      hub: state.identity.hub, clientId: state.identity.clientId, ownerKey: state.ownerKey });
    store.enqueue({ id: state.key + ':' + body.sourceRevision + ':' + nextDigest.slice(0, 12), ownerKey: state.ownerKey,
      hub: state.identity.hub, clientId: state.identity.clientId, body, createdAt: now() });
    if (state.handle.accountSync) state.handle.accountSync = { ...state.handle.accountSync, state: 'queued', sourceRevision: body.sourceRevision };
  }

  async function send(job, identity) {
    const response = await fetch(identity, endpoint(identity, '/account-conversations/sync'), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(job.body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true || data.sourceRevision !== job.body.sourceRevision || !data.conversationId) {
      const error = Error(typeof data.detail === 'string' ? data.detail : '本地会话同步未确认');
      error.status = response.status; throw error;
    }
    return data;
  }

  async function flush() {
    if (closed) return { ok: false, closed: true };
    if (flushing) return flushing;
    flushing = (async () => {
      for (const state of bound.values()) {
        try { enqueue(state); } catch (_) {}
      }
      const jobs = store.jobs();
      for (const job of jobs) {
        const state = [...bound.values()].find(item => item.ownerKey === job.ownerKey && item.identity.clientId === job.clientId);
        let identity = state && state.identity;
        if (!identity && typeof identityOf === 'function') {
          try { identity = await identityOf(app); } catch (_) { identity = null; }
          if (!identity || identityKey(identity) !== job.ownerKey || identity.clientId !== job.clientId) continue;
        }
        if (!identity) continue;
        try {
          await send(job, identity);
          store.ack(job.id);
          if (state && state.handle.accountSync) state.handle.accountSync = { ...state.handle.accountSync, state: 'synced', sourceRevision: job.body.sourceRevision };
        } catch (_) {
          store.fail(job.id);
          if (state && state.handle.accountSync) state.handle.accountSync = { ...state.handle.accountSync, state: 'queued' };
          schedule();
          break;
        }
      }
      const remaining = store.jobs();
      for (const state of bound.values()) {
        const waiting = remaining.some(job => job.ownerKey === state.ownerKey &&
          job.clientId === state.identity.clientId);
        if (!waiting && state.sourceRevision > 0 && state.handle.accountSync) {
          state.handle.accountSync = { ...state.handle.accountSync, state: 'synced',
            sourceRevision: state.sourceRevision };
        }
      }
      return { ok: remaining.length === 0, pending: remaining.length };
    })().finally(() => { flushing = null; });
    return flushing;
  }

  async function history() {
    if (closed) return { ok: false, chats: [] };
    const identity = typeof localIdentityOf === 'function'
      ? await localIdentityOf(app)
      : typeof identityOf === 'function' ? await identityOf(app) : null;
    if (!identity) return { ok: false, chats: [] };
    connectRealtime(identity).catch(() => {});
    const response = await fetch(identity, endpoint(identity, '/account-conversations?after=0&limit=100'), {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(data.items)) return { ok: false, chats: [] };
    const chats = data.items.filter(item => item && !item.deleted).map(item => ({
      id: item.id, title: item.title || '账号会话', at: item.updatedAt || '',
      state: item.state || 'idle', adapterId: 'account-sync', accountConversation: true,
      accountCanSend: item.canSend === true, sourceClientId: item.sourceClientId,
      sourceSessionId: item.sourceSessionId, locationMode: 'account', location: 'account', cloud: false,
    }));
    chats.forEach(item => accountIds.add(item.id));
    scheduleReconcile();
    return { ok: true, chats };
  }

  async function openProjection(id) {
    const wanted = safeText(id, 180);
    if (!wanted) return null;
    const identity = typeof identityOf === 'function' ? await identityOf(app) : null;
    if (!identity) return null;
    const base = endpoint(identity, '/account-conversations/' + encodeURIComponent(wanted) + '/messages');
    let after = 0;
    let metadata = null;
    const messages = [];
    for (let page = 0; page < 200; page++) {
      const response = await fetch(identity, base + '?after=' + after + '&limit=100', {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000) });
      const data = await response.json().catch(() => ({}));
      if (response.status === 404) return null;
      if (!response.ok || !data.conversation || !Array.isArray(data.items) || typeof data.cursor !== 'number') {
        throw Error('跨设备会话正文读取失败');
      }
      metadata = data.conversation;
      for (const item of data.items) {
        if (!item || typeof item.id !== 'string' || item.deleted) continue;
        const at = Date.parse(String(item.createdAt || ''));
        messages.push({ id: item.id, role: item.role, text: safeText(item.text), position: Number(item.position || 0),
          sentAt: Number.isFinite(at) ? at : now(), done: item.done === true });
      }
      if (messages.length > MAX_MESSAGES || messages.reduce((n, item) => n + item.text.length, 0) > 32 * 1024 * 1024) {
        throw Error('跨设备会话正文超过桌面端读取上限');
      }
      const next = data.cursor;
      if (next <= after || data.hasMore !== true) break;
      after = next;
    }
    if (!metadata || metadata.id !== wanted) return null;
    accountIds.add(wanted);
    const title = safeText(metadata.title || '账号会话', 200);
    const snapshotValue = {
      messages: messages.sort((a, b) => a.position - b.position),
      status: safeText(metadata.state || 'idle', 24),
      adapterId: 'account-sync', displayName: '账号会话',
      modelSelection: {}, execution: { accountConversation: true, readOnly: true },
      accessControl: { mode: 'readonly', capabilities: [] },
    };
    return {
      ref: 'account-view-' + wanted,
      sessionId: wanted,
      adapterId: 'account-sync', displayName: '账号会话', cwd: '',
      ui: { title, mode: 'readonly', selectedSkills: [], capabilities: [] },
      snapshot: () => snapshotValue,
      uiSnapshot: () => snapshotValue,
      historyRow: () => ({ id: wanted, title, state: snapshotValue.status, at: metadata.updatedAt || '',
        adapterId: 'account-sync', accountConversation: true, accountCanSend: metadata.canSend === true,
        sourceClientId: metadata.sourceClientId, sourceSessionId: metadata.sourceSessionId,
        locationMode: 'account', location: 'account' }),
      on: () => () => {},
      status: () => snapshotValue.status,
      inFlight: () => false,
      send: async () => ({ ok: false, accepted: false, reason: '跨设备会话是只读投影，请在来源设备继续' }),
      stop: async () => ({ ok: false, reason: '跨设备会话是只读投影' }),
      close: async () => true,
    };
  }

  async function close() {
    closed = true;
    stopRealtime();
    if (timer) clearTimeout(timer);
    for (const state of bound.values()) { try { state.dispose && state.dispose(); } catch (_) {} }
    bound.clear();
  }

  return { bind, flush, close, history, openProjection, onChange(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener); return () => listeners.delete(listener);
    }, isRemote: () => false,
    isAccountConversation: id => accountIds.has(String(id || '')), jobs: () => store.jobs() };
}

module.exports = { create };
