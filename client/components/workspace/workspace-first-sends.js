(function (global) {
  'use strict';
  const states = { opening: '正在启动', sending: '正在发送', accepted: '已发送', failed: '发送失败', uncertain: '发送待确认' };
  function label(key, fallback) { return global.SoduWorkI18n?.t('workspace.firstSend.' + key, fallback) || fallback; }
  function status(row) { return label(row.status, states[row.status]); }

  function create({ api, owner, repaint, openChat, openRecord, associationState, fileProject, hasHistory }) {
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
      if (detail?.pane.isConnected && detail.scope === scope) detail.paint(rows.get(detail.id));
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
      if (loadedOwner !== owner()) return;
      const row = rows.get(id);
      if (!row) return;
      if (row.status === 'accepted' && row.sessionId) { openChat(row); return; }
      openRecord(id);
    }
    function mount(id, host) {
      close();
      const scope = owner(), pane = document.createElement('section');
      pane.className = 'nchat';
      pane.dataset.firstSendRecord = id;
      pane.append(global.ChatDomPatch.htmlFragment('<div class="nchat-main"><div class="nchat-scroll" tabindex="0"><div class="nchat-inner">' +
        '<div class="nmsg user"><div class="nbubble" data-user-content></div><small data-send-files data-user-content></small></div>' +
        '<div class="nmsg ai"><p role="status"></p><div class="ws-first-send-actions">' +
        '<button type="button" data-send-action></button><button type="button" data-send-copy></button><button type="button" data-send-dismiss></button></div></div></div></div></div>'));
      const user = pane.querySelector('.nmsg.user'), text = pane.querySelector('.nbubble'),
        files = pane.querySelector('[data-send-files]'), message = pane.querySelector('[role="status"]'),
        action = pane.querySelector('[data-send-action]'), copy = pane.querySelector('[data-send-copy]'), dismiss = pane.querySelector('[data-send-dismiss]');
      const current = () => detail?.pane === pane && pane.isConnected && owner() === scope;
      let confirmDismiss = null, confirmedChat;
      const catalogChat = () => confirmedChat && hasHistory?.(confirmedChat.sessionId) ? confirmedChat : undefined;
      function editState(value) {
        return global.NativeChat?.firstSendEditState?.(value, Boolean(hasHistory?.(value.sessionId))) || '';
      }
      function paint(value) {
        if (value?.status === 'accepted' && value.confirmed && value.sessionId)
          confirmedChat = { status: 'accepted', sessionId: value.sessionId };
        else if (value) confirmedChat = null;
        value ||= catalogChat();
        if (!value) {
          user.hidden = true; text.textContent = ''; files.textContent = '';
          action.hidden = true; copy.hidden = true; dismiss.hidden = true; confirmDismiss = null;
          message.textContent = label('unavailable', '这条发送记录已不可用');
          return;
        }
        if (confirmDismiss && (confirmDismiss.attemptId !== (value.attemptId || id) || confirmDismiss.status !== value.status))
          confirmDismiss = null;
        text.textContent = value.text || '';
        files.textContent = (value.attachmentNames || []).join(' · '); files.hidden = !files.textContent;
        user.hidden = !text.textContent && !files.textContent;
        const state = editState(value);
        const hint = state === 'occupied' ? label('existingDraft', '原会话里已有未发送的草稿') :
          state === 'reselect' ? label('reselect', '请复制原文，在新会话中重新选择所需附件或能力后发送') : '';
        message.textContent = [status(value), value.reason, hint].filter(Boolean).join(' · ');
        const inspect = value.sessionId && (['accepted', 'uncertain'].includes(value.status) || state === 'occupied');
        const retry = value.status === 'failed' && !value.canAttachFailed && value.canRetry;
        action.hidden = !(state === 'editable' || inspect || retry);
        action.textContent = state === 'editable' ? label('edit', '编辑后发送') : inspect ? label('open', '打开会话') : label('retry', '重试发送');
        copy.hidden = !(value.status === 'failed' && value.text && global.navigator?.clipboard);
        copy.textContent = label('copy', '复制原文');
        dismiss.hidden = !['failed', 'uncertain'].includes(value.status);
        dismiss.textContent = confirmDismiss ? label('confirmDismiss', '确认移除') : label('dismiss', '移除发送记录');
      }
      detail = { pane, id, scope, paint };
      copy.onclick = async () => {
        const value = rows.get(id);
        if (!current() || value?.status !== 'failed' || !value.text) return;
        try { await global.navigator.clipboard.writeText(value.text); }
        catch (error) { if (current()) message.textContent = error.message; }
      };
      dismiss.onclick = async () => {
        const value = rows.get(id);
        if (!current() || !value || dismiss.disabled || !['failed', 'uncertain'].includes(value.status)) return;
        if (!confirmDismiss) {
          confirmDismiss = { attemptId: value.attemptId || id, status: value.status };
          paint(value); return;
        }
        const confirmation = confirmDismiss;
        confirmDismiss = null;
        paint(value);
        dismiss.disabled = true;
        try {
          const result = await api().dismissFirstSend(id, confirmation.attemptId, confirmation.status);
          if (!current()) return;
          await refresh();
          if (current() && !result?.ok) message.textContent = result?.reason || status(value);
        } catch (error) { if (current()) message.textContent = error.message; }
        finally { if (current()) dismiss.disabled = false; }
      };
      action.onclick = async () => {
        const value = rows.get(id) || catalogChat();
        if (!current() || !value || action.disabled) return;
        action.disabled = true;
        try {
          if (value.sessionId && ['accepted', 'uncertain'].includes(value.status)) { openChat(value); return; }
          if (value.status !== 'failed') return;
          if (value.canAttachFailed) {
            const reply = await api().firstSends();
            if (!current()) return;
            const displayed = rows.get(id);
            if (displayed?.status !== value.status || displayed.attemptId !== value.attemptId ||
                displayed.sessionId !== value.sessionId) return;
            const fresh = reply?.ok && reply.rows?.find(row => row.intentId === id);
            if (!fresh || fresh.status !== 'failed' || !fresh.canAttachFailed || fresh.attemptId !== value.attemptId ||
                fresh.sessionId !== value.sessionId) { await refresh(); return; }
            const state = editState(fresh);
            if (state === 'occupied' || state === 'editable' &&
                global.NativeChat.restoreFirstSendForEdit(fresh, Boolean(hasHistory?.(fresh.sessionId)))) await openChat(fresh);
            else paint(fresh);
            return;
          }
          if (!value.canRetry) return;
          const result = await api().retryFirstSend(id, value.attemptId || id);
          if (!current()) return;
          await refresh();
          if (current() && !result?.ok) message.textContent = result?.reason || label('failed', states.failed);
        } catch (error) { if (current()) message.textContent = error.message || label('failed', states.failed); }
        finally { if (current()) action.disabled = false; }
      };
      paint(loadedOwner === scope ? rows.get(id) : undefined); host.replaceChildren(pane);
      return true;
    }
    return { clear, refresh, recent, show, mount, get activeId() { return detail?.pane.isConnected ? detail.id : ''; } };
  }
  global.WorkspaceFirstSends = { create, status };
})(window);
