(function (global) {
  'use strict';
  const states = { opening: '正在启动', sending: '正在发送', accepted: '已发送', failed: '发送失败', uncertain: '发送待确认' };
  function label(key, fallback) { return global.SoduWorkI18n?.t('workspace.firstSend.' + key, fallback) || fallback; }
  function status(row) { return label(row.status, states[row.status]); }
  function deliveryNote(row) {
    if (!row) return label('unavailable', '这条发送记录已不可用');
    if (row.status === 'uncertain' && !row.sessionId) return label('noReceipt', '尚未收到这条消息的发送回执。');
    return row.reason || status(row);
  }

  function create({ api, owner, repaint, openChat, openRecord, openDraft, associationState, fileProject, hasHistory }) {
    let rows = new Map(), loadedOwner = '', version = 0, off, detail;
    let applying = new Set();
    function close() {
      if (!detail) return;
      const pane = detail.pane;
      detail = null;
      pane.remove();
    }
    function clear() {
      ++version; rows.clear(); loadedOwner = ''; applying = new Set(); close();
      off?.(); off = null;
    }
    async function recoverAssociations(source, scope, generation) {
      if (!source.firstSendAssociations || !source.ackFirstSendAssociations) return;
      const active = applying, current = () => active === applying && scope === owner();
      const result = await source.firstSendAssociations();
      if (!current() || generation !== version || !result?.ok || !Array.isArray(result.rows)) return;
      for (const row of result.rows) {
        if (!current()) return;
        if (!row?.intentId || !row.sessionId || !row.sidebarProjectId || active.has(row.intentId)) continue;
        const state = associationState?.(row.sessionId);
        if (state === 'pending') continue;
        active.add(row.intentId);
        try {
          if (state !== 'hidden' && fileProject?.(row) !== true) continue;
          if (!current()) return;
          await source.ackFirstSendAssociations(row.intentId, row.sessionId);
          if (current()) repaint();
        } catch { /* Other confirmed requests can proceed if this acknowledgement fails. */ }
        finally { active.delete(row.intentId); }
      }
    }
    async function refresh() {
      const source = api(), scope = owner();
      if (!scope || !source?.firstSends) return;
      if (!off) off = source.onFirstSendsChanged?.(refresh);
      const generation = ++version;
      let reply;
      try { reply = await source.firstSends(); } catch { return; }
      if (scope !== owner() || generation !== version || !reply?.ok || !Array.isArray(reply.rows)) return;
      loadedOwner = scope;
      rows = new Map(reply.rows.filter(row => row?.intentId && Object.hasOwn(states, row.status))
        .map(row => [row.intentId, row]));
      if (detail?.pane.isConnected && detail.scope === scope) detail.paint(rows.get(detail.id), true);
      else if (detail?.pane.isConnected) close();
      else detail = null;
      repaint();
      try { await recoverAssociations(source, scope, generation); } catch { /* Retry on a later history refresh. */ }
    }
    function recent(known, isHidden) {
      if (loadedOwner !== owner()) return [];
      const ids = new Set(known.flatMap(row => [row.id, ...(row.historyAliasIds || [])]));
      return [...rows.values()].filter(row => !row.sessionId || (!isHidden(row.sessionId) &&
        (row.status !== 'accepted' || !ids.has(row.sessionId)))).map(row => ({
        localId: row.intentId, firstSend: row, title: row.title, at: row.at, count: 0,
        state: ({ opening: 'starting', sending: 'running', accepted: 'completed', failed: 'failed', uncertain: 'waiting' })[row.status],
      })).sort((a, b) => b.at - a.at);
    }
    function show(id) {
      if (loadedOwner === owner() && rows.has(id)) return openRecord(id);
    }
    function mount(id, host) {
      close();
      const scope = owner(), navigation = global.WorkspaceNavigation?.generation;
      const initial = loadedOwner === scope ? rows.get(id) : undefined;
      const pane = document.createElement('section');
      pane.className = 'nchat';
      pane.dataset.firstSendRecord = id;
      pane.append(global.ChatDomPatch.htmlFragment(
        '<div class="nchat-stage"><div class="nchat-main">' +
        '<header class="nchat-head"><div class="nchat-head-title"><span><b data-send-title data-user-content></b></span></div></header>' +
        '<div class="nchat-content-area"><div class="nchat-scroll" tabindex="0"><div class="nchat-inner">' +
        '<div class="nmsg user"><div class="nbubble" data-user-content></div><small data-send-files data-user-content></small>' +
        '<div class="nstatus show" role="status"></div></div></div></div></div></div></div>'));
      const title = pane.querySelector('[data-send-title]'), text = pane.querySelector('.nbubble'), files = pane.querySelector('[data-send-files]'),
        message = pane.querySelector('[role="status"]');
      let confirmedChat, opened = false;
      function paint(row, fresh) {
        if (row?.status === 'accepted' && row.confirmed && row.sessionId)
          confirmedChat = { status: 'accepted', sessionId: row.sessionId };
        else if (row) confirmedChat = undefined;
        const value = row || (confirmedChat && hasHistory?.(confirmedChat.sessionId) ? confirmedChat : undefined);
        title.textContent = value?.title || '';
        text.textContent = value?.text || ''; text.hidden = !text.textContent;
        files.textContent = (value?.attachmentNames || []).join(' · '); files.hidden = !files.textContent;
        message.textContent = deliveryNote(value);

        // Route only on a fresh journal read while the same sidebar selection owns the page.
        if (!fresh || !value || opened || detail?.pane !== pane || !pane.isConnected ||
            owner() !== scope || navigation !== global.WorkspaceNavigation?.generation ||
            row && initial && (row.attemptId || id) !== (initial.attemptId || id)) return;
        const known = Boolean(value.sessionId && hasHistory?.(value.sessionId));
        const state = value.status === 'failed' && global.NativeChat?.firstSendEditState?.(value, known);
        if (state === 'starter') {
          opened = true;
          return openDraft(value);
        }
        if (!value.sessionId) return;
        if (value.status === 'accepted' || value.status === 'uncertain' || state === 'occupied' ||
            state === 'editable' && global.NativeChat.restoreFirstSendForEdit(value, known)) {
          opened = true;
          return openChat(value);
        }
      }
      detail = { pane, id, scope, paint };
      host.replaceChildren(pane);
      paint(initial, false);
      void refresh();
      return true;
    }
    return { clear, refresh, recent, show, mount, get activeId() {
      return detail?.pane.isConnected ? detail.id :
        global.document?.querySelector('#cpChat [data-first-send-draft-id]')?.dataset.firstSendDraftId || '';
    } };
  }
  global.WorkspaceFirstSends = { create, status };
})(window);
