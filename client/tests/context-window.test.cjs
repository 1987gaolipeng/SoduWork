'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_CONTEXT_WINDOW,
  normalize,
  resolveContextWindow,
} = require('../main/conversation/context-window.js');

test('context resolver prefers an explicit configured window', () => {
  assert.deepEqual(resolveContextWindow({ contextWindow: '32k', id: 'unknown-model' }), {
    contextWindow: 32000,
    contextWindowKnown: true,
    contextWindowEstimated: false,
    contextWindowSource: 'configured',
  });
});

test('context resolver reads model suffixes and common provider catalogue entries', () => {
  assert.equal(resolveContextWindow({ id: 'moonshot-v1-128k' }).contextWindow, 128000);
  assert.equal(resolveContextWindow({ id: 'deepseek-chat' }).contextWindow, 64000);
  assert.equal(resolveContextWindow({ id: 'gpt-4.1' }).contextWindow, 1_048_576);
  assert.equal(resolveContextWindow({ id: 'qwen-max' }).contextWindow, 131072);
});

test('context resolver always returns a numeric safe estimate for unknown bases', () => {
  const resolved = resolveContextWindow({ provider: 'custom-openai-compatible', id: 'internal-model' });
  assert.equal(resolved.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(resolved.contextWindowKnown, true);
  assert.equal(resolved.contextWindowEstimated, true);
  assert.equal(resolved.contextWindowSource, 'safe-default');
  assert.equal(normalize('not-a-number'), 0);
});
