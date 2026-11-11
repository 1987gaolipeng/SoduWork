(function (global) {
  'use strict';
  const fields = {agentId: 80, modelName: 160, reasoningEffort: 24};
  const fail = error => ({ok: false, reason: String(error?.message || error)});
  function clean(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !Object.hasOwn(fields, key))) throw Error('执行选择格式不正确');
    const out = {};
    for (const [key, limit] of Object.entries(fields)) {
      const value = Object.hasOwn(raw, key) ? raw[key] : '';
      if (typeof value !== 'string' || value.length > limit || /[\x00-\x1f]/.test(value)) throw Error('执行选择包含无效字段');
      out[key] = value.trim();
    }
    if (!out.agentId) throw Error('请选择执行底座');
    if (out.reasoningEffort && (out.agentId !== 'codex' || !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(out.reasoningEffort))) throw Error('思考强度无效');
    return out;
  }
  const same = (a, b) => a && b && Object.keys(fields).every(key => (a[key] || '') === (b[key] || ''));
  function defaultModel(data, agentId) {
    const runtime = data?.targets?.targets?.find(row => row.agentId === agentId);
    if (!runtime || !['managed', 'company'].includes(runtime.modelMode || (runtime.modelPick ? 'company' : 'account')) || data?.models?.error) return null;
    const models = data.models || {}, defaults = models.defaultModels || {};
    // Match PC: an explicit per-runtime default (including empty) wins. Never
    // silently choose the first catalog entry when policy cannot resolve one.
    const name = Object.hasOwn(defaults, agentId) ? defaults[agentId] : models.defaultModel;
    const row = models.usable?.find(item => item.name === name);
    return row ? {name: row.name, label: row.label || row.name} : null;
  }
  function create({handleOf, resources, emit, terminal}) {
    function check(handle) {
      if (handle.closed) throw Error('对话已关闭，请重新打开');
      if (handle.pending) throw Error('上一条消息尚未确认，请先核对回执');
      if (!['idle', ''].includes(handle.status || '') && !terminal(handle.status)) throw Error('请等待本轮和排队消息完成后切换');
    }
    function choices(handle, data) {
      if (handle.taskId && !handle.runnerId) throw Error('原执行环境尚未确认，请稍后重试');
      const seen = new Set();
      return (data.targets?.targets || []).filter(row => row.type === 'agent' && row.online === true && row.remote === true &&
        (!handle.taskId || row.runnerId === handle.runnerId) && row.agentId && !seen.has(row.agentId) && seen.add(row.agentId));
    }
    function active(handle) {
      return handle.pendingExecutionSelection || handle.activeExecutionSelection ||
        {agentId: handle.adapterId || '', modelName: handle.model?.name || '', reasoningEffort: ''};
    }
    function present(handle, selection, data) {
      handle.adapterId = selection.agentId;
      handle.displayName = global.AgentBrand?.LABELS[selection.agentId] ||
        data?.targets?.targets?.find(row => row.agentId === selection.agentId)?.name || selection.agentId;
      const found = data?.models?.usable?.find(row => row.name === selection.modelName);
      const prior = handle.model?.name === selection.modelName ? handle.model : null;
      handle.model = {name: selection.modelName,
        label: found?.label || prior?.label || selection.modelName || '默认模型'};
    }
    async function conversationRuntimes(ref) {
      try {
        const handle = handleOf(ref), data = await resources();
        if (handle.closed || handleOf(ref) !== handle) throw Error('对话已关闭，请重新打开');
        const availableRuntimes = choices(handle, data).map(row => ({id: row.agentId,
          displayName: global.AgentBrand?.LABELS[row.agentId] || row.name || row.agentId,
          modelMode: row.modelMode || (row.modelPick ? 'company' : 'account'), remote: true,
          accessControl: {supported: false}}));
        return {ok: true, runtimes: availableRuntimes, availableRuntimes};
      } catch (error) { return fail(error); }
    }
    async function select(ref, change) {
      try {
        const handle = handleOf(ref); check(handle);
        const version = (handle.selectionVersion || 0) + 1; handle.selectionVersion = version;
        const data = await resources();
        check(handle);
        if (handleOf(ref) !== handle || version !== handle.selectionVersion) throw Error('选择已变化，请重新确认');
        const rows = choices(handle, data), previous = active(handle), next = clean({...previous, ...change});
        const picked = rows.find(row => row.agentId === next.agentId);
        if (!picked) throw Error('原执行环境尚未安装或授权此底座');
        const managed = ['managed', 'company'].includes(picked.modelMode);
        if (next.agentId !== previous.agentId) {
          const old = rows.find(row => row.agentId === previous.agentId);
          if (old?.modelMode !== picked.modelMode || !managed) next.modelName = '';
          next.reasoningEffort = '';
        }
        if (next.modelName) {
          if (managed) {
            if (!(data.models?.usable || []).some(row => row.name === next.modelName)) throw Error('所选模型当前不可用，请重新选择');
          } else if (picked.modelMode !== 'account' || next.agentId !== 'codex' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(next.modelName)) {
            throw Error('此底座暂不支持在手机指定模型，请使用默认模型');
          }
        }
        if (handle.taskId) handle.pendingExecutionSelection = Object.freeze({...next});
        else handle.activeExecutionSelection = Object.freeze({...next});
        handle.selectionCatalog = data;
        present(handle, next, data); emit(handle, 'runtime-selection');
        const selection = {name: handle.model.name, model: handle.model};
        const snapshot = global.SoduWorkMobileSnapshot?.project(handle);
        return {ok: true, adapterId: handle.adapterId, displayName: handle.displayName, selection,
          ...(snapshot ? {snapshot} : {}), effective: 'next-turn'};
      } catch (error) { return fail(error); }
    }
    function poll(handle, page) {
      if (typeof page.runnerId === 'string' && page.runnerId) {
        if (handle.runnerId && handle.runnerId !== page.runnerId) throw Error('执行环境发生变化，请重新打开对话核对');
        handle.runnerId = page.runnerId;
      }
      let observed;
      const agent = page.activeExecutionSelection?.agentId || page.engine || page.cli;
      if (agent) observed = clean(page.activeExecutionSelection?.agentId ? page.activeExecutionSelection : {
        agentId: agent, modelName: typeof page.model === 'string' ? page.model : page.model?.name || '', reasoningEffort: ''});
      if (observed) {
        if (same(observed, handle.selectionAwaitingObservation)) handle.selectionAwaitingObservation = null;
        if (!handle.selectionAwaitingObservation) handle.activeExecutionSelection = Object.freeze({...observed});
      }
      const current = active(handle);
      if (current.agentId) present(handle, current, handle.selectionCatalog);
    }
    function sendArgs(handle) {
      return handle.taskId && handle.pendingExecutionSelection ?
        {executionSelection: Object.freeze({...handle.pendingExecutionSelection})} : {};
    }
    function accepted(handle, result) {
      if (result?.ok !== true || !result?.acceptedSelection) return false;
      const selected = clean(result.acceptedSelection);
      if (handle.pendingExecutionSelection && !same(handle.pendingExecutionSelection, selected)) return false;
      handle.activeExecutionSelection = Object.freeze({...selected});
      handle.selectionAwaitingObservation = handle.activeExecutionSelection;
      handle.pendingExecutionSelection = null;
      present(handle, selected, handle.selectionCatalog);
      return true;
    }
    function refreshCatalog(handle, data) {
      if (data?.models?.error || !Array.isArray(data?.models?.usable)) return;
      handle.selectionCatalog = data;
      const current = active(handle);
      if (current.agentId) present(handle, current, data);
    }
    return {refreshCatalog, conversationRuntimes, selectAgent: (ref, agentId) => select(ref, {agentId}),
      selectModel: (ref, modelName) => select(ref, {modelName}), poll, sendArgs, accepted};
  }
  global.SoduWorkMobileSelection = {create, defaultModel};
})(window);
