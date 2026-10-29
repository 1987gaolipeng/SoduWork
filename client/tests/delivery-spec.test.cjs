'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const spec = require('../main/conversation/delivery-spec.js');
const harness = require('../main/conversation/goal-harness.js');

test('a complete web product is a multi-dimensional delivery, not one regex label', () => {
  const row = spec.compile({
    goal: '\u4ece\u96f6\u5b8c\u6574\u4ea4\u4ed8\u4e00\u4e2a\u53ef\u4e0a\u7ebf\u7684\u4f01\u4e1a\u7f51\u7ad9\u5e94\u7528',
    acceptance: '\u7528\u6237\u53ef\u5b8c\u6210\u4e3b\u8981\u64cd\u4f5c\uff1b\u524d\u540e\u7aef\u5b8c\u6574\uff1b\u53ef\u542f\u52a8\u9a8c\u6536',
  });
  assert.equal(row.complete, true);
  assert.equal(row.workKinds.includes('website'), true);
  assert.equal(row.workKinds.includes('engineering'), true);
  assert.equal(row.deliverables.some((item) => item.kind === 'website'), true);
  assert.equal(row.deliverables.some((item) => item.kind === 'repository'), true);
  assert.equal(row.coverage.includes('frontend-decision'), true);
  assert.equal(row.coverage.includes('backend-api-decision'), true);
  assert.equal(row.journeys.length >= 3, true);
});

test('quality dimensions separate correctness from commercial finish', () => {
  const row = spec.compile({ goal: '\u5b8c\u6574\u5236\u4f5c\u4e00\u4e2a\u53ef\u5546\u7528\u7684\u524d\u7aef\u7f51\u7ad9' });
  const dimensions = new Map(row.dimensions.map((item) => [item.key, item]));
  assert.equal(dimensions.get('correctness').hard, true);
  assert.equal(dimensions.get('usability').hard, true);
  assert.equal(dimensions.get('visual').threshold, 85);
  assert.equal(row.qualityThreshold, 85);
});

test('Pi receives a concise inner-loop contract that continues past planning', () => {
  const prompt = harness.prompt({
    goal: '\u5b8c\u6574\u5f00\u53d1\u4e00\u4e2a\u53ef\u8fd0\u884c\u7684\u7f51\u7ad9',
    acceptance: '\u5173\u952e\u8def\u5f84\u53ef\u7528',
  });
  assert.match(prompt, /SoduWork DeliverySpec v1/);
  assert.match(prompt, /same turn/);
  assert.match(prompt, /backend-only layer/);
  assert.match(prompt, /native tool loop/);
  assert.ok(prompt.length < 7000, 'the contract should guide Pi without drowning its context');
});

test('simple conversational work is not forced through an engineering harness', () => {
  const row = spec.compile({ goal: '\u53ea\u56de\u7b54\u4e00\u53e5\u8bdd\uff0c\u89e3\u91ca\u4ec0\u4e48\u662f SoduWork' });
  assert.deepEqual(row.workKinds, ['conversation']);
  assert.equal(row.deliverables[0].kind, 'result');
  assert.equal(row.coverage.includes('backend-api-decision'), false);
});

test('negative constraints never become positive web or runtime requirements', () => {
  const row = spec.compile({
    goal: '\u521b\u5efa proof.md\uff0c\u4e0d\u8981\u521b\u5efa\u7f51\u9875\uff0c\u4e0d\u8981\u542f\u52a8\u670d\u52a1\uff0c\u4e0d\u8981\u505a\u754c\u9762\u68c0\u67e5',
    acceptance: 'proof.md \u5185\u5bb9\u7b49\u4e8e SODUWORK_FINAL_GATE_OK',
  });
  assert.deepEqual(row.workKinds, ['document']);
  assert.equal(row.primaryKind, 'document');
  assert.equal(row.complete, false);
  assert.equal(row.coverage.includes('frontend-decision'), false);
});
