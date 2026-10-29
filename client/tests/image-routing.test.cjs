'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const routing = require('../main/pi-session/image-routing');

const image = { type: 'image', mimeType: 'image/png', data: 'cGl4ZWxz' };
function history() {
  return [{ role: 'user', content: 'Read screenshot.png', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'read_1', name: 'read', arguments: { path: 'screenshot.png' } }],
      api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'toolUse', timestamp: 2 },
    { role: 'toolResult', toolCallId: 'read_1', toolName: 'read', content: [{ ...image }], isError: false, timestamp: 3 },
    { role: 'user', content: 'Describe that screenshot again', timestamp: 4 }];
}

test('real SDK history image omission is blocked before conversion after switching to a text-only model', async () => {
  const chunks = path.resolve(__dirname, '../node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks');
  const file = fs.readdirSync(chunks).find(name => /^openai-completions-.*\.js$/.test(name));
  assert.ok(file, 'the installed real SDK must expose its OpenAI converter');
  const { convertMessages } = await import(pathToFileURL(path.join(chunks, file)).href);
  const messages = history(), original = JSON.stringify(messages);
  const model = { id: 'fixture', provider: 'fixture', api: 'openai-completions', input: ['text'], imageRouting: 'vision-fallback' };
  // Pure conversion only: no HTTP service or model invocation is created.
  const unsafe = convertMessages(model, { messages }, {});
  assert.doesNotMatch(JSON.stringify(unsafe), /data:image/);
  assert.match(JSON.stringify(unsafe), /image omitted/);
  let conversions = 0;
  assert.throws(() => {
    routing.observationInputs(model, [], messages);
    conversions++; convertMessages(model, { messages }, {});
  }, /原图已保留.*未自动更换模型/);
  assert.equal(conversions, 0);
  assert.equal(JSON.stringify(messages), original);
  const native = { ...model, input: ['text', 'image'], imageRouting: 'native' };
  assert.deepEqual(routing.observationInputs(native, [], messages), []);
  assert.match(JSON.stringify(convertMessages(native, { messages }, {})), /data:image\/png;base64,cGl4ZWxz/);
});

test('explicit image adapters receive deduplicated current and historical pixels without mutating history', () => {
  const messages = history(), original = JSON.stringify(messages);
  messages.push({ role: 'user', content: [{ ...image }] });
  const before = JSON.stringify(messages);
  const model = { input: ['text'], imageRouting: 'vision-fallback', visionFallbackAvailable: true };
  const second = { ...image, data: 'bmV3IHBpeGVscw==' };
  assert.deepEqual(routing.observationInputs(model, [{ ...image }, second], messages), [image, second]);
  assert.equal(JSON.stringify(messages), before);
  assert.equal(JSON.stringify(messages.slice(0, -1)), original);
  assert.deepEqual(routing.observationInputs({ input: ['text'] }, [], [{ role: 'user', content: 'plain text' }]), []);
});

test('a pure-text follow-up may omit historical images explicitly, while new images still require vision', () => {
  const model = { input:['text'], imageRouting:'vision-fallback' };
  const messages = history(), before = JSON.stringify(messages);
  assert.deepEqual(routing.observationInputs(model, [], messages, {allowHistoryOmission:true}), []);
  assert.match(routing.historyNotice(model, [], messages), /没有读取这些图片.*本轮文字继续/);
  assert.throws(() => routing.observationInputs(model, [image], messages, {allowHistoryOmission:true}), /原图已保留/);
  assert.equal(routing.historyNotice(model, [image], messages), '');
  assert.match(routing.historyNotice({...model,visionFallbackAvailable:true}, [], messages), /没有读取这些图片/);
  assert.deepEqual(routing.observationInputs({...model,visionFallbackAvailable:true}, [], messages,
    {allowHistoryOmission:true}), [], 'ordinary follow-ups do not retry an old visual observation');
  assert.equal(routing.historyNotice({...model,input:['text','image'],imageRouting:'native'}, [], messages), '');
  assert.equal(JSON.stringify(messages), before);
});
