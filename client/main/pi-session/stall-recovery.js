'use strict';

/* A provider stream can stay open without emitting an event. Keep that failure
   separate from tool timeouts: tools already have their own adaptive limits. */
const MARKER = '<soduwork-internal-runtime-recovery>';
const GOAL_SCOPE = '<scope>goal</scope>';
const HARD_IDLE_MS = 3 * 60 * 1000;
const MAX_RECOVERIES = 1;
const ABORT_SETTLE_MS = 5 * 1000;
const ERROR_CODE = 'SODUWORK_AGENT_STREAM_STALLED';

function shouldInterrupt(input, now) {
  const state = input || {};
  const clock = Number(now) || Date.now();
  return Boolean(state.promptActive && !state.activeTool && !state.waitingUser &&
    Number(state.lastActivityAt || 0) > 0 &&
    clock - Number(state.lastActivityAt) >= HARD_IDLE_MS);
}

function reason(idleMs) {
  const seconds = Math.max(1, Math.round(Number(idleMs || HARD_IDLE_MS) / 1000));
  return '\u6a21\u578b\u8fde\u7eed ' + seconds +
    ' \u79d2\u6ca1\u6709\u8fd4\u56de\u65b0\u5185\u5bb9\uff0cSoduWork \u5df2\u4e2d\u65ad\u672c\u6b21\u7b49\u5f85\u5e76\u4fdd\u7559\u5de5\u4f5c\u73b0\u573a\u3002';
}

function error(message) {
  const value = new Error(String(message || reason(HARD_IDLE_MS)));
  value.code = ERROR_CODE;
  return value;
}

function isError(value) {
  return Boolean(value && value.code === ERROR_CODE);
}

function isRecoveryPrompt(value) {
  return String(value || '').includes(MARKER);
}

function isGoalRecoveryPrompt(value) {
  const source = String(value || '');
  return source.includes(MARKER) && source.includes(GOAL_SCOPE);
}

function normalPrompt(request, incident) {
  return [
    MARKER,
    '<scope>normal</scope>',
    'The previous provider stream became silent and was interrupted by SoduWork.',
    'Continue the same user request from the exact current state. Do not restart or repeat completed work.',
    'Never repeat successful writes, sends, submissions or publications. Check uncertain outcomes read-only first; ask the user if they cannot be verified.',
    'Inspect the current workspace only when needed, finish the remaining work, and report the real result.',
    'Original request: ' + String(request || '').trim(),
    'Runtime incident: ' + String(incident || '').trim(),
    '</soduwork-internal-runtime-recovery>',
  ].join('\n');
}

function goalPrompt(goalQuality, goal, incident) {
  const continuation = goalQuality && typeof goalQuality.continuationPrompt === 'function'
    ? goalQuality.continuationPrompt(goal || {}, {
      kind: 'stall', reason: String(incident || '').trim(),
      used: Math.round(HARD_IDLE_MS / 1000),
      limit: Math.round(HARD_IDLE_MS / 1000), unit: 'seconds',
    }) : '';
  return [
    MARKER,
    GOAL_SCOPE,
    'The previous provider stream became silent and was interrupted by SoduWork.',
    'Resume from the exact current workspace and checkpoint. Do not redo completed work.',
    'Never repeat successful writes, sends, submissions or publications. Check uncertain outcomes read-only first; ask the user if they cannot be verified.',
    continuation,
    '</soduwork-internal-runtime-recovery>',
  ].filter(Boolean).join('\n');
}

module.exports = {
  MARKER, HARD_IDLE_MS, MAX_RECOVERIES, ABORT_SETTLE_MS, ERROR_CODE,
  shouldInterrupt, reason, error, isError,
  isRecoveryPrompt, isGoalRecoveryPrompt, normalPrompt, goalPrompt,
};
