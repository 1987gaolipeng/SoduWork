'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const goalLoop = require('../conversation/goal-loop');
const policy = require('./execution-policy');

const AT = 1770000000000;

function failed(reason, key) {
  return {
    phase: 'blocked', retryable: true, source: 'independent-review', reason,
    deterministic: {
      checks: [{ key: key || 'journey', pass: false, reason }],
      gaps: [{ check: key || 'journey', reason, action: 'fix it' }],
    },
    gaps: [],
  };
}

test('portable policy reproduces the Pi loop transition order for repair and delivery', () => {
  let portable = policy.createExecutionPolicy({ goal: '交付一个可运行的网站' });
  portable = policy.beginExecutionPolicy(portable, { at: AT });
  portable = policy.startPolicyAction(portable, { at: AT + 1 });
  portable = policy.observePolicyAction(portable, { at: AT + 2 });
  portable = policy.beginPolicyVerification(portable, { at: AT + 3 });
  const first = policy.decidePolicyReview(portable, failed('表单不能提交'), {
    at: AT + 4,
  });

  let native = goalLoop.compile({ goal: '交付一个可运行的网站' });
  const append = (state, type, payload, index) => goalLoop.reduce(state,
    goalLoop.event(type, payload || {}, 'native-' + index, AT + index));
  native = append(native, 'run.started', {}, 0);
  native = append(native, 'plan.ready', {}, 1);
  native = append(native, 'action.started', {}, 2);
  native = append(native, 'action.observed', {}, 3);
  native = append(native, 'verification.started', {}, 4);
  native = append(native, 'verification.failed', {
    reason: '表单不能提交', decision: 'retry',
    checks: failed('表单不能提交').deterministic.checks,
    result: failed('表单不能提交'),
  }, 5);
  native = append(native, 'action.started', {
    focusKey: 'journey', reason: '根据验收缺口定向修订',
  }, 6);

  assert.equal(first.action, 'repair');
  assert.equal(first.state.ledger.node, native.node);
  assert.equal(first.state.ledger.phase, native.phase);
  assert.equal(first.state.ledger.state, native.state);
  assert.equal(first.state.ledger.iteration, native.iteration);
  assert.match(first.prompt, /Highest-priority gap: \[journey\]/);

  let after = policy.observePolicyAction(first.state, { at: AT + 5 });
  after = policy.beginPolicyVerification(after, { at: AT + 6 });
  const passed = policy.decidePolicyReview(after, {
    phase: 'reviewed', retryable: false, reason: '真实验收通过',
    deterministic: { checks: [{ key: 'journey', pass: true, evidence: ['E2E'] }] },
  }, { at: AT + 7 });
  assert.equal(passed.action, 'deliver');
  assert.equal(passed.state.ledger.node, 'package');
  const final = policy.finalizeExecutionPolicy(passed.state, passed.review, { at: AT + 8 });
  assert.equal(final.ledger.state, 'completed');
  assert.equal(final.decision, 'completed');
});

test('portable policy replans once and blocks repeated identical failures', () => {
  let state = policy.createExecutionPolicy({ goal: '完成商业交付' });
  const result = failed('同一个按钮始终不可用');

  const first = policy.decidePolicyReview(state, result, { at: AT });
  assert.equal(first.action, 'repair');
  assert.equal(first.state.stagnantCycles, 0);

  const second = policy.decidePolicyReview(first.state, result, { at: AT + 1 });
  assert.equal(second.action, 'replan');
  assert.equal(second.state.stagnantCycles, 1);
  assert.match(second.prompt, /replan from observed facts/);

  const third = policy.decidePolicyReview(second.state, result, { at: AT + 2 });
  assert.equal(third.action, 'block');
  assert.equal(third.state.stagnantCycles, 2);
  assert.equal(third.review.source, 'stagnation-guard');
  assert.match(third.review.reason, /停止无效空转/);
});

test('portable policy enforces the bounded cycle guard', () => {
  let state = policy.createExecutionPolicy({ goal: '完成交付' }, {
    maxCycles: 2, stagnationLimit: 10,
  });
  const first = policy.decidePolicyReview(state, failed('缺少前端', 'frontend'), {
    fingerprint: 'a'.repeat(64), at: AT,
  });
  assert.equal(first.action, 'repair');
  const second = policy.decidePolicyReview(first.state, failed('缺少测试', 'tests'), {
    fingerprint: 'b'.repeat(64), at: AT + 1,
  });
  assert.equal(second.action, 'block');
  assert.equal(second.review.source, 'cycle-guard');
});

test('portable policy survives serialization and resumes from the same safe state', () => {
  let state = policy.createExecutionPolicy({ goal: '长时间生成研究报告' });
  state = policy.beginExecutionPolicy(state, { at: AT });
  state = policy.startPolicyAction(state, { at: AT + 1 });
  state = policy.pauseExecutionPolicy(state, {
    kind: 'budget', reason: '达到本轮安全预算', used: 60, limit: 60, unit: '分钟',
  }, { at: AT + 2 });
  const restored = policy.normalizeExecutionPolicy(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.ledger.state, 'paused');
  assert.equal(restored.ledger.pause.kind, 'budget');
  const resumed = policy.resumeExecutionPolicy(restored, { at: AT + 3 });
  assert.equal(resumed.ledger.state, 'running');
  assert.equal(resumed.ledger.node, 'act');
  assert.equal(resumed.ledger.pause, null);
});

test('portable policy snapshot stays bounded and contains no runtime-native payload', () => {
  const state = policy.createExecutionPolicy({
    goal: '完成文档', acceptance: ['内容完整', '格式正确'],
  });
  const view = policy.executionPolicyView(state);
  const payload = JSON.stringify(view);
  assert.equal(view.schema, policy.POLICY_SCHEMA);
  assert.equal('messages' in view, false);
  assert.equal('native' in view, false);
  assert.doesNotMatch(payload, /api[_-]?key|authorization|credential/i);
});
