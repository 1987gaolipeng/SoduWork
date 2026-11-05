'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../main/agent-runtime/runner-config.cjs');

test('Runner carries declared thinking mappings to the same selected model', () => {
  const model = { baseUrl: 'https://fixture.invalid', key: 'fixture', id: 'managed-alias',
    reasoning: true, thinkingMode: 'always', thinkingFormat: 'zai', supportsReasoningEffort: true,
    thinkingLevelMap: { off: null, minimal: null, low: 'low', high: 'high' } };
  for (const adapter of ['harness2', 'kimi', 'opencode']) {
    const cfg = create(model, adapter, ['read']);
    assert.equal(cfg.local_cli, adapter);
    assert.equal(cfg.llm.model, model.id);
    assert.equal(cfg.llm.thinkingFormat, 'zai');
    assert.equal(cfg.llm.supportsReasoningEffort, true);
    assert.deepEqual(cfg.llm.thinkingLevelMap, model.thinkingLevelMap);
    cfg.llm.thinkingLevelMap.low = 'changed';
    assert.equal(model.thinkingLevelMap.low, 'low');
  }
});

test('Normalized profiles survive and unknown models receive no invented mapping', () => {
  const base = { baseUrl: 'https://fixture.invalid', key: 'fixture', id: 'managed-alias' };
  const normalized = create({ ...base, reasoning: true, format: 'openai',
    supportsReasoningEffort: true, thinkingLevelMap: { low: 'medium' } }, 'harness2').llm;
  assert.equal(normalized.thinkingFormat, 'openai');
  assert.deepEqual(normalized.thinkingLevelMap, { low: 'medium' });
  const plain = create(base, 'harness2').llm;
  assert.equal(plain.thinkingLevelMap, undefined);
  assert.equal(plain.thinkingFormat, undefined);
  const native = create(base, 'codex');
  assert.equal(native.codex_model, base.id);
});
