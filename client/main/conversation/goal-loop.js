'use strict';

/* Durable, dependency-free delivery loop.
   Pi performs actions; SoduWork owns transitions, retry policy and checkpoints. */
const contract = require('./goal-harness');

const ENTRY_TYPE = 'soduwork.goal.loop';
const SCHEMA_VERSION = 2;
const MAX_PROGRESS = 80;
const MAX_EVENT_IDS = 40;
const INTERNAL_CYCLE_OPEN = '<soduwork-internal-loop-cycle>';
const INTERNAL_CYCLE_CLOSE = '</soduwork-internal-loop-cycle>';
const NODE_PHASE = Object.freeze({
  inspect: 'understand',
  plan: 'plan',
  act: 'execute',
  observe: 'execute',
  verify: 'verify',
  decide: 'verify',
  package: 'deliver',
  done: 'deliver',
});

const clean = (value, limit) =>
  String(value == null ? '' : value).trim().slice(0, limit);

function phaseRows(phase, state) {
  const active = Math.max(0, contract.PHASES.findIndex(([key]) => key === phase));
  return contract.PHASES.map(([key, label], index) => {
    let rowState = index < active ? 'completed'
      : index === active ? 'running' : 'pending';
    if (state === 'completed') rowState = 'completed';
    else if (index === active && ['blocked', 'paused'].includes(state)) {
      rowState = state;
    }
    return { key, label, state: rowState };
  });
}

function taskRows(checks) {
  return (checks || []).map((item, index) => ({
    id: clean(item.key || ('check_' + (index + 1)), 80),
    key: clean(item.key || ('check_' + (index + 1)), 80),
    label: clean(item.label, 240),
    category: clean(item.category, 40),
    required: item.required !== false,
    status: 'pending',
    attempts: 0,
    reason: '',
    evidence: [],
    updatedAt: 0,
  }));
}

function compile(raw) {
  const spec = contract.compile(raw || {});
  const at = Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: clean(raw && raw.runId, 120) || ('goal-' + at.toString(36)),
    objective: spec.objective,
    workKind: spec.workKind,
    workKinds: spec.workKinds,
    criteria: spec.criteria,
    checks: spec.checks,
    deliverables: spec.deliverables,
    coverage: spec.coverage,
    journeys: spec.journeys,
    dimensions: spec.dimensions,
    qualityThreshold: spec.qualityThreshold,
    node: 'inspect',
    phase: 'understand',
    state: 'running',
    decision: '',
    focus: null,
    score: null,
    scoreHistory: [],
    pause: null,
    reason: '',
    revision: 0,
    iteration: 0,
    attempts: 0,
    updatedAt: at,
    tasks: taskRows(spec.checks),
    progress: [],
    recentEventIds: [],
    phases: phaseRows('understand', 'running'),
  };
}

function normalize(value, fallback) {
  const base = value && typeof value === 'object' ? value : {};
  const seed = compile({
    ...(fallback || {}),
    goal: base.objective || (fallback && fallback.goal),
  });
  const source = Number(base.schemaVersion) === SCHEMA_VERSION
    ? { ...seed, ...base }
    : {
        ...seed,
        objective: clean(base.objective || seed.objective, 4000),
        workKind: clean(base.workKind || seed.workKind, 40),
        criteria: Array.isArray(base.criteria) ? base.criteria : seed.criteria,
        workKinds: Array.isArray(base.workKinds) ? base.workKinds : seed.workKinds,
        deliverables: Array.isArray(base.deliverables) ? base.deliverables : seed.deliverables,
        coverage: Array.isArray(base.coverage) ? base.coverage : seed.coverage,
        journeys: Array.isArray(base.journeys) ? base.journeys : seed.journeys,
        dimensions: Array.isArray(base.dimensions) ? base.dimensions : seed.dimensions,
        checks: Array.isArray(base.checks) ? base.checks : seed.checks,
        phase: base.phase || seed.phase,
        state: base.state || seed.state,
        reason: clean(base.reason, 1000),
        attempts: Number(base.attempts || 0),
        iteration: Number(base.attempts || 0),
      };
  let phase = contract.PHASES.some(([key]) => key === source.phase)
    ? source.phase : 'understand';
  let node = Object.prototype.hasOwnProperty.call(NODE_PHASE, source.node)
    ? source.node
    : phase === 'understand' ? 'inspect'
      : phase === 'plan' ? 'plan'
        : phase === 'execute' ? 'act'
          : phase === 'verify' ? 'verify'
            : source.state === 'completed' ? 'done' : 'package';
  const state = ['running', 'retrying', 'paused', 'blocked', 'completed']
    .includes(source.state) ? source.state : 'running';
  // Old checkpoints sent every blocked run to "done", falsely completing verification.
  // Recover the last observed stage; no verification pass may be inferred from termination.
  if (state === 'blocked' && node === 'done') {
    const prior = (Array.isArray(source.progress) ? source.progress : []).slice().reverse()
      .find(item => item && item.node !== 'done' &&
        Object.prototype.hasOwnProperty.call(NODE_PHASE, item.node));
    node = prior ? prior.node : 'verify';
    phase = NODE_PHASE[node];
  }
  const checks = Array.isArray(source.checks) ? source.checks.slice(0, 40) : [];
  const previous = new Map((Array.isArray(source.tasks) ? source.tasks : [])
    .map((item) => [String(item.key || item.id), item]));
  const tasks = taskRows(checks)
    .map((item) => ({ ...item, ...(previous.get(item.key) || {}) }));
  return {
    ...source,
    schemaVersion: SCHEMA_VERSION,
    node,
    phase,
    state,
    checks,
    tasks,
    workKinds: Array.isArray(source.workKinds) ? source.workKinds.slice(0, 8) : seed.workKinds,
    deliverables: Array.isArray(source.deliverables) ? source.deliverables.slice(0, 8) : seed.deliverables,
    coverage: Array.isArray(source.coverage) ? source.coverage.slice(0, 20) : seed.coverage,
    journeys: Array.isArray(source.journeys) ? source.journeys.slice(0, 12) : seed.journeys,
    dimensions: Array.isArray(source.dimensions) ? source.dimensions.slice(0, 10) : seed.dimensions,
    qualityThreshold: Number(source.qualityThreshold || seed.qualityThreshold || 85),
    criteria: Array.isArray(source.criteria) ? source.criteria.slice(0, 20) : [],
    progress: Array.isArray(source.progress)
      ? source.progress.slice(-MAX_PROGRESS) : [],
    recentEventIds: Array.isArray(source.recentEventIds)
      ? source.recentEventIds.slice(-MAX_EVENT_IDS) : [],
    focus: source.focus && typeof source.focus === 'object' ? {
      check: clean(source.focus.check, 80), reason: clean(source.focus.reason, 600),
      action: clean(source.focus.action, 600),
    } : null,
    score: source.score && typeof source.score === 'object' ? source.score : null,
    scoreHistory: Array.isArray(source.scoreHistory) ? source.scoreHistory.slice(-12) : [],
    pause: source.pause && typeof source.pause === 'object' ? {
      kind: clean(source.pause.kind, 40), reason: clean(source.pause.reason, 1000),
      used: Number(source.pause.used || 0), limit: Number(source.pause.limit || 0),
      unit: clean(source.pause.unit, 40),
    } : null,
    phases: phaseRows(phase, state),
  };
}

function applyChecks(tasks, checks, at) {
  const results = new Map((Array.isArray(checks) ? checks : [])
    .map((item) => [String(item.key || item.check), item]));
  return tasks.map((task) => {
    const result = results.get(task.key);
    if (!result) return task;
    const status = result.pass === true || result.status === 'passed'
      ? 'completed'
      : result.pass === false || result.status === 'failed'
        ? 'failed' : task.status;
    const proof = Array.isArray(result.evidence)
      ? result.evidence : result.evidence ? [result.evidence] : [];
    return {
      ...task,
      status,
      reason: clean(result.reason, 600),
      evidence: proof.map((item) => clean(item, 500)).filter(Boolean).slice(0, 8),
      updatedAt: at,
    };
  });
}

function progress(event, state, at) {
  const payload = event.payload || {};
  const toolCount = Number(payload.toolCount);
  return {
    id: clean(event.id, 160) ||
      (event.type + ':' + at + ':' + Number(state.revision || 0)),
    type: clean(event.type, 80),
    node: state.node,
    iteration: state.iteration,
    toolCount: Number.isFinite(toolCount) ? Math.max(0, Math.floor(toolCount)) : null,
    summary: clean(payload.summary || payload.reason, 600),
    evidence: Array.isArray(payload.evidence)
      ? payload.evidence.map((item) => clean(item, 400)).filter(Boolean).slice(0, 8)
      : [],
    at,
  };
}

function reduce(current, rawEvent) {
  const base = normalize(current);
  const event = rawEvent && typeof rawEvent === 'object' ? rawEvent : {};
  const type = clean(event.type, 80);
  if (!type) return base;
  const id = clean(event.id, 160);
  if (id && base.recentEventIds.includes(id)) return base;
  const payload = event.payload || {};
  const at = Number(event.at) || Date.now();
  let next = {
    ...base,
    revision: Number(base.revision || 0) + 1,
    updatedAt: at,
  };
  const move = (node, state, reason, decision) => {
    next.node = node;
    next.phase = NODE_PHASE[node] || next.phase;
    next.state = state || 'running';
    next.reason = clean(reason, 1000);
    next.decision = clean(decision, 40);
  };

  if (type === 'run.started') {
    move('inspect', 'running', payload.reason, '');
    next.evidenceToolFrom = Number.isInteger(payload.toolCount) && payload.toolCount >= 0
      ? payload.toolCount : null;
  }
  else if (type === 'plan.ready') move('plan', 'running', payload.reason, '');
  else if (type === 'action.started') {
    move('act', 'running', payload.reason, '');
    next.iteration = Number(base.iteration || 0) + 1;
    next.attempts = next.iteration;
    const focusKey = clean(payload.focusKey || (base.focus && base.focus.check), 80);
    next.tasks = base.tasks.map((task) =>
      (!focusKey && (task.status === 'pending' || task.status === 'failed')) ||
      (focusKey && task.key === focusKey)
        ? {
            ...task,
            status: 'running',
            attempts: Number(task.attempts || 0) + 1,
            updatedAt: at,
          }
        : task);
  } else if (type === 'action.observed') {
    move('observe', 'running', payload.reason, '');
  } else if (type === 'verification.started') {
    move('verify', 'running', payload.reason, '');
  } else if (type === 'verification.failed') {
    move('decide', 'retrying', payload.reason, payload.decision || 'retry');
    next.tasks = applyChecks(base.tasks, payload.checks, at);
    next.focus = focusGap(next, payload.result || payload);
    if (payload.score && typeof payload.score === 'object') {
      next.score = payload.score;
      next.scoreHistory = [...base.scoreHistory, { ...payload.score, at }].slice(-12);
    }
  } else if (type === 'replan.requested') {
    move('plan', 'retrying', payload.reason, 'replan');
  } else if (type === 'verification.passed') {
    move('package', 'running', payload.reason, 'deliver');
    next.tasks = applyChecks(base.tasks, payload.checks, at);
    next.focus = null;
    if (payload.score && typeof payload.score === 'object') {
      next.score = payload.score;
      next.scoreHistory = [...base.scoreHistory, { ...payload.score, at }].slice(-12);
    }
  } else if (type === 'run.paused') {
    move(base.node, 'paused', payload.reason, 'pause');
    next.pause = {
      kind: clean(payload.kind, 40),
      reason: clean(payload.reason, 1000),
      used: Number(payload.used || 0),
      limit: Number(payload.limit || 0),
      unit: clean(payload.unit, 40),
    };
  } else if (type === 'run.resumed') {
    move('act', 'running', payload.reason, 'resume');
    next.pause = null;
  } else if (type === 'run.blocked') {
    move(base.node === 'done' ? 'verify' : base.node, 'blocked', payload.reason, 'blocked');
    next.tasks = applyChecks(base.tasks, payload.checks, at);
    next.pause = null;
  } else if (type === 'run.completed') {
    move('done', 'completed', payload.reason, 'completed');
    next.pause = null;
    next.tasks = base.tasks.map((task) => task.required
      ? { ...task, status: 'completed', updatedAt: at } : task);
  } else {
    return base;
  }

  next.progress = [...base.progress, progress(event, next, at)]
    .slice(-MAX_PROGRESS);
  next.recentEventIds = id
    ? [...base.recentEventIds, id].slice(-MAX_EVENT_IDS)
    : base.recentEventIds;
  next.phases = phaseRows(next.phase, next.state);
  return next;
}

function event(type, payload, id, at) {
  return {
    type,
    payload: payload || {},
    id: id || '',
    at: Number(at) || Date.now(),
  };
}

function fromEntries(entries, fallback) {
  const rows = Array.isArray(entries) ? entries : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index];
    if (item && item.type === 'custom' && item.customType === ENTRY_TYPE) {
      return normalize(item.data, fallback);
    }
  }
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index];
    if (item && item.type === 'custom' &&
        item.customType === contract.ENTRY_TYPE) {
      return normalize(item.data, fallback);
    }
  }
  return compile(fallback || {});
}

function remaining(value) {
  return normalize(value).tasks
    .filter((item) => item.required && item.status !== 'completed');
}

function focusGap(value, result) {
  const state = normalize(value);
  const verdict = result || {};
  const byKey = new Map(state.checks.map((item) => [String(item.key), item]));
  const rows = [];
  const put = (item, sourceRank) => {
    if (!item) return;
    const check = clean(item.check || item.key, 80);
    const contractRow = byKey.get(check) || {};
    const reason = clean(item.reason || item, 600);
    const action = clean(item.action, 600);
    if (!reason && !action) return;
    rows.push({
      check, reason, action,
      priority: Number(contractRow.priority || item.priority || 50),
      sourceRank,
    });
  };
  const deterministic = verdict.deterministic && verdict.deterministic.gaps;
  (Array.isArray(deterministic) ? deterministic : []).forEach((item) => put(item, 2));
  (Array.isArray(verdict.gaps) ? verdict.gaps : []).forEach((item) => put(item, 1));
  rows.sort((a, b) => b.sourceRank - a.sourceRank || b.priority - a.priority);
  return rows[0] || null;
}

function cyclePrompt(value, result, options) {
  const state = normalize(value);
  const verdict = result || {};
  const opts = options || {};
  const focus = focusGap(state, verdict) || state.focus || {
    check: '', reason: clean(verdict.reason, 600), action: '',
  };
  const preserved = state.tasks.filter((item) => item.status === 'completed')
    .map((item) => item.key).slice(0, 12).join(', ');
  return [
    INTERNAL_CYCLE_OPEN,
    'This is autonomous delivery cycle ' + (state.iteration + 1) +
      '. It is not a new user request.',
    'Objective: ' + state.objective,
    'Decision: ' + (opts.replan
      ? 'replan from observed facts, then execute'
      : 'repair one focused gap and continue execution'),
    'Highest-priority gap: [' + (focus.check || 'quality') + '] ' +
      (focus.reason || 'Verification did not pass'),
    'Required correction: ' + (focus.action || 'Diagnose the cause and close this gap with direct evidence.'),
    'Already passed; preserve these areas: ' + (preserved || 'none recorded yet'),
    'Work in the same directory. Fix this gap and only its necessary dependencies. ' +
      'Do not rewrite unrelated working areas. Rerun the direct proof for this gap.',
    'Do not merely explain the fix and do not write the final user answer. ' +
      'SoduWork will verify again.',
    INTERNAL_CYCLE_CLOSE,
  ].join('\n\n');
}




function isInternalPrompt(value) {
  const text = String(value || '').trim();
  return text.startsWith(INTERNAL_CYCLE_OPEN) && text.endsWith(INTERNAL_CYCLE_CLOSE);
}

function view(value) {
  const row = normalize(value);
  return {
    schemaVersion: row.schemaVersion,
    runId: row.runId,
    node: row.node,
    phase: row.phase,
    state: row.state,
    decision: row.decision,
    reason: row.reason,
    attempts: row.attempts,
    pause: row.pause,
    iteration: row.iteration,
    revision: row.revision,
    workKind: row.workKind,
    workKinds: row.workKinds,
    criteria: row.criteria,
    checks: row.checks,
    deliverables: row.deliverables,
    coverage: row.coverage,
    journeys: row.journeys,
    dimensions: row.dimensions,
    qualityThreshold: row.qualityThreshold,
    score: row.score,
    scoreHistory: row.scoreHistory,
    focus: row.focus,
    phases: row.phases,
    tasks: row.tasks,
    progress: row.progress,
    updatedAt: row.updatedAt,
  };
}

module.exports = {
  ENTRY_TYPE,
  SCHEMA_VERSION,
  compile,
  normalize,
  reduce,
  event,
  fromEntries,
  remaining,
  focusGap,
  cyclePrompt,
  isInternalPrompt,
  view,
};
