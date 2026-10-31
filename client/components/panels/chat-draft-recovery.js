/*
 * Conversation drafts and failed-send recovery; NativeChat owns live state. Mirror drafts
 * in localStorage so same-origin windows can resume them. The per-window Map remains the
 * runtime authority.
 */
(function (global) {
  'use strict';
  function create(ctx) {
  const uiText = value => global.SoduWorkI18n?.translateText?.(value) || value;
  const recoveringRequirements = new WeakSet();
  // File/Blob objects and native input references stay in memory, scoped to
  // this login. Changing chats must preserve an unsent attachment as well as text.
  const attachmentDrafts = new Map();
  // Plugin parameters belong to this login's in-memory draft, never the
  // long-lived text mirror or the runtime's active capability selection.
  const pluginDrafts = new Map();
  const actionDrafts = new Map();
  let restoringDraft = false;
  // Restoring controls fires input/change events synchronously; suppress writes until the complete draft is restored.
  function _withConversationDraftRestore(restore) {
    const previous = restoringDraft;
    restoringDraft = true;
    try { return restore(); } finally { restoringDraft = previous; }
  }
  function _draftComposer() {
    return { input: document.getElementById('nchatInput'), attachments: ctx._messageAttachments,
      plugins: ctx._pluginMention, skills: ctx._skillPicker };
  }
  function _composerText(controls) {
    const typed = String(controls.input?.value || '');
    return controls.attachments?.submissionText?.(typed) ?? typed;
  }
  function _ordinaryDraftFiles(files) {
    // Only the attachment controller can identify an input card. An uploaded
    // TXT (or a File with a similarly named property) remains reference material.
    return (Array.isArray(files) ? files : []).filter(file =>
      global.ConversationAttachments?.inputText?.(file) === undefined);
  }
  function _hasNewInputDraft(draft) {
    const current = _composerText(_draftComposer());
    if (current.trim() && current !== String(draft.text || '')) return true;
    const identity = file => global.ConversationAttachments?.fileIdentity?.(file) ?? file;
    const remaining = new Map();
    for (const file of _ordinaryDraftFiles(draft.files)) {
      const key = identity(file); remaining.set(key, (remaining.get(key) || 0) + 1);
    }
    // Hydration/native staging may replace File objects without user edits.
    // Count each selection too: another paste of the same file is new input.
    return _ordinaryDraftFiles(ctx._messageAttachments?.files?.()).some(file => {
      const key = identity(file), count = remaining.get(key) || 0;
      if (!count) return true;
      remaining.set(key, count - 1); return false;
    });
  }
  function _pluginDraftRows(rows) {
    return (Array.isArray(rows) ? rows : []).slice(0, 3).map(item => {
      const pluginId = String(item?.pluginId || '').trim();
      if (!pluginId) return null;
      const draft = { pluginId };
      for (const key of ['name', 'version', 'key', 'qualifiedKey', 'scopeLabel'])
        if (typeof item[key] === 'string') draft[key] = item[key];
      if (item.inputValues && typeof item.inputValues === 'object') {
        draft.inputValues = Object.fromEntries(Object.entries(item.inputValues).filter(([, value]) =>
          typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)));
      }
      return draft;
    }).filter(Boolean);
  }
  function _currentPluginDraft() {
    return _pluginDraftRows(ctx._pluginMention?.draft?.() || ctx._pluginMention?.selected?.());
  }
  function _hasNewPluginDraft(draft) {
    if (ctx._pluginMention?.action?.()) return true;
    const current = _currentPluginDraft();
    const signature = rows => JSON.stringify(_pluginDraftRows(rows).map(item => ({
      pluginId: item.pluginId, inputValues: Object.entries(item.inputValues || {}).sort(([a], [b]) => a.localeCompare(b)),
    })).sort((a, b) => a.pluginId.localeCompare(b.pluginId)));
    return current.length > 0 && signature(current) !== signature(draft.plugins);
  }
  function _skillDraftNames(value) {
    return [...new Set((Array.isArray(value) ? value : []).filter(name =>
      typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name)))].slice(0, 20);
  }
  function _hasNewSkillDraft(draft) {
    const current = _skillDraftNames(ctx._skillPicker?.selected?.());
    return current.length > 0 && JSON.stringify(current.slice().sort()) !==
      JSON.stringify(_skillDraftNames(draft.skills).sort());
  }
  function _draftKeyForCurrentSession() {
    return String(ctx._draftKey || ctx._sessionId || ctx._ref || 'new').trim() || 'new';
  }
  function _draftOwnerScope() {
    try { return String(global.SoduWorkAPI?.taskStorageKey?.('ops') || ''); } catch (_) { return ''; }
  }
  function _clearConversationDraftScope() {
    ctx._draftScopeEpoch += 1;
    ctx._viewEpoch += 1;
    ctx._conversationDrafts.clear(); ctx._failedConversationDrafts.clear(); ctx._submissionDrafts.clear();
    attachmentDrafts.clear(); pluginDrafts.clear(); actionDrafts.clear();
    ctx._draftStorageLoaded = true;
    ctx._retryDraft = null; ctx._pending = ''; ctx._pendingPlugins = []; ctx._pendingAttachmentNames = []; ctx._localQueue = [];
    ctx._pluginAuthorization = null;
    const input = document.getElementById('nchatInput');
    if (input) input.value = '';
    _withConversationDraftRestore(() => {
      ctx._messageAttachments?.clear(); ctx._pluginMention?.clear(); ctx._skillPicker?.clear();
    });
    _flushConversationDrafts();
  }
  function _draftStorage() {
    /*
     * Use shared localStorage so drafts follow a conversation between windows; sessionStorage
     * is window-local.
     */
    try { return global.localStorage || null; } catch (_) { return null; }
  }
  function _loadConversationDrafts() {
    if (ctx._draftStorageLoaded) return;
    ctx._draftStorageLoaded = true;
    const storage = _draftStorage();
    if (!storage) return;
    try {
      const parsed = JSON.parse(storage.getItem(ctx._draftStorageKey) || '[]');
      if (!Array.isArray(parsed)) return;
      parsed.slice(-30).forEach((row) => {
        const key = String(row && row.key || '').trim();
        const text = String(row && row.text || '');
        const updatedAt = Number(row && row.updatedAt || 0);
        const skills = _skillDraftNames(row && row.skills);
        if (key && (text.trim() || skills.length)) ctx._conversationDrafts.set(key, { text, skills, updatedAt: updatedAt || Date.now() });
      });
    } catch (_) { /* a corrupt browser draft must never block the chat */ }
  }
  function _flushConversationDrafts() {
    if (ctx._draftStorageTimer) {
      clearTimeout(ctx._draftStorageTimer);
      ctx._draftStorageTimer = 0;
    }
    const storage = _draftStorage();
    if (!storage) return;
    try {
      const rows = [...ctx._conversationDrafts.entries()]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
        .slice(-30)
        .map(([key, row]) => ({ key, text: String(row.text || ''), skills: _skillDraftNames(row.skills), updatedAt: row.updatedAt }));
      if (rows.length) storage.setItem(ctx._draftStorageKey, JSON.stringify(rows));
      else storage.removeItem(ctx._draftStorageKey);
    } catch (_) { /* memory storage remains the source of truth if quota is full */ }
  }
  function _scheduleDraftStorage() {
    if (ctx._draftStorageTimer) return;
    ctx._draftStorageTimer = setTimeout(_flushConversationDrafts, 120);
  }
  function _rememberConversationText(key, value, selections) {
    if (restoringDraft) return;
    _loadConversationDrafts();
    const resolvedKey = String(key || _draftKeyForCurrentSession()).trim() || 'new';
    const text = String(value || '');
    const skills = _skillDraftNames(selections === undefined ? ctx._conversationDrafts.get(resolvedKey)?.skills : selections);
    if (text.trim() || skills.length) ctx._conversationDrafts.set(resolvedKey, { text, skills, updatedAt: Date.now() });
    else ctx._conversationDrafts.delete(resolvedKey);
    while (ctx._conversationDrafts.size > 30) {
      const oldest = [...ctx._conversationDrafts.entries()]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (!oldest) break;
      ctx._conversationDrafts.delete(oldest[0]);
    }
    _scheduleDraftStorage();
  }
  function _rememberConversationDraft(key, composer) {
    if (restoringDraft) return;
    const controls = composer || _draftComposer(), input = controls.input;
    const resolvedKey = String(key || _draftKeyForCurrentSession()).trim() || 'new';
    if (!input) return;
    // Persist the complete logical body once. Input-card Files are a view of
    // that body and must not be restored alongside the same saved text.
    const files = _ordinaryDraftFiles(controls.attachments?.files?.());
    if (files.length) {
      attachmentDrafts.delete(resolvedKey);
      attachmentDrafts.set(resolvedKey, files.slice());
    } else attachmentDrafts.delete(resolvedKey);
    const plugins = _pluginDraftRows(controls.plugins?.draft?.() || controls.plugins?.selected?.());
    if (plugins.length) {
      pluginDrafts.delete(resolvedKey);
      pluginDrafts.set(resolvedKey, plugins);
    } else pluginDrafts.delete(resolvedKey);
    const action = controls.plugins?.action?.();
    actionDrafts.delete(resolvedKey);
    if (action?.kind === 'action' && action.actionId) actionDrafts.set(resolvedKey, { ...action });
    while (pluginDrafts.size > 30) pluginDrafts.delete(pluginDrafts.keys().next().value);
    while (actionDrafts.size > 30) actionDrafts.delete(actionDrafts.keys().next().value);
    const retainedBytes = () => [...attachmentDrafts.values()].flat().reduce((sum, file) =>
      sum + (file.nativeReference ? 0 : Number(file.size) || 0), 0);
    while (attachmentDrafts.size > 30 || retainedBytes() > 256 * 1024 * 1024)
      attachmentDrafts.delete(attachmentDrafts.keys().next().value);
    _rememberConversationText(resolvedKey, _composerText(controls), controls.skills?.selected?.() || []);
  }
  function _conversationDraftText(key) {
    _loadConversationDrafts();
    const resolvedKey = String(key || _draftKeyForCurrentSession()).trim() || 'new';
    const row = ctx._conversationDrafts.get(resolvedKey);
    return row && row.text ? row.text : '';
  }
  function _conversationDraftSkills(key) {
    _loadConversationDrafts();
    return _skillDraftNames(ctx._conversationDrafts.get(String(key || _draftKeyForCurrentSession()).trim() || 'new')?.skills);
  }
  function _clearConversationDraft(key, options) {
    _loadConversationDrafts();
    const resolvedKey = String(key || _draftKeyForCurrentSession()).trim() || 'new';
    ctx._conversationDrafts.delete(resolvedKey);
    attachmentDrafts.delete(resolvedKey);
    pluginDrafts.delete(resolvedKey);
    actionDrafts.delete(resolvedKey);
    if (!options?.preserveRequirement || !ctx._failedConversationDrafts.get(resolvedKey)?.draft.requirement)
      ctx._failedConversationDrafts.delete(resolvedKey);
    _scheduleDraftStorage();
  }
  function _restoreConversationDraft(key, composer) {
    _loadConversationDrafts();
    const controls = composer || _draftComposer(), input = controls.input;
    const resolvedKey = String(key || _draftKeyForCurrentSession()).trim() || 'new';
    const row = ctx._conversationDrafts.get(resolvedKey);
    if (!input) return;
    const files = attachmentDrafts.get(resolvedKey)?.slice() || [];
    const plugins = _pluginDraftRows(pluginDrafts.get(resolvedKey));
    const action = actionDrafts.get(resolvedKey);
    _withConversationDraftRestore(() => {
      input.value = row?.text || '';
      controls.attachments?.clear?.();
      if (files.length) controls.attachments?.add?.(files, 'draft');
      controls.plugins?.clear?.();
      if (plugins.length) controls.plugins?.restore?.(plugins);
      if (action) controls.plugins?.restoreAction?.({ ...action });
      controls.skills?.restore?.(row?.skills || []);
      controls.attachments?.foldInput?.();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  function _retainFailedConversationDraft(key, draft, reason) {
    if (!key || !draft) return;
    // A requirement is a scoped queue submission, never a plain composer draft.
    if (!draft.requirement && !_conversationDraftText(key).trim() && !_conversationDraftSkills(key).length && !attachmentDrafts.get(key)?.length && !pluginDrafts.get(key)?.length && !actionDrafts.has(key) &&
        !(key === _draftKeyForCurrentSession() && (_hasNewInputDraft(draft) || _hasNewPluginDraft(draft) || _hasNewSkillDraft(draft)))) _rememberConversationText(key, draft.text, draft.skills || []);
    ctx._failedConversationDrafts.delete(key);
    ctx._failedConversationDrafts.set(key, { draft, reason });
    while (ctx._failedConversationDrafts.size > 30) ctx._failedConversationDrafts.delete(ctx._failedConversationDrafts.keys().next().value);
  }
  function _restoreRetainedConversationFailure() {
    const saved = ctx._failedConversationDrafts.get(_draftKeyForCurrentSession());
    if (!saved) return;
    if (saved.draft.requirement && saved.draft.requirement.ownerScope !== _draftOwnerScope()) return;
    // A lost IPC receipt is not proof that the native session stopped. Restore
    // the input without replacing a currently executing session's status.
    if (ctx._runtimeBusy()) { ctx._retryDraft = saved.draft; _restoreFailedDraft(saved.draft); }
    else ctx._fail('这一轮没发出去', saved.reason, saved.draft);
  }
  function _restoreRetryDraft() {
    const draft = ctx._retryDraft;
    if (draft?.requirement) return _recoverRequirementDraft(draft);
    const el = ctx._mount();
    const input = el && el.querySelector('#nchatInput');
    if (!draft || !input) return;
    if (_hasNewInputDraft(draft) || _hasNewPluginDraft(draft) || _hasNewSkillDraft(draft)) {
      if (typeof petSay === 'function') petSay('输入框里已有新内容，请先发送或清空，再恢复上一轮');
      input.focus();
      return;
    }
    _restoreFailedComposer(input, draft);
    ctx._retryDraft = null;
    if (ctx._snap && !ctx._runtimeBusy()) {
      ctx._snap = { ...ctx._snap, status: 'idle', statusText: '' };
      ctx._render();
    }
    input.focus();
  }
  async function _openPluginAuthRecovery() {
    const draft = ctx._retryDraft;
    const metadata = ctx._pluginAuthorization;
    const builder = global.ChatPluginAuthRecovery;
    if (!draft || !builder || typeof builder.newSessionPayload !== 'function') return false;
    const el = ctx._mount();
    const input = el && el.querySelector('#nchatInput');
    if (_hasNewInputDraft(draft) || _hasNewPluginDraft(draft) || _hasNewSkillDraft(draft)) {
      if (typeof petSay === 'function') petSay(uiText('输入框里已有新内容，请先发送或清空，再恢复上一轮'));
      input?.focus?.();
      return false;
    }
    const payload = builder.newSessionPayload(draft, metadata, ctx._sessionOptions);
    if (!payload || typeof global.WorkspaceHost?.open !== 'function') {
      if (typeof petSay === 'function') petSay(uiText('请新建会话并开启对应能力后再使用这个插件'));
      return false;
    }
    try {
      const opened = await Promise.resolve(global.WorkspaceHost.open('create', payload));
      if (opened === false) throw Error('新会话没有打开');
      ctx._retryDraft = null;
      ctx._pluginAuthorization = null;
      return true;
    } catch (error) {
      if (typeof petSay === 'function') petSay(uiText(String(error?.message || '新会话没有打开，请重试')));
      return false;
    }
  }
  function _restoreFailedDraft(draft) {
    if (!draft || draft.requirement) return;
    const el = ctx._mount();
    const input = el && el.querySelector('#nchatInput');
    if (!input) return;
    if (_hasNewInputDraft(draft) || _hasNewPluginDraft(draft) || _hasNewSkillDraft(draft)) {
      if (typeof petSay === 'function') petSay('输入框里已有新内容，失败的这一轮仍可从“恢复这一轮”取回');
      return;
    }
    _restoreFailedComposer(input, draft);
    input.focus();
  }
  function _restoreFailedComposer(input, draft) {
    const files = _ordinaryDraftFiles(draft.files);
    _withConversationDraftRestore(() => {
      input.value = String(draft.text || '');
      ctx._messageAttachments?.clear?.();
      // This is a complete replay after clear, including repeated clipboard
      // files. Ordinary picker deduplication must not collapse those selections.
      if (files.length) ctx._messageAttachments?.add?.(files, 'draft');
      ctx._skillPicker?.restore?.(draft.skills || []);
      if (Array.isArray(draft.plugins) && draft.plugins.length) ctx._pluginMention?.restore?.(draft.plugins);
      ctx._messageAttachments?.foldInput?.();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    _rememberConversationDraft();
  }
  async function _recoverRequirementDraft(draft) {
    if (recoveringRequirements.has(draft)) return false;
    const saved = draft.requirement, key = _draftKeyForCurrentSession();
    const epoch = ctx._viewEpoch, scopeEpoch = ctx._draftScopeEpoch, ref = ctx._ref;
    const conversationId = String(ctx._sessionId || ref || '');
    const current = () => epoch === ctx._viewEpoch && scopeEpoch === ctx._draftScopeEpoch &&
      ref === ctx._ref && conversationId === String(ctx._sessionId || ctx._ref || '') &&
      saved.ownerScope === _draftOwnerScope();
    if (!saved.taskId || !ref || saved.conversationId !== conversationId || !current()) return false;
    const api = ctx._api(), hub = global.SoduWorkAPI;
    const say = text => { if (current() && typeof petSay === 'function') petSay(text); };
    if (!api?.snapshot || !hub?.getTask || !ctx._startTask) {
      say('请重新打开原会话，从需求队列恢复执行'); return false;
    }
    recoveringRequirements.add(draft);
    try {
      const before = ctx._snap;
      const [latest, task] = await Promise.all([api.snapshot(ref), hub.getTask(saved.taskId)]);
      if (!current() || ctx._retryDraft !== draft) return false;
      if (!latest?.ok || !latest.snapshot || !task || String(task.id) !== saved.taskId)
        throw new Error('暂时无法确认需求的执行状态，请稍后恢复');
      if (task.readOnly || task.canViewExecution === false)
        throw new Error('当前账号没有执行这条需求的权限');
      const snapshot = ctx._snap === before ? latest.snapshot : ctx._snap;
      const execution = snapshot?.execution || {}, queue = execution.turnQueue || {};
      const receipt = task.workRouting?.conversationTurn || {};
      const sameReceipt = receipt.conversationId === conversationId && receipt.turnId === saved.submissionId;
      const accepted = queue.activeTaskId === saved.taskId ||
        (saved.submissionId && queue.activeSubmissionId === saved.submissionId) ||
        (execution.queue || []).some(row => row.taskId === saved.taskId ||
          saved.submissionId && row.submissionId === saved.submissionId);
      const sameConversation = receipt.conversationId === conversationId;
      const activeReceipt = /^(queued|running|waiting)$/.test(receipt.state);
      const runtimeActive = ['starting', 'streaming', 'queued', 'compacting', 'waiting-user'].includes(snapshot?.status) ||
        snapshot?.running === true || execution.running === true || Boolean(snapshot?.pendingUi) ||
        Boolean(snapshot?.pendingPermissions?.length);
      // Hub can retain an active receipt after a client restart. Only the main
      // process may claim it after checking that the original runtime stopped.
      const checkInterrupted = sameConversation && receipt.executor === 'native' && activeReceipt &&
        !runtimeActive && ['idle', 'aborted', 'unreachable'].includes(snapshot?.status);
      const completed = ['done', 'cancel'].includes(task.status) ||
        ['reviewing', 'delivered', 'closed'].includes(task.requirementStage) || receipt.state === 'completed' ||
        /^(done|completed|delivered|reviewing|pending_review)$/.test(String(task.ai?.executionState || task.ai?.state || ''));
      const discard = () => {
        if (ctx._retryDraft === draft) ctx._retryDraft = null;
        if (ctx._failedConversationDrafts.get(key)?.draft === draft) ctx._failedConversationDrafts.delete(key);
      };
      if (accepted || completed || sameConversation && activeReceipt && runtimeActive) {
        if (ctx._snap === before) ctx._snap = latest.snapshot;
        discard();
        const entry = ctx._collabTasks?.get(saved.taskId);
        if (entry) { entry.task = task; entry.queueState = receipt.state || (completed ? 'completed' : 'queued'); }
        ctx._render();
        say(completed ? '需求已有执行结果，请在需求中查看' : '需求已收到，正在原会话中执行或排队');
        return true;
      }
      if (activeReceipt && !sameReceipt && !checkInterrupted)
        throw new Error('这条需求已在执行或排队，请查看原会话，避免重复发送');
      // A transport failure is not a rejection. Reuse the original id until
      // Hub confirms that exact attempt ended; prepare/queue deduplicate it.
      const uncertain = saved.deliveryState === 'uncertain' || receipt.state === 'queued';
      const settled = sameReceipt && /^(failed|cancelled|stopped)$/.test(receipt.state);
      if (uncertain && !settled && !saved.submissionId)
        throw new Error('发送回执尚未确认，请重新打开原会话查看执行状态');
      if (ctx._snap === before) ctx._snap = latest.snapshot;
      const entry = ctx._collabTasks?.get(saved.taskId);
      if (entry) { entry.task = task; entry.queueState = 'failed'; }
      const taskExecution = { ...(saved.taskExecution || {}) };
      if (checkInterrupted) {
        taskExecution.reuseConversation = true;
        if (!taskExecution.reworkSession) taskExecution.followUp = true;
        // A confirmed old receipt owns its saved selection. Do not replay the
        // initial choice override while recovering that same execution.
        delete taskExecution.executionChoice;
      }
      const acceptedRetry = await ctx._startTask(task, {
        instruction: draft.text, taskExecution,
        retry: !uncertain || settled,
        submissionId: uncertain && !settled ? saved.submissionId : '',
      });
      if (!current()) return Boolean(acceptedRetry);
      if (acceptedRetry) discard();
      else if (!ctx._retryDraft) ctx._retryDraft = draft;
      ctx._render();
      return Boolean(acceptedRetry);
    } catch (error) {
      say(String(error?.message || error)); return false;
    } finally { recoveringRequirements.delete(draft); }
  }
  return { _withConversationDraftRestore, _draftKeyForCurrentSession, _draftOwnerScope, _clearConversationDraftScope, _flushConversationDrafts, _rememberConversationText, _rememberConversationDraft, _conversationDraftText, _conversationDraftSkills, _clearConversationDraft, _restoreConversationDraft, _retainFailedConversationDraft, _restoreRetainedConversationFailure, _restoreRetryDraft, _openPluginAuthRecovery, _restoreFailedDraft };
  }
  global.ChatDraftRecovery = { create };
})(window);
