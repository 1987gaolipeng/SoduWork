'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const imageModel = require('../main/pi-session/image-model');
const modelConfig = require('../main/pi-session/model-config');
const { generate } = require('../main/pi-session/image-turn');
const media = require('../main/pi-session/media-artifacts');
const delivery = require('../main/conversation/delivery-contract');

test('personal image selection is qualified by provider and uses the media catalog', async () => {
  const key = imageModel.imageKey({ providerId: 'personal', name: 'same-name' });
  const calls = [];
  const result = await modelConfig.fetchSelection({ hub: 'https://hub.test', clientId: 'c', session: 'device-ticket' }, key, 8000,
    async (url, options) => {
      calls.push({ url, options });
      return Response.json({ key: 'short-lived-proxy', models: { image: [
        { providerId: 'org', name: 'same-name', label: '共享图片模型' },
        { providerId: 'personal', name: 'same-name', label: '我的图片模型' },
      ] } });
    });
  assert.equal(result.ok, true); assert.equal(result.model.providerId, 'personal');
  assert.equal(result.model.modality, 'image');
  assert.equal(calls[0].url, 'https://hub.test/api/v1/ai-proxy/media/config');
  assert.equal(calls[0].options.headers.Authorization, 'Device device-ticket');
  assert.equal(imageModel.imageChoice('normal-text-model'), null);
  assert.equal((await modelConfig.fetchModel({ hub: 'https://hub.test', clientId: 'c', session: 'device-ticket' }, key)).ok, false);
});

test('removed image models fail closed instead of switching to the first model', async () => {
  const value = await imageModel.resolve({ hub: 'https://hub.test', session: 'ticket' },
    imageModel.imageKey({ providerId: 'removed', name: 'same-name' }),
    async () => Response.json({ key: 'short-lived', models: { image: [{ providerId: 'other', name: 'same-name' }] } }));
  assert.equal(value.ok, false);
});

test('an older Hub reports upgrade needed without retrying a billable POST', async () => {
  const messages = [], tools = [], events = []; let calls = 0;
  const value = await generate({
    handle: { sessionId: 'stable', cwd: os.tmpdir(), appendTaskMessage: (...a) => messages.push(a), appendTaskTool: e => tools.push(e) },
    identity: { hub: 'https://hub.test', session: 'ticket' },
    choice: imageModel.imageKey({ providerId: 'mine', name: 'model' }), text: 'poster', submissionId: 'same-turn',
    signal: new AbortController().signal, push: e => events.push(e), emit() {},
    fetchImpl: async () => { calls++; return new Response('', { status: 404 }); },
  });
  assert.equal(value.ok, false); assert.equal(value.retrySafe, false); assert.equal(calls, 1);
  assert.match(value.reason, /更新服务端/);
  assert.equal(messages[0][0], 'user'); assert.equal(messages[1][0], 'assistant');
  assert.equal(tools.at(-1).isError, true); assert.equal(events.at(-1).type, 'agent_settled');
});

test('cancelled image generation preserves an honest transcript and never resubmits', async () => {
  const controller = new AbortController(), messages = []; let calls = 0;
  const value = await generate({
    handle: { sessionId: 'stable', cwd: os.tmpdir(), appendTaskMessage: (...a) => messages.push(a), appendTaskTool() {} },
    identity: { hub: 'https://hub.test', session: 'ticket' },
    choice: imageModel.imageKey({ providerId: 'mine', name: 'model' }), text: 'poster',
    signal: controller.signal, push() {}, emit() {},
    fetchImpl: async () => { calls++; controller.abort(); throw new DOMException('Aborted', 'AbortError'); },
  });
  assert.equal(value.cancelled, true); assert.equal(calls, 1);
  assert.match(messages.at(-1)[1], /可能仍在模型服务处理/);
});

test('image tool envelope, filename and persisted delivery index work without exposing arbitrary workspace images', () => {
  const artifact = { kind: 'image', attachmentId: 'image-12345678', mimeType: 'image/png', filename: 'cover.png',
    url: '/api/v1/attachments/image-12345678?ticket=short-lived', size: 12 };
  const extracted = media.fromToolEvent({ type: 'tool_execution_end', result: { content: [{ type: 'text',
    text: JSON.stringify({ server: 'soduwork-media', tool: 'generate_image', result: { ok: true, artifact } }) }] } });
  assert.deepEqual(extracted, artifact);
  assert.equal(media._safeFilename('../image.exe', 'image/webp'), 'image.webp');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-image-index-'));
  try {
    fs.mkdirSync(path.join(cwd, 'outputs'));
    fs.writeFileSync(path.join(cwd, 'outputs', '.soduwork-media-index.json'), JSON.stringify({
      'https://hub.test:image-12345678': 'cover.png', malicious: '../../elsewhere.png',
    }));
    const files = [{ relative: 'outputs/cover.png', name: 'cover.png', path: path.join(cwd, 'outputs', 'cover.png') },
      { relative: 'assets/logo.png', name: 'logo.png', path: path.join(cwd, 'assets', 'logo.png') }];
    const result = delivery.classify(cwd, files);
    assert.equal(result.items.length, 1); assert.equal(result.items[0].relative, 'outputs/cover.png');
    assert.equal(result.items[0].primary, true);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('stopping an image turn also cancels its attachment download', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-image-abort-'));
  const controller = new AbortController();
  try {
    await assert.rejects(media.materialize({ kind: 'image', attachmentId: 'image-12345678', mimeType: 'image/png',
      filename: 'cover.png', url: '/api/v1/attachments/image-12345678?ticket=short-lived', size: 12 },
    { hub: 'https://hub.test' }, cwd, async (_url, { signal }) => {
      controller.abort(); signal.throwIfAborted();
    }, controller.signal), error => error.name === 'AbortError');
    assert.deepEqual(fs.readdirSync(path.join(cwd, 'outputs')), []);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
