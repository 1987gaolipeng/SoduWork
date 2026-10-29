'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { profile, view, set } = require('../main/conversation/thinking-capabilities');
const { piProvider } = require('../main/conversation/model-selection');
const sessionSpec = require('../main/conversation/session-spec');

test('thinking capability profiles keep provider-specific request metadata consistent', () => {
  assert.deepEqual(profile({ id: 'plain-chat' }), {
    reasoning: false, levels: ['off'], format: '', supportsReasoningEffort: false,
  });
  assert.equal(profile({ id: 'deepseek-v4.1-flash' }).reasoning, true);
  assert.equal(profile({ id: 'deepseek-v4.1-flash' }).format, 'deepseek');
  assert.equal(profile({ id: 'GLM5.3flash' }).format, 'zai');
  assert.equal(profile({ id: 'opaque-think-model', reasoning: true, format: 'qwen-chat-template' }).format,
    'qwen-chat-template');
  assert.equal(profile({ id: 'deepseek-v4.1-flash', reasoning: false }).reasoning, false);

  const provider = piProvider({ id: 'deepseek-v4.1-flash', label: 'DeepSeek', key: 'ticket',
    baseUrl: 'http://model.invalid/v1', contextWindow: 128000 });
  assert.equal(provider.models[0].reasoning, true);
  assert.equal(provider.compat.thinkingFormat, 'deepseek');
  assert.equal(provider.compat.supportsReasoningEffort, true);
});

test('thinking profiles distinguish controllable, always-on, and unavailable models', () => {
  assert.deepEqual(profile({ id: 'always-gateway', thinkingMode: 'always' }), {
    reasoning: true, levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    format: 'openai', supportsReasoningEffort: true, thinkingLevelMap: { off: null },
  });
  assert.equal(profile({ id: 'switchable', thinkingMode: 'controllable' }).reasoning, true);
  assert.equal(profile({ id: 'switchable', thinkingMode: 'controllable' }).supportsReasoningEffort, true);
  assert.deepEqual(profile({ id: 'no-reasoning', thinkingMode: 'none' }), {
    reasoning: false, levels: ['off'], format: '', supportsReasoningEffort: false,
  });

  let applied = '';
  const alwaysSession = {
    thinkingLevel: 'medium',
    supportsThinking: () => true,
    getAvailableThinkingLevels: () => ['minimal', 'low', 'medium'],
    setThinkingLevel: (level) => { applied = level; },
  };
  assert.equal(view(alwaysSession).canDisable, false);
  assert.equal(set(alwaysSession, false).ok, false);
  assert.equal(applied, '');
  const switchableSession = {
    thinkingLevel: 'off',
    supportsThinking: () => true,
    getAvailableThinkingLevels: () => ['off', 'low', 'medium'],
    setThinkingLevel: (level) => { applied = level; },
  };
  assert.equal(view(switchableSession).canDisable, true);
  assert.equal(set(switchableSession, true).ok, true);
  assert.equal(applied, 'medium');
});

test('an explicit thinking-off choice survives goal defaults', () => {
  const spec = sessionSpec.build({ mode: 'goal', goal: 'build a website', thinkingLevel: 'off' }, {
    capabilityIds: [], selectedSkills: [], skillDirs: [], warnings: [],
  }, {});
  assert.equal(spec.intent, 'goal');
  assert.equal(spec.thinkingLevel, 'off');
  assert.equal(sessionSpec.build({ mode: 'goal', goal: 'build a website' }, {
    capabilityIds: [], selectedSkills: [], skillDirs: [], warnings: [],
  }, {}).thinkingLevel, 'high');
});

test('both composers expose the three supported input shortcuts', () => {
  const work = fs.readFileSync(path.join(__dirname, '../components/panels/work-composer.js'), 'utf8');
  const surface = fs.readFileSync(path.join(__dirname, '../components/panels/compose-surface.js'), 'utf8');
  assert.match(work, /function syntaxHint\(\)/);
  assert.ok(work.includes('<kbd>/</kbd>'));
  assert.ok(work.includes('<kbd>/</kbd><b>\\u4f7f\\u7528\\u63d2\\u4ef6</b>'));
  assert.ok(work.includes('<kbd>#</kbd><b>\\u4f7f\\u7528\\u6280\\u80fd</b>'));
  assert.ok(work.includes('<kbd>@</kbd><b>\\u7528\\u6237\\u53d1\\u9001\\u6d88\\u606f</b>'));
  assert.match(work, /<kbd>#<\/kbd>/);
  assert.match(work, /<kbd>@<\/kbd>/);
  assert.match(work, /afterInput: syntaxHint\(\)/);
  assert.match(surface, /afterInput: WorkComposer\.syntaxHint\(\)/);
});
