'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('模型中心支持个人地址覆盖与任意自定义服务', () => {
  const panel = read('components', 'panels', 'panels-models.js');
  const api = read('api.js');
  assert.match(panel, /添加模型服务/);
  assert.match(panel, /data-purl=/);
  assert.match(panel, /data-pname=/);
  assert.match(panel, /OpenAI 兼容/);
  assert.match(panel, /本地服务无需密钥/);
  assert.match(panel, /providers, models: _mdMyModels, keys: _mdKeyEdits/);
  assert.match(api, /async saveMyModels\(body\)[\s\S]*?jfetch\('\/my-models', \{ method: 'PUT', body: JSON\.stringify\(body \|\| \{\}\)/);
});

test('saving personal models preserves provider overrides, custom services, and key removal', async () => {
  const values = new Map(), calls = [];
  const response = { ok: true, providers: [{ id: 'custom-local', hasKey: false }] };
  const window = { dispatchEvent() {}, soduWorkAPI: {
    getHubConnection: async () => ({ ok: true, hub: 'https://hub.example.test', editable: true }),
    deviceAuthBootstrap: async () => ({ ok: true, stored: true, clientId: 'device-1',
      user: { id: 'alice' }, session: 'fixture-session', expiresIn: 1800 }),
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
      { id: 'company-provider', baseUrl: 'https://personal.example.test/v1' },
      { id: 'custom-local', name: 'Local service', baseUrl: 'http://127.0.0.1:12345/v1', kind: 'openai-compat', personal: true, authMode: 'none' },
    ],
    models: [{ name: 'custom-model', providerId: 'custom-local', label: 'Custom model' }],
    keys: { 'company-provider': null, 'custom-local': '' },
    expectedRevision: 7,
  };
  assert.deepEqual(JSON.parse(JSON.stringify(await api.saveMyModels(body))), response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hub.example.test/api/v1/my-models');
  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(calls[0].options.headers.Authorization, 'Device fixture-session');
  assert.deepEqual(JSON.parse(calls[0].options.body), body);
});

test('模型配置保留就地真实探测与组织地址恢复能力', () => {
  const panel = read('components', 'panels', 'panels-models.js');
  assert.match(panel, /保存并测试/);
  assert.match(panel, /SoduWorkAPI\.testMyModel/);
  assert.match(panel, /恢复组织默认地址/);
  assert.match(panel, /连接设置/);
  assert.match(panel, /访问凭据/);
  assert.match(panel, /模型清单/);
});
