'use strict';

// The Runner owns execution and continuation. The desktop only sends explicit
// intent and projects its durable receipt; observing a terminal never resends.
const goalContract = require('../conversation/goal-contract');
const STATUSES = new Set(['working', 'reviewing', 'completed', 'paused', 'blocked', 'disabled']);
const SUPPORTED = new Set(['codex', 'codex-harness', 'opencode', 'dsh', 'kimi', 'qwen']);
const clean = value => String(value || '').trim();
const count = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

function fromOptions(options) {
  const goal = goalContract.normalize(options);
  return goal.intent === 'goal' ? {
    schemaVersion: 1, objective: goal.goal, acceptance: goal.acceptance,
    budgetMinutes: goal.budgetMinutes, maxSteps: goal.maxSteps,
  } : null;
}

function activate(state, goal) {
  if (!goal) return;
  state.taskGoalContract = { ...goal };
  state.taskGoal = { status: 'working', reason: '', elapsedMs: 0, steps: 0,
    budgetMs: goal.budgetMinutes * 60000, maxSteps: goal.maxSteps, continuations: 0 };
  state.taskGoalElapsedAt = Date.now();
  state.goalVisible = true;
  state.intent = 'goal';
  state.goal = goal.objective;
  state.acceptance = goal.acceptance;
  state.budgetMinutes = goal.budgetMinutes;
  state.maxSteps = goal.maxSteps;
  state.goalPaused = false;
  state.goalLimit = null;
}

function receipt(value) {
  if (!value || !STATUSES.has(value.status)) return null;
  return {
    status: value.status, reason: clean(value.reason).slice(0, 2000),
    elapsedMs: count(value.elapsedMs), steps: count(value.steps),
    budgetMs: count(value.budgetMs), maxSteps: count(value.maxSteps),
    continuations: count(value.continuations),
    ...(typeof value.objective === 'string' ? { objective: value.objective } : {}),
    ...(typeof value.acceptance === 'string' ? { acceptance: value.acceptance } : {}),
  };
}

function exhausted(goal) {
  return Boolean(goal && (goal.budgetMs > 0 && goal.elapsedMs >= goal.budgetMs ||
    goal.maxSteps > 0 && goal.steps >= goal.maxSteps));
}

function observe(state, value, terminal) {
  const goal = receipt(value);
  if (!goal || state.pendingTaskGoalControl) return null;
  state.taskGoal = goal;
  state.taskGoalElapsedAt = Date.now();
  state.goalVisible = goal.status !== 'disabled';
  state.intent = state.goalVisible ? 'goal' : '';
  if (typeof goal.objective === 'string') state.goal = goal.objective;
  if (typeof goal.acceptance === 'string') state.acceptance = goal.acceptance;
  if (goal.budgetMs) state.budgetMinutes = goal.budgetMs / 60000;
  if (goal.maxSteps) state.maxSteps = goal.maxSteps;
  state.goalPaused = Boolean(terminal && ['paused', 'blocked'].includes(goal.status));
  const timeLimit = goal.budgetMs > 0 && goal.elapsedMs >= goal.budgetMs;
  state.goalLimit = state.goalPaused ? {
    kind: exhausted(goal) ? 'budget' : 'task-goal', reason: goal.reason || '任务已暂停，进度已保留',
    used: timeLimit ? Math.ceil(goal.elapsedMs / 60000) : goal.steps,
    limit: timeLimit ? goal.budgetMs / 60000 : goal.maxSteps,
    unit: timeLimit ? '分钟' : '个执行步骤', canContinue: !exhausted(goal),
  } : null;
  return goal;
}

module.exports = { supported: id => SUPPORTED.has(id), fromOptions, activate, receipt, observe, exhausted };
