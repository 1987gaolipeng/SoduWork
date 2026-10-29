'use strict';

const assert = require('node:assert/strict');
const recovery = require('./stall-recovery');
const goalQuality = require('../conversation/goal-quality');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  PASS  ${name}\n`);
}

check('model silence is interrupted only after the hard idle boundary', () => {
  const lastActivityAt = 1000;
  assert.equal(recovery.shouldInterrupt({
    promptActive: true, activeTool: false, lastActivityAt,
  }, lastActivityAt + recovery.HARD_IDLE_MS - 1), false);
  assert.equal(recovery.shouldInterrupt({
    promptActive: true, activeTool: false, lastActivityAt,
  }, lastActivityAt + recovery.HARD_IDLE_MS), true);
});

check('an active tool keeps its own adaptive timeout', () => {
  assert.equal(recovery.shouldInterrupt({
    promptActive: true, activeTool: true, lastActivityAt: 1000,
  }, 1000 + recovery.HARD_IDLE_MS * 2), false);
});

check('waiting for a user response is not treated as provider silence', () => {
  assert.equal(recovery.shouldInterrupt({
    promptActive: true, activeTool: false, waitingUser: true, lastActivityAt: 1000,
  }, 1000 + recovery.HARD_IDLE_MS * 2), false);
});

check('idle interruption is disabled outside a model prompt', () => {
  assert.equal(recovery.shouldInterrupt({
    promptActive: false, activeTool: false, lastActivityAt: 1000,
  }, 1000 + recovery.HARD_IDLE_MS * 2), false);
});

check('stall errors have a stable machine-readable code', () => {
  const error = recovery.error('stalled');
  assert.equal(error.code, recovery.ERROR_CODE);
  assert.equal(recovery.isError(error), true);
  assert.equal(recovery.isError(new Error('other')), false);
});

check('normal and goal recovery prompts are private and scoped', () => {
  const normal = recovery.normalPrompt('finish the report', 'stream stalled');
  const goal = recovery.goalPrompt(goalQuality, {
    objective: 'deliver the report', acceptance: ['file opens'],
  }, 'stream stalled');
  assert.equal(recovery.isRecoveryPrompt(normal), true);
  assert.equal(recovery.isGoalRecoveryPrompt(normal), false);
  assert.equal(recovery.isRecoveryPrompt(goal), true);
  assert.equal(recovery.isGoalRecoveryPrompt(goal), true);
  assert.match(goal, /soduwork-internal-runtime-recovery/);
});

process.stdout.write(`\n${passed} stall-recovery assertions passed.\n`);
