'use strict';

// Explicit warmup helper contracts and configuration-only request boundaries.

const test = require('node:test');
const assert = require('node:assert');

const { warmupGateway, _resetWarmup } = require('../main/pi-session/model-config');

function deferred() {
  let resolve;
  const promise = new Promise((resolve_) => { resolve = resolve_; });
  return { promise, resolve };
}

test('warmupGateway sends a 1-token chat completion to the gateway', () => {
  _resetWarmup();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200 };
  };
  warmupGateway('https://hub.example.com/api/v1/ai-proxy/v1', 'ticket', 'dev-model', fetchImpl);
  await_new_tick();
  assert.strictEqual(calls.length, 1);
  const { url, options } = calls[0];
  assert.strictEqual(url, 'https://hub.example.com/api/v1/ai-proxy/v1/chat/completions');
  assert.strictEqual(options.method, 'POST');
  assert.strictEqual(options.headers.Authorization, 'Bearer ticket');
  const body = JSON.parse(options.body);
  assert.strictEqual(body.model, 'dev-model');
  assert.strictEqual(body.max_tokens, 1);
  assert.deepStrictEqual(body.messages, [{ role: 'user', content: 'ping' }]);
});

test('warmupGateway is throttled within the interval', () => {
  _resetWarmup();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true }; };
  warmupGateway('https://hub.example.com/x', 'k', 'm', fetchImpl);
  warmupGateway('https://hub.example.com/x', 'k', 'm', fetchImpl);
  await_new_tick();
  assert.strictEqual(calls, 1, '30 分钟内的第二次调用不得发出请求');
});

test('warmupGateway swallows network failures', () => {
  _resetWarmup();
  const fetchImpl = async () => { throw new Error('boom'); };
  assert.doesNotThrow(() => warmupGateway('https://hub.example.com/x', 'k', 'm', fetchImpl));
  await_new_tick();
});

test('warmupGateway rejects non-http URLs and missing fields', () => {
  _resetWarmup();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true }; };
  warmupGateway('file:///etc', 'k', 'm', fetchImpl);
  warmupGateway('', 'k', 'm', fetchImpl);
  warmupGateway('https://hub.example.com/x', '', 'm', fetchImpl);
  warmupGateway('https://hub.example.com/x', 'k', '', fetchImpl);
  await_new_tick();
  assert.strictEqual(calls, 0);
});

function await_new_tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('preparing an image selection does not send a text completion or consume chat warmup', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const config = require('../main/pi-session/model-config');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-config-warmup-'));
  const environment = { ...process.env }, requests = [];
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    fs.rmSync(root, { recursive: true, force: true }); config._resetWarmup();
  });
  config._resetWarmup();
  t.mock.method(global, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ key: 'fixture-ticket',
      models: { image: [{ providerId: 'personal', name: 'own-image' }] } }) };
  });
  const result = await config.prepare({ getPath: () => root },
    { hub: 'https://fixture.invalid', clientId: 'fixture-device', secret: 'fixture-secret' }, 'image::personal::own-image');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.model.modality, 'image');
  assert.strictEqual(requests.length, 1, 'only the media catalog may be requested');
  assert.ok(requests[0].url.endsWith('/media/config'));
  config.warmupGateway('https://fixture.invalid/v1', 'fixture-ticket', 'chat-model');
  assert.strictEqual(requests.length, 2, 'a later real chat selection can still warm its model');
  assert.strictEqual(JSON.parse(requests[1].options.body).model, 'chat-model');
});

test('preparing and reopening a chat selection never submits implicit inference', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const config = require('../main/pi-session/model-config');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-config-only-'));
  const environment = {...process.env}, requests = [];
  config.invalidate();
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment); config.invalidate();
    fs.rmSync(root, {recursive: true, force: true});
  });
  t.mock.method(global, 'fetch', async (url, options) => {
    requests.push({url, options});
    return {ok: true, status: 200, json: async () => ({ok: true, key: 'fixture-ticket',
      model: 'fixture-model', expiresIn: 3600})};
  });
  const app = {getPath: () => root};
  const identity = {hub: 'https://config-only.invalid', clientId: 'config-only-device', secret: 'fixture-secret'};
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await config.prepare(app, identity, 'fixture-model')).ok, true);
  await await_new_tick();
  assert.ok(requests.length > 0);
  assert.ok(requests.every(row => row.url.includes('/ai-proxy/config')));
  assert.ok(requests.every(row => !row.options.body), 'configuration never sends prompts or billable warmup bodies');
});
