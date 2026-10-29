/*
 * Show real automation history in a page-level drawer so long logs do not expand grid
 * cards. Load after panels-schedules.js and reuse its state/cache.
 */

function _schConversationRunState(run) {
  const receipt = run.receipt || {};
  if (receipt.executionMode === 'soduwork.automation-conversation/v1' && run.state === 'waiting') {
    return [receipt.phase === 'device' ? '等待客户端' : '等待输入', 'waiting'];
  }
  return SCH_RUN_STATE[run.state] || [run.state || '未知', 'starting'];
}

function _schRunRowsHtml(sid) {
  const hasRows = Object.prototype.hasOwnProperty.call(_schRunRows, sid);
  const rows = _schRunRows[sid] || [];
  if (_schRunLoading[sid] && !hasRows) {
    return '<div class="sch-runs-load" role="status"><i></i><span><b>正在读取执行记录</b>' +
      '<small>正在同步对话状态、执行证据和结果…</small></span></div>';
  }
  const errorHtml = _schRunErrors[sid]
    ? '<div class="sch-runs-empty is-error"><span><b>记录暂时没有加载成功</b><small>' +
      esc(_schRunErrors[sid]) + '</small></span><button class="btn-mini" data-run-retry>重试</button></div>'
    : '';
  if (_schRunErrors[sid] && !rows.length) return errorHtml;
  if (!rows.length) {
    return '<div class="sch-runs-empty"><span class="sch-runs-empty-icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24"><path d="M8 5h8M8 9h8M8 13h5"/><path d="M6 3h12v18H6z"/></svg></span>' +
      '<span><b>还没有执行记录</b><small>运行一次后，这里会保留对话、状态、耗时与结果证据。</small></span></div>';
  }
  return errorHtml + '<div class="sch-run-list" aria-label="最近执行记录">' + rows.map(run => {
    const state = _schConversationRunState(run);
    const phase = run.receipt && run.receipt.phase === 'human_gate' ? ' · 等待人工门禁' :
      (run.receipt && run.receipt.phase === 'acceptance' ? ' · 等待结果确认' : '');
    const duration = _schRunDuration(run.durationSeconds);
    const receipt = run.receipt || {};
    const chatId = run.conversationId || receipt.conversationId || '';
    const ordinary = receipt.executionMode === 'soduwork.automation-conversation/v1';
    const title = run.conversationTitle || run.taskTitle || (ordinary ? '正在准备对话' : run.taskId ? '关联任务' : '等待启动');
    const proof = _schmRunProofHtml(run);
    return '<article class="sch-run ' + state[1] + '">' +
      '<span class="sch-run-rail" aria-hidden="true"><i></i></span>' +
      '<span class="sch-run-main"><span class="sch-run-title"><b>' + esc(title) + '</b></span><i>' +
      esc((SCH_RUN_TRIGGER[run.trigger] || run.trigger || '触发') + ' · ' +
        _schLocal(run.startedAt) + (duration ? ' · ' + duration : '') + phase) + '</i>' +
      (proof ? '<span class="sch-run-proof">' + proof + '</span>' : '') +
      (run.error ? '<em class="sch-run-error" title="' + esc(run.error) + '">' + esc(run.error) + '</em>' : '') + '</span>' +
      '<span class="sch-run-side"><em class="sch-run-state"><i></i>' + esc(state[0]) + '</em>' +
      (chatId ? '<button class="btn-mini" data-run-chat="' + esc(chatId) + '">打开对话</button>' :
        run.taskId ? '<button class="btn-mini" data-run-task="' + esc(run.taskId) + '">查看任务</button>' : '') +
      '</span></article>';
  }).join('') + '</div>';
}

function _schRunDrawerHtml(sid) {
  const schedule = (_schRows || []).find(item => item.id === sid) || {};
  const rows = _schRunRows[sid] || [];
  const latest = rows[0] || {};
  const latestState = rows.length ? _schConversationRunState(latest) : ['尚未运行', 'starting'];
  const succeeded = rows.filter(run => run.state === 'succeeded').length;
  const attention = rows.filter(run => run.state === 'failed' || run.state === 'waiting').length;
  return '<div class="sch-run-drawer-head"><div class="sch-run-drawer-title">' +
    "<span>执行记录</span><h2 id=\"schRunTitle\"" + (schedule.title ? ' data-user-content' : '') + '>' + esc(schedule.title || '自动化任务') + '</h2>' +
    '<p>' + esc(schedule.id ? _schRhythm(schedule) : '自动化任务') + ' · 展示最近 20 次真实运行</p></div>' +
    '<div class="sch-run-drawer-actions"><button class="btn-mini" data-run-refresh' +
    (_schRunLoading[sid] ? ' disabled' : '') + '>刷新</button>' +
    '<button class="sch-run-close" data-run-close aria-label="关闭执行记录">' +
    '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div></div>' +
    '<div class="sch-run-overview"><span class="sch-run-latest ' + latestState[1] + '"><small>最近状态</small>' +
    '<b><i></i>' + esc(latestState[0]) + '</b></span><span><small>最近记录</small><b>' + rows.length + '</b></span>' +
    '<span><small>已完成</small><b>' + succeeded + '</b></span><span><small>需关注</small><b>' + attention + '</b></span></div>' +
    '<div class="sch-run-drawer-note"><i></i><span><b>每次运行都可追溯</b>' +
    '<small>普通自动化在对话中执行，可查看过程并继续聊；企业工作流仍以真实节点与审批结果为准。</small></span></div>' +
    '<div class="sch-run-drawer-body"' + (_schRunLoading[sid] ? ' aria-busy="true"' : '') + '>' +
    _schRunRowsHtml(sid) + '</div>';
}

function _schRenderRunDrawer(focusDrawer) {
  const layer = document.getElementById('schRunLayer');
  const content = document.getElementById('schRunContent');
  if (!layer || !content) return;
  document.querySelectorAll('.sch-item [data-act="runs"]').forEach(button => {
    const card = button.closest('.sch-item');
    button.setAttribute('aria-expanded', String(Boolean(card && card.getAttribute('data-sid') === _schRunOpen)));
  });
  if (!_schRunOpen) {
    layer.classList.remove('show'); layer.setAttribute('aria-hidden', 'true'); content.innerHTML = '';
    return;
  }
  const sid = _schRunOpen;
  content.innerHTML = _schRunDrawerHtml(sid);
  layer.classList.add('show'); layer.setAttribute('aria-hidden', 'false');
  content.querySelectorAll('[data-run-close]').forEach(button =>
    button.addEventListener('click', () => _schCloseRuns(true)));
  const retry = content.querySelector('[data-run-retry]');
  if (retry) retry.addEventListener('click', () => _schToggleRuns(sid, true));
  const refresh = content.querySelector('[data-run-refresh]');
  if (refresh) refresh.addEventListener('click', () => _schToggleRuns(sid, true));
  content.querySelectorAll('[data-run-chat]').forEach(button => button.addEventListener('click', () => {
    const chatId = button.getAttribute('data-run-chat');
    closeSchedulePanel();
    if (window.WorkspaceHost) WorkspaceHost.open('create', { tab: 'chat', chatId });
  }));
  content.querySelectorAll('[data-run-task]').forEach(button => button.addEventListener('click', () => {
    const taskId = button.getAttribute('data-run-task');
    closeSchedulePanel();
    if (window.WorkspaceHost) WorkspaceHost.open('detail', { taskId });
    else if (typeof openDetail === 'function') openDetail(taskId);
  }));
  if (focusDrawer) requestAnimationFrame(() => {
    const drawer = layer.querySelector('.sch-run-drawer');
    if (drawer) drawer.focus({ preventScroll: true });
  });
}

function _schCloseRuns(restoreFocus) {
  const returnFocus = _schRunReturnFocus;
  _schRunOpen = ''; _schRunReturnFocus = null;
  clearTimeout(_schRunRefreshTimer);
  _schRenderRunDrawer(false);
  if (restoreFocus && returnFocus && returnFocus.isConnected) {
    requestAnimationFrame(() => returnFocus.focus({ preventScroll: true }));
  }
}

async function _schToggleRuns(sid, force, source) {
  const scope = _schScope;
  if (!force && _schRunOpen === sid) { _schCloseRuns(true); return; }
  if (source) _schRunReturnFocus = source;
  _schRunOpen = sid;
  _schRenderRunDrawer(Boolean(source));
  if (_schRunLoading[sid]) return;
  // Cached rows make reopening immediate, but the chat may have settled while
  // this drawer was closed. Refresh its receipt and resume pending-run polling.
  const hasRows = Object.prototype.hasOwnProperty.call(_schRunRows, sid);
  _schRunLoading[sid] = true; delete _schRunErrors[sid];
  if (!hasRows) _schRenderRunDrawer(false);
  try {
    const rows = await SoduWorkAPI.listScheduleRuns(sid, 20);
    if (scope === _schScope) _schRunRows[sid] = rows;
  } catch (error) {
    if (scope === _schScope) _schRunErrors[sid] = _schErrorText(error);
  } finally {
    if (scope !== _schScope) return;
    delete _schRunLoading[sid]; _schRenderRunDrawer(false);
    // Ordinary chats emit no task-change event. Refresh only the open run
    // history while a conversation receipt is pending; do not poll hidden UI.
    if (_schRunOpen === sid && (_schRunRows[sid] || []).some(run =>
      (run.receipt || {}).executionMode === 'soduwork.automation-conversation/v1' &&
      ['starting', 'running', 'waiting'].includes(run.state))) {
      clearTimeout(_schRunRefreshTimer);
      _schRunRefreshTimer = setTimeout(() => {
        if (_schRunOpen === sid) _schToggleRuns(sid, true);
      }, 5000);
    }
  }
}
