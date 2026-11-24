'use strict';
const pluginGeneration = require('../pi-session/plugin-generation-gate.cjs');

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runnerRuntime = require('../runner-runtime');
const modelConfig = require('../pi-session/model-config');
const contextWindow = require('../conversation/context-window');
const outputs = require('../pi-session/outputs');
const attachmentContract = require('../pi-session/attachment-contract');
const attachmentStaging = require('../pi-session/attachments');
const { createBindings } = require('../conversation/task-bindings');
const { createTurnQueue } = require('../pi-session/turn-queue');
const toolGuard = require('../pi-session/tool-guard');
const agentContract = require('../conversation/agent-contract');
const nativeLocale = require('../native-locale.cjs');
const { CAPABILITIES, RuntimeContractError } = require('./contract');
const { createEventFactory } = require('./events');
const runtimeCatalog = require('./runtime-catalog');
const { createRunnerGoalControls, continuationBlocked } = require('./runner-goal-control');
const taskGoal = require('./runner-task-goal');
const protocolGuard = require('./protocol-guard');
const chatEvents = require('../pi-session/event-stream');
const pluginTurn = require('../pi-session/plugin-turn');
const skillTurn = require('../pi-session/skill-turn');
const TURN_SKILLS = Symbol('trusted-turn-skills');
const taskOutputJournal = require('../conversation/task-output-journal');
const conversationInputPreparation = require('../conversation/conversation-input-preparation.cjs');
const fileChangeJournal = require('../conversation/file-change-journal');
const messageTime = require('../conversation/message-time');
const agentSource = require('../conversation/agent-source.cjs');
const _runnerConfig = require('./runner-config.cjs').createForConversation;
const executionModelId = model => String(model?.localOnly ? model.wireModelId || '' : model?.id || '');
const ADAPTER_ID = 'codex-harness';
const EXECUTION_NAMESPACE = '9af442c8-cd1d-4b91-a668-22da2b2635bf';
const POLL_MS = 420;
const RECONNECT_GRACE_MS = 2 * 60 * 1000;
const RECONNECT_MAX_DELAY_MS = 5000;
const RECOVERY_POLL_MS = 10000;
const RECOVERY_MAX_ATTEMPTS = 12;
const OBSERVED_STATES = new Set(['queued', 'running', 'dispatching', 'starting', 'access-changing',
  'waiting-permission', 'completed', 'done', 'failed', 'stopped', 'interrupted', 'cancelled', 'canceled']);
const TERMINAL_STATES = new Set(['completed', 'done', 'failed', 'stopped', 'interrupted', 'cancelled', 'canceled']);
const RECOVERY_PAUSE_REASON = '发送尚未确认，请检查后继续队列';
const RUNNER_SESSION_DETAILS = new WeakMap();
const RUNNER_INVENTORIES = new WeakMap();
const RUNNER_CAPABILITIES = Object.freeze([
  { id: CAPABILITIES.SESSION_RESUME, level: 'native' },
  { id: CAPABILITIES.TURN_QUEUE, level: 'native' },
  { id: CAPABILITIES.TURN_CANCEL, level: 'native' },
  { id: CAPABILITIES.GOAL_CONTROL, level: 'delegated', native: {
    namespace: 'runner', operations: ['continue', 'pause', 'disable'],
  } },
  { id: CAPABILITIES.ARTIFACT_LIST, level: 'native' },
  { id: CAPABILITIES.ATTACHMENTS, level: 'native' },
  { id: CAPABILITIES.MODEL_SELECT, level: 'native' },
  { id: CAPABILITIES.SKILLS, level: 'delegated' },
  { id: CAPABILITIES.MCP, level: 'delegated' },
  { id: CAPABILITIES.WORKSPACE, level: 'native' },
  { id: CAPABILITIES.NATIVE_EVENTS, level: 'native', native: { namespace: 'runner' } },
]);

function runnerCapabilities(runtimeSpec) {
  return runtimeSpec.goalMode === 'native' ? RUNNER_CAPABILITIES
    : Object.freeze(RUNNER_CAPABILITIES.filter(item => item.id !== CAPABILITIES.GOAL_CONTROL));
}

function _uuidBytes(value) {
  return Buffer.from(String(value || '').replace(/-/g, ''), 'hex');
}

function _uuidV5(namespace, name) {
  const bytes = crypto.createHash('sha1')
    .update(Buffer.concat([_uuidBytes(namespace), Buffer.from(String(name), 'utf8')]))
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20)].join('-');
}

function _legacyOptions(request) {
  const native = request && request.native || {};
  return native.runner && native.runner.openOptions ||
    native.pi && native.pi.openOptions || {};
}

function _text(value, limit = 20000) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

// A plugin selected for a conversation remains the conversation's active
// capability until the caller explicitly clears it. Each turn still gets a
// fresh grant from the trusted resolver; this only carries the selection.
function _pluginIds(value) {
  const source = Array.isArray(value) ? value : [];
  return [...new Set(source.map((item) => String(item && item.pluginId || item || '').trim())
    .filter(Boolean))].slice(0, 3);
}

function _assistantText(value) {
  return require('./assistant-text.cjs').clean(_text(value, 20000));
}

function _proxyError(value) {
  const clean = _text(value, 20000);
  if (!clean.startsWith('{')) return '';
  try {
    const payload = JSON.parse(clean);
    const outer = payload && payload.error;
    if (!outer || typeof outer !== 'object') return '';
    let inner = {};
    if (typeof outer.upstream === 'string' && outer.upstream.trim().startsWith('{')) {
      try { inner = JSON.parse(outer.upstream); } catch (error) { inner = {}; }
    }
    const message = _text(inner && inner.error && inner.error.message || outer.message, 1000);
    if (/not a multimodal model/i.test(message)) {
      return '\u5f53\u524d\u6a21\u578b\u4e0d\u80fd\u76f4\u63a5\u8bfb\u53d6\u56fe\u7247\u3002\u672c\u8f6e\u5df2\u505c\u6b62\uff1b\u8bf7\u91cd\u8bd5\uff0cSoduWork \u4f1a\u6539\u7528\u89c6\u89c9\u89c2\u5bdf\u6216\u7f51\u9875\u7ed3\u6784\u7ee7\u7eed\u68c0\u67e5\u3002';
    }
    return message || '\u6a21\u578b\u670d\u52a1\u672a\u80fd\u5b8c\u6210\u8fd9\u4e00\u8f6e';
  } catch (error) {
    return '';
  }
}

function _fatalHarnessText(value) {
  const clean = _text(value, 20000);
  const proxy = _proxyError(clean);
  if (proxy) return proxy;
  if (/^unexpected status\s+404\b/i.test(clean) && /\/v1\/responses\b/i.test(clean))
    return '当前模型网关不支持 Codex Harness 所需的 Responses 接口，请更换支持 Responses 的模型，或改用 OpenCode、Pi 等底座。';
  return /^(?:unexpected status\s+[45]\d\d\b|request timed out\b|error sending request\b)/i.test(clean)
    ? clean : '';
}

function _resumeCredentialError(value) {
  const text = typeof value === 'string' ? value : (() => {
    const message = value && (value.message || value.reason || value.error);
    if (message) return String(message);
    try { return JSON.stringify(value || ''); } catch (_) { return String(value || ''); }
  })();
  return /acpbridge|unauthori[sz]ed|凭证|credential|expired|session.*(?:invalid|expired|not found)|\b401\b/i.test(text);
}

function _eventAt(item) {
  const parsed = Date.parse(String(item && item.at || ''));
  return Number.isFinite(parsed) ? Math.min(Date.now(), parsed) : Date.now();
}

function _title(value, fallback) {
  const clean = _text(value, 120).replace(/\s+/g, ' ');
  return clean ? clean.slice(0, 40) : String(fallback || 'Agent 工作会话');
}

function _status(value) {
  const raw = String(value || '');
  if (raw === 'waiting-permission') return 'waiting-user';
  if (raw === 'queued') return 'queued';
  if (raw === 'running' || raw === 'dispatching' || raw === 'starting' || raw === 'access-changing') return 'streaming';
  if (raw === 'completed' || raw === 'done') return 'idle';
  if (raw === 'failed') return 'unreachable';
  if (raw === 'stopped' || raw === 'interrupted' || raw === 'cancelled' || raw === 'canceled') return 'aborted';
  return 'idle';
}

function _executionTime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  // Native Runner metadata uses epoch seconds. Accept millisecond snapshots
  // from existing callers, but publish one millisecond clock to the renderer.
  return Math.min(Date.now(), value > 0 && value < 1e11 ? Math.round(value * 1000) : value);
}

function _localFiles(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const source = String(item && (item.path || item.stagedPath) || '');
    if (!source || !path.isAbsolute(source)) return null;
    let stat;
    try { stat = fs.statSync(source); } catch (error) { return null; }
    if (!stat.isFile()) return null;
    return {
      path: source,
      filename: String(item.name || item.filename || path.basename(source)).slice(0, 240),
      // Staged desktop attachments use `mimeType`; renderer-native references
      // historically used `type`/`contentType`. Preserve all three so Runner
      // can recognise pasted images even when the Electron bridge supplied a
      // copied staging path instead of the original File object.
      contentType: String(item.type || item.contentType || item.mimeType || 'application/octet-stream').slice(0, 160),
      size: stat.size,
    };
  }).filter(Boolean).slice(0, 20);
}

/*
 * Renderer attachments normally arrive with an absolute path. Clipboard and
 * drag/drop files can only carry bytes, though, because Chromium does not
 * expose their original path. Pi stages those bytes before dispatch; Runner
 * must do the same or a non-Pi turn loses the file when its optimistic bubble
 * is replaced by the runtime snapshot.
 */
async function _prepareRunnerAttachments(items, root) {
  const source = Array.isArray(items) ? items : [];
  const pending = source.map((item, index) => ({ item, index }))
    .filter(({ item }) => item && item.data != null &&
      !path.isAbsolute(String(item.path || item.stagedPath || '')));
  if (!pending.length) return source;
  const staged = await attachmentStaging.stage(path.resolve(String(root || '')), pending.map(({ item }) => item), {
    stagingDir: path.join(path.resolve(String(root || '')), '.soduwork-inputs'),
  });
  if (!staged?.files || staged.files.length !== pending.length) {
    throw Error('有附件无法复制到当前会话，请重新选择后发送');
  }
  const next = source.slice();
  pending.forEach(({ index }, offset) => { next[index] = staged.files[offset]; });
  return next;
}

function _skillRows(skillDirs) {
  return (Array.isArray(skillDirs) ? skillDirs : []).map((source) => {
    const skillPath = String(source || '');
    if (!skillPath) return null;
    const file = path.join(skillPath, 'SKILL.md');
    let content = '';
    try { content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
    catch (error) { return null; }
    const match = content.match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|\s*$)/);
    if (!match) return null;
    const fields = {};
    match[1].split(/\r?\n/).forEach((line) => {
      if (!line || /^\s|^#/.test(line) || !line.includes(':')) return;
      const at = line.indexOf(':');
      const key = line.slice(0, at).trim();
      let value = line.slice(at + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      fields[key] = value;
    });
    const name = _text(fields.name || path.basename(skillPath), 64);
    const description = _text(fields.description, 1024);
    return name && description ? { name, description, path: skillPath } : null;
  }).filter(Boolean);
}

function publicPluginBadges(value) {
  return require('../conversation/plugin-badges').publicBadges(value);
}

/*
 * Append the language contract after the entire message. Runner has no shared system
 * prompt, so each turn must preserve this ordering to maintain the intended response
 * language.
 */
function _languageContract() {
  return agentContract.outputLanguage(nativeLocale.getLocale());
}

function _goalBrief(options) {
  if (String(options.intent || '') !== 'goal') return '';
  const rows = [];
  if (_text(options.goal)) rows.push('【本次目标】\n' + _text(options.goal));
  if (_text(options.acceptance)) rows.push('【完成标准】\n' + _text(options.acceptance));
  rows.push('这是完整交付目标。先理解与规划，再实施、验证和收尾；不要只完成其中一层。');
  return rows.join('\n\n');
}

function _conversationPrompt(text, options) {
  const value = String(text ?? '');
  if (String(options && options.intent || '') === 'goal') return value;
  const readOnly = options?.accessPolicy ? options.accessPolicy.mode === 'readonly' : options?.readOnly;
  return [
    '【SoduWork 普通对话规则】',
    // Plugin and recovery context is appended later; keep the shared language
    // rule at the end of the complete dispatch/comment, exactly once.
    ...agentContract.prompts({ readOnly }).slice(0, -1),
    '【用户原话】\n' + value,
  ].join('\n\n');
}

function _nativeExecution(adapterId, options) {
  if (String(adapterId || '') !== 'codex') return {};
  const opts = options || {};
  const model = _text(opts.modelName, 160);
  const reasoningEffort = _text(opts.reasoningEffort, 24).toLowerCase();
  return {
    kind: 'local:codex',
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function _snapshot(state) {
  const turn = state.turnQueue?.active();
  const controlled = turn?.options.controlled && !turn.options.pluginDebug &&
    state.taskExecutions?.find(row => row.taskId === turn.options.taskId);
  const controlledView = require('../pi-session/controlled-execution-snapshot.cjs').project(controlled, turn?.id);
  const validating = Boolean((state.pluginGenerationActive || state.pluginGenerationPreparing) &&
    !state.goalPaused && !state.cancelRequested && (state.status === 'idle' ||
      state.pluginGenerationPreparing && state.status === 'aborted'));
  const waitingForStart = (state.status === 'streaming' || state.status === 'queued') &&
    (state.status === 'queued' || state.executionStartedAt === 0);
  const executing = state.status === 'streaming' && !waitingForStart || validating;
  const running = executing || Boolean(state.pendingPermissions?.length);
  const occupied = running || waitingForStart;
  const now = Date.now();
  const executionStart = state.executionStartedAt;
  const elapsedStart = executionStart === null ? state.startedAt : executionStart;
  const elapsed = elapsedStart ? Math.max(0, (state.turnEndedAt || now) - elapsedStart) : 0;
  const queueWaitMs = state.submittedAt && executionStart !== null
    ? Math.max(0, (executionStart || state.turnEndedAt || now) - state.submittedAt) : null;
  const active = state.tools.find((tool) => tool.state === 'running') || null;
  const latestProgressAt = Math.max(
    Number(state.lastActivityAt || elapsedStart || now),
    Number(executionStart || 0),
    Number(active && (active.lastProgressAt || active.startedAt) || 0),
  );
  const idleMs = executing ? Math.max(0, now - latestProgressAt) : 0;
  const queue = state.turnQueue ? state.turnQueue.view() : [];
  const goalPhase = state.goalPaused ? (state.taskGoal?.status === 'blocked' ? 'blocked' : 'paused') :
    ['unreachable', 'aborted'].includes(state.status) && state.taskGoal?.status !== 'disabled' ? 'blocked' : state.taskGoal?.status;
  // Project settled native receipts using the same turn ownership as Pi.
  // Missing provider usage remains unknown for the presentation to estimate.
  const metrics = require('../pi-session/turn-metrics').collector(state, state._turnMetricsCache ||= {}, 0);
  state.messages.forEach(metrics.visit);
  return {
    status: controlledView?.status || (validating ? 'streaming' : state.status),
    activePlugins: state.activePluginIds ? state.activePluginIds.slice() : [],
    ...(state.thinking ? { thinking: { ...state.thinking, levels: state.thinking.levels.slice() } } : {}),
    ...(state.modelSelection ? { modelSelection: state.modelSelection.view() } : {}),
    ...(state.taskBindings ? state.taskBindings.view() : {}),
    statusText: controlledView?.statusText ?? (validating ? '\u6b63\u5728\u6574\u7406\u672c\u8f6e\u6210\u679c\u2026' : state.statusText),
    messages: state.messages.map((row) => ({ ...row,
      attachments: attachmentContract.publicFiles(row.attachments),
      blocks: Array.isArray(row.blocks) ? row.blocks.map((block) => ({ ...block })) : row.blocks })),
    turnMetrics: metrics.finish(),
    tools: state.tools.map((row) => ({ ...row })),
    toolPreparations: require('../pi-session/tool-preparation').list(state),
    // `usage` is cumulative consumption, while `contextUsage`/`tokens` is
    // the current context watermark returned by the runner. Keep both so the
    // context meter never has to guess from cumulative billing data.
    usage: state.usage ? { ...state.usage } : null,
    // The Runner's cumulative receipt includes tool-only/hidden work and cost.
    // Display fragments intentionally contain only per-message token details.
    ...(state.usageReceipts ? { usageReceipts: state.usageReceipts } : state.usage ? { usageReceipts: [{ usage: { ...state.usage },
      at: state.updatedAt || 0, model: state.model?.id || '', agent: state.adapterId, cumulative: true,
      ...(state.model?.localOnly || state.localUsageObserved ? { reportable: false } : {}) }] } : {}),
    contextUsage: state.contextUsage ? { ...state.contextUsage } : null,
    tokens: state.contextUsage ? { ...state.contextUsage } : null,
    contextWindow: Number(state.contextWindow || 0) || 0,
    contextWindowKnown: Boolean(state.contextWindowKnown),
    contextWindowEstimated: Boolean(state.contextWindowEstimated),
    contextWindowSource: String(state.contextWindowSource || ''),
    accessPolicy: state.accessPolicy || null,
    nextAccessPolicy: state.nextAccessPolicy || null,
    accessControl: { ...state.accessControl,
      canChangeDuringSession: Boolean(state.accessControl?.canChangeDuringSession && !state.accessRestorePending) },
    adapterId: state.adapterId, displayName: state.displayName,
    appliedAccessPolicy: state.appliedAccessPolicy || null,
    pendingPermissions: state.pendingPermissions || [],
    fileChanges: state.fileChanges || null,
    pendingUi: state.pendingPermissions?.length ? { ...state.pendingPermissions[0], method: 'permission' } : null,
    completion: state.completion ? { ...state.completion } : null,
    ...(state.taskGoal ? { taskGoal: { ...state.taskGoal, objective: state.goal, acceptance: state.acceptance } } : {}),
    running: controlledView ? controlledView.execution.running : running,
    queue,
    queued: queue.length,
    execution: {
      configured: state.goalVisible,
      visible: state.goalVisible,
      active: occupied,
      stopped: state.status === 'aborted' && !state.goalPaused,
      running,
      step: state.taskGoal?.steps ?? state.step,
      maxSteps: state.taskGoal?.maxSteps ?? Number(state.maxSteps || 0),
      elapsedMs: state.taskGoal?.elapsedMs ?? elapsed,
      ...(state.taskGoal ? { elapsedObservedAt: state.taskGoalElapsedAt || null } : {}),
      executionStartedAt: executionStart,
      submittedAt: state.submittedAt || null,
      waitingForStart,
      queueWaitMs,
      startupWaitSince: state.startupWaitSince || null,
      budgetMs: state.taskGoal?.budgetMs ?? Math.max(0, Number(state.budgetMinutes || 0) * 60000),
      paused: state.goalPaused,
      limitRequest: state.goalLimit ? { ...state.goalLimit,
        canContinue: state.goalLimit.canContinue !== false && !continuationBlocked(state, state.turnQueue) } : null,
      canContinue: Boolean(state.goalPaused && state.goalLimit?.canContinue !== false &&
        !taskGoal.exhausted(state.taskGoal) && !continuationBlocked(state, state.turnQueue)),
      ...(state.goalVisible && state.taskGoal ? { quality: {
        phase: goalPhase === 'working' ? 'implementing' : goalPhase,
        reason: state.taskGoal.reason,
      } } : {}),
      reason: state.statusText,
      queuePosition: Number(state.queuePosition || 0),
      queueClass: String(state.queueClass || ''),
      longRunning: Boolean(executing && active &&
        now - Number(active.startedAt || now) >= toolGuard.SOFT_NOTICE_MS),
      stalled: Boolean(executing && elapsedStart &&
        idleMs >= toolGuard.STALL_NOTICE_MS),
      idleMs,
      tool: active ? {
        id: active.id, name: active.name,
        elapsedMs: Math.max(0, now - Number(active.startedAt || now)),
        idleMs: Math.max(0, now - Number(active.lastProgressAt || active.startedAt || now)),
        kind: 'runner', timeoutMs: 0,
      } : null,
      queue,
      queued: queue.length,
      tokens: state.contextUsage ? { ...state.contextUsage } : null,
      usage: state.usage ? { ...state.usage } : null,
      contextWindow: Number(state.contextWindow || 0) || 0,
      contextWindowKnown: Boolean(state.contextWindowKnown),
      contextWindowEstimated: Boolean(state.contextWindowEstimated),
      contextWindowSource: String(state.contextWindowSource || ''),
      turnQueue: state.turnQueue ? state.turnQueue.state() : {},
      recoveryRequired: Boolean(state.recoveryRequired),
      terminalConfirmed: Boolean(state.terminalConfirmed),
      queueImmediate: state.queueImmediate?.view(),
      taskExecutions: state.taskExecutions || [],
      harness: {
        schemaVersion: 1,
        runId: state.runnerRef,
        node: state.status === 'queued' ? 'queue' : (waitingForStart ? 'prepare' : (executing ? 'execute' : 'deliver')),
        phase: state.goalPaused ? 'paused' : state.goalVisible && state.taskGoal ? state.taskGoal.status : state.status === 'queued' ? 'queued' :
          (waitingForStart ? 'starting' : (executing ? 'working' : (state.status === 'idle' ? 'completed' : 'blocked'))),
        state: state.status,
        decision: '', reason: state.statusText,
        attempts: state.round, iteration: state.taskGoal?.steps ?? state.step,
        revision: state.taskGoal?.continuations || 0,
        workKind: state.adapterId, updatedAt: state.updatedAt,
        phases: [], tasks: [], progress: [],
      },
      ...controlledView?.execution,
    },
  };
}

function _eventKind(touched, state) {
  const kind = String(touched && touched.kind || '');
  if (kind === 'queued') return 'turn.queued';
  if (kind === 'started') return 'turn.started';
  if (kind === 'cancelled') return 'turn.cancelled';
  if (kind === 'failed') return 'turn.failed';
  if (kind === 'settled') return state.status === 'idle' ? 'turn.completed' : 'turn.failed';
  return 'state.changed';
}

async function createRunnerHandle(request, defaults, initialSession) {
  const opts = _legacyOptions(request);
  const runtime = defaults.runnerRuntime || runnerRuntime;
  const models = defaults.modelConfig || modelConfig;
  const runtimeSpec = defaults.runtimeSpec || runtimeCatalog.runtime(ADAPTER_ID);
  const adapterId = String(runtimeSpec && runtimeSpec.id || ADAPTER_ID);
  const displayName = String(runtimeSpec && runtimeSpec.displayName || 'Codex Harness');
  if (runtimeSpec.goalMode !== 'native' &&
      (request.consumer === 'goal' || opts.intent === 'goal' || opts.mode === 'goal')) {
    throw new RuntimeContractError('GOAL_MODE_UNSUPPORTED',
      displayName + ' 暂不支持目标模式，请选择其他 Agent 或取消目标后发送');
  }
  const accountModel = runtimeSpec && runtimeSpec.modelMode === 'account';
  const app = opts.app || defaults.app;
  const identity = opts.identity || request.identity;
  const alias = String(opts.ref || 'chat-' + Date.now().toString(36));
  const dispatchId = String(opts.nativeDispatchId || 'chat:' + alias + ':' + adapterId);
  const predictedRef = _uuidV5(EXECUTION_NAMESPACE, dispatchId);
  const resumedRef = String(opts.resumePath || '');
  const runnerRef = resumedRef || predictedRef;
  const resumeNative = Boolean(resumedRef && opts.nativeSessionStarted !== false);
  if (opts.nativeDispatchId && predictedRef !== runnerRef)
    throw new RuntimeContractError('RUNNER_SEGMENT_IDENTITY_INVALID', '原会话执行状态尚未确认，请稍后再次核实');
  // File discovery is scoped to the conversation, while startedAt tracks the
  // current user turn. Reopened legacy archives follow Pi's workspace recovery.
  let outputSince = resumedRef ? 0 : Date.now();
  let outputSinceRestored = !resumedRef;
  const taskBindings = createBindings(app, runnerRef);
  const taskJournal = await taskOutputJournal.create(app, runnerRef);
  const selectionModule = require('../conversation/model-selection');
  const modelPreference = selectionModule.preference(app, runnerRef);
  const savedSelection = modelPreference.readSelection();
  const explicitModel = typeof opts.modelName === 'string';
  let modelName = explicitModel ? opts.modelName : savedSelection.name || '';
  if (resumeNative && !explicitModel && !modelName) {
    // Older chats may only name their model in the Runner journal. When its first
    // page is still polling, the same Runner exposes that metadata in its inventory.
    const history = initialSession?.data;
    const row = history?.ref === resumedRef ? history : (await _runnerInventory(runtime).catch(() => []))
      .find(item => item.ref === resumedRef && item.cli === adapterId);
    if (row?._modelMetadataPrivate === false) {
      const choice = row.activeExecutionSelection;
      modelName = (choice?.agentId === adapterId ? choice.modelName : row.model) || '';
    }
  }
  if (accountModel && (String(modelName).startsWith('local:') ||
      require('../../core/model-choice').imageChoice(modelName)?.name.startsWith('local:'))) {
    throw new RuntimeContractError('RUNNER_MODEL_UNAVAILABLE', '账号型底座不能使用本地模型，请选择账号模型');
  }
  const initialThinking = adapterId === 'codex' ? require('./codex-thinking').profile(modelName,
    resumedRef && typeof savedSelection.reasoningEffort === 'string' ? savedSelection.reasoningEffort
      : opts.reasoningEffort || savedSelection.reasoningEffort || '') : null;
  if (opts.taskRef) {
    const bound = taskBindings.bind(opts.taskRef, opts.taskTitle);
    if (!bound.ok) throw new Error(bound.reason);
  }
  const cwd = path.resolve(String(opts.cwd || process.cwd()));
  let accessControl = { schema: 'soduwork.access-policy/v1', supported: false, modes: [], canChangeDuringSession: false };
  if (opts.accessPolicy) {
    const probe = await runtime.rpc('runtime.detect', { key: adapterId }, 15000);
    const capability = probe?.data?.accessControl;
    if (!probe?.ok || !capability?.supported || capability.schema !== 'soduwork.access-policy/v1' || !capability.modes?.includes(opts.accessPolicy.mode)) {
      throw new RuntimeContractError('ACCESS_POLICY_UNSUPPORTED', '执行机尚未支持此权限模式，请更新执行机或选择兼容底座');
    }
    accessControl = capability;
  }
  const allowHistoricalModel = !opts.startDeviceSegment && Boolean(resumedRef || opts.resumedConversation);
  let prepared = accountModel
    ? { ok: true, model: { id: modelName, name: modelName || displayName, baseUrl: '', key: '' } }
    : await models.fetchModel(identity, modelName, undefined, undefined, false, adapterId,
      { app, allowLocal: true, allowHistorical: allowHistoricalModel });
  // A Runner archive can outlive the model catalog just like a native Pi archive.
  // Historical model names are hints, not a reason to make the whole conversation
  // unreadable. Retry only resumed conversations with the current default; new
  // chats keep an explicit model failure visible so a typo is not silently changed.
  const canRecoverStaleModel = allowHistoricalModel && !modelName.startsWith('local:') &&
    prepared?.code !== 'LOCAL_AGENT_DEFAULT_UNAVAILABLE';
  const returnedModel = String(prepared?.model?.id || '').trim();
  const returnedDifferentModel = Boolean(prepared?.ok && modelName && returnedModel && returnedModel !== modelName);
  if (opts.startDeviceSegment && returnedDifferentModel && !prepared.model.localOnly &&
      !require('../../core/model-choice').imageChoice(modelName)) {
    throw new RuntimeContractError('RUNNER_MODEL_UNAVAILABLE', '当前账号无法使用所选模型，请重新选择模型后发送');
  }
  let resetSavedModel = false;
  if (canRecoverStaleModel && (!prepared?.ok || returnedDifferentModel)) {
    const fallback = accountModel
      ? { ok: true, model: { id: '', name: displayName, baseUrl: '', key: '' } }
      : await models.fetchModel(identity, '', undefined, undefined, false, adapterId,
        { app, allowLocal: true, ignoreAgentPreference: true,
          allowHistorical: allowHistoricalModel });
    if (fallback?.ok && fallback.model) {
      modelName = '';
      prepared = fallback;
      resetSavedModel = true;
    }
  }
  if (!prepared || !prepared.ok || !prepared.model) {
    throw new RuntimeContractError('RUNNER_MODEL_UNAVAILABLE',
      String(prepared && prepared.reason || displayName + ' 没有可用模型'));
  }
  // A default is resolved once for this conversation. Future chats still use their own default.
  if (prepared.model.localOnly) modelName = require('../pi-session/local-model-runtime-privacy.cjs').reference(prepared.model);
  else if (!modelName) modelName = prepared.model.id;
  if (explicitModel || resetSavedModel || modelName && savedSelection.name !== modelName) {
    try { modelPreference.write(modelName, initialThinking?.level); }
    catch (error) {
      // Clearing a retired historical choice is a best-effort repair. A
      // filesystem/AV lock must not turn a recoverable conversation into an
      // open failure; new explicit choices still retain their strict error.
      if (!resetSavedModel) throw error;
    }
  }

  const listeners = new Set();
  const redactors = new Set();
  const redact = value => [...redactors].reduce((text, clean) => clean(text), String(value || ''));
  const waiters = new Set();
  const recoveredTasks = new Map();
  const turnQueue = createTurnQueue(undefined, () => handle.captureDelivery?.());
  const preparedContext = contextWindow.resolveContextWindow(prepared.model);
  const taskGoalSupported = runtimeSpec.goalMode === 'native' && taskGoal.supported(adapterId);
  const initialTaskGoal = taskGoalSupported ? taskGoal.fromOptions(opts) : null;
  const state = {
    alias, runnerRef, dispatchId, cwd, adapterId, displayName, taskBindings,
    accessPolicy: require('../access-control/policy').normalize(opts.accessPolicy, cwd),
    accessControl,
    pendingPermissions: [],
    accessRestorePending: Boolean(resumeNative && !opts.accessPolicy),
    nextAccessPolicy: null,
    model: prepared.model, lastExecutionModelId: executionModelId(prepared.model),
    localUsageObserved: prepared.model.localOnly === true,
    agentExecution: _nativeExecution(adapterId, { ...opts, modelName,
      ...(initialThinking ? { reasoningEffort: initialThinking.level } : {}) }),
    thinking: initialThinking,
    lastExecutionReasoningEffort: initialThinking?.level || '',
    title: require('../conversation/automatic-title').resolve(opts.sessionTitle), intent: String(opts.intent || ''), goal: String(opts.goal || ''),
    acceptance: String(opts.acceptance || ''), maxSteps: initialTaskGoal?.maxSteps ?? Number(opts.maxSteps || 0),
    budgetMinutes: initialTaskGoal?.budgetMinutes ?? Number(opts.budgetMinutes || 0),
    goalVisible: String(opts.intent || '') === 'goal', goalPaused: false, goalLimit: null,
    taskGoalContract: initialTaskGoal, taskGoal: null, pendingTaskGoalControl: '',
    selectedSkills: Array.isArray(opts.skillDirs) ? opts.skillDirs.slice() : [],
    capabilityIds: Array.isArray(opts.capabilityIds) ? opts.capabilityIds.slice() : [],
    status: 'idle', statusText: resumeNative ? '正在接回 ' + displayName + ' 会话…' : '',
    messages: [], tools: [], usage: null, contextUsage: null,
    activePluginIds: _pluginIds(opts.activePluginIds),
    contextWindow: preparedContext.contextWindow,
    contextWindowKnown: preparedContext.contextWindowKnown,
    contextWindowEstimated: preparedContext.contextWindowEstimated,
    contextWindowSource: preparedContext.contextWindowSource,
    completion: null,
    runtimeError: '',
    protocolIssue: null,
    seq: 0, step: 0, round: 1, startedAt: 0, submittedAt: 0, executionStartedAt: null, startupWaitSince: 0,
    updatedAt: Date.now(), lastActivityAt: 0,
    started: resumeNative, dispatchReady: resumeNative,
    cancelRequested: false, manualStopRequested: false, stopSent: false,
    queuePosition: 0, queueClass: '', turnSerial: 0,
    disposed: false, polling: false, preparingPlugins: false, timer: null, turnQueue,
    reconnectSince: 0, reconnectAttempts: 0, fileChanges: null,
    recoveryRequired: false, terminalConfirmed: false, recoveryAttempts: 0,
    initialSession: initialSession || null,
  };
  const transferCloseToken = {};
  let transferClosePending = false;

  state.modelSelection = selectionModule.create({
    name: modelName, model: prepared.model,
    generation: accountModel ? undefined : models.generation,
    async resolve(name) {
      if (!accountModel) return models.fetchModel(identity, name, undefined, undefined, false, adapterId,
        { app, allowLocal: true });
      if (adapterId !== 'codex') return { ok: false };
      const catalog = await require('./native-model-catalog').list(adapterId);
      const row = (catalog.models || []).find(model => model.id === name);
      return row || !name ? { ok: true, model: { id: name, label: row && row.label || '默认模型' } } : { ok: false };
    },
    persist: name => {
      if (state.disposed) throw Error('会话已关闭');
      const next = adapterId === 'codex' ? require('./codex-thinking').profile(name, state.thinking?.level) : null;
      modelPreference.write(name, next?.level);
    },
    changed: () => {
      if (adapterId === 'codex' && state.modelChoicePending)
        state.thinking = require('./codex-thinking').profile(state.modelSelection.capture(), state.thinking?.level);
      emit('model-selection');
    },
    apply(next, name) {
      state.contextUsage = null;
      state.model = next; handle.model = next.id;
      state.localUsageObserved ||= next.localOnly === true;
      const resolved = contextWindow.resolveContextWindow(next);
      state.contextWindow = resolved.contextWindow;
      state.contextWindowKnown = resolved.contextWindowKnown;
      state.contextWindowEstimated = resolved.contextWindowEstimated;
      state.contextWindowSource = resolved.contextWindowSource;
      state.agentExecution = _nativeExecution(adapterId, { ...opts, modelName: name,
        reasoningEffort: state.agentExecution?.reasoningEffort || '' });
    },
  });

  const taskMessages = require('../conversation/task-message-stream.cjs').create(state,
    row => taskJournal.append(state.seq, row));
  async function restoreTaskOutput(through) {
    await taskJournal.restore(through, row => {
      if (row.kind === 'plugin-selection') state.activePluginIds = _pluginIds(row.pluginIds);
      else if (row.kind === 'tool') chatEvents.apply(state, row.event);
      else if (row.kind === 'message') state.messages.push(row.role === 'user'
        ? { role: 'user', text: row.text, attachments: row.files || [], taskId: row.taskId,
          taskOutputKey: row.taskOutputKey, sentAt: messageTime.epoch(row.sentAt), plugins: publicPluginBadges(row.plugins) }
        : { role: 'assistant', taskId: row.taskId, taskOutputKey: row.taskOutputKey,
          ...agentSource.fields(row.sourceAgent),
          completedAt: messageTime.epoch(row.completedAt), blocks: [{ kind: row.blockKind === 'thinking' ? 'thinking' : 'text', text: row.text }], done: true });
    });
  }
  await restoreTaskOutput(0);

  let generationGateActive = 0;
  let pausedPreparation = null;
  const resumedUser = Symbol('already displayed goal request');
  function emit(kind, detail) {
    if (generationGateActive && kind === 'settled') kind = 'changed';
    state.updatedAt = Date.now();
    const snap = _snapshot(state);
    listeners.forEach((listener) => {
      try { listener({ kind, ...(detail || {}) }, snap); } catch (error) { /* isolated observer */ }
    });
  }

  let activeFileJournal = null;
  async function beginFileJournal(turnId) {
    const journal = { turnId: String(turnId || ''), before: null };
    activeFileJournal = journal;
    try { journal.before = await fileChangeJournal.snapshot(cwd); } catch (_) { journal.before = null; }
  }
  async function finishFileJournal() {
    const journal = activeFileJournal;
    if (!journal) return;
    if (!generationGateActive) activeFileJournal = null;
    try {
      const after = await fileChangeJournal.snapshot(cwd);
      state.fileChanges = journal.before
        ? fileChangeJournal.compare(journal.before, after, { turnId: journal.turnId })
        : { schemaVersion: fileChangeJournal.SCHEMA_VERSION, turnId: journal.turnId,
          capturedAt: Date.now(), truncated: true, files: [],
          stats: { created: 0, modified: 0, deleted: 0, renamed: 0, total: 0 } };
    } catch (_) {
      state.fileChanges = { schemaVersion: fileChangeJournal.SCHEMA_VERSION, turnId: journal.turnId,
        capturedAt: Date.now(), truncated: true, files: [],
        stats: { created: 0, modified: 0, deleted: 0, renamed: 0, total: 0 } };
    }
  }

  function settle(result) {
    for (const waiter of waiters) waiter(result);
    waiters.clear();
    if (state.status === 'idle' && turnQueue.size()) queueMicrotask(drainTurns);
  }

  function fail(reason, preserveQueue = false, retrySafe = false) {
    messageStream.finish();
    state.turnEndedAt = Date.now();
    state.status = 'unreachable';
    state.statusText = _text(redact(reason), 1000) || displayName + ' 执行失败';
    state.completion = { reason: 'error', error: state.statusText };
    if (preserveQueue) {
      state.recoveryPause = Boolean(state.recoveryRequired);
      turnQueue.pause(RECOVERY_PAUSE_REASON);
    }
    emit('failed', { reason: state.statusText });
    const result = { ok: false, reason: state.statusText, ...(retrySafe ? { retrySafe: true } : {}) };
    void finishFileJournal();
    settle(result);
    if (!preserveQueue && !state.queueImmediate?.blocked()) turnQueue.clear(result);
  }

  function reconnect(reason) {
    const now = Date.now();
    state.recoveryRequired = true;
    state.terminalConfirmed = false;
    state.reconnectSince = state.reconnectSince || now;
    state.reconnectAttempts += 1;
    if (submissionFailed || now - state.reconnectSince >= RECONNECT_GRACE_MS) {
      if (state.status !== 'unreachable') fail(_text(reason, 1000) || displayName + ' 执行机长时间无法连接', true);
      scheduleRecovery();
      return;
    }
    state.status = 'streaming';
    state.statusText = '与执行机的连接暂时中断，正在自动接回…';
    emit('changed', { reconnecting: true, attempt: state.reconnectAttempts });
    const delay = Math.min(RECONNECT_MAX_DELAY_MS,
      250 * Math.pow(2, Math.min(5, state.reconnectAttempts - 1)));
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(poll, delay);
  }

  const messageStream = require('./runner-messages').create(state, redact);
  let pendingUserEcho = null;
  let lastConfirmedAdmissionKey = '';

  function bindUserEcho(key, options) {
    const row = turnQueue.active()?.runnerUserMessage;
    pendingUserEcho = row && options.recordUser !== false ? { key, previousKey: lastConfirmedAdmissionKey, row } : null;
  }

  function acknowledgeUserEcho(item, text) {
    if (!pendingUserEcho) return false;
    const { key, previousKey, row } = pendingUserEcho;
    const sentAt = messageTime.epoch(item.sentAt);
    const id = String(item.submissionId || '').slice(0, 128);
    if (id && row.submissionId && id !== row.submissionId) return false;
    if (sentAt && sentAt !== row.sentAt) return false;
    if (item.admissionKey !== key && !(id && id === row.submissionId)) {
      // Older Runners omit the key or stamp a comment before advancing the
      // admission. Require the original timestamp for a previous-key echo.
      if (item.admissionKey && (item.admissionKey !== previousKey || !sentAt)) return false;
      if (_text(row.text, 50000) !== text) return false;
    }
    pendingUserEcho = null;
    lastConfirmedAdmissionKey = key;
    row.runnerPersisted = true;
    if (id && !row.submissionId) row.submissionId = id;
    return true;
  }

  function appendItem(item) {
    const kind = String(item.kind || '');
    const eventAt = _eventAt(item);
    state.lastActivityAt = Math.max(Number(state.lastActivityAt || 0), eventAt);
    const rawText = redact(_text(item.full || item.text, 50000));
    if (messageStream.apply(item, redact(String(item.full || item.text || '').slice(0, 50000)))) return;
    const inspected = kind === 'say'
      ? protocolGuard.inspect(_assistantText(rawText), { final: true }) : null;
    const text = inspected ? inspected.text : rawText;
    if (kind === 'step') {
      state.step += 1;
      state.statusText = text || displayName + ' 正在继续处理…';
      return;
    }
    if (kind === 'say') {
      const fatal = _fatalHarnessText(text);
      if (fatal) {
        state.runtimeError = fatal;
        state.statusText = fatal;
        return;
      }
      if (text) {
        state.messages.push({ role: 'assistant', ...agentSource.fields({ agentId: adapterId }), blocks: [{ kind: 'text', text }], done: true,
          completedAt: messageTime.epoch(item.completedAt) || messageTime.epoch(item.at) });
      }
      if (inspected && inspected.detected) {
        const reason = protocolGuard.reason();
        state.protocolIssue = {
          code: inspected.code,
          bytes: Number(inspected.bytes || 0),
          parameters: Number(inspected.parameters || 0),
        };
        state.statusText = reason;
        if (state.goalVisible) {
          state.goalPaused = true;
          state.goalLimit = {
            kind: 'protocol', reason,
            used: state.protocolIssue.parameters, limit: 1, unit: '次恢复',
          };
          state.cancelRequested = true;
        } else {
          state.runtimeError = reason;
        }
        requestStop();
        return;
      }
      if (!text) return;
      state.statusText = '';
      return;
    }
    if (kind === 'user') {
      if (!rawText) return;
      // Restore the first user title before publishing the resumed history.
      state.title = state.title || require('../pi-session/history-state').messageTitle({ messages: [{ role: 'user', text: rawText }] });
      messageStream.finish();
      state.startedAt = Math.max(state.startedAt || 0, eventAt);
      state.turnEndedAt = 0;
      if (acknowledgeUserEcho(item, rawText)) return;
      const plugins = publicPluginBadges(item.plugins);
      // New user events record the effective selection, including an explicit
      // empty selection. Replaying only nonempty badges would undo a clear.
      if (Array.isArray(item.plugins)) state.activePluginIds = _pluginIds(plugins);
      state.messages.push({ role: 'user', text: rawText,
        sentAt: messageTime.epoch(item.sentAt) || messageTime.epoch(item.at), attachments: Array.isArray(item.attachments) ? item.attachments : [],
        ...(item.submissionId ? { submissionId: String(item.submissionId).slice(0, 128) } : {}),
        plugins, runnerPersisted: true });
      return;
    }
    if (kind === 'do') {
      const preparing = messageStream.takePreparation(item);
      const tool = { ...agentSource.fields({ agentId: adapterId }),
        id: preparing?.id || 'runner-' + String(item.seq || state.seq + 1),
        name: String(item.tool || 'command'),
        callId: String(item.callId || ''), toolKind: String(item.toolKind || '').slice(0, 40),
        args: messageStream.argumentsOf(item, text), partial: '', result: '', isError: false,
        state: 'running', after: Math.max(0, state.messages.length - 1),
        startedAt: eventAt, lastProgressAt: eventAt,
      };
      state.tools.push(tool);
      return;
    }
    if (kind === 'out') {
      messageStream.takePreparation(item);
      const current = [...state.tools].reverse().find((tool) => tool.state === 'running' &&
        (!item.callId || tool.callId === String(item.callId)));
      const cancelled = item.state === 'cancelled' && ['access-change', 'output-limit'].includes(item.cancelReason) && item.isError === false;
      const isError = !cancelled && (typeof item.isError === 'boolean' ? item.isError
        : /error|stderr|\u9519\u8bef/i.test(String(item.tool || '')));
      const resultState = cancelled ? 'cancelled' : isError ? 'error' : 'done';
      const result = isError ? require('../access-control/errors').message(text) : text;
      if (current) {
        current.result = result;
        current.isError = isError;
        current.state = resultState;
        if (cancelled) current.cancelReason = item.cancelReason;
        current.lastProgressAt = eventAt;
        current.endedAt = eventAt;
      } else if (text) {
        state.tools.push({ ...agentSource.fields({ agentId: adapterId }),
          id: 'runner-' + String(item.seq || state.seq + 1),
          name: String(item.tool || (isError ? 'error' : 'output')),
          args: {}, partial: '', result, isError,
          state: resultState, ...(cancelled ? { cancelReason: item.cancelReason } : {}),
          after: Math.max(0, state.messages.length - 1),
          startedAt: eventAt, lastProgressAt: eventAt, endedAt: eventAt,
        });
      }
    }
  }

  function releaseManualStop() {
    if (!state.manualStopRequested || state.disposed) return false;
    state.stopAwaitingTerminal = false;
    state.manualStopRequested = false;
    state.cancelRequested = false;
    turnQueue.resume();
    emit('stop-acknowledged');
    queueMicrotask(drainTurns);
    return true;
  }
  function finishGoalStop() {
    if (!state.goalStopAwaitingTerminal || !state.terminalConfirmed || state.stopPending || state.pendingTaskGoalControl) return false;
    state.goalStopAwaitingTerminal = false;
    state.stopAwaitingTerminal = false;
    state.recoveryRequired = false;
    submissionFailed = false;
    state.cancelRequested = Boolean(state.goalPaused);
    if (!state.goalPaused) queueMicrotask(drainTurns);
    emit('goal-stop-confirmed');
    return true;
  }
  function requestStop(goalControl) {
    if (!taskGoalSupported) goalControl = undefined;
    if (['pause', 'disable'].includes(goalControl)) {
      if (!state.started) return true;
      state.pendingTaskGoalControl = goalControl;
      state.goalStopAwaitingTerminal = true;
      state.stopAwaitingTerminal = true;
      state.recoveryRequired = true;
      state.terminalConfirmed = false;
      if (!state.stopPending) state.stopSent = false;
    }
    if (state.pluginGenerationPreparing || state.preparingPlugins || !state.started || !state.dispatchReady || state.stopSent || state.stopPending) return false;
    state.stopSent = true;
    state.stopPending = true;
    if (state.stopAwaitingTerminal) state.recoveryRequired = true;
    state.pendingPermissions = [];
    const generation = submissionGeneration, stop = {}, control = state.pendingTaskGoalControl;
    stopRequest = stop;
    runtime.rpc('job.stop', { ref: state.runnerRef, ...(control ? { taskGoalControl: control } : {}) }, 15000).then((reply) => {
      if (state.disposed || generation !== submissionGeneration || stopRequest !== stop) return;
      const data = reply && reply.data || {};
      if (!reply || reply.ok === false || data.ok === false) {
        if (reply && (reply.ok === false || data.ok === false) && !reply.uncertain && !data.uncertain)
          state.stopPending = false;
        throw new Error(String(reply && reply.error || data.error || '停止没有得到执行机确认'));
      }
      state.stopPending = false;
      stopRequest = null;
      if (state.pendingTaskGoalControl === control) state.pendingTaskGoalControl = '';
      if (state.pendingTaskGoalControl) {
        state.stopSent = false;
        requestStop();
        return;
      }
      if (data.taskGoal) {
        taskGoal.observe(state, data.taskGoal, true);
        if (state.goalPaused) state.statusText = state.goalLimit.reason;
        emit('goal-changed');
      }
      if (state.goalStopAwaitingTerminal) {
        clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          // A pre-stop poll must retire before the terminal-only read. Merely
          // joining it would lose the confirmation when its cancelled result
          // is discarded, leaving a paused goal permanently fenced.
          Promise.resolve(state.polling ? pollFinished : undefined).then(() => {
            if (!state.disposed && generation === submissionGeneration && state.goalStopAwaitingTerminal) void poll(true);
          });
        }, 0);
        return;
      }
      if (state.stopAwaitingTerminal && state.terminalConfirmed) {
        state.recoveryRequired = false;
        submissionFailed = false;
        releaseManualStop();
      } else if (state.stopAwaitingTerminal) scheduleRecovery();
      else releaseManualStop();
    }).catch((error) => {
      if (state.disposed || generation !== submissionGeneration || stopRequest !== stop) return;
      stopRequest = null;
      state.stopSent = false;
      if (control) {
        state.statusText = '目标控制尚未得到执行机确认，请重试';
        state.goalVisible = true;
        state.intent = 'goal';
        state.goalPaused = true;
        state.goalLimit = { kind: 'task-goal', reason: state.statusText, canContinue: false };
        if (state.taskGoal) state.taskGoal = { ...state.taskGoal, status: 'paused', reason: state.statusText };
        emit('goal-control-unconfirmed');
        scheduleRecovery();
      }
      if (!state.manualStopRequested || state.disposed) return;
      if (state.stopAwaitingTerminal && state.terminalConfirmed && !state.stopPending) {
        state.recoveryRequired = false;
        submissionFailed = false;
        releaseManualStop();
        return;
      }
      state.statusText = '停止尚未确认，请重试';
      turnQueue.pause(state.statusText);
      emit('stop-unconfirmed', { reason: String(error && error.message || error) });
      if (state.stopAwaitingTerminal) scheduleRecovery();
    });
    return true;
  }
  // Keep incomplete history private: publishing an old page would lock the
  // UI's monotonic turn clock to an earlier user turn before replay catches up.
  let historyItems = [], historySince = null, submissionGeneration = 0, submissionFailed = false;
  let observationCancellation = 0, recoveryCheck = null, pollFinished = null, stopRequest = null;
  let skillSelectionFailure = null;
  function invalidateObservation() {
    submissionGeneration++;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    return submissionGeneration;
  }
  function beginSubmission() {
    // A stopped snapshot belongs to the old native turn until this admission
    // is acknowledged. Invalidate both its refresh timer and in-flight reads.
    submissionFailed = false;
    state.recoveryRequired = true;
    state.terminalConfirmed = false;
    state.recoveryAttempts = 0;
    state.turnSubmissionPending = true;
    return invalidateObservation();
  }
  function scheduleRecovery() {
    if (state.disposed || state.cancelRequested && !state.stopAwaitingTerminal || !state.recoveryRequired || state.recoveryAttempts >= RECOVERY_MAX_ATTEMPTS) return;
    const generation = submissionGeneration, cancellation = observationCancellation;
    clearTimeout(state.timer);
    // Recovery only reads the original reference. Exhaustion leaves explicit verification available.
    state.timer = setTimeout(() => {
      if (generation !== submissionGeneration || cancellation !== observationCancellation ||
          state.disposed || !state.recoveryRequired || state.cancelRequested && !state.stopAwaitingTerminal) return;
      state.recoveryAttempts++;
      void poll(true);
    }, RECOVERY_POLL_MS);
  }
  function recoveryReceipt(data) {
    if (!OBSERVED_STATES.has(data.status) || data.ref && String(data.ref) !== state.runnerRef) return false;
    const key = state.unconfirmedAdmissionKey;
    if (key?.startsWith('comment:')) return data.admissionKey === key;
    return data.ref === state.runnerRef || key && data.admissionKey === key || !key && state.dispatchReady;
  }
  async function poll(readOnly = false) {
    if (state.polling) return pollFinished;
    const stopOnly = readOnly && state.stopAwaitingTerminal && (state.manualStopRequested || state.goalStopAwaitingTerminal);
    const unavailable = () => state.disposed || state.cancelRequested && !stopOnly;
    if (unavailable() || !state.started || state.pluginGenerationPreparing || state.preparingPlugins || state.turnSubmissionPending || submissionFailed && !state.recoveryRequired ||
      (turnQueue.active() && turnQueue.active().options.controlled)) return;
    state.polling = true;
    let finishPoll;
    pollFinished = new Promise(resolve => { finishPoll = resolve; });
    const cancellation = observationCancellation;
    const accessGeneration = state.accessChangeGeneration || 0;
    const turnGeneration = submissionGeneration;
    const stalePoll = () => {
      if (cancellation === observationCancellation && turnGeneration === submissionGeneration && accessGeneration === (state.accessChangeGeneration || 0)) return false;
      if (!state.disposed && !state.cancelRequested && !state.pluginGenerationPreparing && !state.preparingPlugins && !state.turnSubmissionPending && !submissionFailed)
        state.timer = setTimeout(poll, 0);
      return true;
    };
    try {
      const firstResume = state.initialSession;
      state.initialSession = null;
      const reply = firstResume || await runtime.rpc('job.session', {
        ref: state.runnerRef, since: historySince ?? state.seq, limit: 500,
      }, 15000);
      if (unavailable() || stalePoll()) return;
      const data = reply && reply.data || {};
      if (typeof data.activeExecutionSelection?.modelName === 'string') state.lastExecutionModelId = data.activeExecutionSelection.modelName;
      if (typeof data.activeExecutionSelection?.reasoningEffort === 'string') state.lastExecutionReasoningEffort = data.activeExecutionSelection.reasoningEffort;
      if (!reply || reply.ok === false || data.ok === false) {
        throw new Error(String(reply && reply.error || data.error || '读不到 ' + displayName + ' 会话'));
      }
      if (state.recoveryRequired && !recoveryReceipt(data) || data.ref && String(data.ref) !== state.runnerRef)
        throw Error('尚未确认原会话的执行状态，请稍后再次核实');
      if (stopOnly) {
        // A cancelled unknown admission may be observed and stopped, never replayed or rendered.
        state.dispatchReady = true;
        state.unconfirmedAdmissionKey = '';
        state.terminalConfirmed = TERMINAL_STATES.has(data.status);
        if (state.terminalConfirmed) {
          historyItems = []; historySince = null;
          if (taskGoalSupported) taskGoal.observe(state, data.taskGoal, true);
          state.status = state.goalPaused ? 'idle' : 'aborted';
          state.statusText = state.goalLimit?.reason || '已停止';
          // A late same-reference stop can affect a new turn until its own receipt settles.
          state.recoveryRequired = Boolean(state.stopPending || state.pendingTaskGoalControl);
          if (state.recoveryRequired) { emit('changed'); scheduleRecovery(); }
          else { submissionFailed = false; finishGoalStop(); releaseManualStop(); }
        } else {
          state.recoveryRequired = true;
          state.statusText = '正在核实本轮停止状态…';
          requestStop();
          scheduleRecovery();
          emit('changed');
        }
        return;
      }
      if (data.admissionKey) lastConfirmedAdmissionKey = data.admissionKey;
      const recovered = state.recoveryRequired;
      state.reconnectSince = 0;
      state.reconnectAttempts = 0;
      // A running admission can still be preparing the native process. Only
      // the executor's timestamp starts model execution and its visible clock.
      state.executionStartedAt = _executionTime(data.executionStartedAt) ?? (data.status === 'queued' ? 0 : null);
      if (data.status === 'queued') state.startupWaitSince = 0;
      else if (state.executionStartedAt === 0) state.startupWaitSince ||= Date.now();
      if (state.executionStartedAt > 0) void turnQueue.markStarted();
      if (data.authorizationRequired && !readOnly) {
        const authorization = await runtime.rpc('job.authorize', {
          ref: state.runnerRef,
          cfg: { ..._runnerConfig(state.model, adapterId, state.capabilityIds), ...(state.accessPolicy ? { accessPolicy: state.accessPolicy } : {}) },
        }, 15000);
        const authorized = authorization && authorization.data || {};
        if (!authorization || authorization.ok === false || authorized.ok === false) {
          throw new Error(String(authorization && authorization.error || authorized.error ||
            '执行机没有恢复本轮模型授权'));
        }
      }
      if (unavailable() || stalePoll()) return;
      const cursor = historySince ?? state.seq;
      const page = (Array.isArray(data.items) ? data.items : [])
        .filter(item => Number(item.seq || 0) > cursor)
        .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
      const pageEnd = page.length ? Number(page.at(-1).seq) : cursor;
      if (Number(data.seq || 0) > pageEnd) {
        historyItems.push(...page);
        historySince = pageEnd;
        state.timer = setTimeout(() => poll(readOnly), page.length ? 0 : POLL_MS);
        return;
      }
      const items = historyItems.concat(page);
      if (!outputSinceRestored) {
        outputSinceRestored = true;
        const starts = [Number(data.firstStarted || 0) * 1000,
          ...items.filter(item => item.kind === 'user').map(item => messageTime.epoch(item.at))]
          .filter(value => Number.isFinite(value) && value > 0);
        // Restore the whole conversation, not only its latest turn. Prefer
        // archived provenance so unrelated old inputs do not fill the scan cap.
        if (starts.length) outputSince = Math.min(...starts);
      }
      historyItems = []; historySince = null;
      for (const item of items) {
        if (Number(item.seq || 0) <= state.seq) continue;
        await restoreTaskOutput(Number(item.seq) - 1);
        if (state.disposed) return;
        state.seq = Number(item.seq || state.seq);
        appendItem(item);
      }
      await restoreTaskOutput(state.seq);
      state.round = Number(data.round || state.round || 1);
      state.usage = data.usage && typeof data.usage === 'object' ? { ...data.usage } : state.usage;
      if (Array.isArray(data.usageReceipts)) state.usageReceipts = data.usageReceipts;
      if (data.tokens && typeof data.tokens === 'object') {
        const tokens = data.tokens;
        const fields = Object.keys(tokens).length;
        // Older Runners seeded these three zeros before receiving any usage.
        const unmeasured = fields === 3 && tokens.input === 0 && tokens.output === 0 && tokens.total === 0;
        if (!unmeasured) state.contextUsage = fields ? { ...tokens } : null;
      }
      if (Number(data.ctxWindow) > 0) {
        state.contextWindow = Number(data.ctxWindow);
        state.contextWindowKnown = Object.prototype.hasOwnProperty.call(data, 'ctxWindowKnown')
          ? Boolean(data.ctxWindowKnown) : true;
        if (Object.prototype.hasOwnProperty.call(data, 'ctxWindowEstimated')) {
          state.contextWindowEstimated = Boolean(data.ctxWindowEstimated);
        }
        if (data.ctxWindowSource) state.contextWindowSource = String(data.ctxWindowSource);
        else if (!state.contextWindowSource) state.contextWindowSource = 'runtime';
      }
      state.startedAt = state.startedAt || Math.round(Number(data.started || data.firstStarted || 0) * 1000) || Date.now();
      if (data.accessControl?.schema === 'soduwork.access-policy/v1') state.accessControl = data.accessControl;
      const restoringAccess = state.accessRestorePending;
      let restoredChoice = null;
      if (restoringAccess) {
        const rules = require('../access-control/policy');
        const restored = rules.restoreState(data.accessPolicy?.schema ? data.accessPolicy : null,
          data.nextAccessPolicy?.schema ? data.nextAccessPolicy : null, cwd);
        restoredChoice = restored.nextAccessPolicy || (restored.accessPolicy?.revision > (data.accessPolicy?.revision || 0) ? restored.accessPolicy : null);
        const immediateRestore = state.accessControl?.changeTakesEffect === 'current-turn';
        if (!readOnly && restoredChoice && state.accessControl?.canChangeDuringSession &&
            (immediateRestore || restoredChoice.revision !== data.nextAccessPolicy?.revision || restoredChoice.mode !== data.nextAccessPolicy?.mode)) {
          const current = data.nextAccessPolicy?.schema ? data.nextAccessPolicy : data.accessPolicy;
          const expectedRevision = current?.revision || 0;
          if (immediateRestore) restoredChoice = rules.next(restoredChoice.mode, cwd, current, expectedRevision);
          const saved = await runtime.rpc('job.access', { ref: state.runnerRef, accessPolicy: restoredChoice,
            expectedRevision, applyDuringTurn: immediateRestore }, immediateRestore ? 75000 : 15000);
          if (state.disposed || state.cancelRequested || stalePoll()) return;
          if (!saved?.ok || !saved.data?.ok) throw Error(saved?.error || saved?.data?.error || '无法恢复会话权限，请重试');
          if (immediateRestore) {
            if (saved.data.effective !== 'current-turn' || saved.data.accessPolicy?.revision !== restoredChoice.revision || saved.data.accessPolicy?.mode !== restoredChoice.mode) throw Error('执行机尚未确认恢复的权限');
            Object.assign(data, saved.data);
            restoredChoice = null;
          }
        }
      }
      if (data.accessPolicy?.schema) {
        const rules = require('../access-control/policy');
        const observed = rules.normalize(data.accessPolicy, cwd);
        // Old poll replies cannot undo the revision prepared for the next turn.
        if (!state.accessPolicy || observed.revision >= state.accessPolicy.revision) state.accessPolicy = observed;
      }
      if (data.nextAccessPolicy?.schema) {
        const rules = require('../access-control/policy');
        const pending = restoringAccess ? rules.restore(data.nextAccessPolicy, cwd) : rules.normalize(data.nextAccessPolicy, cwd);
        if (pending.revision > (state.accessPolicy?.revision || 0) && pending.revision >= (state.nextAccessPolicy?.revision || 0)) state.nextAccessPolicy = pending;
      }
      if (!data.nextAccessPolicy?.schema && !state.accessChangePending &&
          state.accessControl?.changeTakesEffect === 'current-turn' &&
          Object.prototype.hasOwnProperty.call(data, 'nextAccessPolicy')) state.nextAccessPolicy = null;
      if (restoredChoice) state.nextAccessPolicy = restoredChoice;
      if (state.nextAccessPolicy && state.accessPolicy?.revision >= state.nextAccessPolicy.revision) state.nextAccessPolicy = null;
      state.accessRestorePending = false;
      state.appliedAccessPolicy = data.appliedAccessPolicy || state.appliedAccessPolicy;
      state.pendingPermissions = Array.isArray(data.pendingPermissions) ? data.pendingPermissions : [];
      state.status = state.pendingPermissions.length ? 'waiting-user' : _status(data.status);
      const observedGoal = taskGoalSupported
        ? taskGoal.observe(state, data.taskGoal, TERMINAL_STATES.has(data.status)) : null;
      state.queuePosition = Math.max(0, Number(data.queuePosition || 0));
      state.queueClass = String(data.queueClass || state.queueClass || '');
      // local_stream persists the human stop reason in `error` even after a
      // successful job.stop. Its stopped terminal is cancellation, not a
      // model failure; execution-policy violations remain explicitly failed.
      const stopped = state.status === 'aborted' && !data.failureKind;
      const goalPaused = state.goalPaused && observedGoal && (!data.error || data.failureKind === 'task_goal');
      if (goalPaused) {
        state.status = 'idle';
        state.runtimeError = '';
        state.statusText = state.goalLimit.reason;
      } else if (data.error && !stopped) {
        state.runtimeError = _text(redact(require('../access-control/errors').message(data.error)), 1000);
        state.status = 'unreachable';
        state.statusText = state.runtimeError;
      } else if (state.protocolIssue) {
        state.status = state.goalPaused ? 'idle' : 'unreachable';
        state.statusText = protocolGuard.reason();
      } else if (stopped) {
        state.statusText = '已停止';
      } else if (state.pendingPermissions.length) {
        state.statusText = '等待权限确认';
      } else if (state.status === 'queued') {
        state.statusText = state.queuePosition > 0
          ? '\u6392\u961f\u4e2d \u00b7 \u7b2c ' + state.queuePosition + ' \u9879'
          : '\u6392\u961f\u4e2d';
      } else if (state.runtimeError && state.status !== 'streaming') {
        state.status = 'unreachable';
        state.statusText = state.runtimeError;
      } else if (observedGoal?.reason) {
        state.statusText = observedGoal.reason;
      }
      if (state.accessChangePending && waiters.size && state.status === 'idle') state.status = 'streaming';
      const active = state.accessChangePending || state.status === 'streaming' || state.status === 'queued' || Boolean(state.pendingPermissions.length);
      // Keep admission fenced until every history page and its native status have been applied.
      state.recoveryRequired = false;
      state.recoveryAttempts = 0;
      state.dispatchReady = true;
      state.unconfirmedAdmissionKey = '';
      submissionFailed = false;
      state.terminalConfirmed = !active && TERMINAL_STATES.has(data.status);
      if (!active && !state.terminalConfirmed) {
        state.recoveryRequired = true;
        if (waiters.size) fail(state.statusText || '原会话执行状态尚未确认', true);
        else emit('changed');
        scheduleRecovery();
        return;
      }
      if (recovered && active && !state.pendingPermissions.length && state.status !== 'queued')
        state.statusText = '已接回执行机，正在继续观察本轮工作…';
      if (!active) {
        await finishFileJournal();
        if (state.disposed || state.cancelRequested || stalePoll()) return;
        messageStream.finish(messageTime.epoch(Number(data.ended || 0) * 1000));
        state.turnEndedAt = state.turnEndedAt || Math.round(Number(data.ended || 0) * 1000) || Date.now();
        // Observers receive cloned tools. Close native activity before the
        // terminal frame so shared progress and delivery components can settle.
        state.tools.forEach((tool) => { if (tool.state === 'running') tool.state = 'done'; });
        if (state.recoveryPause && !turnQueue.active() && !turnQueue.size() &&
            !state.goalPaused && !state.manualStopRequested && !state.queueImmediate.blocked() &&
            turnQueue.state().reason === RECOVERY_PAUSE_REASON) {
          turnQueue.resume();
          state.recoveryPause = false;
        }
      }
      emit(active ? 'changed' : 'settled');
      if (active) {
        state.timer = setTimeout(poll, POLL_MS);
      } else {
        const result = state.status === 'idle'
          ? { ok: true, snapshot: _snapshot(state) }
          : { ok: false, reason: state.statusText || displayName + ' 没有正常完成' };
        settle(result);
      }
    } catch (error) {
      if (!unavailable() && !stalePoll()) {
        if (stopOnly) scheduleRecovery();
        else reconnect(error && error.message || error);
      }
    } finally {
      state.polling = false;
      pollFinished = null;
      finishPoll();
    }
  }

  function waitForTurn() {
    return new Promise((resolve) => waiters.add(resolve));
  }

  function verifyForResume() {
    if (!recoveryCheck && !state.disposed && (!state.cancelRequested || state.stopAwaitingTerminal)) {
      const generation = submissionGeneration, cancellation = observationCancellation;
      clearTimeout(state.timer);
      state.timer = null;
      state.recoveryAttempts = 0;
      recoveryCheck = Promise.resolve().then(() => poll(true)).then(() => {
        if (state.disposed || state.cancelRequested || generation !== submissionGeneration ||
            cancellation !== observationCancellation || state.recoveryRequired || !state.terminalConfirmed) return;
        // This explicit resume owns the release; passive recovery never drains dependent work.
        turnQueue.resume();
        emit('queue-changed');
        queueMicrotask(drainTurns);
      }).finally(() => { recoveryCheck = null; });
      recoveryCheck.catch(() => {});
    }
    return { ok: false, recovering: true, reason: '原会话执行状态尚未确认，正在核实执行状态…', snapshot: _snapshot(state) };
  }

  function appendUser(text, attachments, plugins, sentAt, submissionId) {
    const badges = publicPluginBadges(plugins);
    if (badges.length) state.activePluginIds = _pluginIds(badges);
    const active = turnQueue.active();
    const previous = active?.options[resumedUser];
    if (previous && state.messages.includes(previous)) {
      active.runnerUserMessage = previous;
      previous.plugins = badges;
      return;
    }
    const id = String(submissionId || '').trim().slice(0, 128);
    const row = { role: 'user', text: redact(text), sentAt: messageTime.epoch(sentAt) || Date.now(),
      ...(id ? { submissionId: id } : {}),
      attachments: Array.isArray(attachments) ? attachments : [], plugins: badges,
      runnerPersisted: false };
    state.messages.push(row);
    if (active) active.runnerUserMessage = row;
  }

  function dispatch(text, attachments, turnOptions) {
    const generation = beginSubmission();
    const turnPolicy = state.nextAccessPolicy || state.accessPolicy;
    const next = turnOptions || {};
    // Only a goal explicitly configured through session options may create a
    // persistent Runner loop. Ordinary task wording must remain ordinary chat.
    const dispatchedGoal = taskGoalSupported && !next.controlled && state.taskGoalContract;
    if (dispatchedGoal) taskGoal.activate(state, dispatchedGoal);
    state.cancelRequested = false;
    state.manualStopRequested = false;
    state.stopSent = false;
    state.goalPaused = false;
    state.goalLimit = null;
    state.started = true;
    state.unconfirmedAdmissionKey = 'dispatch:' + state.runnerRef;
    bindUserEcho(state.unconfirmedAdmissionKey, next);
    state.status = 'streaming';
    state.statusText = state.intent === 'goal'
      ? displayName + ' 正在理解并开始工作…' : displayName + ' 正在理解你的问题…';
    messageStream.finish();
    state.startedAt = Date.now();
    state.submittedAt = state.startedAt;
    state.executionStartedAt = 0;
    state.startupWaitSince = state.startedAt;
    state.queuePosition = 0;
    state.turnEndedAt = 0;
    state.runtimeError = '';
    state.protocolIssue = null;
    state.reconnectSince = 0;
    state.reconnectAttempts = 0;
    state.completion = null;
    state.title = state.title || _title(text || state.goal, displayName + ' 工作会话');
    emit('started');
    const taskContext = taskJournal.context();
    const note = [next.promptText || _conversationPrompt(text, { ...opts, intent: state.intent, accessPolicy: turnPolicy }),
      next.materialUnderstandingPrompt,
      ...(opts.contextPrompts || []), taskContext, _goalBrief(state), _languageContract()].filter(Boolean).join('\n\n');
    const completion = waitForTurn();
    const dispatchedModelId = executionModelId(state.model);
    const dispatchedEffort = state.agentExecution?.reasoningEffort || '';
    runtime.rpc('job.dispatch', {
      cli: adapterId,
      dispatchId: state.dispatchId,
      cfg: { ..._runnerConfig(state.model, adapterId, state.capabilityIds), pluginResourceBundles: next[pluginTurn.RESOURCE_BUNDLES] || [],
        ...(adapterId === 'codex' ? { codex_reasoning_effort: dispatchedEffort } : {}),
        ...(turnPolicy ? { accessPolicy: turnPolicy } : {}) },
      task: { id: state.alias, title: state.title, note, status: 'doing',
        priority: 'normal', source: 'SoduWork \u65b0\u5efa\u4f1a\u8bdd' },
      ctx: {
        ...(turnPolicy ? { accessPolicy: turnPolicy } : {}),
        mode: (turnPolicy ? turnPolicy.mode === 'readonly' : opts.readOnly) ? 'plan' : 'work',
        workDir: state.cwd,
        workRoot: state.cwd,
        brief: _goalBrief(state),
        deliveryMode: 'files',
        conversationMode: state.intent === 'goal' ? 'goal' : 'adaptive',
        ...(dispatchedGoal ? { taskGoal: dispatchedGoal } : {}),
        skills: next[TURN_SKILLS] || _skillRows(state.selectedSkills),
        requiredAgentCapabilities: state.capabilityIds,
        conversationUserText: text, conversationSentAt: messageTime.epoch(next.sentAt),
        conversationPlugins: publicPluginBadges(next.plugins),
        agentExecution: state.agentExecution,
      },
      localFiles: _localFiles(attachments),
    }, 60000).then((reply) => {
      if (generation !== submissionGeneration) return;
      state.turnSubmissionPending = false;
      const data = reply && reply.data || {};
      if (!reply || reply.ok === false || !data.ref) {
        // An explicit refusal before admission has no native session to resume.
        // A timeout or an uncertain/ref-bearing receipt must remain unresolved.
        if (reply?.ok === false && !reply.uncertain && !data.uncertain && !data.ref) {
          state.started = false;
          state.recoveryRequired = false;
          state.terminalConfirmed = true;
          state.unconfirmedAdmissionKey = '';
        }
        throw new Error(String(reply && reply.error || displayName + ' 没有成功启动'));
      }
      if (String(data.ref) !== state.runnerRef) {
        throw new Error(displayName + ' 返回了不一致的会话标识');
      }
      state.dispatchReady = true;
      state.recoveryRequired = false;
      state.unconfirmedAdmissionKey = '';
      state.lastExecutionModelId = dispatchedModelId;
      state.lastExecutionReasoningEffort = dispatchedEffort;
      if (turnPolicy) state.accessPolicy = turnPolicy;
      if (state.nextAccessPolicy === turnPolicy) state.nextAccessPolicy = null;
      if (taskContext && !state.disposed) taskJournal.append(state.seq, { kind: 'context-sent' });
      if (state.cancelRequested || state.disposed) {
        requestStop();
        return;
      }
      state.status = _status(data.state || (data.queued ? 'queued' : 'running'));
      state.queuePosition = Math.max(0, Number(data.queuePosition || 0));
      state.queueClass = String(data.queueClass || '');
      if (state.status === 'queued') {
        state.statusText = state.queuePosition > 0
          ? '\u6392\u961f\u4e2d \u00b7 \u7b2c ' + state.queuePosition + ' \u9879'
          : '\u6392\u961f\u4e2d';
      }
      poll();
    }).catch((error) => {
      if (generation !== submissionGeneration) return;
      state.turnSubmissionPending = false;
      submissionFailed = true;
      // This local error is returned before a request is written to Runner.
      const notWritten = error?.code === 'RUNNER_NOT_RUNNING';
      if (notWritten) {
        state.started = false;
        state.recoveryRequired = false;
        state.terminalConfirmed = true;
        state.unconfirmedAdmissionKey = '';
      }
      if (state.cancelRequested && state.manualStopRequested) {
        if (state.recoveryRequired) state.stopAwaitingTerminal = true;
        else releaseManualStop();
      }
      else if (!state.cancelRequested && !state.disposed)
        fail(error && error.message || error, !notWritten || turnQueue.size() > 0, notWritten);
      if (state.recoveryRequired) scheduleRecovery();
    });
    return completion;
  }

  function continueTurn(text, attachments, turnOptions, repairing = false) {
    const generation = beginSubmission();
    const turnPolicy = state.nextAccessPolicy || state.accessPolicy;
    const next = turnOptions || {};
    state.status = 'streaming';
    state.cancelRequested = false;
    state.manualStopRequested = false;
    state.stopSent = false;
    state.goalPaused = false;
    state.goalLimit = null;
    state.statusText = state.intent === 'goal'
      ? '已收到，' + displayName + ' 将按顺序继续…'
      : '已收到，' + displayName + ' 正在理解这句话…';
    messageStream.finish();
    if (!repairing) {
      state.startedAt = Date.now();
      state.submittedAt = state.startedAt;
      state.executionStartedAt = 0;
      state.startupWaitSince = state.startedAt;
      state.queuePosition = 0;
    }
    state.turnEndedAt = 0;
    emit('started');
    state.runtimeError = '';
    state.protocolIssue = null;
    state.reconnectSince = 0;
    state.reconnectAttempts = 0;
    state.completion = null;
    const completion = waitForTurn();
    state.turnSerial += 1;
    const turnId = 'turn:' + state.alias + ':' + state.turnSerial + ':' + Date.now().toString(36);
    state.unconfirmedAdmissionKey = 'comment:' + turnId;
    bindUserEcho(state.unconfirmedAdmissionKey, next);
    const taskContext = taskJournal.context();
    const dispatchedEffort = state.agentExecution?.reasoningEffort || '';
    runtime.rpc('job.comment', {
      ref: state.runnerRef, text, turnId,
      ...(taskGoalSupported && !repairing && next.taskGoalControl ? { taskGoalControl: next.taskGoalControl } : {}),
      ...(executionModelId(state.model) !== state.lastExecutionModelId || adapterId === 'codex' && dispatchedEffort !== state.lastExecutionReasoningEffort
        ? { executionSelection: { agentId: adapterId, modelName: executionModelId(state.model), reasoningEffort: dispatchedEffort } } : {}),
      sentAt: messageTime.epoch(next.sentAt),
      plugins: publicPluginBadges(next.plugins),
      promptText: [next.promptText || _conversationPrompt(text, { ...opts, intent: state.intent, accessPolicy: turnPolicy }),
        next.materialUnderstandingPrompt,
        ...(opts.contextPrompts || []), taskContext, _languageContract()].filter(Boolean).join('\n\n'),
      cfg: { ..._runnerConfig(state.model, adapterId, state.capabilityIds), skillSelection: next[TURN_SKILLS] || _skillRows(state.selectedSkills),
        ...(adapterId === 'codex' ? { codex_reasoning_effort: state.agentExecution?.reasoningEffort || '' } : {}),
        pluginResourceBundles: next[pluginTurn.RESOURCE_BUNDLES] || [],
        ...(turnPolicy ? { accessPolicy: turnPolicy } : {}) },
      localFiles: _localFiles(attachments), recordUser: next.recordUser !== false,
    }, 30000)
      .then((reply) => {
        if (generation !== submissionGeneration) return;
        state.turnSubmissionPending = false;
        if (state.cancelRequested || state.disposed) return;
        const data = reply && reply.data || {};
        if (!reply || reply.ok === false || data.ok === false) {
          if (reply?.ok === false && !reply.uncertain && !data.uncertain) {
            state.recoveryRequired = false;
            state.terminalConfirmed = true;
            state.unconfirmedAdmissionKey = '';
          }
          throw new Error(String(reply && reply.error || data.error || '补充要求没有送达'));
        }
        state.recoveryRequired = false;
        state.unconfirmedAdmissionKey = '';
        if (typeof data.acceptedSelection?.modelName === 'string') state.lastExecutionModelId = data.acceptedSelection.modelName;
        if (adapterId === 'codex') state.lastExecutionReasoningEffort = typeof data.acceptedSelection?.reasoningEffort === 'string'
          ? data.acceptedSelection.reasoningEffort : dispatchedEffort;
        if (turnPolicy && !data.queued) {
          state.accessPolicy = turnPolicy;
          if (state.nextAccessPolicy === turnPolicy) state.nextAccessPolicy = null;
        }
        if (taskContext) taskJournal.append(state.seq, { kind: 'context-sent' });
        state.status = _status(data.state || (data.queued ? 'queued' : 'running'));
        state.queuePosition = Math.max(0, Number(data.queuePosition || 0));
        state.queueClass = String(data.queueClass || state.queueClass || '');
        if (state.status === 'queued') {
          state.statusText = state.queuePosition > 0
            ? '\u6392\u961f\u4e2d \u00b7 \u7b2c ' + state.queuePosition + ' \u9879'
            : '\u6392\u961f\u4e2d';
        }
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(poll, 30);
      }).catch((error) => {
        if (generation !== submissionGeneration) return;
        state.turnSubmissionPending = false;
        submissionFailed = true;
        const notWritten = error?.code === 'RUNNER_NOT_RUNNING';
        if (notWritten) {
          state.recoveryRequired = false;
          state.terminalConfirmed = true;
          state.unconfirmedAdmissionKey = '';
        }
        if (!state.cancelRequested && !state.disposed)
          fail(error && error.message || error, !notWritten || turnQueue.size() > 0, notWritten);
        if (state.recoveryRequired) scheduleRecovery();
      });
    return completion;
  }
  async function sendWithGenerationGate(send, text, attachments, options, stopRequested = () => false) {
    const revision = (state.nextAccessPolicy || state.accessPolicy)?.revision;
    const cancellation = observationCancellation;
    const owner = handle.deliveryOwner;
    const account = require('../device-auth-request').accountScopeKey(identity);
    const stopped = () => Boolean(state.disposed || state.cancelRequested || state.goalPaused || stopRequested() || cancellation !== observationCancellation);
    const cancelled = () => stopped() || (state.nextAccessPolicy || state.accessPolicy)?.revision !== revision;
    const checkFailure = (error, beforeAdmission = false) => {
      // A late worker rejection belongs to its original turn, never a newer
      // stop, access revision or account/owner. Preserve their control state.
      const sameOwner = handle.deliveryOwner === owner && require('../device-auth-request').accountScopeKey(identity) === account;
      if (cancelled() || !sameOwner) {
        // A confirmed permission change cancels this check after native work
        // has ended. Retire its synthetic activity without awaiting a later
        // status poll, while leaving newer owner/stop/pause controls untouched.
        if (!beforeAdmission && sameOwner && !stopped() && !state.accessChangePending &&
            !state.pendingPermissions.length && state.terminalConfirmed && !state.recoveryRequired &&
            !state.turnSubmissionPending && state.status === 'streaming') {
          state.status = 'aborted'; state.statusText = '\u5df2\u505c\u6b62';
          state.completion = { reason: 'cancelled' };
        }
        return state.goalPaused ? { ok: true, paused: true } : { ok: true, cancelled: true, manualStop: true };
      }
      const reason = pluginGeneration.diagnostic({}, error).message;
      state.status = 'unreachable'; state.statusText = reason;
      state.turnEndedAt = Date.now();
      state.completion = { reason: 'error', error: reason };
      // Only a baseline failure is safe to resubmit: finalization may follow
      // successful native writes, so it must not replay the original request.
      return { ok: false, failureKind: 'plugin-validation', retrySafe: beforeAdmission, reason };
    };
    state.pluginGenerationPreparing = true;
    // Baseline scanning yields before native admission. Fence the previous
    // turn's timers and in-flight observations before that first await.
    invalidateObservation();
    let gate, preparationError;
    try {
      gate = await pluginGeneration.begin({ handle, app, identity, cancelled,
        selectedPluginIds: pluginTurn.requestedIds(options),
        // The gate compares content revisions against its pre-dispatch baseline.
        // Filesystem clocks can lag the conversation clock, so time filtering
        // here could let a newly generated invalid draft bypass validation.
        // Public output snapshots retain their conversation ownership boundary.
        outputSnapshot: () => outputs.scanAsync(cwd, 0, state.startedAt),
        repair: prompt => continueTurn(prompt, [], { ...options, promptText: prompt, recordUser: false }, true),
        changed() {
          const phase = pluginGeneration.records(handle).find(row => ['checking', 'repairing'].includes(row.state))?.state;
          if (phase && !cancelled()) {
            state.status = 'streaming';
            state.statusText = phase === 'repairing' ? '\u6b63\u5728\u4fee\u590d\u63d2\u4ef6\u8349\u7a3f\u2026' : '\u6b63\u5728\u68c0\u67e5\u63d2\u4ef6\u8349\u7a3f\u2026';
          }
          emit('changed');
        },
      });
      if (gate.canStart()) await beginFileJournal('turn:' + state.alias + ':' + (state.turnSerial + 1) + ':' + Date.now().toString(36));
    } catch (error) {
      preparationError = error;
    } finally {
      state.pluginGenerationPreparing = false;
      if (state.pendingTaskGoalControl && !state.disposed) requestStop();
    }
    if (preparationError) {
      gate?.dispose();
      activeFileJournal = null;
      const result = checkFailure(preparationError, true);
      if (!result.ok) {
        emit('failed', { reason: result.reason });
        return { ...result, snapshot: _snapshot(state) };
      }
    }
    if (!gate?.canStart()) {
      gate?.dispose();
      activeFileJournal = null;
      const result = state.goalPaused ? { ok: true, paused: true } : { ok: true, cancelled: true, manualStop: true };
      if (state.goalPaused && turnQueue.active()) {
        const active = turnQueue.active();
        pausedPreparation = { text: active.text, attachments: active.attachments, options: active.options,
          user: state.messages.findLast(row => row.role === 'user'), owner, account };
      }
      if (state.manualStopRequested) releaseManualStop();
      return { ...result, snapshot: _snapshot(state) };
    }
    generationGateActive++; state.pluginGenerationActive = generationGateActive;
    let native;
    try { native = send(text, attachments, options); }
    catch (error) { gate.dispose(); generationGateActive--; state.pluginGenerationActive = generationGateActive; throw error; }
    return Promise.resolve(native).then(async result => {
      // Catch only host validation failures here; native send failures retain
      // their existing admission/recovery and queue semantics.
      try { result = await gate.finish(result); }
      catch (error) { return checkFailure(error); }
      if (result?.failureKind === 'plugin-validation') {
        state.status = 'unreachable'; state.statusText = result.reason;
        state.completion = { reason: 'error', error: result.reason };
      } else if (result?.cancelled) {
        if (!state.goalPaused && !state.pendingPermissions.length) {
          state.status = 'aborted'; state.statusText = '\u5df2\u505c\u6b62';
          state.completion = { reason: 'cancelled' };
        }
      } else if (result?.ok && !result.paused && !result.recovering && !cancelled()) {
        state.status = 'idle'; state.statusText = '';
      }
      return result;
    }).finally(() => {
      gate.dispose();
      generationGateActive--; state.pluginGenerationActive = generationGateActive;
      if (!generationGateActive) activeFileJournal = null;
      emit(state.status === 'idle' ? 'settled' : state.status === 'unreachable' ? 'failed' : 'changed');
      if (!generationGateActive) queueMicrotask(drainTurns);
    }).then(result => result && typeof result === 'object'
      ? { ...result, snapshot: _snapshot(state) } : result);
  }

  function drainTurns() {
    if (state.disposed || state.pluginGenerationPreparing || state.pluginGenerationActive || state.queueImmediate.blocked() || state.accessChangePending || state.goalPaused || state.cancelRequested || turnQueue.blocked() ||
        state.status === 'streaming' || state.status === 'queued' || state.turnSubmissionPending || state.pendingPermissions.length || state.stopPending ||
        (state.started && !state.dispatchReady)) return;
    const next = turnQueue.take();
    if (!next) return;
    // Resolve the conversation's current selection at dequeue. Every turn
    // obtains its own grant; queued or cancelled drafts cannot change it early.
    const requested = pluginTurn.requestedIds(next.options);
    // Main-process admission can freeze an inherited selection for app/MCP
    // isolation. Keep that snapshot rather than borrowing another queued turn.
    const capturedInheritance = next.options.inheritedPluginSelection === true;
    const inheritedPlugins = (!requested.length || capturedInheritance) && next.options.clearPluginSelection !== true;
    if (next.options.clearPluginSelection === true) {
      state.activePluginIds = [];
    }
    // A requested replacement becomes persistent only when authorization
    // succeeds and appendUser records its trusted badges for this turn.
    // Failed preflight must not poison an ordinary follow-up's selection.
    next.options = { ...next.options, pluginIds: next.options.clearPluginSelection === true
      ? [] : requested.length ? requested.slice() : state.activePluginIds.slice() };
    const completion = turnQueue.run(next, () => {
      if (next.options.controlled) return next.options.controlled.execute(handle, next.text, next.attachments);
      const send = () => {
        if (state.disposed || state.cancelRequested || state.goalPaused || next.stopRequested) return { ok: true, cancelled: true };
        if (inheritedPlugins && !next.options.internal && !next.options.controlled && !next.options.taskId &&
            !handle.taskRef && !handle.taskIds?.length && !next.options.goalMode && !state.goalVisible &&
            !state.taskGoalContract && state.intent !== 'goal' && next.options.source !== 'automation' &&
            !handle.appPluginId && !opts.appContext) {
          try {
            const inheritedIds = capturedInheritance ? requested : state.activePluginIds;
            const retained = require('../personal-plugins').pruneUnavailableInherited(app, inheritedIds);
            if (retained.length !== inheritedIds.length) {
              // Record even an empty selection before any later model/provider
              // failure; replay must not revive a deleted plugin from old turns.
              taskJournal.append(state.seq, { kind: 'plugin-selection', pluginIds: retained });
              state.activePluginIds = retained;
            }
            next.options = { ...next.options, pluginIds: retained };
          } catch (error) {
            return { ok: false, failureKind: 'plugin-grant', retrySafe: true,
              reason: '插件没能在发送前完成授权：' + String(error?.message || error) };
          }
        }
        if (state.model.historicalLocal) throw Error('原本地模型已删除或不可用，请先选择一个当前可用模型后再发送');
        const byteAttachments = (Array.isArray(next.attachments) ? next.attachments : []).some(item =>
          item && item.data != null && !path.isAbsolute(String(item.path || item.stagedPath || '')));
        if (byteAttachments) {
          return _prepareRunnerAttachments(next.attachments, cwd).then(staged => {
            next.attachments = staged;
            return send();
          });
        }
        if (adapterId === 'codex') state.agentExecution = _nativeExecution(adapterId, {
          modelName: state.model.id, reasoningEffort: require('./codex-thinking').profile(
            next.options.modelName, next.options.reasoningEffort).level,
        });
        skillSelectionFailure = null;
        const materialUnderstanding = next.attachments?.length
          ? conversationInputPreparation.prepareSync({
            text: Object.prototype.hasOwnProperty.call(next.options.inputPreparation || {}, 'userText')
              ? next.options.inputPreparation.userText : next.text,
            files: next.attachments, fallback: Boolean(next.options.inputPreparation?.fallback),
          }) : { eligible: false, prompt: '' };
        const preparedOptions = materialUnderstanding.eligible && materialUnderstanding.prompt
          ? { ...next.options, materialUnderstandingPrompt: materialUnderstanding.prompt }
          : next.options;
        // Preserve the synchronous start/cancel contract of ordinary turns.
        if (!pluginTurn.requestedIds(preparedOptions).length && !preparedOptions.skills?.length && typeof opts.resolveConnectors !== 'function') {
          appendUser(next.text, next.attachments, [], preparedOptions.sentAt, preparedOptions.submissionId);
          emit('turn-dequeued', { queueId: next.id, taskId: next.options.taskId || '' });
          return sendWithGenerationGate(state.started ? continueTurn : dispatch,
            next.text, next.attachments, preparedOptions, () => next.stopRequested);
        }
        return sendWithPlugins();
      };
      const sendWithPlugins = () => require('./prepared-turn.cjs').send({
        state, opts, next, skillTurn, pluginTurn, emit, invalidateObservation, redactors,
        appendUser,
        dispatch: (text, files, options) => sendWithGenerationGate(dispatch, text, files, options, () => next.stopRequested),
        continueTurn: (text, files, options) => sendWithGenerationGate(continueTurn, text, files, options, () => next.stopRequested),
        conversationPrompt: _conversationPrompt, skillRows: _skillRows, TURN_SKILLS,
        onSkillFailure: value => { skillSelectionFailure = value; },
      });
      if (state.modelSelection.needsApply(next.options.modelName))
        return state.modelSelection.applyForTurn(next.options.modelName).then(send);
      return send();
    });
    Promise.resolve(completion).then(
      (result) => turnQueue.complete(next, result),
      (error) => turnQueue.complete(next, {
        ok: false, reason: String(error && error.message || error),
      }),
    ).finally(() => {
      // Preparation can fail before the explicit resume reaches Runner. Its
      // last authoritative paused receipt still owns the goal, so a later
      // user retry must carry the continue control again.
      if (taskGoalSupported && next.options.taskGoalControl === 'continue' &&
          ['paused', 'blocked'].includes(state.taskGoal?.status) && !turnQueue.active() &&
          !state.recoveryRequired && !state.turnSubmissionPending && !state.stopPending &&
          !state.cancelRequested && !['streaming', 'queued'].includes(state.status)) {
        taskGoal.observe(state, state.taskGoal, true);
      }
      if (state.manualStopRequested && !state.started && !state.preparingPlugins) releaseManualStop();
      emit('queue-changed');
      if (state.status !== 'streaming' && state.status !== 'queued') queueMicrotask(drainTurns);
    });
  }

  const goalControls = runtimeSpec.goalMode === 'native' ? createRunnerGoalControls({
    state,
    turnQueue,
    snapshot: () => _snapshot(state),
    requestStop,
    emit,
    settle,
    drainTurns,
    hasPausedPreparation: () => Boolean(pausedPreparation),
    continueTurn(text, files, options) {
      const pending = pausedPreparation;
      pausedPreparation = null;
      if (!pending) return sendWithGenerationGate(state.started ? continueTurn : dispatch, text, files, options);
      if (pending.owner !== handle.deliveryOwner ||
          pending.account !== require('../device-auth-request').accountScopeKey(identity))
        return Promise.resolve({ ok: true, cancelled: true, manualStop: true });
      // Baseline preparation paused before admission. Re-enter the queue with
      // the original inputs so runtime selection and grants are resolved afresh.
      return handle.submit(pending.text, pending.attachments, {
        ...pending.options, taskGoalControl: options.taskGoalControl, submissionId: '', [resumedUser]: pending.user,
      }).completion;
    },
  }) : {};
  state.queueImmediate = require('./runner-queue-immediate').create({
    state, queue: turnQueue, runtime, emit, poll, drain: drainTurns,
  });

  const handle = {
    deliveryCaptureAtTurnBoundary: true,
    get taskRef() { return taskBindings.view().taskId; },
    get taskTitle() { return taskBindings.view().taskTitle; },
    get taskIds() { return taskBindings.view().taskIds; },
    get taskBindings() { return taskBindings.view().taskBindings; },
    get activeTaskId() { return taskBindings.view().activeTaskId; },
    bindTask(id, title) {
      const result = taskBindings.bind(id, title);
      if (result.ok) emit('task-bound', { taskId: id });
      return { ...result, snapshot: _snapshot(state) };
    },
    ref: alias,
    adapterId, displayName,
    sessionId: runnerRef,
    get desktopControlScope() { return 'runner:' + runnerRef + ':' + state.round; },
    ownsDesktopControlScope(scope) {
      const prefix = 'runner:' + runnerRef + ':';
      if (typeof scope !== 'string' || !scope.startsWith(prefix)) return false;
      const suffix = scope.slice(prefix.length);
      if (!/^[1-9][0-9]*$/.test(suffix)) return false;
      const round = Number(suffix);
      // The child can start before the next poll publishes its incremented round.
      return round === state.round || round === state.round + 1;
    },
    cwd,
    model: prepared.model.id,
    get intent() { return state.intent; },
    get goal() { return state.goal; },
    ui: {},
    detached: false,
    attachedWindow: null,
    ownerClosed: null,
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot() { return _snapshot(state); },
    toolDetail(id) { return require('../pi-session/tool-detail').find(state.tools, id); },
    uiSnapshot(options) { return require('../pi-session/snapshot-window').limitSnapshot(_snapshot(state), options); },
    async setAccessPolicy(value, expectedRevision) {
      const rules = require('../access-control/policy');
      if (state.disposed || state.accessRestorePending || !state.accessControl?.supported || !state.accessControl?.canChangeDuringSession) return { ok: false, reason: '执行机尚未支持会话权限切换，请更新执行机' };
      if (state.accessChangePending) return { ok: false, reason: '正在保存权限，请稍候' };
      const policy = rules.next(value.mode, cwd, state.nextAccessPolicy || state.accessPolicy, expectedRevision);
      if (policy.revision !== value.revision) return { ok: false, reason: '权限状态已变化，请重新选择' };
      state.accessChangeGeneration = (state.accessChangeGeneration || 0) + 1;
      const previousPending = state.nextAccessPolicy;
      let changeConfirmed = false;
      state.accessChangePending = true;
      try {
        let result = null;
        const applyDuringTurn = state.accessControl?.changeTakesEffect === 'current-turn';
        if (state.started) {
          if (!state.dispatchReady) return { ok: false, reason: '会话正在启动，请稍后修改权限' };
          const reply = await runtime.rpc('job.access', { ref: state.runnerRef, accessPolicy: policy, expectedRevision, applyDuringTurn }, applyDuringTurn ? 75000 : 15000);
          if (!reply?.ok || !reply.data?.ok) return { ok: false, reason: reply?.data?.error || reply?.error || '权限变更没有保存，请重试' };
          result = reply.data;
          if (applyDuringTurn && (result.effective !== 'current-turn' || result.accessPolicy?.revision !== policy.revision || result.accessPolicy?.mode !== policy.mode)) return { ok: false, reason: '执行机尚未确认本轮权限已生效，请重试' };
        }
        if (state.disposed || state.cancelRequested) return { ok: false, reason: '会话已停止，权限切换已取消' };
        const effective = result?.effective || (applyDuringTurn && !state.started ? 'current-turn' : 'next-turn');
        if (effective === 'current-turn') {
          state.accessPolicy = rules.normalize(result?.accessPolicy || policy, cwd);
          state.nextAccessPolicy = null;
          state.appliedAccessPolicy = result?.appliedAccessPolicy || null;
          state.pendingPermissions = result?.pendingPermissions || [];
        } else state.nextAccessPolicy = policy;
        changeConfirmed = true;
        emit('access-changed');
        return { ok: true, effective };
      } finally {
        state.accessChangeGeneration = (state.accessChangeGeneration || 0) + 1;
        if (!changeConfirmed) state.nextAccessPolicy = previousPending;
        state.accessChangePending = false;
        if (state.started && !state.disposed && !state.cancelRequested) { clearTimeout(state.timer); state.timer = setTimeout(poll, 0); }
        queueMicrotask(drainTurns);
      }
    },
    appendTaskMessage(role, text, files, taskId, taskOutputKey, sourceModel, sourceAgent, plugins) {
      if (state.disposed) return;
      if (taskOutputKey && state.messages.some(m => m.taskOutputKey === taskOutputKey)) return;
      const at = Date.now();
      const timing = role === 'user' ? { sentAt: messageTime.epoch(turnQueue.active()?.options?.sentAt) || at } : { completedAt: at };
      const source = role === 'assistant' ? agentSource.fields(sourceAgent) : {};
      const badges = role === 'user' ? publicPluginBadges(plugins) : [];
      taskJournal.append(state.seq, { kind: 'message', role, text, files, taskId, taskOutputKey, ...timing, ...source,
        ...(role === 'user' ? { plugins: badges } : {}) });
      if (role === 'user') {
        appendUser(text, files, [], timing.sentAt, turnQueue.active()?.options?.submissionId);
        Object.assign(state.messages[state.messages.length - 1], { plugins: badges, taskOutputKey });
        if (taskId) state.messages[state.messages.length - 1].taskId = String(taskId);
      }
      else state.messages.push({ role: 'assistant', taskId, taskOutputKey, ...timing, ...source,
        blocks: [{ kind: 'text', text }], done: true });
      emit('task-message');
    },
    taskMessageStreaming: true,
    appendTaskRuntimeEvent(item, taskId) {
      if (state.disposed) return;
      if (item.kind === 'task-stream-end') { taskMessages.finish(item.streamPrefix); emit('task-message'); return; }
      if (taskMessages.apply(item, taskId)) { emit('task-message'); return; }
      if (require('../pi-session/tool-preparation').runtime(state, item)) emit('tool-preparing', { taskId });
    },
    appendTaskTool(event, taskId) {
      if (state.disposed) return;
      event = { ...event, sourceAgent: agentSource.normalize(event.sourceAgent) || undefined };
      taskJournal.append(state.seq, { kind: 'tool', event, taskId });
      chatEvents.apply(state, event);
      emit('tool', { taskId });
    },
    rememberWorkflowPlugin(id) {
      if (state.disposed) return;
      const ids = _pluginIds([id]);
      taskJournal.append(state.seq, { kind: 'plugin-selection', pluginIds: ids });
      state.activePluginIds = ids;
    },
    pluginDebugChanged(value) {
      handle.pluginDebug = value;
      if (turnQueue.active() && turnQueue.active().options.pluginDebug) {
        state.status = value.status === 'running' ? 'streaming' : ['waiting', 'failed', 'blocked'].includes(value.status) ? 'waiting-user' : 'idle';
        state.statusText = value.reason || '';
      }
      emit('plugin-debug');
    },
    taskExecutionChanged(value) {
      require('../pi-session/tool-preparation').finishTask(state, value);
      value = { ...(state.taskExecutions || []).find(x => x.taskId === value.taskId), ...value };
      state.taskExecutions = (state.taskExecutions || []).filter(x => x.taskId !== value.taskId).concat(value);
      state.status = value.status === 'running' ? 'streaming' : value.status === 'waiting' ? 'waiting-user' : 'idle';
      state.statusText = value.reason || '';
      emit('task-execution', { taskId: value.taskId });
    },
    status() { return state.status; },
    inFlight() { return Boolean(state.recoveryRequired || state.pendingPermissions.length || state.stopPending) || state.status === 'streaming' || state.status === 'queued' || turnQueue.size() > 0 || Boolean(turnQueue.active()); },
    async claimInterruptedTask(taskId) {
      const id = String(taskId || '');
      const eligible = () => resumedRef && !state.disposed && !handle.inFlight() &&
        !state.preparingPlugins && !state.turnSubmissionPending && !state.accessChangePending &&
        !state.accessRestorePending && !state.cancelRequested && !state.manualStopRequested &&
        !state.goalPaused && !state.queueImmediate.blocked() && !turnQueue.state().paused &&
        !(state.taskExecutions || []).some(row => row.taskId === id) && taskBindings.view().taskIds.includes(id);
      if (!eligible() || recoveredTasks.has(id)) return null;
      const token = crypto.randomUUID(), serial = state.turnSerial;
      recoveredTasks.set(id, token);
      let claimed = false;
      try {
        // A disconnected view is not proof of an interrupted native execution.
        // Recheck the original Runner archive before reusing its Hub receipt.
        const reply = await runtime.rpc('job.session', { ref: state.runnerRef, since: state.seq, limit: 1 }, 15000);
        const data = reply?.data;
        const terminal = ['done', 'completed', 'failed', 'stopped', 'interrupted', 'cancelled', 'canceled'];
        if (reply?.ok !== true || !data || data.ok === false || !terminal.includes(data.status) ||
            data.ref && data.ref !== state.runnerRef || data.pendingPermissions?.length || data.stopPending ||
            !eligible() || state.turnSerial !== serial || recoveredTasks.get(id) !== token) return null;
        claimed = true;
        return token;
      } catch (_) {
        return null;
      } finally {
        if (!claimed && recoveredTasks.get(id) === token) recoveredTasks.delete(id);
      }
    },
    releaseInterruptedTask(taskId, token) {
      const id = String(taskId || '');
      if (recoveredTasks.get(id) !== token) return false;
      return recoveredTasks.delete(id);
    },
    historyRow(snapshot) {
      return { ...taskBindings.view(), id: runnerRef, adapterId, title: state.title ||
        (state.goal ? _title(state.goal) : ''),
        nativeSessionStarted: state.started || taskJournal.nativeHistoryObserved,
        nativeDispatchId: predictedRef === runnerRef ? dispatchId : '',
        usedHarnesses: require('../conversation/used-harnesses').fromSnapshot(state, adapterId),
        cwd, at: state.updatedAt, count: state.messages.length, state: snapshot?.status || (state.pluginGenerationActive && state.status === 'idle' ? 'streaming' : state.status) };
    },
    goalView() {
      return { configured: state.goalVisible, intent: state.goalVisible ? 'goal' : '',
        mode: state.goalVisible ? 'goal' : 'chat', goal: state.goal,
        acceptance: state.acceptance, maxSteps: state.maxSteps,
        budgetMinutes: state.budgetMinutes, paused: state.goalPaused };
    },
    async selectModel(name) {
      if (state.disposed || state.modelChoicePending) return { ok: false, reason: '会话已关闭或正在切换模型，请稍候' };
      state.modelChoicePending = true;
      try {
        const result = await state.modelSelection.select(name);
        return state.thinking && result.ok ? { ...result, thinking: { ...state.thinking, levels: state.thinking.levels.slice() } } : result;
      } finally { state.modelChoicePending = false; }
    },
    setThinkingLevel(level) {
      if (adapterId !== 'codex') return { ok: false, reason: '当前 Agent 不支持此思考强度设置' };
      if (state.disposed || state.modelChoicePending) return { ok: false, reason: '会话已关闭或正在切换模型，请稍候' };
      if (typeof level !== 'string' || /[\r\n\0]/.test(level)) return { ok: false, reason: '思考强度无效' };
      const name = state.modelSelection.capture(), next = require('./codex-thinking').profile(name, level);
      if (!next.supported || level && !next.levels.includes(level)) return { ok: false, reason: '当前模型不支持此思考强度，请刷新模型后重试' };
      try { modelPreference.write(name, next.level); }
      catch (_) { return { ok: false, reason: '思考强度未能保存，请重试；原设置已保留' }; }
      state.thinking = next;
      emit('thinking-changed');
      return { ok: true, thinking: { ...next, levels: next.levels.slice() } };
    },
    submit(text, attachments, options) {
      const value = String(text ?? '');
      if (!value.trim()) return { accepted: false, result: { ok: false, reason: '请输入内容' } };
      if (value.length > 50000) return { accepted: false, result: { ok: false,
        reason: '本次输入最多 50000 个字符，请缩短后重试；内容未截断。' } };
      const resumingGoal = taskGoalSupported && state.goalPaused && !options?.controlled && !options?.taskId;
      if (resumingGoal && (continuationBlocked(state, turnQueue) || state.goalLimit?.canContinue === false)) {
        return { accepted: false, result: { ok: false, reason: state.goalLimit?.canContinue === false
          ? state.goalLimit.reason : '正在确认当前任务的停止状态，请稍后继续' } };
      }
      if (resumingGoal && turnQueue.find(turnQueue.view()[0]?.id)?.options.controlled)
        return { accepted: false, result: { ok: false, reason: '请先关闭当前目标，再执行排队任务' } };
      // Do not carry an automatic pause from an already-settled turn into a
      // new prompt. Goal pauses, permission waits, recovery and explicit
      // control pauses are protected by these admission checks (and by the
      // queue's pause source tracking).
      if (!state.cancelRequested && !state.stopPending && !state.turnSubmissionPending &&
          !state.preparingPlugins && !state.pendingPermissions.length && !state.goalPaused &&
          !state.accessChangePending && !['streaming', 'queued', 'waiting-user'].includes(state.status) &&
          !(state.started && !state.dispatchReady) && !turnQueue.active() && !turnQueue.size()) {
        turnQueue.resetIfIdle();
      }
      const busy = state.cancelRequested || state.stopPending || state.pendingPermissions.length || state.status === 'streaming' || state.status === 'queued' || turnQueue.blocked() || turnQueue.size() > 0 ||
        (state.started && !state.dispatchReady);
      {
        const taskModelOverride = options?.taskId && !options.controlled && typeof options.modelName === 'string';
        const modelName = taskModelOverride ? options.modelName : state.modelSelection.capture();
        const item = turnQueue.add({ text: value, attachments, options: { ...options, modelName,
          ...(adapterId === 'codex' ? { reasoningEffort: taskModelOverride && typeof options.reasoningEffort === 'string'
            ? options.reasoningEffort : state.thinking?.level || '' } : {}),
          sentAt: messageTime.epoch(options?.sentAt) || Date.now() } });
        if (item && Object.hasOwn(item.options, resumedUser)) turnQueue.prioritize(item.id);
        const retryingSkill = skillTurn.resumeRetry(turnQueue, item, skillSelectionFailure);
        // A turn that can start immediately should enter the transcript in the
        // same render pass. Emitting a queued event for every submission makes
        // the composer flash a queue row before the matching user message.
        if (busy && !retryingSkill) emit('turn-queued', { queueId: item.id });
        if (resumingGoal) goalControls.continueGoal();
        else drainTurns();
        return { accepted: true, queued: Boolean(busy && !retryingSkill), queueId: item.id,
          position: turnQueue.size(), completion: item.completion };
      }
    },
    send(text, attachments, options) { return handle.submit(text, attachments, options).completion; },
    async answerUi(value = {}) {
      const request = state.pendingPermissions.find(row => row.requestId === value.requestId);
      const question = request?.action === 'native.question';
      const validDecision = question ? value.decision === 'deny' || value.decision === 'answer' &&
        typeof value.optionId === 'string' && Array.isArray(request.options) && request.options.some(item => item?.optionId === value.optionId)
        : ['once', 'session', 'deny'].includes(value.decision);
      if (state.disposed || state.cancelRequested || state.stopSent || !request || request.policyRevision !== value.policyRevision || !validDecision) {
        return { ok: false, reason: '这条权限请求已失效，请使用当前请求' };
      }
      const reply = await runtime.rpc('job.permission', { ref: state.runnerRef,
        requestId: value.requestId, policyRevision: value.policyRevision, decision: value.decision,
        ...(question && value.decision === 'answer' ? { optionId: value.optionId } : {}) }, 15000);
      const result = reply?.data || reply;
      if (reply?.ok === false || result?.ok === false) return { ok: false, reason: result?.error || reply?.error || '权限确认失败，请重试' };
      state.pendingPermissions = state.pendingPermissions.filter(row => row.requestId !== value.requestId);
      emit('permission-answered');
      return { ok: true };
    },

    cancel() {
      pausedPreparation = null;
      observationCancellation++;
      state.queueImmediate.cancel();
      const active = turnQueue.active();
      if (active && active.options.controlled) {
        turnQueue.stopActive();
        turnQueue.clear({ ok: true, cancelled: true, queued: true, manualStop: true });
        turnQueue.pause('正在停止当前任务');
        Promise.resolve(active.options.controlled.cancel()).then(() => {
          turnQueue.resume();
          emit('queue-changed');
          queueMicrotask(drainTurns);
        }).catch(() => {
          turnQueue.pause('停止尚未确认，请重试');
          handle.taskExecutionChanged({ taskId: active.options.taskId, status: 'waiting', reason: '停止尚未确认，请重试' });
        });
        return { ok: true };
      }
      if (!active && !state.started) return { ok: true };
      state.manualStopRequested = true;
      state.stopAwaitingTerminal = Boolean(state.stopAwaitingTerminal || submissionFailed && state.recoveryRequired);
      state.cancelRequested = true;
      state.goalPaused = false;
      state.goalLimit = null;
      turnQueue.stopActive();
      turnQueue.clear({ ok: true, cancelled: true, queued: true, manualStop: true });
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      requestStop();
      messageStream.finish();
      state.turnEndedAt = Date.now();
      state.status = 'aborted';
      state.statusText = '已停止';
      void finishFileJournal();
      emit('cancelled');
      settle({ ok: true, cancelled: true, manualStop: true, snapshot: _snapshot(state) });
      if (state.stopAwaitingTerminal) scheduleRecovery();
      return { ok: true };
    },
    cancelQueued(id) {
      if (state.queueImmediate.locked(id)) return { ok: false, reason: '这条消息正在引导，请稍候' };
      const item = turnQueue.cancel(id, { ok: true, cancelled: true, queued: true });
      if (!item) return { ok: false, reason: '这条排队消息已经开始执行或已被取消' };
      emit('turn-queue-cancelled', { queueId: item.id });
      return { ok: true, cancelled: true, snapshot: _snapshot(state) };
    },
    updateQueue(id, action, value) {
      if (action === 'send-now') return state.queueImmediate.send(id).then(result => ({ ...result, snapshot: _snapshot(state) }));
      if (action === 'resume' && state.recoveryRequired) return verifyForResume();
      if (action === 'resume' && state.queueImmediate.blocked()) {
        const result = state.queueImmediate.resume(); if (!result.ok) return result;
      }
      if (state.queueImmediate.locked(id))
        return { ok: false, reason: '这条消息正在引导，请稍候' };
      const ok = action === 'resume' ? (turnQueue.resume(), state.cancelRequested = false, state.manualStopRequested = false, true)
        : action === 'edit' ? turnQueue.edit(id, value)
          : action === 'before' ? turnQueue.moveBefore(id, value)
          : action === 'up' || action === 'down' ? turnQueue.move(id, action === 'up' ? -1 : 1) : false;
      if (!ok) return { ok: false, reason: '只能调整尚未发送的消息' };
      emit('queue-changed'); queueMicrotask(drainTurns);
      return { ok: true, snapshot: _snapshot(state) };
    },
    ...goalControls,
    ...(goalControls.disableGoal ? { disableGoal() {
      pausedPreparation = null;
      if (state.goalVisible) observationCancellation++;
      return goalControls.disableGoal();
    } } : {}),
    outputs() { return outputs.list(cwd, outputSince); },
    outputSnapshot() { return { ...outputs.scan(cwd, outputSince, state.startedAt), fileChanges: state.fileChanges || null, pluginValidation: pluginGeneration.records(handle) }; },
    async outputSnapshotAsync() {
      const since = outputSince, turnSince = state.startedAt, fileChanges = state.fileChanges || null;
      const scanned = await outputs.scanAsync(cwd, since, turnSince);
      if (outputSince !== since || state.startedAt !== turnSince || (state.fileChanges || null) !== fileChanges)
        throw Error('当前轮次的成果已变化，请刷新后重试');
      return { ...scanned, fileChanges, pluginValidation: pluginGeneration.records(handle) };
    },
    async closeForDeviceTransfer() {
      const refusal = () => Object.assign(Error('原执行尚未确认结束，迁移保持冻结；请核对本机执行状态后重试'),
        { code: 'DEVICE_TRANSFER_EXECUTION_UNCONFIRMED' });
      const idle = () => !state.disposed && !handle.inFlight() && !state.preparingPlugins &&
        !state.pluginGenerationActive && !state.pluginGenerationPreparing && !state.turnSubmissionPending &&
        !state.accessChangePending && !state.accessRestorePending && !state.modelChoicePending &&
        !state.pendingTaskGoalControl && !state.stopAwaitingTerminal && !state.goalStopAwaitingTerminal &&
        !state.goalPaused && !state.queueImmediate.blocked() && !pausedPreparation &&
        (!state.taskGoal || ['completed','disabled'].includes(state.taskGoal.status)) &&
        !(state.taskExecutions || []).some(row => !TERMINAL_STATES.has(row.status) || row.running || row.active) &&
        !state.tools.some(tool => !['done','completed','failed','error','cancelled','canceled'].includes(tool.state));
      if (transferClosePending || !idle()) throw refusal();
      transferClosePending = true;
      const serial = state.turnSerial, generation = submissionGeneration;
      const external = JSON.stringify(state.taskExecutions || []);
      try {
        // A never-dispatched segment has no native job. Every existing segment
        // needs fresh local Runner proof; a cached UI terminal cannot authorize handoff.
        if (state.started || resumedRef || taskJournal.nativeHistoryObserved) {
          const reply = await runtime.rpc('job.session',{ref:state.runnerRef,since:state.seq,limit:1},15000);
          const data = reply?.data;
          if (reply?.ok !== true || data?.ok !== true || data.ref !== state.runnerRef ||
              !TERMINAL_STATES.has(data.status) || data.deviceTransfer?.schemaVersion !== 1 ||
              data.deviceTransfer.quiescent !== true || data.pendingPermissions?.length || data.stopPending ||
              data.detached || data.canStop || data.taskGoal && !['completed','disabled'].includes(data.taskGoal.status)) throw refusal();
        }
        if (!idle() || state.turnSerial !== serial || submissionGeneration !== generation ||
            JSON.stringify(state.taskExecutions || []) !== external) throw refusal();
        // No await separates this final check and passive disposal. Ordinary
        // close retains its stop behavior; migration must never stop active work.
        handle.close(transferCloseToken);
        return true;
      } catch (_) { throw refusal(); }
      finally { transferClosePending = false; }
    },
    close(transferProof) {
      pausedPreparation = null;
      if (state.disposed) return;
      state.disposed = true;
      taskJournal.close();
      observationCancellation++;
      // Release the same optional memory subscription as the direct Pi handle.
      const disposeMemory = handle.ui?.memorySubscription;
      if (handle.ui) delete handle.ui.memorySubscription;
      if (typeof disposeMemory === 'function') {
        try { Promise.resolve(disposeMemory()).catch(() => {}); } catch (_) {}
      }
      state.queueImmediate.cancel();
      if (state.timer) clearTimeout(state.timer);
      state.cancelRequested = true;
      state.timer = null;
      turnQueue.clear({ ok: false, reason: '会话已关闭' });
      if (transferProof !== transferCloseToken) requestStop();
      listeners.clear();
      redactors.clear();
      settle({ ok: false, reason: '会话已关闭' });
    },
  };

  if (resumeNative) {
    state.startedAt = 0;
    state.status = 'streaming';
    setTimeout(poll, 0);
  }
  // Old sessions remain usable while capability discovery runs. An old Runner
  // never gets a versioned change unless it explicitly advertises this protocol.
  if (!opts.accessPolicy) Promise.resolve().then(() => runtime.rpc('runtime.detect', { key: adapterId }, 15000))
    .then(reply => { if (!state.disposed && reply?.ok && reply.data?.accessControl?.schema === 'soduwork.access-policy/v1') {
      state.accessControl = reply.data.accessControl; emit('access-capability');
    } }).catch(() => {});
  return handle;
}

function wrapRunnerSession(handle, request, details, runtimeSpec) {
  const adapterId = String(runtimeSpec && runtimeSpec.id || ADAPTER_ID);
  const listeners = new Set();
  const event = createEventFactory({
    runtimeId: String(request && request.runtimeId || 'desktop'),
    adapterId,
    sessionId: handle.sessionId,
  });
  let disposed = false;
  const detach = handle.on((touched, snapshot) => {
    const value = event(_eventKind(touched, { status: snapshot.status }), { snapshot }, {
      source: 'runtime', native: { namespace: 'runner', type: touched.kind, payload: touched },
    });
    listeners.forEach((listener) => { try { listener(value); } catch (error) {} });
  });
  const runtimeSession = {
    id: handle.sessionId,
    adapterId,
    capabilities: runnerCapabilities(runtimeSpec),
    send(input) {
      const value = typeof input === 'string' ? { text: input } : input || {};
      return handle.submit(value.text, value.attachments, value.options);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot() { return handle.snapshot(); },
    cancel() { return handle.cancel(); },
    artifacts() { return handle.outputSnapshotAsync(); },
    controlGoal(action) {
      const methods = { continue: 'continueGoal', pause: 'pauseGoal', disable: 'disableGoal' };
      const method = methods[String(action || '')];
      if (!method || typeof handle[method] !== 'function') {
        throw new RuntimeContractError('CAPABILITY_UNAVAILABLE',
          'unsupported Runner goal action: ' + action);
      }
      return handle[method]();
    },
    async dispose() {
      if (disposed) return false;
      disposed = true;
      detach();
      handle.close();
      listeners.clear();
      RUNNER_SESSION_DETAILS.delete(runtimeSession);
      return true;
    },
  };
  RUNNER_SESSION_DETAILS.set(runtimeSession, Object.freeze({ handle, result: details || {} }));
  return runtimeSession;
}

function getRunnerSessionDetails(runtimeSession) {
  return RUNNER_SESSION_DETAILS.get(runtimeSession) || null;
}

function _runnerInventory(runtime, { force = false } = {}) {
  let slot = RUNNER_INVENTORIES.get(runtime);
  if (!slot) {
    slot = { at: 0, runs: [], pending: null, revision: 0 };
    RUNNER_INVENTORIES.set(runtime, slot);
  }
  if (slot.pending) return slot.pending;
  if (!force && slot.at && Date.now() - slot.at < 750) return Promise.resolve(slot.runs);
  const revision = slot.revision;
  slot.pending = Promise.resolve(runtime.rpc('runtime.sessions', {}, 10000)).then((reply) => {
    if (!reply || reply.ok === false) {
      throw new Error(String(reply && reply.error || '读不到 Runner 会话目录'));
    }
    if (!Array.isArray(reply.data?.runs)) throw new Error('Runner 会话目录响应无效');
    if (slot.revision === revision) {
      slot.runs = reply.data.runs;
      slot.at = Date.now();
    }
    return slot.runs;
  }).finally(() => { slot.pending = null; });
  return slot.pending;
}

function _dropRunnerInventory(runtime, ref) {
  const slot = RUNNER_INVENTORIES.get(runtime);
  if (!slot) return;
  const wanted = String(ref || '');
  slot.revision += 1;
  slot.runs = (slot.runs || []).filter(row => String(row && row.ref || '') !== wanted);
  slot.at = Date.now();
}

function createRunnerRuntimeAdapter(options) {
  const opts = options || {};
  const runtime = opts.runnerRuntime || runnerRuntime;
  const runtimeSpec = opts.runtimeSpec || runtimeCatalog.runtime(ADAPTER_ID);
  if (!runtimeSpec || runtimeSpec.transport !== 'runner') {
    throw new RuntimeContractError('INVALID_RUNNER_RUNTIME',
      'Runner adapter needs a registered runner runtime');
  }
  const adapterId = String(runtimeSpec.id);
  const displayName = String(runtimeSpec.displayName);
  const defaults = { ...opts, runtimeSpec };
  const isChat = row => row.cli === adapterId && /^chat-/.test(String(row.taskId || ''));
  async function historyRow(row, metadataOnly = false) {
    return {
      id: row.ref, path: row.ref, adapterId,
      ...(!metadataOnly ? { usedHarnesses: require('../conversation/used-harnesses').merge([adapterId],
        await taskOutputJournal.usedHarnesses(opts.app, row.ref).catch(() => [])) } : {}),
      cwd: row.workDir || '', title: row.title || displayName + ' 工作会话',
      createdAt: Math.round(Number(row.started || row.ended || 0) * 1000),
      at: Math.round(Number(row.ended || row.started || 0) * 1000),
      count: Number(row.seq || 0), state: _status(row.state),
    };
  }
  const adapter = {
    id: adapterId,
    displayName,
    version: '1',
    capabilities: runnerCapabilities(runtimeSpec),
    async detect() {
      try {
        const reply = await runtime.rpc('runtime.detect', { key: adapterId }, 15000);
        const item = reply && reply.data || {};
        return item.installed && !['unauthed', 'nollm', 'missing'].includes(item.state)
          ? { ok: true, version: item.version || '', path: item.bin || '', state: item.state || 'ready',
            ...(item.accessControl ? { accessControl: item.accessControl } : {}) }
          : { ok: false, reason: item.why || '这台电脑还没安装 ' + displayName,
            state: item.state || 'missing',
            ...(item.accessControl ? { accessControl: item.accessControl } : {}) };
      } catch (error) {
        return { ok: false, reason: String(error && error.message || error) };
      }
    },
    async createSession(request) {
      const handle = await createRunnerHandle(request, defaults);
      return wrapRunnerSession(handle, request, { ok: true }, runtimeSpec);
    },
    async resumeSession(request) {
      let options = _legacyOptions(request);
      const resumePath = String(options.resumePath || '');
      let initialSession = null;
      if (resumePath && (options.verifyLegacySegment || options.nativeSessionStarted === false)) {
        // Controlled task output does not prove that this native segment was
        // dispatched. Verify both the archive and durable admission journal;
        // a timeout, an old Runner or an active admission must remain fenced.
        let probe;
        try { probe = await runtime.rpc('job.session', { ref: resumePath, since: 0, limit: 1 }, 5000); }
        catch (error) { if (_resumeCredentialError(error)) throw error; }
        const failure = probe?.error || probe?.data?.error;
        if (_resumeCredentialError(failure)) throw Error(String(failure));
        if (probe?.ok === true && probe.data?.ok === false && !probe.data?.items?.length) {
          let proof;
          try { proof = await runtime.rpc('job.has', { ref: resumePath }, 5000); }
          catch (_) { /* Missing proof never authorizes a new dispatch. */ }
          const absent = proof?.ok === true && proof.data?.has === false &&
            proof.data.inflight === false && proof.data.persisted === false &&
            proof.data.admissionDurable === true && Boolean(proof.data.bootId);
          if (absent) {
            const dormantOptions = { ...options, nativeSessionStarted: false };
            const dormantRequest = { ...request, native: { ...request.native,
              runner: { ...request.native?.runner, openOptions: dormantOptions } } };
            const handle = await createRunnerHandle(dormantRequest, defaults);
            if (!handle.historyRow().nativeSessionStarted) {
              if (options.nativeDispatchId) return wrapRunnerSession(handle, request, { ok: true, resumed: true }, runtimeSpec);
              // Legacy manifests overwrote the original dispatch alias on reopen.
              // Preserve their controlled transcript in the public conversation
              // before replacing only the never-admitted native segment.
              const error = new RuntimeContractError('RUNNER_SEGMENT_NOT_ADMITTED', 'Native segment has no execution admission');
              error.snapshot = handle.snapshot(); error.taskBindings = handle.taskBindings;
              handle.close();
              throw error;
            }
            // A local native cursor contradicts absence. Never replace a
            // previously dispatched segment merely because its archive vanished.
            handle.close();
          }
        }
        options = { ...options, nativeSessionStarted: true };
        request = { ...request, native: { ...request.native,
          runner: { ...request.native?.runner, openOptions: options } } };
        if (probe?.ok && probe.data?.ok !== false && Array.isArray(probe.data?.items)) initialSession = probe;
      }
      if (resumePath && !initialSession) {
        // Check immediately available credential errors, but never wait for a
        // long-polling job.session response before creating the handle. The
        // normal polling loop remains authoritative for delayed responses.
        const probe = Promise.resolve().then(() => runtime.rpc('job.session',
          { ref: resumePath, since: 0, limit: 1 }, 15000));
        const result = await Promise.race([
          probe.then(value => ({ settled: true, value }), error => ({ settled: true, error })),
          new Promise(resolve => setTimeout(() => resolve({ settled: false }), 0)),
        ]);
        if (result.settled) {
          // A credential probe can return only status/authorization metadata.
          // Reuse it as a history page only when it actually contains items;
          // otherwise the normal full poll must still restore the conversation.
          if (result.value?.ok && Array.isArray(result.value?.data?.items)) initialSession = result.value;
          const failure = result.error || result.value?.error || result.value?.data?.error ||
            (!result.value?.ok ? result.value : null);
          if (_resumeCredentialError(failure)) {
            throw new Error(typeof failure === 'string' ? failure : JSON.stringify(failure));
          }
        }
      }
      const handle = await createRunnerHandle(request, defaults, initialSession);
      return wrapRunnerSession(handle, request, { ok: true, resumed: true }, runtimeSpec);
    },
    async historyEntry(id, { strict = false, metadataOnly = false } = {}) {
      try {
        const row = (await _runnerInventory(runtime, { force: strict })).find(row => row.ref === id && isChat(row));
        return { ok: true, chats: row ? [await historyRow(row, metadataOnly)] : [] };
      } catch (error) {
        return { ok: false, reason: String(error && error.message || error), chats: [] };
      }
    },
    async history(limit = 50, { strict = false, metadataOnly = false } = {}) {
      try {
        const runs = await _runnerInventory(runtime, { force: strict });
        const selected = runs.filter(isChat).slice(0, Math.max(1, Number(limit) || 50));
        const chats = [];
        // Bound concurrent journal streams when the full sidebar is requested.
        for (let start = 0; start < selected.length; start += 16)
          chats.push(...await Promise.all(selected.slice(start, start + 16).map(row => historyRow(row, metadataOnly))));
        return { ok: true, chats };
      } catch (error) {
        return { ok: false, reason: String(error && error.message || error), chats: [] };
      }
    },
    async forgetSession(ref) {
      const wanted = String(ref || '');
      const refused = (value) => {
        const reason = String(value || '底座拒绝了删除');
        const notFound = /不在|不存在|找不到/.test(reason);
        if (notFound) _dropRunnerInventory(runtime, wanted);
        return { ok: false, ...(notFound ? { notFound: true } : {}), reason };
      };
      try {
        const reply = await runtime.rpc('runtime.session.forget', { ref: wanted }, 15000);
        if (reply && reply.ok === false) return refused(reply.error);
        const data = reply && reply.data || {};
        if (data.ok === false) return refused(data.error);
        _dropRunnerInventory(runtime, wanted);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: String(error && error.message || error) };
      }
    },
  };
  return Object.freeze(adapter);
}

module.exports = {
  ADAPTER_ID,
  RUNNER_CAPABILITIES,
  createRunnerRuntimeAdapter,
  getRunnerSessionDetails,
  _runnerInventory, _dropRunnerInventory,
  _uuidV5,
  _skillRows,
};
