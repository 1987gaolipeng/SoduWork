'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const fsNode = require('node:fs');
const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

async function fetchDeclaredModel(metadata) {
  return require('../main/pi-session/model-config').fetchModel(
    { hub: 'https://hub.example.test', clientId: 'device-1', session: 'device-session' },
    'managed-alias', 8000,
    async () => new Response(JSON.stringify({ ok: true, key: 'fixture', model: 'managed-alias', ...metadata }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }),
    false, 'kimi');
}

test('unsupported streaming keeps Hub archives readable while rejecting a new Pi turn', async t => {
  const modelConfig = require('../main/pi-session/model-config');
  const rootDir = fsNode.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-capability-'));
  t.after(() => fsNode.rmSync(rootDir, { recursive: true, force: true }));
  const app = { getPath: () => rootDir };
  const identity = { hub: 'https://hub.fixture.invalid', clientId: 'device-history-capability', session: 'synthetic-session' };
  const modelName = 'historical-capability-model';
  const fetchImpl = async () => new Response(JSON.stringify({ ok: true, key: 'synthetic-ticket', model: modelName,
    baseUrl: 'https://gateway.fixture.invalid/v1', capabilityProfile: { streaming: { state: 'unsupported' } } }),
  { status: 200, headers: { 'Content-Type': 'application/json' } });
  const historical = await modelConfig.fetchModel(identity, modelName, 1000, fetchImpl, false, 'pi',
    { app, allowHistorical: true });
  assert.equal(historical.ok, true, historical.reason);
  assert.equal(historical.historical, true);
  assert.equal(historical.model.key, 'history-only');
  const active = await modelConfig.fetchModel(identity, modelName, 1000, fetchImpl, false, 'pi', { app });
  assert.equal(active.ok, false);
  assert.equal(active.code, 'MODEL_CAPABILITY_INCOMPATIBLE');
});

test('model configuration deadline recognizes runtime RPC cancellation without reporting quota exhaustion', async t => {
  const { MessageChannel } = require('node:worker_threads');
  const { createRpcPeer } = require('../main/agent-runtime/process-rpc');
  const { port1, port2 } = new MessageChannel();
  const caller = createRpcPeer({ send: packet => port1.postMessage(packet) });
  const host = createRpcPeer({ send: packet => port2.postMessage(packet), handlers: {
    authRequest() { return new Promise(resolve => this.signal.addEventListener('abort', () => resolve(null), { once: true })); },
  } });
  port1.on('message', packet => caller.receive(packet));
  port2.on('message', packet => host.receive(packet));
  t.after(() => { caller.close(); host.close(); port1.close(); port2.close(); });
  const result = await require('../main/pi-session/model-config').fetchModel(
    { hub: 'https://hub.example.test', clientId: 'device-timeout', session: 'device-session' },
    'managed-alias', 30, (_url, options) => caller.call('authRequest', [], { signal: options.signal }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MODEL_CONFIG_TIMEOUT');
  assert.equal(result.reason, '服务响应超时，可稍后重试');
  assert.equal(require('../core/token-quota').detail(result), null);
  assert.equal(Object.hasOwn(result, 'quota'), false);
  assert.doesNotMatch(result.reason, /Runtime request aborted/);
});

test('only the configuration deadline is a timeout; independent cancellation and quota refusals remain distinct', async () => {
  const { fetchModel } = require('../main/pi-session/model-config');
  const identity = { hub: 'https://hub.example.test', clientId: 'device-errors', session: 'device-session' };
  const cancelled = await fetchModel(identity, 'managed-alias', 1000, async () => {
    throw Object.assign(Error('Runtime caller cancelled the request'), { name: 'RpcError', code: 'RPC_ABORTED' });
  });
  assert.equal(cancelled.ok, false);
  assert.notEqual(cancelled.code, 'MODEL_CONFIG_TIMEOUT');
  assert.equal(require('../core/token-quota').detail(cancelled), null);
  const quota = { enabled: true, exceeded: true, limit: 10, used: 10 };
  const denied = await fetchModel(identity, 'managed-alias', 1000, async () => new Response(JSON.stringify({
    detail: { code: 'TOKEN_QUOTA_EXCEEDED', message: '当前 AI 使用额度暂不可用，请查看额度详情', quota },
  }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
  assert.equal(denied.status, 403);
  assert.equal(denied.code, 'TOKEN_QUOTA_EXCEEDED');
  assert.deepEqual(denied.quota, quota);
});

test('Hub reasoning declarations survive model normalization and the runner boundary', async () => {
  const { create } = require('../main/agent-runtime/runner-config.cjs');
  for (const declaration of [
    { thinkingMode: 'always', thinkingAlwaysOn: true },
    { thinkingMode: 'always' },
    { thinkingMode: 'controllable', thinkingAlwaysOn: false },
    { thinkingMode: 'controllable' },
    { thinkingMode: 'none', thinkingAlwaysOn: false },
    { reasoning: true, thinkingAlwaysOn: true },
  ]) {
    const result = await fetchDeclaredModel({ ...declaration, thinkingFormat: 'zai',
      supportsReasoningEffort: true, thinkingLevelMap: { low: 'low', high: 'high' } });
    assert.equal(result.ok, true);
    assert.equal(result.model.reasoning, declaration.thinkingMode !== 'none');
    const runner = create(result.model, 'kimi').llm;
    for (const model of [result.model, runner]) {
      assert.equal(model.thinkingMode, declaration.thinkingMode);
      assert.equal(model.thinkingAlwaysOn, declaration.thinkingAlwaysOn);
      assert.equal(Object.hasOwn(model, 'thinkingMode'), Object.hasOwn(declaration, 'thinkingMode'));
      assert.equal(Object.hasOwn(model, 'thinkingAlwaysOn'), Object.hasOwn(declaration, 'thinkingAlwaysOn'));
      assert.equal(Object.hasOwn(model, 'thinkingLevel'), false);
    }
    if (declaration.thinkingMode === 'always' || declaration.thinkingAlwaysOn === true) {
      assert.equal(result.model.thinkingLevelMap.off, null);
      assert.equal(runner.thinkingLevelMap.off, null);
    } else if (declaration.thinkingMode === 'controllable') {
      assert.equal(Object.hasOwn(result.model.thinkingLevelMap, 'off'), false);
      assert.equal(Object.hasOwn(runner.thinkingLevelMap, 'off'), false);
    } else {
      assert.equal(Object.hasOwn(runner, 'reasoning'), false);
    }
  }
});

test('Hub model metadata does not invent thinking policy or accept malformed declarations', async () => {
  const ordinary = await fetchDeclaredModel({ reasoning: false });
  assert.equal(ordinary.ok, true);
  assert.equal(ordinary.model.reasoning, false);
  for (const field of ['thinkingMode', 'thinkingAlwaysOn', 'thinkingLevel']) {
    assert.equal(Object.hasOwn(ordinary.model, field), false, field);
  }
  for (const invalid of [null, '', 'AUTO', 'controllable ', 1, {}, []]) {
    const result = await fetchDeclaredModel({ thinkingMode: invalid, thinkingAlwaysOn: invalid,
      thinkingLevel: invalid });
    assert.equal(result.ok, true);
    for (const field of ['thinkingMode', 'thinkingAlwaysOn', 'thinkingLevel']) {
      assert.equal(Object.hasOwn(result.model, field), false, field);
    }
  }
});

test('Hub explicit thinking level remains explicit through the runner boundary', async () => {
  const { create } = require('../main/agent-runtime/runner-config.cjs');
  for (const thinkingLevel of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const result = await fetchDeclaredModel({ thinkingMode: 'controllable', thinkingAlwaysOn: false,
      thinkingFormat: 'zai', thinkingLevel });
    assert.equal(result.ok, true);
    assert.equal(result.model.thinkingLevel, thinkingLevel);
    assert.equal(create(result.model, 'kimi').llm.thinkingLevel, thinkingLevel);
  }
});

test('conflicting mandatory-thinking declarations reject runtime admission without breaking normalization', async t => {
  const cfg = require('../main/pi-session/model-config');
  const ref = 'local:model-' + '7'.repeat(32);
  t.mock.method(require('../main/local-model-store.cjs'), 'resolve', () => ({
    modelRef: ref, name: 'glm_5.3_flash', baseUrl: 'https://fixture.invalid/v1', key: '',
    config: { thinkingMode: 'none' },
  }));
  const local = await cfg.fetchModel(null, ref, 1000, () => { throw Error('No request expected'); }, false, 'pi', { allowLocal: true });
  assert.equal(local.ok, false); assert.equal(local.code, 'MODEL_THINKING_CONFLICT');
  assert.match(local.reason, /不支持关闭思考/);
  const managed = await fetchDeclaredModel({ model: 'glm-5.3', reasoning: false });
  assert.equal(managed.ok, false); assert.equal(managed.code, 'MODEL_THINKING_CONFLICT');
  assert.match(managed.reason, /不支持关闭思考/);
});

test('模型中心支持个人自建服务与本地服务', () => {
  const panel = read('components', 'panels', 'panels-models.js');
  const api = read('api.js');
  assert.match(panel, /添加模型服务/);
  assert.match(panel, /data-purl=/);
  assert.match(panel, /data-pname=/);
  assert.match(panel, /OpenAI 兼容/);
  assert.match(panel, /本地服务无需密钥/);
  assert.match(panel, /payload\.providers/);
  assert.match(panel, /payload\.localProviders/);
  assert.match(api, /async saveMyModels\(body\)[\s\S]*?jfetch\('\/my-models', \{ method: 'PUT'/);
});

test('saving personal models keeps local services out of the Hub payload', async () => {
  const values = new Map(), calls = [], localCalls = [];
  const response = { ok: true, providers: [{ id: 'custom-hub', personal: true, hasKey: false }] };
  const window = { dispatchEvent() {}, soduWorkAPI: {
    getHubConnection: async () => ({ ok: true, hub: 'https://hub.example.test', editable: true }),
    deviceAuthBootstrap: async () => ({ ok: true, stored: true, clientId: 'device-1',
      user: { id: 'alice' }, session: 'fixture-session', expiresIn: 1800 }),
    localModels: {
      get: async () => ({ revision: 7, providers: [{ id: 'custom-local', localOnly: true }], myModels: [], usable: [], mediaUsable: {} }),
      save: async body => { localCalls.push(body); return { ok: true, revision: 8 }; },
    },
  } };
  vm.runInNewContext(read('api.js'), {
    window, User: { id: 'device-1', name: 'Fixture' }, navigator: { platform: 'test' },
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    fetch: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(response)); },
    URL, URLSearchParams, Response, AbortController, CustomEvent: class {},
    console: { log() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  }, { filename: 'api.js' });
  const api = window.SoduWorkAPI;
  await api.registerClient();
  const body = {
    providers: [
      { id: 'custom-hub', baseUrl: 'https://personal.example.test/v1' },
      { id: 'custom-local', name: 'Local service', baseUrl: 'http://127.0.0.1:12345/v1', kind: 'openai-compat', personal: true, authMode: 'none', localOnly: true },
    ],
    models: [
      { name: 'personal-model', providerId: 'custom-hub', label: 'Personal model' },
      { name: 'custom-model', providerId: 'custom-local', label: 'Custom model', localOnly: true },
    ],
    keys: { 'custom-hub': null, 'custom-local': 'local-secret' },
    localProviders: [{ id: 'custom-local', name: 'Local service', baseUrl: 'http://127.0.0.1:12345/v1', kind: 'openai-compat', personal: true, authMode: 'none', localOnly: true }],
    localModels: [{ name: 'custom-model', providerId: 'custom-local', label: 'Custom model', localOnly: true }],
    localKeys: { 'custom-local': 'local-secret' },
    localRevision: 7,
    expectedRevision: 7,
  };
  assert.deepEqual(JSON.parse(JSON.stringify(await api.saveMyModels(body))), response);
  assert.equal(localCalls.length, 1);
  assert.equal(localCalls[0].expectedRevision, 7);
  assert.equal(localCalls[0].keys['custom-local'], 'local-secret');
  const hubCalls = calls.filter(call => call.url === 'https://hub.example.test/api/v1/my-models' && call.options.method === 'PUT');
  assert.equal(hubCalls.length, 1);
  assert.equal(hubCalls[0].options.method, 'PUT');
  assert.equal(hubCalls[0].options.headers.Authorization, 'Device fixture-session');
  const hubBody = JSON.parse(hubCalls[0].options.body);
  assert.deepEqual(hubBody.providers, [{ id: 'custom-hub', baseUrl: 'https://personal.example.test/v1' }]);
  assert.deepEqual(hubBody.models, [{ name: 'personal-model', providerId: 'custom-hub', label: 'Personal model' }]);
  assert.deepEqual(hubBody.keys, { 'custom-hub': null });
  assert.equal(JSON.stringify(hubBody).includes('custom-local'), false);
});

test('saving only local models does not require a Hub connection', async () => {
  const values = new Map(), calls = [], localCalls = [];
  const window = { dispatchEvent() {}, soduWorkAPI: { localModels: {
    get: async () => ({ revision: 2, providers: [], myModels: [], usable: [], mediaUsable: {} }),
    save: async body => { localCalls.push(body); return { ok: true }; },
  } } };
  vm.runInNewContext(read('api.js'), {
    window, User: {}, navigator: { platform: 'test' },
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    fetch: async (url, options) => { calls.push({ url, options }); throw Error('Hub must not be contacted'); },
    URL, URLSearchParams, Response, AbortController, CustomEvent: class {},
    console: { log() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  }, { filename: 'api.js' });
  await window.SoduWorkAPI.saveMyModels({
    localProviders: [{ id: 'custom-local', localOnly: true, baseUrl: 'http://127.0.0.1:12345/v1' }],
    localModels: [{ providerId: 'custom-local', name: 'custom-model', localOnly: true }],
    localKeys: {}, localRevision: 2,
  });
  assert.equal(localCalls.length, 1);
  assert.equal(calls.length, 0);
});

test('local capability checks stay in the desktop process', async () => {
  const values = new Map(), calls = [], probes = [];
  const window = { dispatchEvent() {}, soduWorkAPI: { localModels: {
    get: async () => ({ providers: [{ id: 'custom-local', localOnly: true }],
      myModels: [{ id: 'local:model-' + '1'.repeat(32), providerId: 'custom-local', name: 'qwen3', localOnly: true }], usable: [], mediaUsable: {} }),
    checkCapabilities: async input => { probes.push(JSON.parse(JSON.stringify(input))); return { ok: true,
      checks: { connection: { status: 'passed' }, streaming: { status: 'passed' } } }; },
  } } };
  vm.runInNewContext(read('api.js'), {
    window, User: {}, navigator: { platform: 'test' },
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    fetch: async (url, options) => { calls.push({ url, options }); throw Error('Hub must not be contacted'); },
    URL, URLSearchParams, Response, AbortController, CustomEvent: class {},
    console: { log() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  }, { filename: 'api.js' });
  const report = await window.SoduWorkAPI.checkMyModelCapabilities({ providerId: 'device:custom-local', model: 'qwen3', checks: ['connection', 'streaming'] });
  assert.equal(report.ok, true);
  assert.deepEqual(probes, [{ modelRef: 'local:model-' + '1'.repeat(32), checks: ['connection', 'streaming'] }]);
  assert.equal(report.checks.connection.status, 'passed');
  assert.equal(report.checks.streaming.status, 'passed');
  assert.equal(calls.length, 0);
});

test('a managed-only save does not erase existing local model definitions', async () => {
  const values = new Map(), localCalls = [], hubCalls = [];
  const window = { dispatchEvent() {}, soduWorkAPI: { localModels: {
    get: async () => ({ revision: 4, providers: [{ id: 'custom-local', localOnly: true,
      baseUrl: 'http://127.0.0.1:12345/v1', authMode: 'none' }],
      myModels: [{ providerId: 'custom-local', name: 'qwen3', localOnly: true }], usable: [], mediaUsable: {} }),
    save: async body => { localCalls.push(body); return { ok: true }; },
  } } };
  vm.runInNewContext(read('api.js'), {
    window, User: {}, navigator: { platform: 'test' },
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    fetch: async (url, options) => { hubCalls.push({ url, options }); return new Response(JSON.stringify({ ok: true })); },
    URL, URLSearchParams, Response, AbortController, CustomEvent: class {},
    console: { log() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  }, { filename: 'api.js' });
  await assert.rejects(window.SoduWorkAPI.saveMyModels({
    providers: [{ id: 'company-provider', baseUrl: '' }], keys: { 'custom-local': 'ignored-by-hub' },
  }), /来源不明确/);
  assert.equal(localCalls.length, 0);
  assert.equal(hubCalls.length, 0);
});

test('a missing local bridge cannot forward local-looking keys to the Hub', async () => {
  const values = new Map(), hubCalls = [];
  const window = { dispatchEvent() {} };
  vm.runInNewContext(read('api.js'), {
    window, User: {}, navigator: { platform: 'test' },
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    fetch: async (url, options) => {
      hubCalls.push({ url, options });
      return new Response(JSON.stringify({ ok: true }));
    },
    URL, URLSearchParams, Response, AbortController, CustomEvent: class {},
    console: { log() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  }, { filename: 'api.js' });
  await assert.rejects(window.SoduWorkAPI.saveMyModels({
    providers: [{ id: 'company-provider', baseUrl: '' }],
    keys: { 'local-service': 'must-not-forward' },
  }), /来源不明确/);
  assert.equal(hubCalls.length, 0);
});

test('个人模型配置保留就地真实探测', () => {
  const panel = read('components', 'panels', 'panels-models.js');
  assert.match(panel, /保存并测试/);
  assert.match(panel, /SoduWorkAPI\.testMyModel/);
  assert.match(panel, /连接设置/);
  assert.match(panel, /访问凭据/);
  assert.match(panel, /模型清单/);
});

test('额度耗尽时历史会话仍可使用本地模型元数据打开', async t => {
  const modelConfig = require('../main/pi-session/model-config');
  const rootDir = fsNode.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-quota-'));
  t.after(() => fsNode.rmSync(rootDir, { recursive: true, force: true }));
  const app = { getPath: () => rootDir };
  modelConfig.writeModels(path.join(rootDir, 'pi-agent'), {
    baseUrl: 'https://hub.example.test/api/v1/ai-proxy/v1', id: 'saved-model', label: 'Saved model',
    input: ['text'], contextWindow: 128000, maxOutputTokens: 4096,
  });
  const result = await modelConfig.fetchModel(
    { hub: 'https://hub.example.test', clientId: 'device-1', session: 'device-session' },
    'saved-model', 8000,
    async () => new Response(JSON.stringify({ detail: {
      code: 'TOKEN_QUOTA_EXCEEDED', quota: { enabled: true, exceeded: true },
    } }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    false, 'pi', { app, allowHistorical: true });
  assert.equal(result.ok, true);
  assert.equal(result.historical, true);
  assert.equal(result.model.id, 'saved-model');
  assert.equal(result.model.key, 'history-only');
  const denied = await modelConfig.fetchModel(
    { hub: 'https://hub.example.test', clientId: 'device-1', session: 'device-session' },
    'saved-model', 8000,
    async () => new Response(JSON.stringify({ detail: {
      code: 'TOKEN_QUOTA_EXCEEDED', quota: { enabled: true, exceeded: true },
    } }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'TOKEN_QUOTA_EXCEEDED');
});
