(function (global) {
  'use strict';

  /*
   * On-demand requirement details and selection for the composer queue. Keep ordinary
   * conversations full-width and reuse the existing message stream.
   */
  const STAGES = [
    { key: 'understand', label: '理解需求', icon: '1' },
    { key: 'plan', label: '规划', icon: '2' },
    { key: 'dispatch', label: '派活', icon: '3' },
    { key: 'execute', label: '执行中', icon: '4' },
    { key: 'verify', label: '验证中', icon: '5' },
    { key: 'release', label: '发布', icon: '6' },
    { key: 'health', label: '健康检查', icon: '7' },
  ];

  const LABELS = {
    starting: '准备中', queued: '排队中', dispatching: '派活中',
    pending: '待执行', todo: '待执行', running: '执行中', doing: '执行中',
    executing: '执行中', verifying: '验证中', completed: '已完成',
    complete: '已完成', done: '已完成', delivered: '已完成',
    failed: '失败', blocked: '已阻断', waiting: '等待用户',
    waiting_user: '等待用户', waiting_human: '等待人工',
    waiting_external: '等待外部', stopped: '已停止', cancelled: '已停止',
    canceled: '已停止', unreachable: '连接异常', incomplete: '未完成',
  };

  const STATUS_ALIAS = {
    success: 'completed', succeeded: 'completed', finished: 'completed',
    closed: 'completed', error: 'failed', failure: 'failed', aborted: 'failed',
    pending_user: 'waiting', awaiting_user: 'waiting', 'waiting-user': 'waiting',
    'waiting-human': 'waiting_human', 'waiting-external': 'waiting_external',
    in_progress: 'running', 'in-progress': 'running', working: 'running',
    active: 'running',
  };

  const PHASE_ALIAS = {
    intake: 'understand', understanding: 'understand', understood: 'understand',
    planning: 'plan', planned: 'plan', dispatching: 'dispatch', dispatched: 'dispatch',
    implementing: 'execute', coding: 'execute', executing: 'execute', running: 'execute',
    reviewing: 'verify', reviewed: 'verify', checking: 'verify', validating: 'verify',
    release: 'release', releasing: 'release', publishing: 'release',
    delivery: 'release', deliver: 'release', deployed: 'release',
    health: 'health', healthy: 'health', healthcheck: 'health',
    completed: 'health', done: 'health', delivered: 'health',
  };

  function text(value, fallback) {
    const result = String(value == null ? '' : value).trim();
    return result || String(fallback || '');
  }

  function short(value, fallback, max) {
    const result = text(value, fallback);
    const limit = max || 64;
    return result.length > limit ? result.slice(0, limit - 1) + '…' : result;
  }

  function first(values, fallback) {
    for (const value of values || []) {
      if (value != null && String(value).trim()) return String(value).trim();
    }
    return fallback || '未配置';
  }

  function firstValue(values) {
    for (const value of values || []) {
      if (value != null && value !== '' && !(typeof value === 'object' && !Object.keys(value).length)) {
        return value;
      }
    }
    return null;
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(new RegExp(String.fromCharCode(34), 'g'), '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeStatus(value) {
    const raw = text(value, 'starting').toLowerCase().replace(/-/g, '_');
    return STATUS_ALIAS[raw] || raw;
  }

  function phaseFromTrace(state) {
    const trace = state && state.trace || {};
    const summary = trace.summary || {};
    const stage = (Array.isArray(trace.stages) ? trace.stages : []).find((item) =>
      String(item.id || '') === String(summary.currentStageId || ''));
    const raw = text(state && state.phase || summary.currentPhase ||
      (stage && (stage.phase || stage.category || stage.kind)), '').toLowerCase()
      .replace(/-/g, '_');
    if (PHASE_ALIAS[raw]) return PHASE_ALIAS[raw];
    if (/understand|intake|spec|需求|收集/.test(raw)) return 'understand';
    if (/plan|planning|规划|方案/.test(raw)) return 'plan';
    if (/dispatch|assign|派活|安排/.test(raw)) return 'dispatch';
    if (/verify|review|test|quality|validate|验证|复核|验收/.test(raw)) return 'verify';
    if (/release|publish|deploy|delivery|发布|上线|交付/.test(raw)) return 'release';
    if (/health|smoke|健康|冒烟/.test(raw)) return 'health';
    const status = normalizeStatus(state && state.status ||
      (state && state.execution || {}).status || (state && state.task || {}).status);
    if (status === 'failed' || status === 'blocked' || status === 'unreachable' ||
        status === 'incomplete') return 'failed';
    if (/waiting/.test(status)) return 'verify';
    if (status === 'completed' || status === 'complete' || status === 'done' ||
        status === 'delivered') return 'health';
    if (status === 'running' || status === 'doing' || status === 'executing') return 'execute';
    if (status === 'dispatching' || status === 'queued') return 'dispatch';
    if (status === 'todo' || status === 'pending') return 'understand';
    return state && state.taskId ? 'understand' : 'plan';
  }

  function phaseOf(state) { return phaseFromTrace(state); }

  function isTerminal(status) {
    return ['completed', 'complete', 'done', 'delivered'].includes(status);
  }

  function actors(state) {
    const task = state && state.task || {};
    const execution = state && state.execution || {};
    const context = execution.executionContext || state && state.executionContext || task.executionContext || {};
    const identity = execution.identity || {};
    const agent = context.agent || context.assignee || {};
    const host = first([execution.host, context.runner && context.runner.host, execution.runnerClientId, execution.runnerId,
      context.runnerName, context.runnerId], '本机 Runner');
    return {
      owner: first([task.creatorName, task.createdByName, task.ownerName, task.owner], '当前用户'),
      agent: first([agent.name, agent.label, execution.agentName, identity.agentName,
        context.agentName, task.agentName], state && state.adapterId === 'codex' ? 'Codex' : 'Pi'),
      runner: host,
      model: first([execution.model, context.model, state && state.model && state.model.id], '自动选择'),
      project: first([task.projectName, task.repoName, context.projectName, context.repoName], '未绑定工程'),
      branch: first([task.branch, context.branch, execution.branch], '默认分支'),
      remote: context.location && ['local', 'remote'].includes(context.location.mode)
        ? context.location.mode === 'remote'
        : typeof execution.remote === 'boolean' ? execution.remote
        : typeof context.remote === 'boolean' ? context.remote
        : Boolean(execution.host && execution.host !== 'localhost' && execution.host !== '127.0.0.1'),
    };
  }

  function currentAction(status, phase) {
    if (status === 'failed' || status === 'blocked' || status === 'unreachable' || status === 'incomplete') {
      return { key: 'retry', label: '重试本步骤', desc: '保留需求上下文和执行配置，重新运行当前步骤' };
    }
    if (/^waiting/.test(status)) {
      return { key: 'focus', label: '补充信息', desc: '当前步骤需要你的输入，补充后继续执行' };
    }
    if (isTerminal(status)) {
      return { key: 'artifacts', label: '查看成果', desc: '成果、验证证据和发布记录已回到当前会话' };
    }
    if (['understand', 'plan', 'dispatch'].includes(phase) ||
        status === 'starting' || status === 'todo' || status === 'pending') {
      return { key: 'start', label: '安排执行', desc: '确认执行 Agent 后，在当前会话启动需求' };
    }
    if (phase === 'verify') {
      return { key: 'focus', label: '查看验证', desc: '正在核对交付标准和可复现的验证证据' };
    }
    return { key: 'focus', label: '查看执行', desc: '执行事件会持续汇总到当前会话消息流' };
  }

  function icon(kind) {
    const paths = {
      queue: '<path d="M5 4v11a3 3 0 0 0 3 3h10M14 14l4 4-4 4M10 5h9M10 9h6"/>',
      arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
      pin: '<path d="m14.5 4.5 5 5-2.4 2.4-.3 4.1-2.4 2.4-1.8-4.1-3.2-3.2-4.1-1.8 2.4-2.4 4.1-.3z"/><path d="m13 13-5.5 5.5M7 18.5l-1.5 1.5"/>',
      task: '<rect x="5" y="4" width="14" height="16" rx="3"/><path d="M9 9h6M9 13h6M9 17h3"/>',
      check: '<path d="m5 12 4 4L19 6"/>',
      search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
      close: '<path d="m7 7 10 10M17 7 7 17"/>',
    };
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (paths[kind] || paths.task) + '</svg>';
  }

  function artifactRows(state) {
    const trace = state && state.trace || {};
    const rows = [];
    [state && state.outputs, trace.artifacts, state && state.evidence].forEach((list) => {
      if (Array.isArray(list)) list.forEach((item) => rows.push(item));
    });
    const seen = new Set();
    return rows.filter((item) => {
      const value = item && typeof item === 'object' ? item : { name: item };
      const name = text(value.name || value.title || value.filename || value.path, '');
      if (!name || seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  }

  function criteriaRows(task) {
    const value = task && (task.acceptanceCriteria || task.acceptance || task.criteria);
    if (Array.isArray(value)) return value.map((item) =>
      typeof item === 'object' ? (item.text || item.title || item.name) : item).filter(Boolean);
    if (value) return String(value).split(/\r?\n|；|;/).map((item) => item.trim()).filter(Boolean);
    return [];
  }

  function rawGate(state, keys) {
    const task = state && state.task || {};
    const execution = state && state.execution || {};
    const trace = state && state.trace || {};
    const gates = state && state.gates || task.gates || execution.gates || trace.gates;
    const candidates = [];
    if (Array.isArray(gates)) {
      gates.forEach((item) => {
        if (item && keys.some((key) => String(item.key || item.name || item.type || '').toLowerCase().includes(key))) {
          candidates.push(item);
        }
      });
    } else if (gates && typeof gates === 'object') {
      keys.forEach((key) => { if (gates[key] != null) candidates.push(gates[key]); });
    }
    keys.forEach((key) => {
      [state && state[key], task[key], execution[key], trace[key]].forEach((item) => {
        if (item != null) candidates.push(item);
      });
    });
    return firstValue(candidates);
  }

  function gateInfo(value, fallback, required) {
    if (value == null) {
      return { label: required ? '待确认' : fallback, tone: required ? 'waiting' : 'idle' };
    }
    const raw = typeof value === 'object'
      ? first([value.status, value.state, value.result, value.phase, value.label], fallback)
      : String(value);
    const lower = raw.toLowerCase().replace(/-/g, '_');
    if (/approve|pass|success|complete|succeed|通过|已完成/.test(lower)) {
      return { label: /approve|pass|success|complete|succeed/.test(lower) ? '已通过' : raw, tone: 'done' };
    }
    if (/fail|reject|block|error|失败|驳回|阻断/.test(lower)) return { label: raw, tone: 'failed' };
    if (/run|doing|active|progress|执行|进行/.test(lower)) return { label: raw, tone: 'doing' };
    if (/wait|pending|confirm|待|等待/.test(lower)) return { label: raw, tone: 'waiting' };
    if (/none|skip|not_required|无需|不需要/.test(lower)) return { label: raw, tone: 'idle' };
    return { label: raw, tone: 'idle' };
  }

  function isCloudConversation(state) {
    return Boolean(state && (
      state.cloudHandoff?.phase === 'committed' ||
      state.snapshot?.cloudHandoff?.phase === 'committed' ||
      state.execution?.cloud === true || state.execution?.mode === 'cloud' ||
      state.snapshot?.execution?.cloud === true || state.snapshot?.execution?.mode === 'cloud'
    ));
  }

  function gateRows(state, status, phase) {
    const task = state && state.task || {};
    const cloud = isCloudConversation(state);
    const approvalRequired = !cloud && Boolean(task.approvalRequired || task.requiresApproval ||
      state.approvalRequired || state.requiresApproval);
    const reviewValue = rawGate(state, ['ai_review', 'aireview', 'review']);
    const review = gateInfo(reviewValue, '未开始');
    if (!reviewValue && phase === 'verify' && !isTerminal(status)) {
      review.label = '进行中'; review.tone = 'doing';
    }
    const human = gateInfo(rawGate(state, ['human_approval', 'approval', 'approve']), '按策略', approvalRequired);
    const merge = gateInfo(rawGate(state, ['auto_merge', 'merge']), '未开始');
    const release = gateInfo(rawGate(state, ['release', 'publish', 'deploy']), '未开始');
    const health = gateInfo(rawGate(state, ['health', 'health_check', 'smoke']), '未开始');
    return [
      ['AI Review', review], ['人工审批', human], ['自动合并', merge],
      ['发布', release], ['健康检查', health],
    ].filter((_row, index) => [
      reviewValue != null,
      !cloud && (approvalRequired || rawGate(state, ['human_approval', 'approval', 'approve']) != null),
      rawGate(state, ['auto_merge', 'merge']) != null,
      rawGate(state, ['release', 'publish', 'deploy']) != null,
      rawGate(state, ['health', 'health_check', 'smoke']) != null,
    ][index]);
  }

  function statusPill(info) {
    return '<span class="ncollab-gate-status is-' + esc(info.tone) + '">' +
      '<i></i>' + esc(info.label) + '</span>';
  }

  function renderStages(state, status, phase) {
    const traceStages = (state.trace || {}).stages;
    const rows = Array.isArray(traceStages) && traceStages.length
      ? traceStages.map(stage => ({ label: stage.name || stage.label || stage.title || '执行步骤',
          status: normalizeStatus(stage.state || stage.status || 'pending') }))
      : [{ label: '需求已创建', status: 'completed' },
         { label: '执行', status: isTerminal(status) ? 'completed' :
           state.execution && state.execution.startedAt ? status : 'pending' },
         { label: '返回结果', status: isTerminal(status) ? status : 'pending' }];
    return '<ol class="ncollab-dossier-stages">' + rows.map((stage, index) => {
      const stateClass = /^(completed|complete|done|delivered)$/.test(stage.status) ? 'done'
        : /fail|block|error|unreachable|incomplete/.test(stage.status) ? 'failed'
        : /running|doing|executing|waiting|dispatching/.test(stage.status) ? 'active' : 'pending';
      const label = stateClass === 'pending' ? '待开始' : (LABELS[stage.status] || stage.status);
      return '<li class="is-' + stateClass + '"><span class="ncollab-stage-marker">' +
        (stateClass === 'done' ? icon('check') : index + 1) + "</span><b data-user-content>" +
        esc(stage.label) + '</b><em>' + esc(label) + '</em></li>';
    }).join('') + '</ol>';
  }

  function executionMetrics(execution, task) {
    const usage = execution.usage || {};
    const tokenObject = execution.tokens && typeof execution.tokens === 'object' ? execution.tokens : {};
    const sessions = Array.isArray(execution.sessions) ? execution.sessions.filter(Boolean) : [];
    const total = [usage.totalTokens, usage.total, tokenObject.total,
      typeof execution.tokens === 'number' ? execution.tokens : null]
      .find(value => value != null && Number.isFinite(Number(value)) && Number(value) > 0);
    const partial = Number(tokenObject.input || 0) + Number(tokenObject.output || 0);
    // Hub records duration and usage per session; the execution trace contains the session list.
    // Aggregate those values for the task. Without sessions, use the task's
    // actualStart/actualEnd timestamps for duration. If usage has no source,
    // show it as unavailable. session.tokens is the current context size, overwritten each step;
    // only usage represents cumulative consumption.
    const parseTime = value => {
      if (value == null) return null;
      // task.actualStart/actualEnd are milliseconds; execution.startedAt is an ISO timestamp.
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      const t = Date.parse(value); return Number.isFinite(t) ? t : null;
    };
    const firstTime = (...candidates) => {
      for (const value of candidates) { const t = parseTime(value); if (t != null) return t; }
      return null;
    };
    const sessionTokens = sessions.reduce((sum, item) => {
      const u = (item && item.usage) || {};
      const value = [u.totalTokens, u.total]
        .find(v => v != null && Number.isFinite(Number(v)) && Number(v) > 0);
      return sum + (value != null ? Number(value) : 0);
    }, 0);
    const tokens = total != null ? Number(total).toLocaleString()
      : partial ? partial.toLocaleString()
      : sessionTokens ? sessionTokens.toLocaleString() : '未提供';
    const starts = sessions.map(item => parseTime(item && item.startedAt)).filter(t => t != null);
    const ends = sessions.map(item => parseTime(item && item.finishedAt)).filter(t => t != null);
    const start = starts.length ? Math.min(...starts)
      : firstTime(execution.startedAt, task && task.actualStart);
    const end = ends.length ? Math.max(...ends)
      : (firstTime(execution.finishedAt, task && task.actualEnd)
        ?? (start != null ? Date.now() : null));
    const seconds = start != null && end != null
      ? Math.max(0, Math.round((end - start) / 1000)) : null;
    return {
      tokens,
      duration: seconds == null ? first([execution.durationText], '未提供')
        : seconds < 60 ? seconds + ' 秒' : Math.floor(seconds / 60) + ' 分 ' + (seconds % 60) + ' 秒',
    };
  }

  function renderDossier(value, status, phase, a, artifacts, tab) {
    const task = value.task || {};
    const execution = value.execution || {};
    const title = text(task.title, '当前协作需求');
    const target = text(task.description || task.note || value.goal, '添加需求描述，让执行目标更清楚。');
    const criteria = criteriaRows(task);
    const gates = gateRows(value, status, phase);
    const { duration, tokens } = executionMetrics(execution, task);
    const retries = first([execution.retryCount, value.retryCount], '0');
    const action = currentAction(status, phase);
    const executionOnly = !isCloudConversation(value) && isTerminal(status) && task.status && !['done', 'completed', 'complete'].includes(task.status);
    const completionLabel = executionOnly ? '执行完成 · 需求待确认' : (LABELS[status] || '准备中');
    const titleRow = label => '<div class="ncollab-section-label"><b>' + label + '</b></div>';
    const section = (label, body, cls) => '<section class="ncollab-dossier-section ' + (cls || '') + '">' + titleRow(label) + body + '</section>';
    const evidence = artifacts.length
      ? '<div class="ncollab-evidence-list">' + artifacts.map((item) => {
        const row = item && typeof item === 'object' ? item : { name: item };
        return '<div class="ncollab-evidence-row"><span>' + icon('task') + '</span><div><b>' +
          esc(text(row.name || row.title || row.filename || row.path, '成果')) + '</b><small>' +
          esc(row.kind || row.type || '交付证据') + '</small></div></div>';
      }).join('') + '</div>'
      : '<p class="ncollab-dossier-empty">暂未产生交付成果。文件、截图和验证报告产生后会汇总在这里。</p>';
    const acceptance = criteria.length
      ? '<ul class="ncollab-checklist">' + criteria.map(item =>
        '<li><span class="ncollab-check" aria-hidden="true"></span><p>' + esc(item) + '</p></li>').join('') + '</ul>'
      : '<p class="ncollab-dossier-empty">暂未单独填写验收标准，以需求描述为准。</p>';
    const config = '<div class="ncollab-config-grid"><div><small>Agent</small><b>' + esc(a.agent) +
      '</b></div><div><small>执行位置</small><b>' + (a.remote ? '远程执行' : '本机执行') +
      '</b></div><div class="is-wide"><small>执行机 · Runner</small><b>' + esc(a.runner) +
      '</b></div><div class="is-wide"><small>模型</small><b>' + esc(a.model) +
      '</b></div><div><small>工程</small><b>' + esc(a.project) + '</b></div><div><small>分支</small><b>' +
      esc(a.branch) + '</b></div></div>';
    const tabs = [['task', '需求与进度'], ['execution', '执行配置'], ['artifacts', '成果', artifacts.length]];
    const panel = (key, body) => '<div class="ncollab-tab-panel" id="ncollab-panel-' + key +
      '" role="tabpanel" aria-labelledby="ncollab-tab-' + key + '"' + (tab !== key ? ' hidden' : '') + '>' + body + '</div>';
    return '<aside class="ncollab-dossier" role="dialog" aria-modal="false" aria-labelledby="ncollabTitle" tabindex="-1" data-collab-dossier>' +
      '<header class="ncollab-dossier-head"><div class="ncollab-dossier-eyebrow">' + icon('task') +
      '<span>会话需求</span></div><h2 id="ncollabTitle">' + esc(title) + '</h2>' +
      '<div class="ncollab-dossier-meta"><span class="ncollab-dossier-status is-' + esc(status) + '"><i></i>' +
      esc(completionLabel) + '</span><span>' + esc(a.agent) + ' · ' + (a.remote ? '远程执行' : '本机执行') + '</span></div>' +
      '<button type="button" class="ncollab-close" data-collab-close aria-label="关闭需求详情">' + icon('close') + '</button></header>' +
      '<div class="ncollab-tabs" role="tablist" aria-label="需求详情内容">' + tabs.map(([key, label, count]) =>
        '<button type="button" role="tab" id="ncollab-tab-' + key + '" data-collab-tab="' + key +
        '" aria-controls="ncollab-panel-' + key + '" aria-selected="' + (tab === key) + '" tabindex="' + (tab === key ? 0 : -1) +
        '">' + label + (count != null ? '<small>' + count + '</small>' : '') + '</button>').join('') + '</div>' +
      '<div class="ncollab-dossier-scroll">' +
      panel('task', section('需求目标', '<p>' + esc(target) + '</p>', 'ncollab-dossier-objective') +
        section('验收标准', acceptance) + section('流程进度', renderStages(value, status, phase)) +
        (gates.length ? section('审批与发布', '<div class="ncollab-gates">' + gates.map(row =>
          '<div class="ncollab-gate-row"><span>' + esc(row[0]) + '</span>' + statusPill(row[1]) + '</div>').join('') + '</div>') : '')) +
      panel('execution', section('执行配置', config)) +
      panel('artifacts', section('成果与证据', evidence)) +
      '</div><footer class="ncollab-dossier-foot"><div class="ncollab-metrics"><div><span>已用时</span><b>' + esc(duration) +
      '</b></div><div><span>重试</span><b>' + esc(retries) + ' 次</b></div><div><span>Token</span><b>' + esc(tokens) +
      '</b></div></div>' + (action.key === 'retry' || action.key === 'start' || /^waiting/.test(status)
        ? '<button type="button" class="ncollab-dossier-action" data-collab-action="' + action.key + '">' +
          esc(action.label) + '</button>' : '') + '</footer></aside>';
  }

  function renderPicker(picker, ui) {
    const tasks = Array.isArray(picker.tasks) ? picker.tasks : [];
    const policy = global.RequirementSessionContext, context = picker.context || {};
    const projects = [...new Map(tasks.filter(t => t.projectId).map(t => [t.projectId, t.projectName || t.project?.name || t.projectId])).entries()];
    const canScope = Boolean(tasks.length && (context.projectId || context.repoId || projects.length));
    if (!tasks.some(task => String(task.id) === ui.selection)) ui.selection = '';
    const selected = tasks.find(task => String(task.id) === ui.selection);
    const busy = Boolean(picker.submitting);
    const project = task => text(task.projectName || (task.project || {}).name || task.repoName ||
      (task.workRouting || {}).projectName || task.source, '独立需求');
    const rows = tasks.map(task => {
      const title = text(task.title || task.name, '未命名需求'), meta = project(task);
      const reason = policy?.compatibility(task, context) || '', relation = policy?.relation(task,context) || 'unbound';
      const checked = String(task.id) === ui.selection;
      return '<button type="button" class="ncollab-picker-row" role="radio" aria-checked="' + checked +
        '" tabindex="' + (checked || !ui.selection && task === tasks[0] ? 0 : -1) +
        '" data-collab-task-select="' + esc(task.id) + '" data-task-title="' + esc(title + ' ' + meta) +
        '" data-project-id="' + esc(task.projectId || '') + '" data-related="' + (['project','repo'].includes(relation) ? 'true' : 'false') +
        '"' + (busy || reason ? ' disabled' : '') + '><span class="ncollab-picker-task-icon">' + icon('task') +
        '</span><span class="ncollab-picker-copy"><b>' + esc(title) +
        '</b><small>' + esc(meta) + '</small>' + (reason ? '<small class="ncollab-picker-reason">' + esc(reason) + '</small>' : '') +
        '</span><span class="ncollab-picker-radio">' + icon('check') + '</span></button>';
    }).join('');
    return '<div class="ncollab-picker" role="dialog" aria-modal="false" aria-labelledby="ncollabPickerTitle" aria-busy="' + busy + '">' +
      '<header class="ncollab-picker-head"><span class="ncollab-picker-mark">' + icon('queue') +
      '</span><div><h2 id="ncollabPickerTitle">选择需求</h2></div>' +
      '<button type="button" class="ncollab-close" data-collab-picker-close aria-label="关闭需求选择">' + icon('close') + '</button></header>' +
      '<label class="ncollab-picker-search">' + icon('search') +
      '<input type="search" data-collab-search aria-label="搜索待办需求" placeholder="搜索需求名称或工程"' +
      (busy ? ' disabled' : '') + '></label>' +
      (canScope ? '<div class="ncollab-picker-context"><select data-collab-project-scope aria-label="按项目筛选需求"' + (busy ? ' disabled' : '') + '>' +
      (context.projectId || context.repoId ? '<option value="related"' + (ui.scope === 'related' ? ' selected' : '') + '>本项目 / 本工程</option>' : '') +
      '<option value="all"' + (ui.scope === 'all' ? ' selected' : '') + '>全部需求</option>' +
      projects.map(([id,name]) => '<option data-user-content value="' + esc(id) + '"' + (ui.scope === id ? ' selected' : '') + '>' + esc(name) + '</option>').join('') + '</select></div>' : '') +
      '<div class="ncollab-picker-caption"><span>可添加的待办 <b data-collab-match-count>' + tasks.length +
      '</b></span></div>' +
      (picker.error ? '<div class="ncollab-picker-error" role="alert"><span>' + esc(picker.error) +
        '</span><button type="button" data-collab-picker-retry' + (busy ? ' disabled' : '') + '>重试</button></div>' : '') +
      '<div class="ncollab-picker-list" role="radiogroup" aria-label="选择要加入的待办需求">' +
      (picker.loading ? '<div class="ncollab-picker-empty" role="status"><span class="ncollab-notice-spinner"></span><b>正在读取待办需求</b></div>' :
        rows || (picker.error ? '' : '<div class="ncollab-picker-empty">' + icon('check') +
        '<b>暂无可添加的待办</b></div>')) +
      '<div class="ncollab-picker-empty" data-collab-no-match hidden>' + icon('search') +
      '<b>没有找到匹配的需求</b></div></div>' +
      '<footer class="ncollab-picker-foot"><div><b data-collab-selection-title title="' + esc(selected && selected.title || '') + '">' +
      esc(selected && (selected.title || selected.name) || '未选择需求') +
      '</b></div><button type="button" class="ncollab-picker-submit" data-collab-picker-submit' +
      (!selected || busy || picker.loading || policy?.compatibility(selected,context) ? ' disabled' : '') + '>' + (busy ? '<span class="ncollab-notice-spinner"></span>正在确认…' :
      '在本会话执行' + icon('arrow')) + '</button></footer></div>';
  }

  function renderView(host, state, fire, pin, collapsed, ui) {
    const value = state || {};
    const singularTask = value.task || {};
    const singularId = text(value.taskId || singularTask.id, '');
    const rows = Array.isArray(value.tasks) && value.tasks.length
      ? value.tasks
      : (singularId ? [Object.assign({}, value, { taskId: singularId, task: singularTask })] : []);
    // Goal mode alone must not occupy the collaboration sidebar; require an attached requirement.
    // Ordinary and requirement-free goal conversations retain a full-width message stream.
    const collaboration = Boolean(rows.length);
    if (!collaboration && !(value.picker && value.picker.open)) {
      return ui.setMarkup('');
    }
    const activeId = String(value.activeTaskId || singularId || (rows[0] && rows[0].taskId) || '');
    const activeRow = rows.find((row) => String(row.taskId || (row.task || {}).id || '') === activeId) || rows[0] || value;
    const activeTask = activeRow.task || {};
    const activeValue = Object.assign({}, value, activeRow, {
      taskId: String(activeRow.taskId || activeTask.id || activeId),
      task: activeTask,
      activeTaskId: activeId,
    });
    const execution = activeValue.execution || {};
    const status = normalizeStatus(activeValue.status || execution.status || activeTask.status);
    const phase = phaseOf(activeValue);
    const a = actors(activeValue);
    const statusLabel = LABELS[status] || '准备中';
    const artifacts = artifactRows(activeValue);
    const collapsedClass = collapsed ? ' is-collapsed' : '';
    const pickerOpen = Boolean(value.picker && value.picker.open);
    const picker = pickerOpen ? renderPicker(value.picker, ui) : '';
    const sessionNotice = activeValue.taskOpenPending
      ? '<div class="ncollab-session-notice is-pending"><span class="ncollab-notice-spinner"></span><div><b>正在建立协作会话</b><small>需求信息已保存，正在连接可用的 Agent 与执行机</small></div></div>'
      : activeValue.taskOpenError
        ? '<div class="ncollab-session-notice is-error"><span class="ncollab-notice-mark">!</span><div><b>协作会话暂时不可用</b><small>' +
          esc(short(activeValue.taskOpenError, '', 180)) + '</small></div><button type="button" data-collab-action="reopen">重试连接</button></div>'
        : '';
    const dossier = pin === 'dossier' && activeId && !pickerOpen
      ? renderDossier(activeValue, status, phase, a, artifacts, ui.tab).replace('data-collab-dossier', 'id="ncollabDossier" data-collab-dossier')
      : '';
    const html =
      '<section class="ncollab ncollab-scene ncollab-anchor' + collapsedClass + '" data-task-id="' + esc(activeId) + '" aria-label="协作需求">' +
      picker + sessionNotice + dossier + '</section>';
    // Provider deltas must not replace a button between pointerdown and click,
    // or replace the search input while a user is composing Chinese text.
    if (!ui.setMarkup(html)) return false;
    const currentValue = () => {
      const latest = ui.getState();
      const row = (latest.tasks || []).find(item => String(item.taskId || item.task?.id || '') === activeId);
      return Object.assign({}, latest, row || {}, { taskId: activeId });
    };
    host.querySelectorAll('[data-collab-task-select]').forEach((button) => button.addEventListener('click', () => {
      const taskId = button.getAttribute('data-collab-task-select');
      if (button.hasAttribute('data-collab-pin')) {
        if (taskId === activeId && pin === 'dossier' && !pickerOpen) ui.close();
        else { ui.tab = 'task'; ui.search = ''; fire && fire('open-task', Object.assign({}, ui.getState(), { taskId, pin: 'dossier' })); }
      } else {
        if (!ui.getState().picker?.submitting) { ui.selection = taskId; ui.selectTask(); }
      }
    }));
    host.querySelectorAll('[data-collab-add]').forEach((button) => button.addEventListener('click', () =>
      ui.add()));
    const close = host.querySelector('[data-collab-close]');
    if (close) close.addEventListener('click', () =>
      ui.close());
    const pickerClose = host.querySelector('[data-collab-picker-close]');
    if (pickerClose) pickerClose.addEventListener('click', () => ui.close());
    host.querySelectorAll('[data-collab-action]').forEach((button) => button.addEventListener('click', () =>
      fire && fire(button.getAttribute('data-collab-action'), currentValue())));
    host.querySelectorAll('[data-collab-tab]').forEach(button => {
      button.addEventListener('click', () => ui.selectTab(button.getAttribute('data-collab-tab')));
      button.addEventListener('keydown', event => {
        const keys = ['task', 'execution', 'artifacts'];
        let index = keys.indexOf(button.getAttribute('data-collab-tab'));
        if (event.key === 'ArrowRight') index = (index + 1) % keys.length;
        else if (event.key === 'ArrowLeft') index = (index + keys.length - 1) % keys.length;
        else if (event.key === 'Home') index = 0;
        else if (event.key === 'End') index = keys.length - 1;
        else return;
        event.preventDefault(); ui.selectTab(keys[index]);
      });
    });
    const submit = host.querySelector('[data-collab-picker-submit]');
    if (submit) submit.addEventListener('click', () => {
      if (!submit.disabled && ui.selection) fire && fire('select-task', Object.assign({}, ui.getState(), { taskId: ui.selection }));
    });
    const retry = host.querySelector('[data-collab-picker-retry]');
    const projectScope = host.querySelector('[data-collab-project-scope]');
    if (projectScope) projectScope.addEventListener('change', () => { ui.scope = projectScope.value; ui.selection = ''; ui.selectTask(); });
    if (retry) retry.addEventListener('click', () => fire && fire('add-task', ui.getState()));
    host.querySelectorAll('.ncollab-picker-row').forEach(button => button.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const choices = Array.from(host.querySelectorAll('.ncollab-picker-row')).filter(row => !row.hidden && !row.disabled);
      if (!choices.length) return;
      let index = choices.indexOf(button);
      index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 :
        (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      event.preventDefault(); ui.selection = choices[index].getAttribute('data-collab-task-select'); ui.selectTask();
    }));
    const search = host.querySelector('[data-collab-search]');
    if (search) {
      search.value = ui.search;
      search.addEventListener('input', () => { ui.search = search.value; ui.filter(); });
    }
    return true;
  }

  function mergeEvents(left, right) {
    const map = new Map();
    [].concat(Array.isArray(left) ? left : [], Array.isArray(right) ? right : [])
      .forEach((item, index) => {
        if (!item || typeof item !== 'object') return;
        const sequence = Number(item.eventSequence || item.sequence || item.seq || 0);
        const key = String(item.eventId || item.id || (sequence ? 'seq:' + sequence : 'row:' + index));
        const old = map.get(key);
        if (!old || sequence >= Number(old.eventSequence || old.sequence || old.seq || 0)) map.set(key, item);
      });
    return Array.from(map.values()).sort((a, b) =>
      Number(a.eventSequence || a.sequence || a.seq || 0) -
      Number(b.eventSequence || b.sequence || b.seq || 0));
  }

  function create(options) {
    const opts = options || {}, host = opts.host;
    const doc = host && host.ownerDocument;
    let state = {}, pin = '', collapsed = false, destroyed = false, drawKey = '', visiblePanel = '', markup;
    let pressed = null, pendingPaint = false, paintTimer = null;
    const scrolls = new Map();
    const ui = {
      tab: 'task', search: '', selection: '', scope: 'all',
      getState: () => state,
      setMarkup(html) {
        if (markup === html) return false;
        host.innerHTML = html; markup = html; return true;
      },
      selectTask() { draw(); const row = Array.from(host.querySelectorAll('.ncollab-picker-row')).find(n => n.getAttribute('data-collab-task-select') === ui.selection); if (row) { row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest' }); } },
      filter() {
        const needle = ui.search.trim().toLocaleLowerCase();
        let matches = 0;
        host.querySelectorAll('[data-task-title]').forEach(button => {
          const inScope = ui.scope === 'all' || (ui.scope === 'related' ? button.getAttribute('data-related') === 'true' : button.getAttribute('data-project-id') === ui.scope);
          button.hidden = !inScope || !button.getAttribute('data-task-title').toLocaleLowerCase().includes(needle);
          if (!button.hidden) matches++;
        });
        const empty = host.querySelector('[data-collab-no-match]');
        if (empty) empty.hidden = matches > 0 || !state.picker?.tasks?.length || Boolean(state.picker && (state.picker.loading || state.picker.error));
        const count = host.querySelector('[data-collab-match-count]');
        if (count) count.textContent = matches;
        const rows = Array.from(host.querySelectorAll('.ncollab-picker-row'));
        const selected = rows.find(row => !row.hidden && !row.disabled && row.getAttribute('data-collab-task-select') === ui.selection);
        rows.forEach(row => row.tabIndex = row === (selected || rows.find(n => !n.hidden && !n.disabled)) ? 0 : -1);
        // A search must not leave a hidden task armed for submission.
        if (ui.selection && !selected && !state.picker?.submitting) {
          ui.selection = '';
          rows.forEach(row => row.setAttribute('aria-checked', 'false'));
          const submit = host.querySelector('[data-collab-picker-submit]');
          if (submit) submit.disabled = true;
          const title = host.querySelector('[data-collab-selection-title]');
          if (title) { title.textContent = '选择一项待办需求'; title.title = ''; }
        }
      },
      close(restoreFocus = true) {
        const wasPicker = Boolean(state.picker && state.picker.open);
        pin = ''; ui.search = ''; ui.selection = '';
        if (wasPicker && opts.onAction) opts.onAction('picker-close', state);
        draw();
        if (restoreFocus) {
          const doc = host.ownerDocument;
          const button = wasPicker ? Array.from(doc.querySelectorAll('[data-queue-action="add"]'))
            .find(node => node.getClientRects().length) : Array.from(doc.querySelectorAll('[data-queue-action="detail"],[data-task-receipt]'))
            .find(node => (node.getAttribute('data-task-id') || node.getAttribute('data-task-receipt')) === String(state.activeTaskId || state.taskId || ''));
          if (button && button.focus) button.focus({ preventScroll: true });
        }
      },
      add() {
        if (state.picker && state.picker.open) return ui.close();
        pin = ''; ui.search = '';
        if (opts.onAction) opts.onAction('add-task', state);
        const input = host.querySelector('[data-collab-search]');
        if (input && input.focus) input.focus({ preventScroll: true });
      },
      selectTab(value) {
        ui.tab = value; draw();
        const button = host.querySelector('[data-collab-tab="' + value + '"]');
        if (button && button.focus) button.focus({ preventScroll: true });
      },
    };
    function draw() {
      if (!host || destroyed) return;
      // A list response may change both the DOM and the panel's height while
      // the mouse is held. Finish that click before painting its latest state.
      // Explicit dismissal and a conversation change must still take effect now.
      if (pressed && pressed.sessionId === state.sessionId && (pin || state.picker?.open)) {
        pendingPaint = true; return;
      }
      clearPress();
      pendingPaint = false;
      const scroll = host.querySelector('.ncollab-dossier-scroll,.ncollab-picker-list');
      if (scroll) scrolls.set(drawKey, scroll.scrollTop);
      const focus = doc && doc.activeElement;
      const focusInside = focus && host.contains && host.contains(focus);
      const attributes = ['data-collab-tab', 'data-collab-task-select', 'data-collab-action', 'data-collab-search', 'data-collab-project-scope', 'data-collab-close', 'data-collab-add', 'data-collab-picker-close', 'data-collab-picker-submit', 'data-collab-picker-retry'];
      const focusKey = focusInside && attributes.find(key => focus.hasAttribute(key));
      const focusValue = focusKey ? focus.getAttribute(focusKey) : '';
      const selection = focusKey === 'data-collab-search' ? [focus.selectionStart, focus.selectionEnd] : null;
      drawKey = state.picker && state.picker.open ? 'picker' : String(state.activeTaskId || state.taskId || '') + ':' + ui.tab;
      if (!renderView(host, state, opts.onAction, pin, collapsed, ui)) return;
      const panelKind = state.picker && state.picker.open ? 'picker' : pin;
      const panel = host.querySelector(panelKind === 'picker' ? '.ncollab-picker' : '[data-collab-dossier]');
      if (panel && panelKind !== visiblePanel && panel.classList) panel.classList.add('is-opening');
      const openedPicker = panelKind === 'picker' && visiblePanel !== 'picker';
      visiblePanel = panelKind;
      if (openedPicker && !focusKey) {
        const input = host.querySelector('[data-collab-search]');
        if (input) input.focus({ preventScroll: true });
      }
      const next = host.querySelector('.ncollab-dossier-scroll,.ncollab-picker-list');
      if (next) next.scrollTop = openedPicker ? 0 : scrolls.get(drawKey) || 0;
      ui.filter();
      if (focusKey) {
        const target = Array.from(host.querySelectorAll('[' + focusKey + ']')).find(node => node.getAttribute(focusKey) === focusValue);
        if (target && target.focus) {
          target.focus({ preventScroll: true });
          if (selection && selection[0] != null && target.setSelectionRange && target.type !== 'search') target.setSelectionRange(...selection);
        }
      }
    }
    function dismiss(event) {
      if (!pin && !(state.picker && state.picker.open)) return;
      if (event.type === 'keydown') {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        // Do not consume Escape belonging to another modal or picker.
        if (doc.activeElement && doc.activeElement.closest && doc.activeElement.closest('[aria-modal="true"]')) return;
        event.preventDefault(); event.stopPropagation(); ui.close();
      } else if (!host.contains(event.target)) ui.close(false);
    }
    function holdPaint(event) {
      if (!host.contains(event.target)) return;
      clearPress();
      pressed = { pointerId: event.pointerId, sessionId: state.sessionId };
    }
    function clearPress() {
      pressed = null;
      if (paintTimer != null) clearTimeout(paintTimer);
      paintTimer = null;
    }
    function releasePaint(event) {
      if (!pressed || event.pointerId != null && event.pointerId !== pressed.pointerId) return;
      if (paintTimer != null) return;
      // pointerup is followed by click; a microtask would repaint too early.
      paintTimer = setTimeout(() => { clearPress(); if (pendingPaint) draw(); }, 0);
    }
    if (doc) {
      doc.addEventListener('keydown', dismiss);
      doc.addEventListener('pointerdown', dismiss);
      doc.addEventListener('pointerdown', holdPaint, true);
      doc.addEventListener('pointerup', releasePaint, true);
      doc.addEventListener('pointercancel', releasePaint, true);
      doc.defaultView?.addEventListener('blur', releasePaint);
    }
    return {
      render(value) {
        const previousId = state.sessionId;
        const wasPicker = Boolean(state.picker && state.picker.open);
        state = value || {};
        if (previousId !== state.sessionId) markup = undefined;
        if (!wasPicker || previousId !== state.sessionId) { ui.search = ''; ui.selection = ''; ui.scope = state.picker?.scope || 'all'; }
        if (previousId && state.sessionId !== previousId) { pin = ''; ui.tab = 'task'; scrolls.clear(); }
        draw();
      },
      setPin(value) {
        pin = String(value || ''); draw();
        const close = host && host.querySelector('[data-collab-close]');
        if (pin && close && close.focus) close.focus({ preventScroll: true });
      },
      setCollapsed(value) { collapsed = Boolean(value); draw(); },
      destroy() {
        destroyed = true; scrolls.clear();
        clearPress(); pendingPaint = false;
        if (doc) {
          doc.removeEventListener('keydown', dismiss); doc.removeEventListener('pointerdown', dismiss);
          doc.removeEventListener('pointerdown', holdPaint, true); doc.removeEventListener('pointerup', releasePaint, true);
          doc.removeEventListener('pointercancel', releasePaint, true); doc.defaultView?.removeEventListener('blur', releasePaint);
        }
        if (host) host.innerHTML = '';
      },
      getState() { return Object.assign({}, state, { pin, collapsed, tab: ui.tab }); },
    };
  }

  function phaseOfCompat(state, legacyStatus) {
    if (arguments.length > 1) {
      if (legacyStatus === 'waiting') return 'verify';
      if (legacyStatus === 'failed') return 'failed';
      if (legacyStatus === 'doing') return 'execute';
      return phaseOf({ status: legacyStatus });
    }
    return phaseOf(state);
  }

  global.ChatCollaboration = {
    create, mergeEvents, normalizeStatus, phaseOf: phaseOfCompat,
    statusLabel: (value) => LABELS[normalizeStatus(value)] || '准备中',
  };
})(window);
