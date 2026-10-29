'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../main/conversation/goal-harness.js');
const loop = require('../main/conversation/goal-loop.js');
const review = require('../main/conversation/goal-review.js');

const deterministic = { pass: true, checks: [], gaps: [], summary: 'machine gates passed' };

function scored(spec, values, verdict) {
  return JSON.stringify({
    verdict: verdict || 'pass',
    summary: 'reviewed',
    scores: spec.dimensions.map((item) => ({
      dimension: item.key,
      score: Object.prototype.hasOwnProperty.call(values || {}, item.key)
        ? values[item.key] : 95,
      reason: 'observed evidence',
      action: 'improve the weakest observed detail',
      evidence: ['workspace evidence'],
    })),
    gaps: [], evidence: [], deliverables: [],
  });
}

test('an independent pass must also clear the commercial quality threshold', () => {
  const spec = contract.compile({ goal: '\u5b8c\u6574\u4ea4\u4ed8\u4e00\u4e2a\u53ef\u5546\u7528\u7684\u7f51\u7ad9' });
  const passed = review.outcome(scored(spec, {}), { deterministic, spec });
  assert.equal(passed.phase, 'reviewed');
  assert.ok(passed.score.total >= passed.score.threshold);

  const weak = review.outcome(scored(spec, { visual: 20 }), { deterministic, spec });
  assert.equal(weak.phase, 'blocked');
  assert.equal(weak.retryable, true);
  assert.equal(weak.score.pass, false);
  assert.match(weak.gaps[0].check, /^quality:/);
});

test('missing quality dimensions are a verifier protocol failure, never a pass', () => {
  const spec = contract.compile({ goal: '\u5f00\u53d1\u4e00\u4e2a\u5b8c\u6574\u5e94\u7528' });
  const result = review.outcome(JSON.stringify({
    verdict: 'pass', summary: 'looks fine', gaps: [], scores: [],
  }), { deterministic, spec });
  assert.equal(result.phase, 'blocked');
  assert.equal(result.source, 'verifier-protocol');
  assert.match(result.reason, /completeness/);
});

test('repair cycles select one highest-priority gap and preserve passed work', () => {
  let state = loop.compile({
    goal: '\u5b8c\u6574\u4ea4\u4ed8\u4e00\u4e2a\u7f51\u7ad9',
    acceptance: '\u4e3b\u8981\u8def\u5f84\u53ef\u7528',
  });
  state = loop.reduce(state, loop.event('verification.failed', {
    reason: 'two gaps',
    checks: [
      { key: 'usable', pass: true, evidence: ['opened'] },
      { key: 'journey', pass: false, reason: 'submit does not work' },
    ],
    result: {
      gaps: [{ check: 'visual', reason: 'spacing is rough', action: 'polish spacing' }],
      deterministic: { gaps: [{ check: 'journey', reason: 'submit does not work', action: 'fix submit' }] },
    },
  }, 'focus-1'));
  assert.equal(state.focus.check, 'journey');
  const prompt = loop.cyclePrompt(state, {
    gaps: [{ check: 'visual', reason: 'spacing is rough', action: 'polish spacing' }],
    deterministic: { gaps: [{ check: 'journey', reason: 'submit does not work', action: 'fix submit' }] },
  });
  assert.match(prompt, /Highest-priority gap: \[journey\]/);
  assert.match(prompt, /preserve these areas: usable/);
  assert.doesNotMatch(prompt, /Remaining ledger/);
});
