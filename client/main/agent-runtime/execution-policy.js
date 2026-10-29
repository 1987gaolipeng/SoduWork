'use strict';

const crypto = require('crypto');
const goalLoop = require('../conversation/goal-loop');

const POLICY_SCHEMA = 'soduwork.agent-runtime.execution-policy/v1';
const DEFAULT_MAX_CYCLES = 8;
const DEFAULT_STAGNATION_LIMIT = 2;

function _record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function _text(value, limit) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function _integer(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function reviewFingerprint(reviewed) {
  const row = _record(reviewed);
  const gaps = (Array.isArray(row.gaps) ? row.gaps : []).slice(0, 20).map((item) => ({
    check: _text(item && (item.check || item.key), 80),
    reason: _text(item && item.reason, 400),
    action: _text(item && item.action, 400),
  }));
  const deterministic = _record(row.deterministic);
  const machineGaps = (Array.isArray(deterministic.gaps) ? deterministic.gaps : [])
    .slice(0, 20).map((item) => ({
      check: _text(item && (item.check || item.key), 80),
      reason: _text(item && item.reason, 400),
      action: _text(item && item.action, 400),
    }));
  const payload = JSON.stringify({
    phase: _text(row.phase, 40),
    source: _text(row.source, 80),
    reason: _text(row.reason, 600),
    gaps,
    machineGaps,
  });
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

function createExecutionPolicy(spec, options) {
  const opts = _record(options);
  return normalizeExecutionPolicy({
    schema: POLICY_SCHEMA,
    policyId: _text(opts.policyId, 80) || 'soduwork.goal.standard',
    revision: 0,
    cycle: 0,
    stagnantCycles: 0,
    lastFingerprint: '',
    maxCycles: _integer(opts.maxCycles, DEFAULT_MAX_CYCLES, 1, 100),
    stagnationLimit: _integer(opts.stagnationLimit, DEFAULT_STAGNATION_LIMIT, 1, 20),
    decision: '',
    reason: '',
    ledger: goalLoop.compile(spec || {}),
  }, spec);
}

function normalizeExecutionPolicy(value, fallback) {
  const row = _record(value);
  const seed = row.schema === POLICY_SCHEMA ? row : {};
  const ledger = goalLoop.normalize(seed.ledger, fallback || {});
  return {
    schema: POLICY_SCHEMA,
    policyId: _text(seed.policyId, 80) || 'soduwork.goal.standard',
    revision: _integer(seed.revision, 0, 0, Number.MAX_SAFE_INTEGER),
    cycle: _integer(seed.cycle, 0, 0, 100000),
    stagnantCycles: _integer(seed.stagnantCycles, 0, 0, 100000),
    lastFingerprint: /^[a-f0-9]{64}$/i.test(String(seed.lastFingerprint || ''))
      ? String(seed.lastFingerprint).toLowerCase() : '',
    maxCycles: _integer(seed.maxCycles, DEFAULT_MAX_CYCLES, 1, 100),
    stagnationLimit: _integer(
      seed.stagnationLimit, DEFAULT_STAGNATION_LIMIT, 1, 20),
    decision: _text(seed.decision, 40),
    reason: _text(seed.reason, 1000),
    ledger,
  };
}

function _append(value, type, payload, at) {
  const row = normalizeExecutionPolicy(value);
  const nextRevision = row.revision + 1;
  const event = goalLoop.event(
    type,
    payload || {},
    row.policyId + ':' + nextRevision + ':' + type,
    Number(at) || Date.now(),
  );
  const ledger = goalLoop.reduce(row.ledger, event);
  if (ledger.revision === row.ledger.revision) return row;
  return { ...row, revision: nextRevision, ledger };
}

function beginExecutionPolicy(value, options) {
  const opts = _record(options);
  let row = _append(value, 'run.started', {
    reason: _text(opts.reason, 1000) || '开始理解目标与工作现场',
  }, opts.at);
  row = _append(row, 'plan.ready', {
    reason: _text(opts.planReason, 1000) || '目标、验收标准与执行账本已经就绪',
  }, opts.at);
  return { ...row, decision: 'execute', reason: '' };
}

function startPolicyAction(value, options) {
  const opts = _record(options);
  const row = _append(value, 'action.started', {
    focusKey: _text(opts.focusKey, 80),
    reason: _text(opts.reason, 1000) || '开始执行当前最高优先级工作',
  }, opts.at);
  return { ...row, decision: 'execute', reason: '' };
}

function observePolicyAction(value, options) {
  const opts = _record(options);
  return _append(value, 'action.observed', {
    reason: _text(opts.reason, 1000) || '本轮执行结束，开始采集真实证据',
    evidence: Array.isArray(opts.evidence) ? opts.evidence.slice(0, 8) : [],
  }, opts.at);
}

function beginPolicyVerification(value, options) {
  const opts = _record(options);
  return _append(value, 'verification.started', {
    reason: _text(opts.reason, 1000) || '开始确定性验收与独立复核',
  }, opts.at);
}

function decidePolicyReview(value, reviewed, options) {
  const opts = _record(options);
  const result = _record(reviewed);
  let row = normalizeExecutionPolicy(value);
  const cycle = row.cycle + 1;
  if (String(result.phase || '') === 'reviewed') {
    row = _append(row, 'verification.passed', {
      reason: _text(result.reason, 1000),
      checks: result.deterministic && result.deterministic.checks,
      score: result.score,
    }, opts.at);
    return {
      state: { ...row, cycle, stagnantCycles: 0, lastFingerprint: '',
        decision: 'deliver', reason: _text(result.reason, 1000) },
      action: 'deliver', review: result, prompt: '',
    };
  }

  const fingerprint = /^[a-f0-9]{64}$/i.test(String(opts.fingerprint || ''))
    ? String(opts.fingerprint).toLowerCase() : reviewFingerprint(result);
  const stagnantCycles = fingerprint && fingerprint === row.lastFingerprint
    ? row.stagnantCycles + 1 : 0;
  const retryable = result.retryable === true;
  const replan = stagnantCycles > 0;
  const canRetry = retryable && cycle < row.maxCycles &&
    stagnantCycles < row.stagnationLimit;
  let effective = result;
  if (!canRetry && retryable) {
    effective = {
      ...result,
      retryable: false,
      source: stagnantCycles >= row.stagnationLimit
        ? 'stagnation-guard' : 'cycle-guard',
      reason: stagnantCycles >= row.stagnationLimit
        ? '同一类验收缺口连续出现，SoduWork 已停止无效空转'
        : '已达到本次自动修订轮次上限，仍未达到交付标准',
    };
  }
  row = _append(row, 'verification.failed', {
    reason: _text(effective.reason, 1000),
    decision: replan ? 'replan' : 'retry',
    checks: effective.deterministic && effective.deterministic.checks,
    score: effective.score,
    result: effective,
  }, opts.at);
  row = {
    ...row,
    cycle,
    stagnantCycles,
    lastFingerprint: fingerprint,
    decision: canRetry ? (replan ? 'replan' : 'repair') : 'block',
    reason: _text(effective.reason, 1000),
  };
  if (!canRetry) {
    return { state: row, action: 'block', review: effective, prompt: '' };
  }
  if (replan) {
    row = _append(row, 'replan.requested', {
      reason: '原修补路径没有消除缺口，正在根据已观察事实换方案',
    }, opts.at);
  }
  row = _append(row, 'action.started', {
    focusKey: row.ledger.focus && row.ledger.focus.check,
    reason: replan
      ? '根据重复失败事实重新规划并执行'
      : '根据验收缺口定向修订',
  }, opts.at);
  row = { ...row, decision: replan ? 'replan' : 'repair' };
  return {
    state: row,
    action: replan ? 'replan' : 'repair',
    review: effective,
    prompt: goalLoop.cyclePrompt(row.ledger, effective, { replan }),
  };
}

function pauseExecutionPolicy(value, pause, options) {
  const opts = _record(options);
  const detail = _record(pause);
  const row = _append(value, 'run.paused', {
    kind: _text(detail.kind, 40),
    reason: _text(detail.reason, 1000),
    used: Number(detail.used || 0),
    limit: Number(detail.limit || 0),
    unit: _text(detail.unit, 40),
  }, opts.at);
  return { ...row, decision: 'pause', reason: _text(detail.reason, 1000) };
}

function resumeExecutionPolicy(value, options) {
  const opts = _record(options);
  const row = _append(value, 'run.resumed', {
    reason: _text(opts.reason, 1000) || '从安全检查点继续执行',
  }, opts.at);
  return { ...row, decision: 'execute', reason: '' };
}

function finalizeExecutionPolicy(value, reviewed, options) {
  const opts = _record(options);
  const result = _record(reviewed);
  const passed = String(result.phase || '') === 'reviewed';
  const row = _append(value, passed ? 'run.completed' : 'run.blocked', {
    reason: _text(result.reason, 1000) ||
      (passed ? '成果已经通过验收' : '成果未达到交付标准'),
    checks: result.deterministic && result.deterministic.checks,
  }, opts.at);
  return {
    ...row,
    decision: passed ? 'completed' : 'blocked',
    reason: _text(result.reason, 1000),
  };
}

function executionPolicyView(value) {
  const row = normalizeExecutionPolicy(value);
  return {
    schema: row.schema,
    policyId: row.policyId,
    revision: row.revision,
    cycle: row.cycle,
    stagnantCycles: row.stagnantCycles,
    maxCycles: row.maxCycles,
    stagnationLimit: row.stagnationLimit,
    decision: row.decision,
    reason: row.reason,
    ledger: goalLoop.view(row.ledger),
  };
}

module.exports = {
  POLICY_SCHEMA,
  DEFAULT_MAX_CYCLES,
  DEFAULT_STAGNATION_LIMIT,
  createExecutionPolicy,
  normalizeExecutionPolicy,
  beginExecutionPolicy,
  startPolicyAction,
  observePolicyAction,
  beginPolicyVerification,
  decidePolicyReview,
  pauseExecutionPolicy,
  resumeExecutionPolicy,
  finalizeExecutionPolicy,
  executionPolicyView,
  reviewFingerprint,
};
