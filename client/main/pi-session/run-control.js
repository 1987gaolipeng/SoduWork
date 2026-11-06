'use strict';

const stallRecovery = require('./stall-recovery');
const toolProgress = require('./tool-progress');

function createState() {
  return {
    startedAt: 0,
    terminalAt: 0,
    lastActivityAt: Date.now(),
    retryWaitUntil: 0,
    retryBudget: require('./model-retry-budget.cjs').create(),
    toolSteps: 0,
    toolProgress: toolProgress.create(),
    stopReason: '',
    stopKind: '',
    monitorTimer: null,
    promptActive: false,
    promptReject: null,
    stalledIncident: null,
    recoveryTimer: null,
    recoveryWaitCancel: null,
    abortPromise: Promise.resolve(),
    stallPending: false,
    protocolPending: null,
    protocolRecoveryCount: 0,
    stallRecoveryCount: 0,
    recoveryReceipt: null,
    toolIds: new Set(),
    activeTools: new Map(),
  };
}

function activeTool(state) {
  return [...state.activeTools.values()].sort((a, b) => a.startedAt - b.startedAt)[0] || null;
}

function continuation(ctx) {
  if (!ctx.visible() || (typeof ctx.closed === 'function' && ctx.closed())) return null;
  const limit = ctx.limitRequest();
  if (limit) return { ...limit };
  if (ctx.qualityPhase() !== 'blocked') return null;
  const harness = ctx.harnessView() || {};
  const focus = harness.focus;
  return {
    kind: 'blocked',
    reason: [ctx.qualityReason(), focus && focus.reason, focus && focus.action]
      .filter(Boolean).join('\n'),
  };
}

function stepLimit(ctx) {
  const value = Number(ctx.maxToolSteps || ctx.maxSteps || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function execution(state, ctx) {
  const waitingPermission = Boolean(state.permissionWaitSince || ctx.waitingPermission?.());
  const now = state.permissionWaitSince || Date.now();
  const elapsedAt = state.terminalAt || now;
  const elapsedMs = state.startedAt ? Math.max(0, elapsedAt - state.startedAt) : 0;
  const status = ctx.status();
  const streaming = !waitingPermission && (state.promptActive || status === 'streaming');
  const activeList = [...state.activeTools.values()].sort((a, b) => a.startedAt - b.startedAt);
  const active = activeList[0] || null;
  const latestProgressAt = activeList.reduce((latest, item) =>
    Math.max(latest, Number(item.lastProgressAt || item.startedAt || 0)), state.lastActivityAt);
  const idleMs = streaming ? Math.max(0, now - latestProgressAt) : 0;
  const limit = ctx.limitRequest();
  return {
    configured: ctx.configured,
    visible: ctx.visible(),
    active: ctx.goalEnabled(),
    elapsedMs,
    waitingPermission,
    budgetMs: ctx.budgetMs,
    step: state.toolSteps,
    maxSteps: ctx.maxSteps,
    maxToolSteps: stepLimit(ctx),
    longRunning: Boolean(streaming && active && now - active.startedAt >= ctx.toolGuard.SOFT_NOTICE_MS),
    stalled: Boolean(streaming && state.startedAt && idleMs >= ctx.toolGuard.STALL_NOTICE_MS),
    idleMs,
    tool: active ? {
      id: active.id, name: active.name,
      elapsedMs: Math.max(0, now - active.startedAt),
      idleMs: Math.max(0, now - active.lastProgressAt),
      kind: active.kind,
      timeoutMs: active.timeoutSeconds ? active.timeoutSeconds * 1000 : 0,
    } : null,
    stopped: Boolean(state.stopReason) && state.stopKind !== 'steering',
    stopKind: state.stopKind || '',
    reason: state.stopKind === 'steering' ? '' : state.stopReason,
    paused: ctx.qualityPhase() === 'paused',
    canContinue: Boolean(continuation(ctx)) && !ctx.inFlight() && !state.stallPending &&
      !ctx.queueSize() && status !== 'waiting-user',
    running: !state.terminalAt && (ctx.inFlight() || state.stallPending),
    finalizing: Boolean(state.terminalAt && ctx.inFlight()),
    terminalAt: Number(state.terminalAt || 0),
    queue: ctx.queueView(),
    queued: ctx.queueSize(),
    limitRequest: limit ? { ...limit, canContinue: !(ctx.inFlight() || ctx.queueSize()) } : null,
    harness: ctx.harnessView(),
    quality: {
      required: ctx.visible(), phase: ctx.qualityPhase(),
      reason: ctx.qualityReason(), rounds: ctx.qualityRounds(),
    },
  };
}

function abortProvider(ctx) {
  try {
    if (ctx.piSession && typeof ctx.piSession.abort === 'function') {
      return Promise.resolve(require('./interrupt').interrupt(ctx.piSession)).catch(() => {});
    }
  } catch (error) { /* the provider may have settled at the same moment */ }
  return Promise.resolve();
}

function stopForLimit(state, kind, reason, ctx) {
  if (state.stopReason) return;
  const configuredSteps = stepLimit(ctx);
  const effectiveReason = kind === 'steps' && configuredSteps && state.toolSteps > configuredSteps
    ? '\u672c\u8f6e\u5df2\u8fbe\u5230 ' + configuredSteps + ' \u6b21\u5de5\u5177\u8c03\u7528\u5b89\u5168\u4e0a\u9650\uff0c\u53e6\u6709 ' +
      (state.toolSteps - configuredSteps) + ' \u4e2a\u5e76\u884c\u8c03\u7528\u5df2\u542f\u52a8\u5e76\u4e00\u5e76\u505c\u6b62\u3002\u5f53\u524d\u8fdb\u5ea6\u548c\u6587\u4ef6\u90fd\u5df2\u4fdd\u7559\u3002'
    : reason;
  state.stopReason = effectiveReason;
  const goalMode = typeof ctx.goalEnabled === 'function' && ctx.goalEnabled();
  const limit = {
    kind,
    reason: effectiveReason,
    used: kind === 'tool-loop' ? state.toolProgress.noProgress : kind === 'steps' ? state.toolSteps : ctx.goalBudgetMinutes,
    limit: kind === 'tool-loop' ? toolProgress.MAX_NO_PROGRESS : kind === 'steps' ? configuredSteps : ctx.goalBudgetMinutes,
    unit: kind === 'tool-loop' || kind === 'steps' ? '\u6b21\u5de5\u5177\u8c03\u7528' : '\u5206\u949f',
  };
  // Goal runs expose a resumable pause card.  Normal conversations have no
  // goal state to pause; retain the notice and abort the provider instead of
  // manufacturing a hidden goal that blocks the next user turn.
  if (goalMode) {
    ctx.setLimitRequest(limit);
    ctx.setQuality('paused', effectiveReason);
    ctx.checkpoint('run.paused', limit);
  } else if (['steps', 'tool-loop'].includes(kind) && ctx.acc && typeof ctx.acc.appendNotice === 'function') {
    ctx.acc.appendNotice(effectiveReason, 'error');
  }
  ctx.acc.abort();
  abortProvider(ctx);
  ctx.emit({ kind: 'budget-stopped' });
}

function stopStalledTool(state, tool, ctx) {
  if (state.stopReason || !tool) return;
  const seconds = Math.max(1, Math.round((Date.now() - tool.startedAt) / 1000));
  const prefix = '“' + (tool.name || '当前工具') + '”已连续运行 ' + seconds + ' 秒仍未结束。';
  const reason = prefix + '正在取消该步骤并等待退出，已有文件和输出会保留。';
  state.stopReason = reason;
  state.stopKind = 'tool-stall';
  if (ctx.goalIntent === 'goal') {
    const limit = {
      kind: 'stall', reason,
      used: seconds, limit: Math.round(tool.hardLimitMs / 1000), unit: '\u79d2',
    };
    ctx.setLimitRequest(limit);
    ctx.setQuality('paused', reason);
    ctx.checkpoint('run.paused', limit);
  }
  ctx.acc.abort();
  // A request to abort is not proof of termination. Keep active tool facts
  // until their real end events, and let the queue await native settlement.
  const stopping = state.abortPromise = abortProvider(ctx);
  stopping.then(() => {
    if (state.abortPromise !== stopping || state.stopKind !== 'tool-stall' || ctx.piSession?.isIdle !== true) return;
    state.stopReason = prefix + '该步骤已退出，已有文件和输出已保留；可以继续对话。';
    const limit = ctx.limitRequest?.();
    if (limit?.kind === 'stall') {
      ctx.setLimitRequest({ ...limit, reason: state.stopReason });
      ctx.setQuality('paused', state.stopReason);
    }
    ctx.emit({ kind: 'tool-stop-confirmed', reason: state.stopReason });
  });
  ctx.emit({ kind: 'tool-stalled', reason });
}

function stopStalledAgent(state, ctx) {
  if (state.stopReason || !state.promptActive || state.activeTools.size) return;
  const now = Date.now();
  const idleMs = Math.max(0, now - state.lastActivityAt);
  const message = stallRecovery.reason(idleMs);
  state.stopReason = message;
  state.stalledIncident = { reason: message, idleMs, at: now };
  const reject = state.promptReject;
  state.promptReject = null;
  if (typeof reject === 'function') reject(stallRecovery.error(message));
  ctx.acc.abort();
  state.abortPromise = abortProvider(ctx);
  ctx.emit({ kind: 'agent-stalled', reason: message, idleMs });
}

function stopProtocolIssue(state, issue, ctx) {
  if (state.stopReason) return;
  const reason = ctx.protocolGuard.reason(issue);
  state.stopReason = reason;
  if (ctx.goalEnabled()) {
    const limit = {
      kind: 'protocol', reason,
      code: issue && issue.code || ctx.protocolGuard.CODE,
      used: Number(issue && issue.parameters || 0), limit: 1,
      unit: '\u6b21\u81ea\u52a8\u6062\u590d',
    };
    ctx.setLimitRequest(limit);
    ctx.setQuality('paused', reason);
    ctx.checkpoint('run.paused', limit);
  }
  ctx.acc.abort();
  state.abortPromise = abortProvider(ctx);
  ctx.emit({ kind: 'protocol-stopped', issue: {
    code: issue && issue.code || ctx.protocolGuard.CODE,
    parameters: Number(issue && issue.parameters || 0),
  } });
}

function observeEvent(state, ev, executionPolicy) {
  toolProgress.observe(state.toolProgress, ev);
  state.lastActivityAt = Date.now();
  if (ev?.type === 'auto_retry_start') state.retryWaitUntil = state.lastActivityAt + Math.max(0, Number(ev.delayMs) || 0);
  else if (['auto_retry_end', 'message_start', 'agent_settled'].includes(ev?.type)) state.retryWaitUntil = 0;
  if (ev?.type === 'compaction_start') state.compactingSince = state.lastActivityAt;
  if (ev?.type === 'compaction_end') state.compactingSince = 0;
  if (ev && ev.type === 'agent_start' && !state.startedAt) state.startedAt = state.lastActivityAt;
  if (ev && ev.type === 'tool_execution_start') {
    const id = String(ev.toolCallId || '');
    if (!id || !state.toolIds.has(id)) {
      if (id) state.toolIds.add(id);
      state.toolSteps += 1;
    }
    if (id) {
      state.activeTools.set(id, {
        id, name: String(ev.toolName || '\u5de5\u5177'), startedAt: state.lastActivityAt,
        lastProgressAt: state.lastActivityAt,
        ...executionPolicy(ev.toolName, ev.args),
      });
    }
  } else if (ev && ev.type === 'tool_execution_update') {
    const tool = state.activeTools.get(String(ev.toolCallId || ''));
    if (tool) tool.lastProgressAt = state.lastActivityAt;
  } else if (ev && ev.type === 'tool_execution_end') {
    state.activeTools.delete(String(ev.toolCallId || ''));
  }
}

async function promptComplete(state, rawPrompt, prompt, options) {
  state.promptActive = true;
  let rejectStall;
  const stalled = new Promise((_, reject) => { rejectStall = reject; });
  state.promptReject = rejectStall;
  try {
    return await Promise.race([rawPrompt(prompt, options), stalled]);
  } finally {
    if (state.promptReject === rejectStall) state.promptReject = null;
    state.promptActive = false;
  }
}

function permissionWait(state, waiting) {
  const now = Date.now();
  if (waiting) { if (!state.permissionWaitSince) state.permissionWaitSince = now; return; }
  if (!state.permissionWaitSince) return;
  const duration = now - state.permissionWaitSince;
  if (state.startedAt) state.startedAt += duration;
  state.lastActivityAt = now;
  for (const tool of state.activeTools.values()) { tool.startedAt += duration; tool.lastProgressAt = now; }
  state.permissionWaitSince = 0;
}

function startMonitor(state, ctx) {
  state.monitorTimer = setInterval(() => {
    if (!state.promptActive || !state.startedAt || state.permissionWaitSince || ctx.waitingPermission?.()) return;
    const now = Date.now();
    if (ctx.goalEnabled() && ctx.budgetMs && now - state.startedAt >= ctx.budgetMs) {
      stopForLimit(state, 'time', '\u672c\u8f6e\u5df2\u8fd0\u884c ' + ctx.goalBudgetMinutes +
        ' \u5206\u949f\uff0c\u5f53\u524d\u8fdb\u5ea6\u548c\u6587\u4ef6\u90fd\u5df2\u4fdd\u7559\u3002', ctx);
      return;
    }
    const tool = activeTool(state);
    if (tool && now - tool.startedAt >= tool.hardLimitMs) {
      stopStalledTool(state, tool, ctx);
      return;
    }
    if (!tool && stallRecovery.shouldInterrupt({
      promptActive: state.promptActive,
      activeTool: false,
      waitingUser: ctx.status() === 'waiting-user' ||
        Boolean(state.compactingSince && now - state.compactingSince < 5 * 60 * 1000),
      lastActivityAt: state.lastActivityAt,
      retryWaitUntil: state.retryWaitUntil,
    }, now)) {
      stopStalledAgent(state, ctx);
      return;
    }
    ctx.emit({ kind: 'watchdog' });
  }, 10000);
  if (state.monitorTimer && typeof state.monitorTimer.unref === 'function') state.monitorTimer.unref();
}

function clearRecoveryTimers(state) {
  if (state.recoveryTimer) clearTimeout(state.recoveryTimer);
  state.recoveryTimer = null;
  state.recoveryWaitCancel?.();
  state.recoveryWaitCancel = null;
}

function afterRecoveryCleanup(state, launch) {
  state.recoveryTimer = setTimeout(() => { state.recoveryTimer = null; launch(); }, 16);
}

async function waitForNativeExit(state, ctx) {
  let timer, cancel;
  const interrupted = new Promise(resolve => {
    cancel = () => resolve(false);
    state.recoveryWaitCancel = cancel;
    timer = setTimeout(cancel, stallRecovery.ABORT_SETTLE_MS);
  });
  try {
    const settled = await Promise.race([state.abortPromise.then(() => true), interrupted]);
    return settled && !state.activeTools.size && ctx.piSession?.isIdle === true;
  } finally {
    clearTimeout(timer);
    if (state.recoveryWaitCancel === cancel) state.recoveryWaitCancel = null;
  }
}

function cancelPending(state) {
  const pending = state.stallPending || Boolean(state.protocolPending);
  state.stallPending = false;
  state.protocolPending = null;
  state.stalledIncident = null;
  if (pending || state.recoveryReceipt?.pending) finishTurn(state);
  clearRecoveryTimers(state);
  state.recoveryReceipt?.finish({ ok: true, cancelled: true, manualStop: true });
  return pending;
}

// An internal recovery is part of the original submission. Keep that queue
// item's completion pending until recovery ends, including chained bounded
// recoveries; otherwise a successful answer leaves the queue stuck on waiting.
function recoveryReceipt(state) {
  let settle;
  const receipt = { pending: true, promise: new Promise(resolve => { settle = resolve; }),
    finish(value) { if (!receipt.pending) return; receipt.pending = false; settle(value); } };
  state.recoveryReceipt = receipt;
  return receipt;
}
async function finishRecovery(state, result) {
  const seen = new Set();
  while (result?.recovering && state.recoveryReceipt && !seen.has(state.recoveryReceipt)) {
    const receipt = state.recoveryReceipt;
    seen.add(receipt);
    result = await receipt.promise;
  }
  return result;
}

function scheduleStall(state, context, ctx) {
  const incident = state.stalledIncident;
  if (!incident) return { handled: false, recovering: false, reason: '' };
  state.stalledIncident = null;
  const request = context || {};
  const asGoal = Boolean(request.goalMode && ctx.goalIntent === 'goal');
  if (state.stallRecoveryCount >= stallRecovery.MAX_RECOVERIES || !state.retryBudget.reserve()) {
    const terminal = incident.reason +
      '\u81ea\u52a8\u6062\u590d\u540e\u4ecd\u672a\u7ee7\u7eed\uff0c\u5df2\u505c\u6b62\u7b49\u5f85\u3002\u5de5\u4f5c\u76ee\u5f55\u548c\u5df2\u6709\u8f93\u51fa\u5747\u5df2\u4fdd\u7559\uff0c\u53ef\u76f4\u63a5\u91cd\u8bd5\u6216\u7ee7\u7eed\u3002';
    state.stopReason = terminal;
    state.stopKind = 'agent-stall';
    state.terminalAt = Date.now();
    if (asGoal) {
      const limit = {
        kind: 'stall', reason: terminal,
        used: Math.round(incident.idleMs / 1000),
        limit: Math.round(stallRecovery.HARD_IDLE_MS / 1000), unit: 'seconds',
      };
      ctx.setLimitRequest(limit);
      ctx.setQuality('paused', terminal);
      ctx.checkpoint('run.paused', limit);
    }
    ctx.acc.appendNotice(terminal, 'error');
    ctx.emit({ kind: 'agent-stall-failed', reason: terminal });
    return { handled: true, recovering: false, reason: terminal };
  }
  state.stallRecoveryCount += 1;
  state.stallPending = true;
  const receipt = recoveryReceipt(state);
  if (typeof ctx.acc.recoverRuntime === 'function') ctx.acc.recoverRuntime();
  function launch() {
    Promise.resolve(resume()).catch((error) => {
      if (!receipt.pending || state.recoveryReceipt !== receipt || ctx.closed()) {
        receipt.finish({ ok: true, cancelled: true }); return;
      }
      state.stallPending = false;
      const message = '\u81ea\u52a8\u6062\u590d\u542f\u52a8\u5931\u8d25\uff1a' +
        String((error && error.message) || error);
      state.stopReason = message;
      state.stopKind = 'agent-stall';
      state.terminalAt = Date.now();
      ctx.acc.appendNotice(message, 'error');
      ctx.emit({ kind: 'agent-stall-recovery-failed', reason: message });
      receipt.finish({ ok: false, failureKind: 'agent-stall', retrySafe: true,
        terminalAt: state.terminalAt, reason: message, snapshot: ctx.acc.snapshot() });
      queueMicrotask(ctx.drainTurns);
    });
  }
  async function resume() {
    if (!receipt.pending || state.recoveryReceipt !== receipt || !state.stallPending || ctx.closed()) {
      receipt.finish({ ok: true, cancelled: true }); return;
    }
    if (ctx.inFlight()) { afterRecoveryCleanup(state, launch); return; }
    const exited = await waitForNativeExit(state, ctx);
    if (!receipt.pending || state.recoveryReceipt !== receipt || !state.stallPending || ctx.closed()) {
      receipt.finish({ ok: true, cancelled: true }); return;
    }
    if (!exited) {
      throw new Error('上一模型连接尚未确认退出，已停止自动恢复；已有进度保留，请等待停止后再继续。');
    }
    if (ctx.inFlight()) { afterRecoveryCleanup(state, launch); return; }
    state.stopReason = '';
    if (asGoal && ctx.budgetMs && Date.now() - state.startedAt >= ctx.budgetMs) {
      state.stallPending = false;
      finishTurn(state);
      stopForLimit(state, 'time', '本轮已达到配置的运行时间，已有进度和文件已保留。', ctx);
      receipt.finish({ ok: true, paused: true, snapshot: ctx.acc.snapshot() });
      return;
    }
    ctx.setFailedLastTurn(false);
    if (asGoal) {
      ctx.setGoalEnabled(true);
      ctx.setQuality('implementing', '\u6a21\u578b\u6d41\u5df2\u6062\u590d\uff0c\u6b63\u5728\u4ece\u5f53\u524d\u68c0\u67e5\u70b9\u7ee7\u7eed');
      ctx.checkpoint('run.resumed', { reason: ctx.qualityReason(), automatic: true });
    } else {
      ctx.setGoalEnabled(false);
      ctx.endGoalTurn();
    }
    ctx.emit({ kind: 'agent-stall-recovering', attempt: state.stallRecoveryCount });
    const prompt = asGoal
      ? stallRecovery.goalPrompt(ctx.goalQuality, ctx.goal, incident.reason)
      : stallRecovery.normalPrompt(request.request, incident.reason);
    state.stallPending = false;
    if (!receipt.pending || ctx.closed()) return;
    const completion = ctx.send(prompt, [], {
      internal: true, runtimeRecovery: true, continuing: asGoal, goalMode: asGoal,
      pluginIds: asGoal ? ctx.goalPluginIds()
        : (Array.isArray(request.pluginIds) ? request.pluginIds.slice() : []),
      ...(Array.isArray(request.skills) ? { skills: request.skills.slice() } : {}),
      projectId: asGoal ? ctx.goalPluginProjectId() : String(request.projectId || ''),
    });
    receipt.finish(await completion);
  }
  queueMicrotask(launch);
  return { handled: true, recovering: true, reason: incident.reason };
}

function scheduleProtocol(state, context, ctx) {
  const request = context || {};
  const stored = ctx.limitRequest() && ctx.limitRequest().kind === 'protocol'
    ? { ...ctx.limitRequest() } : null;
  const issue = ctx.acc.state && ctx.acc.state.protocolIssue;
  const paused = stored || (issue ? {
    kind: 'protocol', code: issue.code, reason: ctx.protocolGuard.reason(issue),
    used: Number(issue.parameters || 0), limit: 1, unit: 'automatic recovery',
  } : null);
  if (!paused || state.protocolRecoveryCount >= 1 || state.protocolPending || !state.retryBudget.reserve()) return false;
  /* Repeated tool narration gets one bounded recovery. The provider is
     aborted first, the polluted assistant turn is quarantined, and the
     existing recovery counter prevents an endless retry loop. If the clean
     retry produces the same protocol issue, the normal hard stop remains. */
  const asGoal = Boolean(request.goalMode && ctx.goalIntent === 'goal');
  state.protocolRecoveryCount += 1;
  const pending = {};
  const receipt = recoveryReceipt(state);
  state.protocolPending = pending;
  function launch() {
    Promise.resolve(resume()).catch(error => {
      if (!receipt.pending || state.recoveryReceipt !== receipt || ctx.closed()) {
        receipt.finish({ ok: true, cancelled: true }); return;
      }
      state.protocolPending = null;
      state.stopReason = '自动恢复启动失败：' + String(error?.message || error);
      state.stopKind = 'protocol';
      state.terminalAt = Date.now();
      ctx.acc.appendNotice(state.stopReason, 'error');
      ctx.emit({ kind: 'protocol-recovery-failed', reason: state.stopReason });
      receipt.finish({ ok: false, failureKind: 'protocol', reason: state.stopReason, snapshot: ctx.acc.snapshot() });
      if (typeof ctx.drainTurns === 'function') queueMicrotask(ctx.drainTurns);
    });
  }
  async function resume() {
    // An explicit stop/dispose/new turn invalidates the queued recovery.
    if (!receipt.pending || state.recoveryReceipt !== receipt || state.protocolPending !== pending || ctx.closed()) {
      if (state.protocolPending === pending) state.protocolPending = null;
      receipt.finish({ ok: true, cancelled: true }); return;
    }
    // Turn cleanup can await the journal or delivery persistence. The queued
    // microtask runs before that finally block releases inFlight; keep the
    // original submission pending until cleanup finishes, just as stall
    // recovery does, instead of silently cancelling the promised retry.
    if (ctx.inFlight()) { afterRecoveryCleanup(state, launch); return; }
    const exited = await waitForNativeExit(state, ctx);
    if (!receipt.pending || state.recoveryReceipt !== receipt || state.protocolPending !== pending || ctx.closed()) {
      if (state.protocolPending === pending) state.protocolPending = null;
      receipt.finish({ ok: true, cancelled: true }); return;
    }
    if (!exited) throw new Error('上一模型连接尚未确认退出，已停止自动恢复；已有进度保留，请等待停止后再继续。');
    if (ctx.inFlight()) { afterRecoveryCleanup(state, launch); return; }
    state.protocolPending = null;
    if (ctx.limitRequest() && ctx.limitRequest().kind === 'protocol') ctx.setLimitRequest(null);
    state.stopReason = '';
    if (asGoal && ctx.budgetMs && Date.now() - state.startedAt >= ctx.budgetMs) {
      finishTurn(state);
      stopForLimit(state, 'time', '本轮已达到配置的运行时间，已有进度和文件已保留。', ctx);
      receipt.finish({ ok: true, paused: true, snapshot: ctx.acc.snapshot() });
      return;
    }
    ctx.setFailedLastTurn(false);
    if (typeof ctx.acc.recoverProtocol === 'function') ctx.acc.recoverProtocol();
    if (asGoal) {
      ctx.setGoalEnabled(true);
      ctx.setQuality('implementing', '\u5f02\u5e38\u6a21\u578b\u8f93\u51fa\u5df2\u9694\u79bb\uff0c\u6b63\u5728\u4ece\u73b0\u6709\u5de5\u4f5c\u73b0\u573a\u81ea\u52a8\u6062\u590d');
      ctx.checkpoint('run.resumed', { reason: ctx.qualityReason(), automatic: true });
    } else {
      ctx.setGoalEnabled(false);
      ctx.endGoalTurn();
    }
    ctx.emit({ kind: 'protocol-recovering', attempt: state.protocolRecoveryCount });
    const target = asGoal ? ctx.goal : {
      request: String(request.request || '').trim(),
      acceptance: 'complete the previous user request and report the real result',
      recoveryScope: 'normal',
    };
    const completion = Promise.resolve().then(() => {
      if (!receipt.pending || ctx.closed()) return { ok: true, cancelled: true };
      return ctx.send(ctx.protocolGuard.recoveryPrompt(target, paused), [], {
      internal: true, runtimeRecovery: true, continuing: asGoal, goalMode: asGoal,
      pluginIds: asGoal ? ctx.goalPluginIds()
        : (Array.isArray(request.pluginIds) ? request.pluginIds.slice() : []),
      ...(Array.isArray(request.skills) ? { skills: request.skills.slice() } : {}),
      projectId: asGoal ? ctx.goalPluginProjectId() : String(request.projectId || ''),
      });
    });
    completion.then(receipt.finish, error => receipt.finish({ ok: false,
      reason: String(error?.message || error), snapshot: ctx.acc.snapshot() }));
  }
  queueMicrotask(launch);
  return true;
}

function finishTurn(state) {
  // Automatic recovery is still the same execution. Its reset preserves the
  // original budget; an intermediate cleanup must not publish it as complete.
  if (state.startedAt && !state.terminalAt && !state.stallPending && !state.protocolPending) {
    state.terminalAt = state.permissionWaitSince || Date.now();
  }
}

function resetTurn(state, resetRecovery, preserveBudget = false) {
  if (!preserveBudget || !state.startedAt) state.startedAt = Date.now();
  state.terminalAt = 0;
  state.lastActivityAt = Date.now();
  state.retryWaitUntil = 0;
  if (!preserveBudget) state.retryBudget.reset();
  state.compactingSince = 0;
  state.permissionWaitSince = 0;
  if (!preserveBudget) {
    state.toolSteps = 0;
    state.toolProgress = toolProgress.create();
    state.toolIds.clear();
  }
  state.activeTools.clear();
  state.stopReason = '';
  state.stopKind = '';
  if (resetRecovery) resetRecoveries(state);
}

function resetRecoveries(state) {
  clearRecoveryTimers(state);
  state.recoveryReceipt?.finish({ ok: true, cancelled: true, manualStop: true });
  state.recoveryReceipt = null;
  state.protocolPending = null;
  state.protocolRecoveryCount = 0;
  state.stallRecoveryCount = 0;
}

function dispose(state) {
  cancelPending(state);
  if (state.monitorTimer) clearInterval(state.monitorTimer);
  state.monitorTimer = null;
}

module.exports = { permissionWait,
  createState, continuation, execution, observeEvent, promptComplete, startMonitor,
  stopForLimit, stopStalledTool, stopStalledAgent, stopProtocolIssue,
  cancelPending, scheduleStall, scheduleProtocol, resetTurn, finishTurn, resetRecoveries, finishRecovery,
  dispose, isStallError: stallRecovery.isError,
};
