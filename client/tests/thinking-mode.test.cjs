'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { profile, view, set, conflict } = require('../main/conversation/thinking-capabilities');
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

test('GLM 5.3 wire identities expose only supported mandatory thinking levels', () => {
  const expected = { off: null, minimal: null, low: 'low', medium: null,
    high: 'high', xhigh: null, max: 'max' };
  for (const id of ['glm-5.3', 'glm-5.3-flash', 'glm_5.3_flash', 'GLM5.3flash']) {
    const result = profile({ id });
    assert.equal(result.reasoning, true);
    assert.equal(result.format, 'zai');
    assert.deepEqual(result.thinkingLevelMap, expected);
    assert.equal(profile({ id, thinkingMode: 'none' }).reasoning, false);
    assert.match(conflict({ id, thinkingMode: 'none' }), /不支持关闭思考/);
    assert.match(conflict({ id, reasoning: false }), /不支持关闭思考/);
  }
  assert.equal(profile({ id: 'private-alias', label: 'glm-5.3' }).reasoning, false,
    'A display label is not a provider protocol declaration');
  assert.deepEqual(profile({ id: 'local:model-' + '8'.repeat(32), wireModelId: 'glm_5.3_flash' }).thinkingLevelMap,
    expected, 'The private transport identity remains available for capability normalization');
  assert.equal(profile({ id: 'glm-5.3', thinkingLevelMap: { high: 'max' } }).thinkingLevelMap.high, 'max',
    'An explicit supported effort mapping must not be silently reduced');
  assert.match(conflict({ id: 'glm-5.3', thinkingLevelMap: { low: 'minimal' } }), /仅支持/);
});

test('an explicit thinking protocol enables an opaque alias without overriding an explicit disable', () => {
  assert.equal(profile({ id: 'private-alias', thinkingFormat: 'zai' }).reasoning, true);
  assert.equal(profile({ id: 'private-alias', thinkingFormat: 'zai', thinkingMode: 'none' }).reasoning, false);
  assert.equal(profile({ id: 'private-alias', thinkingFormat: 'zai', reasoning: false }).reasoning, false);
});

test('real Pi transport honors mandatory GLM 5.3 reasoning and explicit alias protocols', async () => {
  const { streamSimple } = await import('../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js');
  const { getSupportedThinkingLevels } = await import('../node_modules/@earendil-works/pi-ai/dist/models.js');
  for (const spec of [
    { id: 'glm_5.3_flash', reasoning: 'off', expected: 'low' },
    { id: 'glm-5.3', reasoning: 'medium', expected: 'high' },
    { id: 'glm-5.3-flash', reasoning: 'max', expected: 'max' },
    { id: 'private-alias', thinkingFormat: 'zai', reasoning: 'off', expected: 'disabled' },
    { id: 'private-alias', label: 'glm5.3', reasoning: 'off', expected: 'unknown' },
  ]) {
    const { reasoning, expected, ...config } = spec;
    const provider = piProvider({ ...config, baseUrl: 'https://fixture.invalid/v1', maxOutputTokens: 4096 });
    const model = { ...provider.models[0], api: provider.api, provider: 'soduwork', baseUrl: provider.baseUrl };
    let request;
    const result = await streamSimple(model, { messages: [{ role: 'user', content: 'Reply OK.', timestamp: 1 }] }, {
      apiKey: 'synthetic-fixture', reasoning, maxRetries: 0, env: {}, fetch: async (_url, options) => {
        request = JSON.parse(options.body);
        const delta = { choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] };
        return new Response('data: ' + JSON.stringify(delta) + '\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } });
      },
    }).result();
    assert.equal(result.stopReason, 'stop');
    assert.equal(request.max_completion_tokens, 4096, 'The configured output budget is unchanged');
    if (expected === 'unknown') {
      assert.equal(request.thinking, undefined); assert.equal(request.reasoning_effort, undefined);
    } else if (expected === 'disabled') {
      assert.equal(request.thinking.type, 'disabled'); assert.equal(request.reasoning_effort, undefined);
    } else {
      assert.deepEqual(getSupportedThinkingLevels(model), ['low', 'high', 'max']);
      assert.deepEqual(request.thinking, { type: 'enabled', clear_thinking: false });
      assert.equal(request.reasoning_effort, expected);
    }
  }
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
