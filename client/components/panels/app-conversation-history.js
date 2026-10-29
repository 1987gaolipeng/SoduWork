/* App navigation uses the same account-scoped sidebar groups and NativeChat archives. */
(function (global) {
  'use strict';
  if (global.__deskPanel !== 'chatbar') return;
  const native = global.soduWorkAPI || global.SoduWorkAPI;
  let application = null, store = null, scope = '', root = null, dialog = null;
  let generation = 0, busy = false, initialization = Promise.resolve();
  // Read-only projection of the existing runtime presence; never persist running state.
  const presence = new Map();
  let presenceRevision = 0, offPresence = null;
  const accountApi = () => global.SoduWorkAPI || global.soduWorkAPI;
  const key = () => global.WorkspaceSidebarState.storageKey(accountApi());
  const signedIn = () => !accountApi()?.clientAuthSnapshot || !!accountApi().clientAuthSnapshot()?.user?.id;
  const current = () => !!application && !!store && signedIn() && scope === key();
  const chat = () => global.NativeChat;
  const historyApi = () => native?.conversationSession || native?.piSession;
  function controls() {
    root?.querySelectorAll('[data-app-chat-history],[data-app-chat-history-title],[data-app-chat-new]').forEach(button => {
      button.disabled = busy || !current();
    });
    renderActive();
    renderHistory();
  }
  function error(message) {
    if (!root) return;
    let status = root.querySelector('.app-chat-history-error');
    if (!status) {
      status = document.createElement('div'); status.className = 'app-chat-history-error'; status.role = 'status';
      root.appendChild(status);
    }
    status.textContent = String(message || '操作没有完成，请重试');
  }
  function clearError() { root?.querySelector('.app-chat-history-error')?.remove(); }
  function group() {
    if (!current()) return null;
    const saved = store.view([]).projects.find(p => p.appId === application.id);
    // Keep the existing group order and creation metadata while projecting live status.
    return saved ? { ...saved, items: saved.items.map(row => ({ ...row, ...presence.get(row.id)?.row })) } : null;
  }
  function identified(id, title) {
    if (!current() || !id) return;
    try {
      store.recordAppChat(application.id, application.name, { id, title: title || '新对话' }, application.icon);
      renderActive();
      renderHistory();
    } catch (problem) { error(problem.message); }
  }
  function close() {
    const previous = dialog; dialog = null;
    if (previous) { if (previous.matches(':popover-open')) previous.hidePopover(); previous.remove(); }
    root?.querySelectorAll('[data-app-chat-history],[data-app-chat-history-title]').forEach(button => button.setAttribute('aria-expanded', 'false'));
  }
  function activeRows() {
    if (!current()) return [];
    return (group()?.items || []).flatMap(row => {
      const live = presence.get(row.id)?.row;
      const state = global.WorkspaceChatHistory.chatState(live);
      return live?.live === true && ['starting', 'running', 'waiting'].includes(state)
        ? [{ ...row, ...live, state, title: live.customTitle || row.customTitle || live.title || row.title }] : [];
    });
  }
  function renderActive() {
    const card = root?.querySelector('[data-app-active-chats]');
    if (!card) return;
    const rows = activeRows(), selected = chat()?.sessionInfo?.()?.sessionId;
    // A single active conversation needs a shortcut whenever it is off-screen.
    card.hidden = !rows.length || (rows.length === 1 && rows[0].id === selected);
    const list = card.querySelector('[data-app-active-list]');
    if (card.hidden) { list.replaceChildren(); return; }
    card.querySelector('[data-app-active-count]').textContent = String(rows.length);
    const existing = new Map([...list.children].map(button => [button.dataset.appActiveId, button]));
    rows.forEach((row, index) => {
      let button = existing.get(row.id);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.className = 'app-chat-active-row';
        button.dataset.appActiveId = row.id;
        button.innerHTML = '<i class="st-chat" aria-hidden="true"></i><span data-user-content></span><small></small>';
        button.onclick = () => { void select(row.id); };
      }
      existing.delete(row.id);
      const label = row.state === 'waiting' ? (row.status === 'queued' ? '等待执行' : '等待确认')
        : row.state === 'starting' ? '正在启动' : '进行中';
      const title = button.querySelector('span'), status = button.querySelector('small');
      if (title.textContent !== row.title) title.textContent = row.title;
      if (status.textContent !== label) status.textContent = label;
      button.title = row.title + ' · ' + label;
      button.dataset.state = row.state;
      paintIndicator(button, row);
      button.setAttribute('aria-current', String(row.id === selected));
      button.disabled = busy;
      if (list.children[index] !== button) list.insertBefore(button, list.children[index] || null);
    });
    existing.forEach(button => button.remove());
  }
  function receivePresence(event) {
    if (!current()) return;
    const row = event?.presence, id = String(event?.sessionId || row?.id || '');
    if (!id || !row) return;
    const before = presence.get(id)?.row;
    presence.set(id, { row: { ...row, id }, revision: ++presenceRevision });
    if (before && ['state', 'status', 'live', 'title', 'customTitle'].every(key => before[key] === row[key])) return;
    renderActive(); renderHistory();
  }
  async function refreshPresence() {
    const ticket = generation, revision = presenceRevision;
    const result = await historyApi()?.history();
    if (ticket !== generation || !current() || !result?.ok) return result;
    for (const row of result.chats || []) {
      if (row?.id && (presence.get(row.id)?.revision || 0) <= revision) {
        presence.set(row.id, { row, revision });
      }
    }
    store.remember(result.chats || []);
    renderActive(); renderHistory();
    return result;
  }
  async function select(id) {
    if (!current() || busy) return false;
    const row = group()?.items.find(item => item.id === id);
    if (!row) return false;
    const ticket = generation;
    busy = true; controls(); close(); clearError();
    try {
      const ok = await chat().enter('', row.id, { chatTitle: row.title });
      if (ticket !== generation || !current()) return false;
      if (!ok) throw Error('这条对话暂时无法打开，请重新选择或新建对话');
      identified(row.id, chat().sessionInfo().title || row.title);
      return true;
    } catch (problem) { if (ticket === generation && current()) error(problem.message); return false; }
    finally { if (ticket === generation) { busy = false; controls(); } }
  }
  function newChat() {
    if (!current() || busy) return;
    close(); clearError();
    // NativeChat.reset saves the old draft and releases its view; execution keeps its existing lifecycle.
    chat().reset(); chat().prepare(); controls();
    document.getElementById('nchatInput')?.focus();
  }
  function positionHistory() {
    const anchor = root?.querySelector('[data-app-chat-history]');
    if (!dialog || !anchor) return;
    const rect = anchor.getBoundingClientRect(), viewport = document.documentElement.clientWidth;
    const left = Math.max(12, Math.min(rect.left, viewport - 36)), width = Math.min(320, viewport - left - 12);
    dialog.style.setProperty('--app-history-width', width + 'px');
    dialog.style.setProperty('--app-history-left', left + 'px');
    dialog.style.setProperty('--app-history-top', rect.bottom + 10 + 'px');
    dialog.style.setProperty('--app-history-arrow', rect.left + rect.width / 2 - left + 'px');
  }
  function renderHistory() {
    if (!dialog || !current()) return;
    const body = dialog.querySelector('[data-app-history-list]');
    const existing = new Map([...body.querySelectorAll('[data-app-chat-id]')].map(button => [button.dataset.appChatId, button]));
    const rows = group()?.items || [], selected = chat()?.sessionInfo?.()?.sessionId;
    if (rows.length) body.querySelector('.app-chat-history-empty')?.remove();
    rows.slice().sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0)).forEach((row, index) => {
      let button = existing.get(row.id);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.className = 'app-chat-history-row';
        button.innerHTML = '<i class="st-chat" aria-hidden="true"></i><span data-user-content></span><time></time>';
        button.onclick = () => { void select(row.id); };
      }
      existing.delete(row.id);
      button.dataset.appChatId = row.id; button.setAttribute('aria-current', String(row.id === selected));
      button.disabled = busy;
      const title = button.querySelector('span'), label = row.customTitle || row.title;
      if (title.textContent !== label) title.textContent = label;
      const state = paintIndicator(button, row), fallback = global.WorkspaceChatHistory.CHAT_STATE[state];
      const status = global.SoduWorkI18n?.t('chat.state.' + state, fallback) || fallback;
      button.setAttribute('data-user-attributes', 'title aria-label');
      const separator = global.SoduWorkI18n?.getLocale() === 'en-US' ? ', ' : '，';
      button.title = label + ' · ' + status; button.setAttribute('aria-label', label + separator + status);
      const time = button.querySelector('time'), at = Number(row.updatedAt || row.createdAt || 0);
      if (at) { time.dateTime = new Date(at).toISOString(); time.textContent = new Date(at).toLocaleDateString(); }
      else { time.removeAttribute('datetime'); time.textContent = ''; }
      if (body.children[index] !== button) body.insertBefore(button, body.children[index] || null);
    });
    existing.forEach(button => button.remove());
    if (!rows.length && !body.children.length) { const empty = document.createElement('p'); empty.className = 'app-chat-history-empty'; empty.textContent = '还没有应用对话'; body.appendChild(empty); }
  }
  function paintIndicator(button, row) {
    const state = global.WorkspaceChatHistory.chatState(row);
    button.classList.remove('is-starting', 'is-running', 'is-waiting', 'is-completed', 'is-failed', 'is-stopped');
    button.classList.add('is-' + state); button.setAttribute('data-conversation-state', state);
    button.querySelector('.st-chat').className = 'st-chat st-chat-' + state;
    return state;
  }
  async function openHistory() {
    if (!current() || busy) return;
    if (dialog) { close(); return; }
    clearError();
    dialog = document.createElement('dialog'); dialog.className = 'app-chat-history-dialog'; dialog.popover = 'auto';
    dialog.setAttribute('aria-label', '历史对话');
    dialog.innerHTML = '<header><b>历史对话</b><button type="button" aria-label="关闭" data-app-history-close>×</button></header><div data-app-history-list></div>';
    dialog.querySelector('[data-app-history-close]').onclick = close;
    const popup = dialog;
    popup.addEventListener('toggle', event => {
      if (event.newState === 'closed' && dialog === popup) close();
    });
    document.body.appendChild(dialog); positionHistory(); renderHistory(); dialog.showPopover();
    root?.querySelectorAll('[data-app-chat-history],[data-app-chat-history-title]').forEach(button => button.setAttribute('aria-expanded', 'true'));
    const ticket = generation;
    try {
      const result = await refreshPresence();
      if (ticket !== generation || !current()) return;
      if (!result?.ok) throw Error(result?.reason || '历史记录刷新失败，请重试');
      // A limited inventory refreshes known titles only; missing rows are never inferred to be deleted.
      renderHistory();
    } catch (problem) { if (ticket === generation && current()) error(problem.message); }
  }
  function bind(nextRoot) {
    root = nextRoot;
    const header = root?.querySelector('.nchat-head');
    if (header && !root.querySelector('[data-app-active-chats]')) {
      const card = document.createElement('section'); card.className = 'app-chat-active'; card.hidden = true;
      card.setAttribute('data-app-active-chats', ''); card.setAttribute('aria-label', '正在进行的对话');
      card.innerHTML = '<header><b>正在进行</b><span data-app-active-count></span></header><div data-app-active-list></div>';
      header.after(card);
    }
    const history = root?.querySelector('[data-app-chat-history]'), add = root?.querySelector('[data-app-chat-new]');
    if (history) history.onclick = () => { void openHistory(); };
    const title = root?.querySelector('[data-app-chat-history-title]');
    if (title) title.onclick = () => { void openHistory(); };
    if (add) add.onclick = newChat;
    controls();
  }
  function start(hello, ready) {
    const ticket = ++generation;
    initialization = Promise.all([hello, ready]).then(async ([result]) => {
      if (ticket !== generation || !result?.ok || !result.application?.id || !signedIn()) return;
      application = result.application; scope = key();
      store = global.WorkspaceSidebarState.create(global.WorkspaceSidebarState.accountOptions({ storage: localStorage, api: accountApi() }));
      if (!offPresence) {
        const api = historyApi();
        offPresence = api?.onEventBatch ? api.onEventBatch(receivePresence, { presenceOnly: true }) : api?.onEvent?.(receivePresence);
      }
      void refreshPresence().catch(() => { /* Runtime events remain authoritative when inventory is unavailable. */ });
      controls();
      const active = chat()?.sessionInfo?.();
      if (active?.sessionId) { identified(active.sessionId, active.title); return; }
      const saved = group(), id = saved?.lastChatId || saved?.items[0]?.id;
      if (id) await select(id);
    }).catch(problem => { if (ticket === generation) error(problem.message); });
    return initialization;
  }
  global.addEventListener('soduwork-data-scope-changed', () => {
    if (!application) return;
    generation++; close(); offPresence?.(); offPresence = null; presence.clear(); presenceRevision = 0;
    application = null; store = null; scope = ''; busy = false;
    chat()?.reset(); chat()?.prepare(); controls();
  });
  global.addEventListener('soduwork-device-auth', event => {
    if (!application && global.__soduWorkChatbarReady && event.detail?.state === 'active') {
      void start(native.workPreview.composerHello(), Promise.resolve());
    }
  });
  global.addEventListener('storage', event => { if (event.key === scope && current()) { renderHistory(); renderActive(); } });
  global.addEventListener('beforeunload', () => { offPresence?.(); });
  global.addEventListener('soduwork-locale-change', renderHistory);
  global.addEventListener('resize', positionHistory);
  global.SoduWorkAppConversations = { start, ready: () => initialization,
    applicationId: () => current() ? application.id : '', bind, identified, select, newChat, openHistory };
})(window);
