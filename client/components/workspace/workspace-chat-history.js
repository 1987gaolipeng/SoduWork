/* Pure history reconciliation, shared by the sidebar and its contract tests. */
(function (global) {
  'use strict';
  const MAX_CHAT_ITEMS = 50;
  const HISTORY_GAP_GRACE_MS = 30000;
  const DRAFT_GRACE_MS = 120000;
  const CHAT_STATE = {
    starting: '正在启动', running: '正在执行', waiting: '等待你确认', completed: '已完成',
    failed: '执行失败', stopped: '已停止',
  };
  const CHAT_STATE_ALIAS = {
    queued: 'starting', streaming: 'running', working: 'running', compacting: 'running',
    'waiting-user': 'waiting', paused: 'waiting', idle: 'completed', done: 'completed',
    archived: 'completed', released: 'completed',
    error: 'failed', unreachable: 'failed', incomplete: 'failed', 'no-output': 'failed',
    cancelled: 'stopped', aborted: 'stopped',
  };
  function chatState(item) {
    if (item && item.pending) return 'starting';
    /* Runner and cloud adapters historically used `status` while the Pi
       history bridge uses `state`. Prefer the canonical state but accept the
       legacy field so an active cloud session cannot look completed in the
       sidebar (and become deletable while it is still running). */
    const raw = String(item && (item.state || item.status) || '');
    const normalized = CHAT_STATE_ALIAS[raw] || raw;
    return CHAT_STATE[normalized] ? normalized : 'completed';
  }

  function _chatAt(item) { return Number(item && (item.at || item.updatedAt || item.createdAt) || 0); }
  function _chatUiKey(item, previous) {
    const kept = String(previous && previous._uiKey || item && item._uiKey || '');
    if (kept) return kept;
    const local = String(item && item.localId || '');
    if (local) return 'draft:' + local;
    const id = String(item && item.id || '');
    return id ? 'chat:' + id : '';
  }
  function _withChatUiKey(item, previous) {
    const row = { ...(item || {}) };
    const key = _chatUiKey(row, previous);
    if (key) row._uiKey = key;
    return row;
  }
  function _sameDraft(draft, real) {
    if (!draft || !real) return false;
    const direct = String(draft.id || '') && String(draft.id) === String(real.id || '');
    if (direct) return true;
    if (!draft.pending || String(draft.title || '') !== String(real.title || '')) return false;
    return Math.abs(_chatAt(real) - _chatAt(draft)) <= DRAFT_GRACE_MS;
  }
  function _settleDraft(draft, real) {
    const merged = _withChatUiKey({ ...draft, ...real, id: real.id, pending: false }, draft);
    delete merged.localId;
    return merged;
  }
  function _reconcileChats(current, items, now) {
    const clock = Number(now || Date.now());
    const incoming = (items || []).filter((item) => item && item.id);
    const used = new Set();
    const stable = [];
    (current || []).forEach((row) => {
      let found = incoming.find((item) => !used.has(String(item.id)) &&
        String(item.id) === String(row && row.id || ''));
      if (!found && row && row.pending) {
        found = incoming.find((item) => !used.has(String(item.id)) && _sameDraft(row, item));
      }
      if (found) {
        used.add(String(found.id));
        const merged = row && row.pending ? _settleDraft(row, found)
          : _withChatUiKey({ ...row, ...found, pending: false }, row);
        delete merged._missingAt;
        stable.push(merged);
      } else if (row) {
        const state = chatState(row);
        const grace = row.pending || state === 'starting' || state === 'running' || state === 'waiting'
          ? DRAFT_GRACE_MS : HISTORY_GAP_GRACE_MS;
        const missingAt = Number(row._missingAt || clock);
        if ((row.pending && clock - _chatAt(row) < DRAFT_GRACE_MS) || clock - missingAt < grace) {
          stable.push(_withChatUiKey({ ...row, _missingAt: missingAt }, row));
        }
      }
    });
    const fresh = incoming.filter((item) => !used.has(String(item.id)))
      .sort((a, b) => _chatAt(b) - _chatAt(a))
      .map((item) => _withChatUiKey({ ...item, pending: false }));
    if (!(current || []).length) return fresh.slice(0, MAX_CHAT_ITEMS);

    /*
     * History pages contain at most 50 records. Preserve existing row positions, move
     * genuinely updated conversations to the top, and append older history without truncating
     * visible records.
     */
    const newestVisibleAt = Math.max(0, ...(current || []).map(_chatAt));
    const promoted = fresh.filter((item) => _chatAt(item) > newestVisibleAt);
    const promotedIds = new Set(promoted.map((item) => String(item.id)));
    const next = promoted.concat(stable);
    for (const item of fresh) {
      if (next.length >= MAX_CHAT_ITEMS) break;
      if (!promotedIds.has(String(item.id))) next.push(item);
    }
    return next.slice(0, MAX_CHAT_ITEMS);
  }
  function _upsertChatItems(current, item) {
    if (!item) return (current || []).slice(0, MAX_CHAT_ITEMS);
    const rows = (current || []).slice();
    let index = rows.findIndex((row) => {
      const direct = String(item.id || '') && String(row && row.id || '') === String(item.id);
      const local = String(item.localId || '') &&
        String(row && (row.localId || row.id) || '') === String(item.localId);
      return direct || local;
    });
    if (index < 0 && item.id) index = rows.findIndex((row) => _sameDraft(row, item));
    if (index < 0) return [_withChatUiKey(item), ...rows].slice(0, MAX_CHAT_ITEMS);
    rows[index] = rows[index] && rows[index].pending && item.id
      ? _settleDraft(rows[index], item)
      : _withChatUiKey({ ...rows[index], ...item }, rows[index]);
    return rows.slice(0, MAX_CHAT_ITEMS);
  }

  global.WorkspaceChatHistory = { MAX_CHAT_ITEMS, CHAT_STATE, chatState, _chatAt, _chatUiKey, _withChatUiKey, _sameDraft, _settleDraft, _reconcileChats, _upsertChatItems };
})(window);
