'use strict';

const { CAPABILITIES, RuntimeContractError } = require('./contract');
const { createEventFactory } = require('./events');

const PI_SESSION_DETAILS = new WeakMap();

const PI_CAPABILITIES = Object.freeze([
  { id: CAPABILITIES.SESSION_RESUME, level: 'native' },
  { id: CAPABILITIES.TURN_QUEUE, level: 'native' },
  { id: CAPABILITIES.TURN_CANCEL, level: 'native' },
  { id: CAPABILITIES.ARTIFACT_LIST, level: 'native' },
  { id: CAPABILITIES.APPROVAL_RESPOND, level: 'native' },
  { id: CAPABILITIES.GOAL_CONTROL, level: 'native', native: {
    namespace: 'pi', operations: ['continue', 'pause', 'disable'],
  } },
  { id: CAPABILITIES.ATTACHMENTS, level: 'native' },
  { id: CAPABILITIES.MODEL_SELECT, level: 'native' },
  { id: CAPABILITIES.SKILLS, level: 'native' },
  { id: CAPABILITIES.MCP, level: 'native' },
  { id: CAPABILITIES.WORKSPACE, level: 'native' },
  { id: CAPABILITIES.NATIVE_EVENTS, level: 'native', native: { namespace: 'pi' } },
]);

const NATIVE_OPERATIONS = Object.freeze({
  continueGoal: 'continueGoal',
  pauseGoal: 'pauseGoal',
  disableGoal: 'disableGoal',
  cancelQueued: 'cancelQueued',
  goalView: 'goalView',
  historyRow: 'historyRow',
  status: 'status',
});

function _set(target, key, value) {
  if (value !== undefined && value !== null && value !== '') target[key] = value;
}

function _acceptance(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join('\n');
  return value === undefined || value === null ? '' : String(value);
}

function toPiOpenOptions(request, defaults) {
  const req = request || {};
  const native = req.native && req.native.pi && req.native.pi.openOptions;
  const out = native && typeof native === 'object' ? { ...native } : {};
  const goal = req.goal && typeof req.goal === 'object' ? req.goal : {};
  const workspace = req.workspace && typeof req.workspace === 'object' ? req.workspace : {};
  const resume = req.resume && typeof req.resume === 'object' ? req.resume : {};
  const task = req.task && typeof req.task === 'object' ? req.task : {};
  const runtime = req.runtime && typeof req.runtime === 'object' ? req.runtime : {};

  _set(out, 'app', runtime.app || defaults.app);
  _set(out, 'identity', req.identity || defaults.identity);
  _set(out, 'cwd', workspace.path || req.cwd);
  _set(out, 'taskRef', task.id || req.taskRef);
  _set(out, 'taskTitle', task.title || req.taskTitle);
  if (req.requireTaskBinding === true) out.requireTaskBinding = true;
  _set(out, 'thinkingLevel', req.thinkingLevel);
  _set(out, 'modelName', req.model && (req.model.id || req.model.name) || req.modelName);
  _set(out, 'skillDirs', req.skillDirs);
  _set(out, 'capabilityIds', req.capabilityIds);
  _set(out, 'readOnly', req.permissions && req.permissions.write === false);
  _set(out, 'resolvePlugins', req.resolvePlugins);
  _set(out, 'inputAttachments', req.attachments);
  if (req.mode === 'goal' || goal.objective || goal.text || goal.goal) {
    out.intent = 'goal';
    out.goal = String(goal.objective || goal.text || goal.goal || '');
    out.acceptance = _acceptance(goal.acceptance || goal.acceptanceCriteria);
  } else if (req.mode === 'chat') {
    out.intent = '';
  }
  _set(out, 'resumePath', resume.path || req.resumePath);
  _set(out, 'resumeCwd', resume.cwd || req.resumeCwd);
  _set(out, 'resumeAt', resume.at || req.resumeAt);
  return out;
}

function _status(raw) {
  const status = String((raw && raw.status) || 'idle');
  if (status === 'streaming' || status === 'compacting') return 'running';
  if (status === 'waiting-user') return 'waiting';
  if (status === 'aborted') return 'cancelled';
  if (['unreachable', 'no-output', 'incomplete'].includes(status)) return 'failed';
  return status === 'idle' ? 'idle' : status;
}

function _text(value, limit) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function _number(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function _object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function _rows(value, limit, project) {
  return (Array.isArray(value) ? value : []).slice(-limit).map(project);
}

function _limit(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    kind: _text(value.kind, 40),
    reason: _text(value.reason, 1000),
    used: _number(value.used),
    limit: _number(value.limit),
    unit: _text(value.unit, 40),
    canContinue: Boolean(value.canContinue),
  };
}

function _harness(value) {
  const row = _object(value);
  return {
    schemaVersion: _number(row.schemaVersion),
    runId: _text(row.runId, 160),
    node: _text(row.node, 40),
    phase: _text(row.phase, 40),
    state: _text(row.state, 40),
    decision: _text(row.decision, 40),
    reason: _text(row.reason, 1000),
    attempts: _number(row.attempts),
    iteration: _number(row.iteration),
    revision: _number(row.revision),
    workKind: _text(row.workKind, 40),
    updatedAt: _number(row.updatedAt),
    pause: _limit(row.pause),
    phases: _rows(row.phases, 12, (item) => ({
      key: _text(item && item.key, 40),
      label: _text(item && item.label, 80),
      state: _text(item && item.state, 40),
    })),
    tasks: _rows(row.tasks, 64, (item) => ({
      id: _text(item && (item.id || item.key), 80),
      label: _text(item && item.label, 240),
      category: _text(item && item.category, 40),
      status: _text(item && item.status, 40),
      required: !item || item.required !== false,
      attempts: _number(item && item.attempts),
      reason: _text(item && item.reason, 600),
      updatedAt: _number(item && item.updatedAt),
    })),
    progress: _rows(row.progress, 64, (item) => ({
      id: _text(item && item.id, 160),
      type: _text(item && item.type, 80),
      node: _text(item && item.node, 40),
      iteration: _number(item && item.iteration),
      summary: _text(item && item.summary, 600),
      at: _number(item && item.at),
    })),
  };
}

function _snapshot(sessionId, handle, supplied) {
  const raw = supplied && typeof supplied === 'object' ? supplied : handle.snapshot();
  const execution = raw.execution && typeof raw.execution === 'object' ? raw.execution : {};
  return {
    schema: 'soduwork.agent-runtime.snapshot/v1',
    adapterId: 'pi',
    sessionId,
    status: _status(raw),
    running: Boolean(execution.running || (typeof handle.inFlight === 'function' && handle.inFlight())),
    queued: Number(execution.queued || 0),
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    tools: Array.isArray(raw.tools) ? raw.tools : [],
    notices: Array.isArray(raw.notices) ? raw.notices : [],
    execution: {
      configured: Boolean(execution.configured),
      visible: execution.visible !== false,
      active: Boolean(execution.active),
      stopped: Boolean(execution.stopped),
      running: Boolean(execution.running),
      step: _number(execution.step),
      maxSteps: _number(execution.maxSteps),
      elapsedMs: _number(execution.elapsedMs),
      idleMs: _number(execution.idleMs),
      budgetMs: _number(execution.budgetMs),
      paused: Boolean(execution.paused),
      canContinue: Boolean(execution.canContinue),
      reason: _text(execution.reason, 1000),
      limitRequest: _limit(execution.limitRequest),
      quality: {
        required: Boolean(execution.quality && execution.quality.required),
        phase: _text(execution.quality && execution.quality.phase, 40),
        reason: _text(execution.quality && execution.quality.reason, 1000),
        rounds: _number(execution.quality && execution.quality.rounds),
      },
      harness: _harness(execution.harness),
    },
    native: { namespace: 'pi', snapshot: raw },
  };
}

function _eventType(touched, snapshot) {
  const kind = String((touched && touched.kind) || '');
  if (kind === 'turn-queued') return 'turn.queued';
  if (kind === 'turn-dequeued') return 'turn.started';
  if (kind === 'turn-finished' || kind === 'settled') {
    const status = _status(snapshot || {});
    if (status === 'failed') return 'turn.failed';
    if (status === 'cancelled') return 'turn.cancelled';
    if (snapshot && snapshot.execution && snapshot.execution.paused) return 'turn.paused';
    return 'turn.completed';
  }
  if (kind === 'goal-paused' || kind === 'goal-paused-by-user' || kind === 'budget-stopped') {
    return 'turn.paused';
  }
  if (kind === 'aborted' || kind === 'turn-queue-cancelled') return 'turn.cancelled';
  if (kind === 'ui') return 'approval.requested';
  if (kind === 'ui-answered') return 'approval.resolved';
  if (kind === 'permission') return snapshot?.pendingPermissions?.length || snapshot?.pendingUi?.requestId
    ? 'approval.requested' : 'approval.resolved';
  return 'state.changed';
}

function wrapPiSession(handle, request, details) {
  if (!handle || typeof handle !== 'object') {
    throw new RuntimeContractError('PI_SESSION_INVALID', 'Pi did not return a session handle');
  }
  const sessionId = String(handle.sessionId || handle.ref || '');
  if (!sessionId) throw new RuntimeContractError('PI_SESSION_INVALID', 'Pi session has no identity');
  const listeners = new Set();
  const event = createEventFactory({
    runtimeId: String((request && request.runtimeId) || 'local'),
    adapterId: 'pi',
    sessionId,
  });
  let disposed = false;
  const detach = typeof handle.on === 'function' ? handle.on((touched, rawSnapshot) => {
    const nativeType = String((touched && touched.kind) || 'unknown');
    const value = event(_eventType(touched, rawSnapshot), {
      snapshot: _snapshot(sessionId, handle, rawSnapshot),
    }, {
      turnId: touched && (touched.queueId || touched.submissionId),
      source: nativeType === 'ui' ? 'framework' : 'runtime',
      native: {
        namespace: 'pi',
        type: nativeType,
        payload: touched && typeof touched === 'object' ? { ...touched } : {},
      },
    });
    listeners.forEach((listener) => {
      try { listener(value); } catch (error) { /* one observer cannot stop the runtime */ }
    });
  }) : () => {};

  const runtimeSession = {
    id: sessionId,
    adapterId: 'pi',
    capabilities: PI_CAPABILITIES,
    native: Object.freeze({ namespace: 'pi', operations: Object.keys(NATIVE_OPERATIONS) }),
    send(input) {
      const value = typeof input === 'string' ? { text: input } : (input || {});
      const text = String(value.text || '');
      const attachments = Array.isArray(value.attachments) ? value.attachments : [];
      const options = value.options && typeof value.options === 'object' ? value.options : {};
      if (typeof handle.submit === 'function') {
        const accepted = handle.submit(text, attachments, options);
        const receipt = result => ({
          accepted: result.accepted !== false,
          queued: Boolean(result.queued),
          queueId: String(result.queueId || ''),
          position: Number(result.position || 0),
          ...(result.result !== undefined ? { result: result.result } : {}),
          completion: result.completion || Promise.resolve(result.result),
        });
        // Remote admission is asynchronous; its completion remains a separate
        // promise. Local adapters keep their existing synchronous receipt.
        return accepted?.then ? Promise.resolve(accepted).then(receipt) : receipt(accepted);
      }
      return {
        accepted: true,
        queued: false,
        completion: Promise.resolve(handle.send(text, attachments, options)),
      };
    },
    subscribe(listener) {
      if (typeof listener !== 'function') {
        throw new RuntimeContractError('INVALID_SUBSCRIBER', 'runtime subscriber must be a function');
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot() { return _snapshot(sessionId, handle); },
    cancel() {
      if (typeof handle.cancel !== 'function') {
        throw new RuntimeContractError('CAPABILITY_UNAVAILABLE', 'Pi session cannot be cancelled');
      }
      return handle.cancel();
    },
    artifacts() {
      if (typeof handle.outputSnapshotAsync === 'function') {
        return Promise.resolve(handle.outputSnapshotAsync()).then(snapshot => snapshot.files || []);
      }
      return typeof handle.outputs === 'function' ? handle.outputs() : { files: [] };
    },
    respondApproval(response) {
      if (typeof handle.answerUi !== 'function') {
        throw new RuntimeContractError('CAPABILITY_UNAVAILABLE', 'Pi session has no approval channel');
      }
      return handle.answerUi(response);
    },
    controlGoal(action) {
      const methods = { continue: 'continueGoal', pause: 'pauseGoal', disable: 'disableGoal' };
      const method = methods[String(action || '')];
      if (!method || typeof handle[method] !== 'function') {
        throw new RuntimeContractError('CAPABILITY_UNAVAILABLE', 'unsupported Pi goal action: ' + action);
      }
      return handle[method]();
    },
    invokeNative(operation, ...args) {
      const method = NATIVE_OPERATIONS[String(operation || '')];
      if (!method || typeof handle[method] !== 'function') {
        throw new RuntimeContractError('NATIVE_OPERATION_UNAVAILABLE',
          'unsupported Pi native operation: ' + operation);
      }
      return handle[method](...args);
    },
    async dispose() {
      if (disposed) return false;
      disposed = true;
      listeners.clear();
      try { detach(); } catch (error) { /* best-effort listener cleanup */ }
      try {
        if (typeof handle.close === 'function') await handle.close();
        return true;
      } finally {
        PI_SESSION_DETAILS.delete(runtimeSession);
      }
    },
  };
  PI_SESSION_DETAILS.set(runtimeSession, Object.freeze({
    handle,
    result: details && details.result ? details.result : null,
  }));
  return runtimeSession;
}

function getPiSessionDetails(runtimeSession) {
  return PI_SESSION_DETAILS.get(runtimeSession) || null;
}

function createPiRuntimeAdapter(options) {
  const opts = options || {};
  const sessionModule = opts.sessionModule;
  if (!sessionModule || typeof sessionModule.open !== 'function' ||
      typeof sessionModule.probe !== 'function') {
    throw new RuntimeContractError('PI_MODULE_INVALID',
      'Pi adapter needs a session module with open() and probe()');
  }
  const adapter = {
    id: 'pi',
    displayName: 'Pi',
    version: String(opts.version || '1'),
    capabilities: PI_CAPABILITIES,
    detect(context) {
      const value = context || {};
      return sessionModule.probe(value.app || opts.app);
    },
    async createSession(request) {
      const result = await sessionModule.open(toPiOpenOptions(request, opts));
      if (!result || !result.ok || !result.session) {
        throw new RuntimeContractError(result?.code === 'TASK_BINDING_MISMATCH' ? result.code : 'PI_SESSION_OPEN_FAILED',
          String((result && result.reason) || 'Pi session failed to open'), { result });
      }
      return wrapPiSession(result.session, request, { result });
    },
    async resumeSession(request) {
      const openOptions = toPiOpenOptions(request, opts);
      if (!openOptions.resumePath) {
        throw new RuntimeContractError('RESUME_STATE_REQUIRED',
          'Pi resume needs resume.path or resumePath');
      }
      const result = await sessionModule.open(openOptions);
      if (!result || !result.ok || !result.session) {
        throw new RuntimeContractError(result?.code === 'TASK_BINDING_MISMATCH' ? result.code : 'PI_SESSION_RESUME_FAILED',
          String((result && result.reason) || 'Pi session failed to resume'), { result });
      }
      return wrapPiSession(result.session, request, { result });
    },
  };
  return Object.freeze(adapter);
}

module.exports = {
  PI_CAPABILITIES,
  NATIVE_OPERATIONS,
  createPiRuntimeAdapter,
  getPiSessionDetails,
  toPiOpenOptions,
  wrapPiSession,
};
