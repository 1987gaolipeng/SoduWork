'use strict';

const crypto = require('node:crypto');
const { fetchWithDeviceAuthRetry, accountScopeKey } = require('../device-auth-request');
const runtime = require('../platform-connections/runtime.cjs');

const MAX_TEXT = 200000;
const MAX_MESSAGES = 1000;

function safeText(value, limit = MAX_TEXT) {
  return String(value == null ? '' : value).slice(0, limit);
}

function messageText(item) {
  const directText = typeof item?.text === 'string' ? item.text : '';
  const directContent = typeof item?.content === 'string' ? item.content : '';
  if (directText) return directText;
  if (directContent) return directContent;
  const blocks = Array.isArray(item?.blocks) ? item.blocks :
    Array.isArray(item?.content) ? item.content : [];
  const blockText = blocks.filter(block => block && (!block.kind || block.kind === 'text'))
    .map(block => typeof block.text === 'string' ? block.text : block.content)
    .filter(value => typeof value === 'string').join('\n\n');
  return blockText || directText || directContent;
}

function syncState(value) {
  const state = String(value || '').trim().toLowerCase();
  if (['streaming', 'running', 'queued', 'starting', 'dispatching', 'waiting-user', 'responding'].includes(state)) return 'responding';
  if (['completed', 'done'].includes(state)) return 'completed';
  if (['aborted', 'canceled', 'cancelled', 'interrupted'].includes(state)) return 'interrupted';
  if (['unreachable', 'error', 'failed'].includes(state)) return 'failed';
  if (['stopped'].includes(state)) return 'stopped';
  return 'idle';
}

function sourceMessage(sessionId, item, position, messageTimes, now) {
  const role = item && (item.role === 'assistant' || item.role === 'user') ? item.role : '';
  if (!role) return null;
  // Pi stores visible assistant prose in text blocks; reasoning and tool
  // arguments must not become the cross-device reply body.
  const text = safeText(messageText(item));
  const id = safeText(item.id || `${sessionId}:${position}:${role}`, 240);
  const rawTime = item.sentAt ?? item.createdAt ?? item.completedAt ?? item.timestamp ?? item.at;
  const numericTime = typeof rawTime === 'number' ? rawTime :
    typeof rawTime === 'string' && rawTime.trim() && Number.isFinite(Number(rawTime))
      ? Number(rawTime) : NaN;
  const parsedTime = Number.isFinite(numericTime) ? numericTime
    : typeof rawTime === 'string' && rawTime.trim() ? Date.parse(rawTime) : NaN;
  // Legacy messages without a timestamp keep their first observed time across
  // polling and restarts; reading a transcript must not change its revision.
  const createdAt = Number.isFinite(parsedTime) && Math.abs(parsedTime) <= 8640000000000000
    ? parsedTime : messageTimes[id] ?? now();
  messageTimes[id] = createdAt;
  return { id, position, role, text, deleted: item.deleted === true, done: item.done === true,
    createdAt: new Date(createdAt).toISOString() };
}

function snapshot(handle, messageTimes, now) {
  const sessionId = safeText(handle.sessionId, 180);
  const raw = typeof handle.snapshot === 'function' ? handle.snapshot() : {};
  const rows = Array.isArray(raw.messages) ? raw.messages : [];
  // A silently truncated checkpoint is worse than a delayed checkpoint: the
  // Hub would retain an incomplete transcript and other devices could render
  // it as the source of truth. Refuse the snapshot and let the source device
  // report the bounded-sync error instead.
  if (rows.length > MAX_MESSAGES) throw Error('source conversation exceeds the sync message limit');
  const messages = rows.map((item, index) => sourceMessage(sessionId, item, index, messageTimes, now)).filter(Boolean);
  const history = typeof handle.historyRow === 'function' ? handle.historyRow(raw) : {};
  const title = safeText(history && history.title || raw.title || '本地会话', 200);
  const state = syncState(raw.status || history && history.state || 'idle');
  // A dedicated task view can have a native session id but no independent
  // transcript. Preserve its explicit binding instead of cloning the task.
  const taskIds = [...new Set([
    ...(Array.isArray(history?.taskIds) ? history.taskIds : []),
    history?.taskId, handle.taskRef,
  ].filter(Boolean).map(String))];
  const taskProjectionId = !handle.acceptanceSession && taskIds.length === 1 &&
    rows.every(item => String(item?.taskId || '') === taskIds[0]) ? taskIds[0] : '';
  return { sessionId, title, state, messages, taskProjectionId };
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isProjection(handle) {
  if (handle.passiveCloudView) return true;
  const view = typeof handle.snapshot === 'function' ? handle.snapshot() : {};
  return view?.execution?.accountConversation === true || view?.cloudHandoff?.phase === 'committed';
}

function historyRow(item, identity) {
  return {
    id: item.id, title: item.title || '账号会话', at: item.updatedAt || '',
    state: item.state || 'idle', adapterId: 'account-sync', accountConversation: true,
    accountProjection: true, owner: runtime.connectionScope(identity),
    accountCanSend: item.canSend === true, sourceClientId: item.sourceClientId,
    sourceSessionId: item.sourceSessionId, locationMode: 'account', location: 'account', cloud: false,
  };
}

function create({ app, identityOf, localIdentityOf, store, retryMs = 5000,
  fetch = fetchWithDeviceAuthRetry, now = () => Date.now(), realtime = false }) {
  const bound = new Map();
  let closed = false;
  let timer = null;
  let flushing = null;
  const accountIds = new Set();
  const accountRows = new Map();
  const listeners = new Set();
  let socket = null;
  let socketScope = '';
  let socketTimer = null;
  let socketAttempt = 0;
  let socketGeneration = 0;
  let reconcileTimer = null;
  let historyPromise = null;
  let historyAt = 0;
  let historyScope = '';
  const historyTtl = 3000;
  const historyPageSize = 100;
  const historyMaxPages = 20;

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

  function emitChanged(id, row, identity) {
    const presence = row ? historyRow(row, identity) : {
      id, deleted: true, accountConversation: true, owner: runtime.connectionScope(identity),
    };
    for (const listener of listeners) {
      try { listener(String(id || ''), row, presence); } catch (_) {}
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
      history({ force: true }).then(result => {
        // A completed refresh must still belong to the socket that requested it.
        if (!result.ok || closed || generation !== socketGeneration || socket !== current) return;
        emitChanged(value.conversationId, accountRows.get(String(value.conversationId || '')) || null, identity);
      }).catch(() => {});
    };
    current.onerror = () => { try { current.close(); } catch (_) {} };
    current.onclose = () => {
      if (socket === current) socket = null;
      if (!closed && generation === socketGeneration) scheduleRealtime(identity, generation);
    };
  }

  function bind(handle, identity, options = {}) {
    if (!handle || !identity || closed) return null;
    // Hub-owned transcripts already have an authoritative directory entry.
    // Observing one on a PC must not publish a second local conversation.
    if (isProjection(handle)) return null;
    const sourceSessionId = safeText(handle.sessionId, 180);
    if (!sourceSessionId) throw Error('本地会话标识无效');
    const ownerKey = identityKey(identity);
    if (!ownerKey) throw Error('当前账号身份无效');
    const key = ownerKey + ':' + sourceSessionId;
    const previous = store.session(key) || {};
    const state = { handle, identity: { ...identity }, key, ownerKey,
      sourceEpoch: safeText(previous.sourceEpoch || sourceSessionId + ':desktop', 180),
      messageTimes: Object.assign(Object.create(null), previous.messageTimes || {}),
      sourceRevision: Number(previous.sourceRevision || 0),
      // `digest` includes the revision for the request fence. The content
      // digest must stay independent of that fence, otherwise every event
      // appears to be a new snapshot even when the transcript is unchanged.
      contentDigest: previous.contentDigest || '', digest: previous.digest || '',
      recordTimer: null, dispose: null };
    bound.set(key, state);
    connectRealtime(state.identity).catch(() => {});
    scheduleReconcile();
    handle.accountSync = { state: 'pending', sourceSessionId, ownerKey };
    const record = () => {
      try { enqueue(state); } catch (error) { handle.accountSync = { ...handle.accountSync, state: 'error', reason: error.message }; }
    };
    if (typeof handle.on === 'function') {
      try {
        state.dispose = handle.on(() => {
          // Runner output can emit once per token/block. Coalesce those
          // notifications before serializing and persisting a full snapshot.
          if (state.recordTimer) clearTimeout(state.recordTimer);
          state.recordTimer = setTimeout(() => {
            state.recordTimer = null;
            record(); schedule();
          }, 200);
          state.recordTimer.unref?.();
        });
      } catch (_) {}
    }
    record();
    // Initial binding may discover an already populated local session. Ensure
    // that its first checkpoint is delivered even when no new UI event follows.
    schedule();
    return state;
  }

  function enqueue(state) {
    // A locally bound session can be handed off after the initial bind.
    if (isProjection(state.handle)) return;
    const view = snapshot(state.handle, state.messageTimes, now);
    const content = { sourceClientId: state.identity.clientId, sourceSessionId: view.sessionId,
      sourceEpoch: state.sourceEpoch, title: view.title, state: view.state,
      archived: false, deleted: false, snapshotComplete: true, messages: view.messages,
      taskProjectionId: view.taskProjectionId };
    const contentDigest = digest(content);
    if (contentDigest === state.contentDigest) return;
    const body = { ...content, sourceRevision: state.sourceRevision + 1 };
    const requestDigest = digest(body);
    state.sourceRevision = body.sourceRevision;
    state.contentDigest = contentDigest;
    state.digest = requestDigest;
    store.setSession(state.key, { sourceEpoch: state.sourceEpoch, sourceRevision: state.sourceRevision,
      contentDigest, digest: requestDigest,
      messageTimes: state.messageTimes,
      hub: state.identity.hub, clientId: state.identity.clientId, ownerKey: state.ownerKey });
    store.enqueue({ id: state.key + ':' + body.sourceRevision + ':' + requestDigest.slice(0, 12), ownerKey: state.ownerKey,
      hub: state.identity.hub, clientId: state.identity.clientId, body, createdAt: now() });
    if (state.handle.accountSync) state.handle.accountSync = { ...state.handle.accountSync, state: 'queued', sourceRevision: body.sourceRevision };
  }

  async function send(job, identity) {
    // Older outboxes may contain native states rejected by the Hub. Normalize
    // on every retry, preserving the source revision, epoch and message IDs.
    const body = { ...job.body, state: syncState(job.body.state) };
    const response = await fetch(identity, endpoint(identity, '/account-conversations/sync'), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
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
      // Login can become available after startup. Keep pending jobs durable
      // and retry without requiring another native conversation event.
      if (remaining.length) schedule();
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

  async function history({ force = false } = {}) {
    if (closed) return { ok: false, chats: [] };
    if (historyPromise) return historyPromise;
    const currentIdentity = () => typeof localIdentityOf === 'function'
      ? localIdentityOf(app) : typeof identityOf === 'function' ? identityOf(app) : null;
    const identity = await currentIdentity();
    if (!identity) return { ok: false, chats: [] };
    const scope = value => value ? String(value.hub || '').replace(/\/+$/, '') + '\0' + identityKey(value) : '';
    const currentScope = scope(identity);
    if (currentScope && currentScope !== historyScope) {
      accountRows.clear();
      accountIds.clear();
      historyAt = 0;
    }
    if (!force && currentScope === historyScope && now() - historyAt < historyTtl) {
      return { ok: true, chats: [...accountRows.values()].filter(item => item && !item.deleted)
        .map(item => historyRow(item, identity)) };
    }
    const captured = currentScope;
    const load = (async () => {
      connectRealtime(identity).catch(() => {});
      const items = [];
      let after = 0;
      for (let page = 0; page < historyMaxPages; page += 1) {
        const response = await fetch(identity,
          endpoint(identity, '/account-conversations?after=' + after + '&limit=' + historyPageSize), {
            method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000) });
        const data = await response.json().catch(() => ({}));
        if (closed || captured !== scope(await currentIdentity())) {
          return { ok: false, chats: [], reason: '账号或服务已切换' };
        }
        if (!response.ok || !Array.isArray(data.items)) return { ok: false, chats: [] };
        items.push(...data.items);
        if (data.hasMore !== true) break;
        const next = Number(data.cursor);
        if (!Number.isSafeInteger(next) || next <= after) {
          return { ok: false, chats: [], reason: '账号会话分页无效' };
        }
        after = next;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const latest = new Map(items.filter(item => item?.id).map(item => [String(item.id), item]));
      for (const [id, item] of latest) {
        if (item.deleted) {
          accountRows.delete(id);
          accountIds.delete(id);
        } else {
          accountRows.set(id, item);
          accountIds.add(id);
        }
      }
      const chats = [...latest.values()].filter(item => !item.deleted).map(item => historyRow(item, identity));
      historyAt = now();
      historyScope = currentScope;
      scheduleReconcile();
      return { ok: true, chats };
    })();
    historyPromise = load;
    try { return await load; }
    finally { if (historyPromise === load) historyPromise = null; }
  }

  async function row(id) {
    const wanted = safeText(id, 180);
    if (!wanted) return null;
    const cached = accountRows.get(wanted);
    if (cached) return cached;
    const identity = typeof localIdentityOf === 'function'
      ? await localIdentityOf(app)
      : typeof identityOf === 'function' ? await identityOf(app) : null;
    if (!identity) return null;
    const response = await fetch(identity,
      endpoint(identity, '/account-conversations/' + encodeURIComponent(wanted) + '/source'), {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000) });
    const data = await response.json().catch(() => ({}));
    if (response.status === 404) return null;
    if (!response.ok || !data.conversation) return null;
    accountRows.set(wanted, data.conversation);
    return data.conversation;
  }

  async function openProjection(id) {
    const wanted = safeText(id, 180);
    if (!wanted) return null;
    const identity = typeof identityOf === 'function' ? await identityOf(app) : null;
    if (!identity) return null;
    const base = endpoint(identity, '/account-conversations/' + encodeURIComponent(wanted) + '/messages');
    let metadata = null;
    let snapshotValue = null;
    let refreshPromise = null;
    async function refresh() {
      if (refreshPromise) return refreshPromise;
      refreshPromise = (async () => {
        let after = 0;
        let nextMetadata = null;
        const messages = [];
        for (let page = 0; page < 200; page++) {
          const response = await fetch(identity, base + '?after=' + after + '&limit=100', {
            method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000) });
          const data = await response.json().catch(() => ({}));
          if (response.status === 404) return false;
          if (!response.ok || !data.conversation || !Array.isArray(data.items) || typeof data.cursor !== 'number') {
            throw Error('跨设备会话正文读取失败');
          }
          nextMetadata = data.conversation;
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
        if (!nextMetadata || nextMetadata.id !== wanted) return false;
        metadata = nextMetadata;
        accountIds.add(wanted);
        accountRows.set(wanted, metadata);
        snapshotValue = {
          messages: messages.sort((a, b) => a.position - b.position),
          status: safeText(metadata.state || 'idle', 24),
          adapterId: 'account-sync', displayName: '账号会话',
          modelSelection: {}, execution: { accountConversation: true, readOnly: true },
          accessControl: { mode: 'readonly', capabilities: [] },
        };
        return true;
      })().finally(() => { refreshPromise = null; });
      return refreshPromise;
    }
    if (!await refresh()) return null;
    const title = () => safeText(metadata?.title || '账号会话', 200);
    return {
      ref: 'account-view-' + wanted,
      sessionId: wanted,
      adapterId: 'account-sync', displayName: '账号会话', cwd: '',
      ui: { get title() { return title(); }, mode: 'readonly', selectedSkills: [], capabilities: [] },
      snapshot: () => snapshotValue,
      uiSnapshot: () => snapshotValue,
      historyRow: () => historyRow({ ...metadata, id: wanted, title: title(), state: snapshotValue.status }, identity),
      refresh,
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

  if (store.jobs().length) schedule();
  return { bind, flush, close, history, row, openProjection, onChange(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener); return () => listeners.delete(listener);
    }, isRemote: () => false,
    isAccountConversation: id => accountIds.has(String(id || '')), jobs: () => store.jobs() };
}

module.exports = { create };
