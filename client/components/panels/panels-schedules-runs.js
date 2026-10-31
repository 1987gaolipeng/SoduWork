/*
 * Show real automation history in a page-level drawer so long logs do not expand grid
 * cards. Load after panels-schedules.js and reuse its state/cache.
 */

function _schConversationRunState(run) {
  const receipt = run.receipt || {};
  if (receipt.executionMode === 'soduwork.automation-conversation/v1' && run.state === 'waiting') {
    return [receipt.phase === 'device' ? '等待客户端' : '等待输入', 'waiting'];
  }
  const result = await bridge.list();
  const plugin = ((result && result.items) || []).find(item =>
    item && item.key === key && item.enabled !== false && item.entrypoints?.automation);
  if (!plugin) throw new Error('个人插件「' + key + '」未安装、已停用或不支持自动化');
  if (spec.versionPolicy === 'pinned' &&
      (String(plugin.version || '') !== String(spec.version || '') ||
       String(plugin.checksum || '') !== String(spec.checksum || ''))) {
    throw new Error('个人插件版本与自动化锁定版本不一致，请重新选择插件');
  }
  const pluginId = String(plugin.pluginId || '').trim();
  if (!pluginId) throw new Error('个人插件缺少本机标识，请重新安装后重试');
  return { pluginId, version: String(plugin.version || ''), checksum: String(plugin.checksum || '') };
}

async function _schOpenRunEntryConversation(run) {
  const chatId = _schRunChatId(run);
  const sessionTitle = String(run && (run.conversationTitle || run.automationTitle) || '');
  if (!chatId) return false;
  if (globalThis.WorkspaceHost && typeof globalThis.WorkspaceHost.open === 'function') {
    if (typeof closeSchedulePanel === 'function') closeSchedulePanel();
    return globalThis.WorkspaceHost.open('create', {
      tab: 'chat', chatId, chatTitle: sessionTitle || '自动化执行', source: 'schedule-run',
      ...(sessionTitle ? { sessionTitle } : {}),
    });
  }
  // Older standalone windows do not expose WorkspaceHost, but the shared
  // bridge still knows how to route an existing chat into the workspace.
  if (typeof globalThis.openPiChatEntry === 'function') {
    if (typeof closeSchedulePanel === 'function') closeSchedulePanel();
    globalThis.openPiChatEntry(chatId);
    return true;
  }
  return false;
}

async function _schLaunchDirectConversation(launched, scope) {
  const input = launched && launched.conversationInput || {};
  const bridge = globalThis.soduWorkAPI &&
    (globalThis.soduWorkAPI.conversationSession || globalThis.soduWorkAPI.piSession);
  if (!bridge || typeof bridge.open !== 'function' || typeof bridge.send !== 'function' ||
      !String(input.text || '').trim()) return false;
  const runId = String(launched && launched.scheduleRunId || '');
  const instanceId = String(launched && launched.instanceId || '');
  const conversationTitle = String(input.conversationTitle || launched.conversationTitle || '自动化执行');
  let pluginLock;
  try { pluginLock = await _schResolvePersonalPlugin(input); }
  catch (error) {
    if (runId && instanceId && typeof SoduWorkAPI.acknowledgeScheduleRun === 'function') {
      await SoduWorkAPI.acknowledgeScheduleRun(runId, {
        instanceId, conversationId: '', state: 'failed', error: String(error.message || error).slice(0, 300),
      }).catch(() => {});
    }
    return false;
  }
  const options = {
    adapterId: String(input.adapterId || 'pi'), modelName: String(input.modelName || ''),
    cwd: String(input.cwd || ''), intent: 'chat', sessionTitle: conversationTitle,
    ...(input.projectId ? { projectId: String(input.projectId).trim() } : {}),
    ...(input.repoId ? { repoId: String(input.repoId).trim() } : {}),
    capabilities: Array.isArray(input.capabilities) ? input.capabilities : [],
    skills: Array.isArray(input.skills) ? input.skills : [],
    ...(pluginLock ? { pluginLock } : {}),
  };
  let opened;
  try {
    // Keep the automation identity in the main process so pinned personal
    // plugins are validated against the same local version before the first
    // turn. Older clients fall back to the ordinary bridge for compatibility.
    const open = typeof bridge.openAutomation === 'function' ? bridge.openAutomation : bridge.open;
    opened = await open(options);
  }
  catch (_) { return false; }
  if (scope !== _schScope || !opened || opened.ok === false || !opened.ref) return false;
  const chatId = String(opened.sessionId || opened.conversationId || '');
  const acknowledge = (state, error = '') => {
    if (!runId || !instanceId || typeof SoduWorkAPI.acknowledgeScheduleRun !== 'function') return Promise.resolve();
    return SoduWorkAPI.acknowledgeScheduleRun(runId, {
      instanceId, conversationId: chatId, state, error,
    }).catch(() => {});
  };
  await acknowledge('starting');
  // Navigate as soon as the ordinary chat exists. Sending the first prompt
  // continues through the same native bridge after the user sees the chat.
  if (chatId) await _schOpenRunEntryConversation({conversationId: chatId, conversationTitle});
  let settled = false;
  let off = null;
  const finish = (state, error = '') => {
    if (settled) return;
    settled = true;
    if (typeof off === 'function') off();
    void acknowledge(state, error);
  };
  off = typeof bridge.onEvent === 'function' ? bridge.onEvent(event => {
    if (String(event && event.ref || '') !== String(opened.ref)) return;
    if (event.kind === 'error') finish('failed', String(event.reason || '本轮执行失败').slice(0, 300));
    else if (event.kind === 'settled') finish('succeeded');
  }) : null;
  try {
    const sent = await bridge.send(opened.ref, String(input.text || ''), input.attachments || [], {
      source: 'automation', submissionId: runId ? 'automation-' + runId : undefined,
      ...(input.projectId ? { projectId: String(input.projectId).trim() } : {}),
      ...(input.repoId ? { repoId: String(input.repoId).trim() } : {}),
      plugins: pluginLock ? [{ pluginId: pluginLock.pluginId }] : [],
    });
    if (!sent || sent.ok === false) {
      finish('failed', String(sent && sent.reason || '自动化消息未被接收').slice(0, 300));
      return false;
    }
    await acknowledge('running');
    return true;
  } catch (error) {
    finish('failed', String(error && error.message || '自动化消息未被接收').slice(0, 300));
    return false;
  }
}

async function _schLaunchRunConversation(sid, launched, scope) {
  if (launched && launched.conversationInput &&
      await _schLaunchDirectConversation(launched, scope)) return true;
  if (await _schOpenRunEntryConversation(launched || {})) return true;
  const runId = String(launched && launched.scheduleRunId || '');
  // The local automation worker publishes the chat id immediately after the
  // session is created. Probe quickly during that handshake, then back off so
  // a slow model startup does not create a request storm.
  for (let attempt = 0; attempt < 30; attempt++) {
    const delay = attempt < 8 ? 120 : 300;
    await new Promise(resolve => setTimeout(resolve, delay));
    if (scope !== _schScope) return false;
    let rows;
    try { rows = await SoduWorkAPI.listScheduleRuns(sid, 20); } catch (_) { continue; }
    if (scope !== _schScope) return false;
    _schRunRows[sid] = rows;
    const row = (rows || []).find(item => runId && String(item.id) === runId) ||
      (rows || []).find(item => item.trigger === 'manual');
    if (row && await _schOpenRunEntryConversation(row)) return true;
  }
  return false;
}

function _schRunRowsHtml(sid) {
  const hasRows = Object.prototype.hasOwnProperty.call(_schRunRows, sid);
  const rows = _schRunRows[sid] || [];
  if (_schRunLoading[sid] && !hasRows) {
    return '<div class="sch-runs-load" role="status"><i></i><span><b>正在读取执行记录</b>' +
      '<small>正在同步对话状态与结果…</small></span></div>';
  }
  const errorHtml = _schRunErrors[sid]
    ? '<div class="sch-runs-empty is-error"><span><b>记录暂时没有加载成功</b><small>' +
      esc(_schRunErrors[sid]) + '</small></span><button class="btn-mini" data-run-retry>重试</button></div>'
    : '';
  if (_schRunErrors[sid] && !rows.length) return errorHtml;
  if (!rows.length) {
    return '<div class="sch-runs-empty"><span class="sch-runs-empty-icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24"><path d="M8 5h8M8 9h8M8 13h5"/><path d="M6 3h12v18H6z"/></svg></span>' +
      '<span><b>还没有执行记录</b><small>运行一次后，这里会保留对应会话、状态与结果。</small></span></div>';
  }
  return errorHtml + '<div class="sch-run-list" aria-label="最近执行记录">' + rows.map(run => {
    const state = _schConversationRunState(run);
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
        _schLocal(run.startedAt) + (duration ? ' · ' + duration : '')) + '</i>' +
      (run.error ? '<em class="sch-run-error" title="' + esc(run.error) + '">' + esc(run.error) + '</em>' : '') + '</span>' +
      '<span class="sch-run-side"><em class="sch-run-state"><i></i>' + esc(state[0]) + '</em>' +
      '<button class="btn-mini" data-run-chat="' + esc(chatId) + '" data-run-title="' + esc(title) + '"' +
      (chatId ? '' : ' aria-label="\u6253\u5f00\u4f1a\u8bdd\uff08\u51c6\u5907\u4e2d\uff09"') + '>\u6253\u5f00\u4f1a\u8bdd</button>' +
      '</span></article>';
  }).join('') + '</div>';
}

function _schRunDrawerHtml(sid) {
  const schedule = (_schRows || []).find(item => item.id === sid) || {};
  const rows = _schRunRows[sid] || [];
  const latest = rows[0] || {};
  const latestState = rows.length ? _schConversationRunState(latest) : ['待执行', 'starting'];
  const succeeded = rows.filter(run => run.state === 'succeeded').length;
  const attention = rows.filter(run => run.state === 'failed' || run.state === 'cancelled').length;
  return '<div class="sch-run-drawer-head"><div class="sch-run-drawer-title">' +
    "<span>执行记录</span><h2 id=\"schRunTitle\"" + (schedule.title ? ' data-user-content' : '') + '>' + esc(schedule.title || '自动化会话') + '</h2>' +
    '<p>' + esc(schedule.id ? _schRhythm(schedule) : '自动化会话') + ' · 展示最近 20 次真实运行</p></div>' +
    '<div class="sch-run-drawer-actions"><button class="btn-mini" data-run-refresh' +
    (_schRunLoading[sid] ? ' disabled' : '') + '>刷新</button>' +
    '<button class="sch-run-close" data-run-close aria-label="关闭执行记录">' +
    '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div></div>' +
    '<div class="sch-run-overview"><span class="sch-run-latest ' + latestState[1] + '"><small>最近状态</small>' +
    '<b><i></i>' + esc(latestState[0]) + '</b></span><span><small>最近记录</small><b>' + rows.length + '</b></span>' +
    '<span><small>已完成</small><b>' + succeeded + '</b></span><span><small>需关注</small><b>' + attention + '</b></span></div>' +
    '<div class="sch-run-drawer-note"><i></i><span><b>每次运行都可追溯</b>' +
    '<small>自动化任务的提示词、模型过程和最终结果都在对应会话中查看。</small></span></div>' +
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
    if (chatId) {
      void _schOpenRunEntryConversation({ conversationId: chatId,
        conversationTitle: button.getAttribute('data-run-title') || '' });
      return;
    }
    // Refresh the receipt so the same visible entry becomes actionable as
    // soon as the client has accepted the first message.
    button.disabled = true;
    button.textContent = '\u6b63\u5728\u51c6\u5907';
    void _schToggleRuns(sid, true);
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
