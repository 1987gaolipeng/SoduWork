/* Executors can reuse a conversation or explicitly choose a probed local execution channel. */
(function (global) {
  'use strict';
  const esc = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function canUseLocalAgents(task, options) {
    const sessions = global.soduWorkAPI?.conversationSession;
    if (!global.NativeChat?.enqueueTask || !sessions?.runtimes || !sessions?.probe) return false;
    const routing = task?.workRouting || {};
    // Only ordinary direct tasks can use the existing local conversation path.
    // Project, workflow and remote execution still require the Hub's Runner contract.
    return ![task, routing, task?.executionContext, routing.executionContext, options?.selection].some(value => {
      const item = value || {}, runner = item.runner || {};
      return item.repoId || item.repo?.id || item.repo?.path || item.workflowBindingId ||
        item.selectedWorkflowBindingId || item.workflowId || item.bindingId || item.plugin?.bindingId ||
        item.strategy === 'workflow' || item.selectedStrategy === 'workflow' || item.assigneeType === 'squad' ||
        runner.mode === 'remote' || runner.remote === true || item.location?.mode === 'remote' ||
        /^runner:/.test(String(item.agentId || item.agent?.id || item.agent?.key || ''));
    });
  }
  async function localAgents(task, options, onAgent) {
    if (!canUseLocalAgents(task, options)) return {ok:true, agents:[]};
    const sessions = global.soduWorkAPI.conversationSession;
    async function bounded(work, ms) {
      let timer;
      try { return await Promise.race([Promise.resolve().then(work),
        new Promise(resolve => { timer = setTimeout(() => resolve({ok:false, reason:'连接检查超时，请重新检查'}), ms); })]); }
      catch (_) { return {ok:false, reason:'本机执行服务未能响应，请重新检查连接'}; }
      finally { clearTimeout(timer); }
    }
    // Probe each registered runtime once so a slow Runner cannot delay a ready Pi.
    const catalog = await bounded(() => sessions.runtimes({catalogOnly:true}), 5000);
    if (!catalog?.ok || !Array.isArray(catalog.runtimes)) return {ok:false, agents:[],
      failures:[{name:'本机 Agent', reason:String(catalog?.reason || '无法读取本机执行目录').slice(0, 240)}]};
    const seen = new Set();
    const rows = catalog.runtimes.filter(row => {
      if (!row || !/^[a-z][a-z0-9-]{0,39}$/.test(row.id || '') || seen.has(row.id) ||
          !['direct', 'runner'].includes(row.transport) || (row.transport === 'direct' && row.id !== 'pi')) return false;
      seen.add(row.id); return true;
    });
    const agents = [], failures = [];
    await Promise.all(rows.map(async row => {
      // These are trusted runtime detection calls, not model turns or installations.
      const detected = await bounded(() => sessions.probe(row.id), 15000);
      if (detected?.ok !== true || ['bad', 'missing', 'unauthed', 'nollm'].includes(detected.state)) {
        // Missing installations are expected; connection/authentication failures
        // must remain visible instead of silently shrinking the Agent directory.
        if (detected?.state !== 'missing') failures.push({id:row.id, name:row.displayName || row.id,
          reason:String(detected?.reason || detected?.message || '执行环境尚未就绪').slice(0, 240)});
        return;
      }
      const agent = {key:'local:' + row.id, cli:row.id, name:row.displayName || row.id,
        available:true, local:true, remote:false, locationMode:'local', locationLabel:'本机',
        modelPick:row.modelMode === 'managed', modelSource:'conversation',
        versions:detected.version ? [detected.version] : [], executionSource:'conversation',
        note:'在本机执行，沿用 Agent 的当前配置'};
      agents.push(agent);
      onAgent?.(agent);
    }));
    return {ok:true, agents, failures};
  }
  async function nativeOption(options) {
    // Offer the local conversation runtime only after a successful probe; it is distinct from a backend Runner.
    // Project execution retains directory and permission checks; local availability does not imply an online Runner.
    if (options?.selection?.repoId) return null;
    const sessions = global.soduWorkAPI?.conversationSession || global.soduWorkAPI?.piSession;
    if (!sessions?.probe) return null;
    let timer;
    try {
      // Show available backend execution options while a local probe is still pending.
      const state = await Promise.race([sessions.probe('pi'),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); })]);
      return state?.ok === true ? {id:'native:pi', name:'Pi · 本机对话', available:true} : null;
    } catch (_) { return null; }
    finally { clearTimeout(timer); }
  }
  async function executeNative(taskId, brief, options = {}) {
    if (!global.NativeChat?.enqueueTask) throw Error('当前客户端未加载会话执行能力');
    const result = await global.NativeChat.enqueueTask(taskId, {
      source:'task-dispatch', agentId:'local:pi', executionChoice:'native', brief,
      ...(options.submissionMode ? { submissionMode: options.submissionMode } : {}),
    });
    if (!result?.ok) throw Error(result?.reason || '需求未能进入会话');
    return result;
  }
  async function mount(host, task, {valid, completed}) {
    const policy = global.RequirementSessionContext;
    const sessions = global.soduWorkAPI?.conversationSession || global.soduWorkAPI?.piSession;
    if (!policy || !sessions?.history || !global.NativeChat?.enqueueTask) return;
    const box = document.createElement('section'); box.className = 'rq-session-choice';
    box.innerHTML = '<label>执行会话<select aria-label="选择执行会话" disabled><option>正在读取项目会话…</option></select></label>' +
      '<div class="rq-session-details" hidden><p>沿用这段会话的上下文、Agent、模型和工作目录。需求说明与材料会作为下一项工作加入。</p>' +
      '<div class="rq-session-facts" data-user-content></div><label><span>补充说明 <small>选填</small></span><textarea rows="2" maxlength="2000" placeholder="这条需求需要特别注意什么"></textarea></label>' +
      '<footer><span class="rq-session-status" role="status"></span><button type="button" class="rq-primary">在此会话执行</button></footer></div>';
    host.querySelector('.fwd-head').after(box);
    const select = box.querySelector('select'), details = box.querySelector('.rq-session-details');
    const status = box.querySelector('.rq-session-status'), send = box.querySelector('button');
    let candidates = [], busy = false;
    const live = () => box.isConnected && valid();
    function change() {
      const chosen = candidates.find(row => row.sessionId === select.value);
      host.classList.toggle('uses-existing-session', Boolean(chosen)); details.hidden = !chosen;
      if (!chosen) return;
      status.textContent = chosen.reason || ''; send.disabled = Boolean(chosen.reason);
      box.querySelector('.rq-session-facts').textContent = [chosen.title, global.AgentBrand?.LABELS[chosen.adapterId] || chosen.adapterId,
        chosen.cwd].filter(Boolean).join(' · ');
    }
    select.onchange = change;
    send.onclick = async () => {
      if (busy || !live() || send.disabled) return;
      const chosen = candidates.find(row => row.sessionId === select.value); if (!chosen || chosen.reason) return;
      busy = true; select.disabled = true; send.disabled = true; send.textContent = '正在加入会话…'; status.textContent = '';
      const confirm = host.querySelector('#fwdConfirm'); confirm.dataset.idleLabel = confirm.textContent;
      try {
        const result = await global.NativeChat.enqueueTask(task.id, {source:'requirement-session', reuseConversation:true,
          chatId: chosen.sessionId, brief: box.querySelector('textarea').value.trim()});
        if (!live()) return;
        if (!result?.ok) throw Error(result?.reason || '需求未能加入会话，请重试');
        await completed(task.id, result.conversationId || chosen.sessionId);
      } catch (error) { if (live()) status.textContent = error.message || '会话暂时无法打开，需求已保留'; }
      finally {
        if (live()) { busy = false; select.disabled = false; send.disabled = false; send.textContent = '在此会话执行'; delete confirm.dataset.idleLabel; }
      }
    };
    try {
      const [history, snapshot] = await Promise.all([sessions.history(), global.SoduWorkAPI.getTasksSnapshot()]);
      if (!live()) return;
      if (history.ok === false || snapshot.online !== true || snapshot.stale) throw Error('暂时无法读取已有会话，可使用其他执行方式');
      const current = global.NativeChat.sessionInfo?.() || {}, rows = snapshot.items || [];
      const chats = (history.chats || []).map(row => ({...row,...row.requirementContext}));
      const indexed = new Map(chats.map(row => [row.id, {tasks: rows.filter(t => t.canViewExecution !== false &&
        [row.taskId,...(row.taskIds || []),...(row.taskBindings || []).map(b => b.taskId)].includes(t.id))}]));
      const grouped = chats.map(row => {
        const project = global.WorkspaceShell?.projectForChat?.(row.id);
        return {...row, projectId: row.projectId || project?.businessProjectId || ''};
      });
      candidates = policy.candidates(task, grouped, current, id => indexed.get(id));
      if (!candidates.length) { box.remove(); return; }
      select.innerHTML = '<option value="">新建会话 / 选择其他执行方式</option>' + candidates.map(row =>
        '<option value="' + esc(row.sessionId) + '">' + (row.current ? '当前会话 · ' : '') + esc(row.title) + (row.reason ? ' · 需核对配置' : '') + '</option>').join('');
      // Project affinity suggests candidates without selecting an old conversation for the executor.
      select.value = '';
      select.disabled = false; change();
    } catch (error) {
      if (live()) { box.innerHTML = '<p class="rq-session-unavailable">' + esc(error.message || '已有会话暂时无法读取，可使用其他执行方式') + '</p>'; }
    }
  }
  global.RequirementSessionChoice = {mount, nativeOption, executeNative, canUseLocalAgents, localAgents};
})(window);
