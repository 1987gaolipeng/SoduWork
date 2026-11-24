'use strict';

const assert = require('assert');
const fs = require('./renderer-source.cjs');
const test = require('node:test');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const catalog = require('../main/agent-runtime/native-model-catalog');
const sessionSpec = require('../main/conversation/session-spec');



function source(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('only the bound Runner supplies selectable native models to a conversation', async () => {
  const runtime = { async rpc(op, request) {
    assert.equal(op, 'runtime.models');
    assert.deepEqual(request, { key: 'codex', ref: 'bound-session' });
    return { ok: true, data: { ok: true, models: [
      { id: 'gpt-5.6-sol', label: '5.6 Sol', reasoningLevels: ['medium', 'xhigh', 'xhigh'], defaultReasoning: 'xhigh' },
      { id: 'hidden-model', visibility: 'hide' }, { id: '../unsafe-model' },
    ] } };
  } };
  const listed = await catalog.list('codex', runtime, 'bound-session');
  assert.equal(listed.ok, true);
  assert.equal(listed.models.length, 1, 'must filter hidden and unsafe models');
  assert.deepEqual(listed.models[0], {
    id: 'gpt-5.6-sol',
    label: '5.6 Sol',
    reasoningLevels: ['medium', 'xhigh'],
    defaultReasoning: 'xhigh',
  });
  assert.deepEqual((await catalog.list('pi', runtime)).models, [], 'Pi must not inherit the Codex catalog');
  const offline = await catalog.list('codex', { rpc: async () => { throw Error('offline'); } });
  assert.deepEqual(offline.models, []);
  assert.equal(offline.ok, false);
});

test('the native discovery source, completed empty list and temporary failure remain distinct', async () => {
  const catalogFor = data => catalog.list('codex', { rpc: async (_op, _request, timeout) => {
    assert.ok(timeout > 5000 && timeout < 12000, 'RPC must leave room for process cleanup inside the composer deadline');
    return { ok: true, data: { ok: true, models: [], ...data } };
  } });
  const empty = await catalogFor({ source: 'codex-native', catalogAvailable: true });
  assert.equal(empty.source, 'codex-native');
  assert.equal(empty.retryable, false);
  const missing = await catalogFor({ catalogAvailable: false, retryable: true });
  assert.equal(missing.retryable, true);
  assert.notEqual(empty.reason, missing.reason);
  assert.equal((await catalogFor({ source: 'codex-account-cache', catalogAvailable: true, retryable: true })).retryable, true);
});

test('native options and picker retain viewport placement and reasoning controls', () => {

  const spec = sessionSpec.build({
    modelName: '  gpt-5.6-sol  ',
    reasoningEffort: '  XHIGH  ',
  }, { capabilityIds: [], selectedSkills: [], skillDirs: [], warnings: [] }, {});
  assert.equal(spec.modelName, 'gpt-5.6-sol');
  assert.equal(spec.reasoningEffort, 'xhigh');

  const preload = source('client/preload.js');
  const ipc = source('client/main/pi-session/runtime-selection-ipc.js');
  const compose = source('client/components/panels/panels-compose.js');
  const picker = source('client/components/panels/panels-compose-model-picker.js');
  const pickerCss = source('client/components/panels/panels-compose-model-picker.css');
  const runner = source('client/main/agent-runtime/runner-adapter.js');
  const desk = source('client/desk.html');
  const backend = source('hub-backend/app/services/local_base.py');

  assert.match(preload, /runtimeModels:\s*\(adapterId, ref\).*pi-session-runtime-models/s);
  assert.match(ipc, /pi-session-runtime-models[\s\S]*native-model-catalog'\)\.list/);
  assert.match(compose, /ComposeModelPicker\.value\(\)[\s\S]*reasoningEffort:\s*modelSelection\.reasoningEffort/);
  assert.match(picker, /row\.id === 'codex'[\s\S]*runtimeModels/);
  assert.match(pickerCss, /position:fixed;right:auto;bottom:auto/, 'top-layer picker uses viewport coordinates');
  // Positioning moved from ancestor-relative CSS into the viewport. Verify the
  // same upward-opening contract at runtime, including short/narrow windows.
  for (const [width, height] of [[1440, 1000], [390, 480]]) {
    const pop = { style: {}, classList: { contains: () => true },
      getBoundingClientRect: () => ({ width: 362, height: Math.min(400, parseFloat(pop.style.maxHeight)) }) };
    const anchor = { top: height - 40, left: width === 1440 ? 650 : width - 160, right: width === 1440 ? 790 : width - 20 };
    const button = { getBoundingClientRect: () => anchor };
    let resize;
    const context = { innerWidth: width, innerHeight: height,
      document: { getElementById: id => id === 'cpModelPop' ? pop : button },
      addEventListener: (name, handler) => { if (name === 'resize') resize = handler; } };
    require('node:vm').runInNewContext(picker, context);
    resize();
    const rect = pop.getBoundingClientRect(), left = parseFloat(pop.style.left), top = parseFloat(pop.style.top);
    assert.ok(left >= 12 && left + rect.width <= width - 12, 'picker stays within horizontal viewport margins');
    assert.equal(left, Math.max(12,Math.min((anchor.left+anchor.right-rect.width)/2,width-12-rect.width)), 'picker centers on the model trigger unless a viewport boundary prevents it');
    assert.ok(top >= 12 && top + rect.height <= height - 49, 'picker stays above its trigger inside short windows');
  }
  assert.match(runner, /adapterId[^\n]*!== 'codex'[\s\S]*agentExecution:\s*_nativeExecution[\s\S]*agentExecution:\s*state\.agentExecution/);
  assert.match(backend, /codex_model[\s\S]*codex_reasoning_effort[\s\S]*model_reasoning_effort/);
  assert.ok(
    desk.indexOf('panels-compose-model-picker.js') < desk.indexOf('panels-compose.js'),
    'model picker must load before the compose controller',
  );

});
