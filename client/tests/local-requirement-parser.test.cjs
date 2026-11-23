'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createLocalRequirementParser } = require('../main/local-requirement-parser.cjs');
const localModels = require('../main/local-model-store.cjs');

function identity() {
  const now = Math.floor(Date.now() / 1000);
  const claims = { typ: 'device', uid: 'local-parser-user', cid: 'local-parser-device', iat: now - 1, exp: now + 3600 };
  return { hub: 'https://hub.fixture.invalid', clientId: 'local-parser-device',
    session: Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + 'a'.repeat(64), secret: 'synthetic-secret' };
}

async function providerFixture(t, reply, authMode = 'none', modelOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-private-parser-'));
  const requests = [], encryptionKey = crypto.randomBytes(32);
  const app = { getPath: () => root };
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
      return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8');
    } };
  const server = http.createServer(async (request, response) => {
    let bytes = '';
    for await (const chunk of request) bytes += chunk;
    const received = { url: request.url, headers: request.headers, body: JSON.parse(bytes) };
    requests.push(received);
    const result = await reply(received);
    response.writeHead(result.status || 200, { 'Content-Type': 'application/json' });
    response.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    localModels.configure(null);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
  localModels.configure({ app, safeStorage });
  const saved = localModels.save({ providers: [{ id: 'private', baseUrl, authMode }],
    models: [{ providerId: 'private', name: 'private-wire-model', modality: 'chat', ...modelOptions }],
    keys: authMode === 'key' ? { private: 'private-provider-key' } : {} });
  const ref = saved.usable[0].name;
  const fetchImpl = (url, options) => {
    assert.equal(url, baseUrl + '/chat/completions', 'no Hub or alternate protocol request is permitted');
    return fetch(url, options);
  };
  const parser = createLocalRequirementParser({ app, identityOf: async () => identity(), fetchImpl });
  return { app, root, ref, baseUrl, requests, parser, fetchImpl };
}

function completion(text, finishReason = 'stop') {
  return { body: { choices: [{ message: { content: text }, finish_reason: finishReason }],
    usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 } } };
}

function rendererParser(parser, getLocale) {
  const values = new Map();
  const box = { URL, URLSearchParams, AbortController, Response, console,
    navigator: { platform: 'test' }, CustomEvent: class {}, dispatchEvent() {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    localStorage: { getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    SoduWorkI18n: { getLocale },
    soduWorkAPI: { conversationSession: { localRequirementParse: parser } },
    fetch: () => assert.fail('private parsing must not contact Hub') };
  box.window = box;
  vm.runInNewContext(require('./renderer-source.cjs').readFileSync(path.join(__dirname, '../api.js'), 'utf8'), box);
  return box.SoduWorkAPI;
}

test('private parsing requests generated fields in the current UI language', async () => {
  let locale = 'en-US';
  const instructions = [];
  const api = rendererParser(async request => {
    instructions.push(request.instructions);
    assert.equal(request.input, '原始需求：\nOriginal issue');
    return { ok: true, text: '{"title":"Original issue"}' };
  }, () => locale);
  assert.equal((await api.parseTaskText('Original issue', 'local:test')).title, 'Original issue');
  assert.match(instructions[0], /Output language: English\./);
  assert.match(instructions[0], /Keep JSON keys, enum values, dates, proper names, identifiers, and literal quotations unchanged/);
  locale = 'ja-JP';
  await api.parseTaskText('Original issue', 'local:test', [], { kind: 'automation' });
  assert.match(instructions[1], /Output language: Japanese\./);
  locale = 'constructor';
  await api.parseTaskText('Original issue', 'local:test');
  assert.match(instructions[2], /Output language: Simplified Chinese\./);
});

test('the default local parser resolves encrypted configuration and calls a real keyless provider', async t => {
  const f = await providerFixture(t, () => completion('{"title":"Local requirement","note":"Keep the full instruction"}'));
  const result = await f.parser({ model: f.ref, input: '原始需求', instructions: '只返回 JSON', requestId: 'real-local-parser' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(JSON.parse(result.text).title, 'Local requirement');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.model, 'private-wire-model');
  assert.equal(f.requests[0].body.stream, false);
  assert.equal(f.requests[0].headers.authorization, undefined);
  assert.equal(result.model, f.ref);
  assert.doesNotMatch(fs.readFileSync(path.join(f.root, 'local-models.secure.json'), 'utf8'), /private-wire-model|127\.0\.0\.1/);
});

test('authenticated stateless app inference uses the same private model path without Hub quota admission', async t => {
  const f = await providerFixture(t, () => completion('Local app answer'), 'key');
  const generate = require('../main/app-ai-generate.cjs').create({ app: f.app,
    authenticatedIdentityOf: async () => identity(), fetchImpl: f.fetchImpl,
    authorizeAI: () => assert.fail('local inference must not check platform model quota') });
  const result = await generate({ appBridge: { appId: 'local:fixture' }, view: null },
    { input: '原始需求', instructions: '仅返回答案', model: f.ref, requestId: 'real-local-app' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, 'Local app answer');
  assert.equal(f.requests[0].headers.authorization, 'Bearer private-provider-key');
  assert.doesNotMatch(JSON.stringify(result), /private-wire-model|private-provider-key|127\.0\.0\.1/);
});

test('requirement and automation renderer parsing use the real private generation result', async t => {
  const f = await providerFixture(t, received => completion(JSON.stringify({ title: 'Local draft',
    note: received.body.messages[1].content, checklist: ['Keep local'], kind: 'requirement', priority: 'normal' })));
  const api = rendererParser(f.parser);
  for (const kind of ['requirement', 'automation']) {
    const result = await api.parseTaskText('Preserve the original instruction.', f.ref, [], { kind });
    assert.equal(result.title, 'Local draft', JSON.stringify(result));
    assert.match(result.note, /Preserve the original instruction/);
  }
  assert.equal(f.requests.length, 2);
});

test('requirement and automation extraction honor encrypted reasoning model output budgets', async t => {
  const f = await providerFixture(t, received => {
    const body = received.body;
    const enoughBudget = body.max_completion_tokens >= 4096;
    return completion(enoughBudget ? '{"title":"Artistic website","note":"Preserve the original request."}'
      : '{"title":"Unfinished draft"}', enoughBudget ? 'stop' : 'length');
  }, 'key', { config: { maxOutputTokens: 16384, reasoning: true, thinkingMode: 'always',
    thinkingFormat: 'openai', supportsReasoningEffort: true } });
  const api = rendererParser(f.parser);
  for (const kind of ['requirement', 'automation']) {
    const result = await api.parseTaskText('Create an artistic website.', f.ref, [], { kind });
    assert.equal(result.title, 'Artistic website', JSON.stringify(result));
    assert.equal(result._parseError, undefined);
  }
  assert.equal(f.requests.length, 2, 'each draft must make exactly one provider request');
  for (const request of f.requests) {
    assert.equal(request.body.max_completion_tokens, 16384);
    assert.equal(request.body.max_tokens, undefined);
    assert.equal(request.body.reasoning_effort, undefined, 'always-thinking models cannot be forced off');
    assert.equal(request.body.tools, undefined, 'extraction remains stateless');
  }
  assert.doesNotMatch(fs.readFileSync(path.join(f.root, 'local-models.secure.json'), 'utf8'),
    /private-wire-model|private-provider-key|16384/);
});

test('local extraction uses the model fallback and preserves configured output and context limits', async t => {
  for (const [name, modelOptions, expected] of [
    ['default output budget', {}, 16384],
    ['larger configured output budget', { config: { maxOutputTokens: 32768 } }, 32768],
    ['smaller configured output budget', { config: { maxOutputTokens: 1024 } }, 1024],
    ['context-bounded fallback', { ctxWindow: 2048 }, 2048],
  ]) {
    await t.test(name, async t => {
      const f = await providerFixture(t, () => completion('{"title":"Bounded draft"}'), 'none', modelOptions);
      const result = await rendererParser(f.parser).parseTaskText('Preserve this requirement.', f.ref);
      assert.equal(result.title, 'Bounded draft', JSON.stringify(result));
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0].body.max_tokens, expected);
    });
  }
});

test('explicit per-call limits remain bounded when a private extraction caller supplies one', async t => {
  const f = await providerFixture(t, () => completion('{"title":"Limited draft"}'), 'none',
    { config: { maxOutputTokens: 16384 } });
  const result = await f.parser({ model: f.ref, input: 'Preserve this requirement.', instructions: 'Return JSON.',
    requestId: 'explicit-extraction-limit', maxOutputTokens: 128 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.requests[0].body.max_tokens, 128);
  await assert.rejects(f.parser({ model: f.ref, input: 'Preserve this requirement.', instructions: 'Return JSON.',
    requestId: 'invalid-extraction-limit', maxOutputTokens: 1000000 }), /限制无效/);
  assert.equal(f.requests.length, 1, 'an invalid caller budget must fail before dispatch');
});

test('reasoning-only truncated responses report the output limit without disclosing private content', async t => {
  const privateReasoning = 'private-wire-model private-provider-key http://private-provider.invalid/v1';
  const outputs = ['', null];
  const f = await providerFixture(t, () => ({ body: { choices: [{ message: {
    content: outputs.shift(), reasoning_content: privateReasoning }, finish_reason: 'length' }] } }));
  const api = rendererParser(f.parser);
  for (let index = 0; index < 2; index++) {
    const result = await api.parseTaskText('Preserve this requirement.', f.ref);
    assert.match(result._parseError, /长度上限.*原文已保留/);
    assert.equal(result.title, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private-wire-model|private-provider-key|private-provider\.invalid/);
  }
  assert.equal(f.requests.length, 2, 'truncation must never trigger an automatic retry');
});

test('truncated structured output is rejected even when its partial JSON happens to be valid', async t => {
  const f = await providerFixture(t, () => completion('{"title":"Incomplete draft"}', 'length'));
  const result = await rendererParser(f.parser).parseTaskText('Preserve the original.', f.ref);
  assert.match(result._parseError, /长度上限.*原文已保留/);
  assert.equal(result.title, undefined);
  assert.equal(f.requests.length, 1, 'the parser never retries provider calls automatically');
});

test('invalid structured output remains a format error and cannot fabricate an empty requirement', async t => {
  const outputs = ['```json\n{"title":"Fenced draft"}\n```', '{"unexpected":"not a requirement"}', 'not JSON'];
  const f = await providerFixture(t, () => completion(outputs.shift()));
  const api = rendererParser(f.parser);
  assert.equal((await api.parseTaskText('Original instruction.', f.ref)).title, 'Fenced draft');
  for (let index = 0; index < 2; index++) {
    const result = await api.parseTaskText('Original instruction.', f.ref);
    assert.match(result._parseError, /格式无效.*原文已保留/);
    assert.equal(result.title, undefined);
  }
  assert.equal(f.requests.length, 3);
});

test('private provider failures expose a safe cause without response metadata or platform quota hints', async t => {
  const f = await providerFixture(t, () => ({ status: 503,
    body: 'private-wire-model private-provider-key http://private-provider.invalid/v1' }));
  const result = await rendererParser(f.parser).parseTaskText('Original instruction.', f.ref);
  assert.match(result._parseError, /本地模型服务返回错误.*原文已保留/);
  assert.doesNotMatch(JSON.stringify(result), /private-wire-model|private-provider-key|private-provider\.invalid|额度/);
  assert.equal(f.requests.length, 1);
});

test('removed local models fail before dispatch without falling back to Hub or its quota', async t => {
  const f = await providerFixture(t, () => assert.fail('deleted models must not reach a provider'));
  localModels.save({ providers: [], models: [], keys: {}, expectedRevision: 1 });
  const result = await rendererParser(f.parser).parseTaskText('Original instruction.', f.ref);
  assert.match(result._parseError, /本地文字模型已删除.*原文已保留/);
  assert.doesNotMatch(result._parseError, /额度/);
  assert.equal(f.requests.length, 0);
});

test('local parser explains provider HTTP failures without exposing upstream messages', async () => {
  for (const [httpStatus,expected] of [[400,/请求参数.*兼容/],[401,/凭据/],[403,/权限/],
    [404,/地址.*模型名称/],[422,/请求参数.*兼容/],[429,/请求过多/],[503,/暂时不可用/]]) {
    const api=rendererParser(async()=>({ok:false,code:httpStatus===429?'APP_AI_RATE_LIMITED':'APP_AI_PROVIDER_ERROR',
      httpStatus,reason:'private-provider-key http://private-provider.invalid/v1'}));
    const result=await api.parseTaskText('原始任务','local:model-'+ 'a'.repeat(32),[],{kind:'automation'});
    assert.match(result._parseError,new RegExp('HTTP '+httpStatus)); assert.match(result._parseError,expected);
    assert.doesNotMatch(result._parseError,/private-provider/);
  }
});

test('a real private provider timeout is bounded, aborts the request and keeps the result uncertain', async t => {
  const f = await providerFixture(t, () => new Promise(() => {}));
  let captured;
  const api = rendererParser(async raw => {
    captured = await f.parser({ ...raw, timeoutMs: 1000 });
    return captured;
  });
  const started = Date.now();
  const result = await api.parseTaskText('Original instruction.', f.ref);
  assert.equal(captured.code, 'APP_AI_RESULT_UNKNOWN');
  assert.equal(captured.uncertain, true);
  assert.match(result._parseError, /中断或超时.*未能确认结果.*原文已保留/);
  assert.equal(result.title, undefined);
  assert.equal(f.requests.length, 1);
  assert.ok(Date.now() - started < 5000);
});

test('local requirement parsing uses the private endpoint and never authorizes with Hub', async () => {
  const requests = [], model = { id: 'local:model-0123456789abcdef0123456789abcdef', wireModelId: 'private-wire-model',
    localOnly: true, baseUrl: 'http://127.0.0.1:43123/v1', key: 'private-key', input: ['text'], maxOutputTokens: 2048 };
  const parser = createLocalRequirementParser({ app: {}, identityOf: async () => identity(),
    resolveModel: async () => ({ ok: true, localOnly: true, model }),
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"Local requirement"}' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    } });
  const result = await parser({ model: model.id, input: '原始需求', instructions: '只返回 JSON',
    requestId: 'local-parser-1', maxOutputTokens: 256, timeoutMs: 1000 });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, model.baseUrl + '/chat/completions');
  assert.equal(requests[0].body.model, model.wireModelId);
  assert.equal(requests[0].headers.Authorization, 'Bearer private-key');
});

test('the local parser rejects hosted model references before any network request', async () => {
  let called = false;
  const parser = createLocalRequirementParser({ app: {}, identityOf: async () => identity(),
    fetchImpl: async () => { called = true; throw Error('unexpected network'); } });
  const result = await parser({ model: 'managed-model', input: '原始需求', instructions: '只返回 JSON', requestId: 'local-parser-2' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'APP_AI_LOCAL_MODEL_REQUIRED');
  assert.equal(called, false);
});
