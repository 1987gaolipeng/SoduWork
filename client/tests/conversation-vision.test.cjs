const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');

const vision = require('../main/pi-session/vision');
const contract = require('../main/pi-session/vision-contract');
const eventStream = require('../main/pi-session/event-stream');

test('visual observations are hidden from the visible user message', () => {
  const prompt = contract.augment('请检查截图', {
    ok: true, model: 'configured-vision', imageCount: 1,
    observation: { summary: '登录按钮不可用', details: ['按钮为灰色'] },
  });
  assert.match(prompt, /configured-vision/);
  assert.equal(contract.parse(prompt).text, '请检查截图');
  const stream = eventStream.create();
  eventStream.apply(stream.state, {
    type: 'message_end', message: { role: 'user', content: prompt },
  });
  assert.equal(stream.state.messages.at(-1).text, '请检查截图');
});

test('vision request uses device session and returns structured observation', async () => {
  let request = null;
  const fakeFetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true, status: 200,
      async json() {
        return { ok: true, model: 'configured-vision', imageCount: 1,
          observation: { summary: '一张设置页截图' } };
      },
    };
  };
  const result = await vision.analyze(
    { hub: 'http://hub/', clientId: 'c1', session: 'device-ticket' },
    [{ mimeType: 'image/png', data: Buffer.from('png').toString('base64') }],
    '看看哪里有问题', 1000, fakeFetch);
  assert.equal(result.ok, true);
  assert.equal(result.model, 'configured-vision');
  assert.equal(request.url, 'http://hub/api/v1/ai-proxy/vision/analyze');
  assert.equal(request.options.headers.Authorization, 'Device device-ticket');
  assert.equal(request.body.context, '看看哪里有问题');
  assert.equal(request.body.images.length, 1);
});

test('vision limits fail explicitly instead of silently dropping images', () => {
  const many = Array.from({ length: 5 }, () => ({
    mimeType: 'image/png', data: Buffer.from('x').toString('base64'),
  }));
  assert.equal(vision.compact(many).ok, false);
  assert.match(vision.compact([{ mimeType: 'image/svg+xml', data: 'eA==' }]).reason, /格式/);
});

test('vision sends more than four images in bounded batches and preserves every observation', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.images.length);
    return {
      ok: true, status: 200,
      async json() {
        return { ok: true, model: 'vision-model', imageCount: body.images.length,
          observation: { summary: 'batch-' + calls.length } };
      },
    };
  };
  const images = Array.from({ length: 9 }, () => ({
    mimeType: 'image/png', data: Buffer.from('x').toString('base64'),
  }));
  const result = await vision.analyze(
    { hub: 'http://hub', clientId: 'c1', session: 'ticket' }, images, '检查全部图片', 1000, fakeFetch);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [4, 4, 1]);
  assert.equal(result.imageCount, 9);
  assert.equal(result.observation.batches.length, 3);
  assert.deepEqual(result.observation.batches.map((item) => item.imageRange), [[1, 4], [5, 8], [9, 9]]);
});

test('native session preserves images; new images require vision while text follow-ups disclose omitted history', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main/pi-session/session.js'), 'utf8');
  assert.match(source, /vision\.analyze\(ctx\.identity, observationInputs, promptText\)/);
  assert.match(source, /visionContract\.augment\(modelPrompt, observed\)/);
  assert.match(source, /outputContinuation\.bind\(\s*piSession, acc/);
  assert.match(source, /prep\.model\?\.imageRouting === 'native'/);
  assert.match(source, /prep\.model\?\.input\?\.includes\('image'\)/);
  assert.match(source, /imageRouting\.observationInputs\(ctx\.prep\.model, visualInputs, ctx\.piSession\.messages,\s*\{ allowHistoryOmission: true \}\)/);
  assert.match(source, /imageRouting\.historyNotice\(ctx\.prep\.model, visualInputs, ctx\.piSession\.messages\)/);
  assert.match(source, /modelPrompt = connectors\.augment\(modelPrompt, historyNotice\)/);
  assert.match(source, /_promptComplete\(modelPrompt, \{ images: nativeImages \? visualInputs : \[\] \}\)/);
  const continuation = fs.readFileSync(path.join(__dirname, '../main/pi-session/output-continuation.js'), 'utf8');
  assert.match(continuation, /return \(prompt, options\) => complete\(session, accumulator, prompt, options/);
});

test('expired vision session renews once for the same account without exposing the device secret', async t => {
  const auth = require('../main/device-auth-request');
  const fixture = require('./helpers/platform-session-fixture.cjs');
  const identity = { ...fixture.identity('expired'), secret: 's'.repeat(40) };
  const renewed = { ...identity, session: fixture.sessions().renewed };
  auth.setIdentityRefresher(async before => {
    assert.equal(before.session, identity.session);
    return renewed;
  });
  t.after(() => auth.setIdentityRefresher(null));
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push(options.headers);
    if (calls.length === 1) {
      return { ok: false, status: 401, json: async () => ({ detail: 'expired' }) };
    }
    return { ok: true, status: 200,
      json: async () => ({ ok: true, model: 'configured-vision', observation: {} }) };
  };
  const result = await vision.analyze(
    identity,
    [{ mimeType: 'image/png', data: Buffer.from('png').toString('base64') }],
    '', 1000, fakeFetch);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].Authorization, 'Device ' + identity.session);
  assert.equal(calls[1].Authorization, 'Device ' + renewed.session);
  assert.ok(calls.every(headers => headers['X-Soduwork-Secret'] === undefined));
});

test('vision cannot retry a rejected session as another account or fall back to its device secret', async t => {
  const auth = require('../main/device-auth-request');
  const fixture = require('./helpers/platform-session-fixture.cjs');
  const identity = { ...fixture.identity('expired'), secret: 's'.repeat(40) };
  auth.setIdentityRefresher(async () => ({ ...identity, session: fixture.sessions().two }));
  t.after(() => auth.setIdentityRefresher(null));
  const calls = [];
  const result = await vision.analyze(identity,
    [{ mimeType: 'image/png', data: Buffer.from('png').toString('base64') }], '', 1000,
    async (_url, options) => {
      calls.push(options.headers);
      return { ok: false, status: 401, json: async () => ({ detail: 'expired' }) };
    });
  assert.equal(result.ok, false);
  assert.match(result.reason, /重新登录/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].Authorization, 'Device ' + identity.session);
  assert.equal(calls[0]['X-Soduwork-Secret'], undefined);
});

test('401 without a fallback secret gives an actionable reason, not a bare status code', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const result = await vision.analyze(
    { hub: 'http://hub', clientId: 'c1', session: 'stale-ticket' },
    [{ mimeType: 'image/png', data: Buffer.from('png').toString('base64') }],
    '', 1000, fakeFetch);
  assert.equal(result.ok, false);
  assert.match(result.reason, /重新登录/);
});
