'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
test('an early H5 submission waits for desk identity hydration and then sends once without consuming composer draft', async () => {
  const handlers = {}, listeners = {}, calls = [];
  const workPreview = { composerHello() {}, onComposerSession() {}, onComposerPut() {},
    onComposerSubmit(fn) { handlers.submit = fn; }, onComposerMode() {},
    composerSubmitResult: async result => calls.push(['receipt', result]), composerSent() {} };
  const window = { __deskPanel: 'chatbar', soduWorkAPI: { workPreview },
    NativeChat: { send: async (text, options) => { calls.push(['send', text, options]); return true; }, sessionInfo: () => ({ ref: '' }) },
    addEventListener: (name, fn) => { listeners[name] = fn; } };
  const sandbox = { window, NativeChat: window.NativeChat, document: { readyState: 'loading', addEventListener() {} },
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, Promise };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../components/panels/chatbar-embed.js'), 'utf8'), sandbox);
  const pending = handlers.submit({ id: 'early', text: '生成便签' });
  await Promise.resolve(); assert.deepEqual(calls, []);
  listeners['soduwork-chatbar-ready'](); await pending;
  assert.equal(calls[0][0], 'send'); assert.equal(calls[0][1], '生成便签');
  assert.equal(calls[0][2].useComposer, false);
  assert.equal(calls[1][0], 'receipt'); assert.equal(calls[1][1].ok, true);
});

function pageComposer(nativeChat) {
  let submit;
  const receipts = [];
  const workPreview = { composerHello() {}, onComposerSession() {}, onComposerPut() {}, onComposerMode() {},
    onComposerSubmit(fn) { submit = fn; }, composerSubmitResult(result) { receipts.push(result); }, composerSent() {} };
  const window = { __deskPanel: 'chatbar', __soduWorkChatbarReady: true, soduWorkAPI: { workPreview },
    NativeChat: nativeChat, addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../components/panels/chatbar-embed.js'), 'utf8'), {
    window, NativeChat: nativeChat, document: { readyState: 'loading', addEventListener() {} },
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, Promise,
  });
  return { submit, receipts };
}

test('busy page sends open another topic, keep the old run and draft, and forward only page attachments', async () => {
  const old = { running: true, draft: '尚未发送的补充', attachments: ['draft.png'] };
  let selected = old, resets = 0;
  const native = { isBusy: () => selected.running, reset() { resets++; selected = {}; }, prepare() {},
    async send(text, options) { selected.text = text; selected.options = options; selected.running = true; return true; } };
  const { submit, receipts } = pageComposer(native);
  await submit({ id: 'page-1', text: '处理另一条记录', attachments: [{ name: 'page.pdf', path: 'fixture' }] });
  assert.equal(resets, 1);
  assert.deepEqual(old, { running: true, draft: '尚未发送的补充', attachments: ['draft.png'] });
  assert.equal(selected.text, '处理另一条记录');
  assert.equal(selected.options.useComposer, false);
  assert.equal(selected.options.attachments[0].name, 'page.pdf');
  assert.equal(receipts[0].ok, true);
});

test('idle page sends reuse the selected topic and report rejection without creating another', async () => {
  let resets = 0, sends = 0;
  const native = { isBusy: () => false, reset() { resets++; }, prepare() {}, async send() { sends++; return false; } };
  const { submit, receipts } = pageComposer(native);
  await submit({ id: 'rejected', text: '提交' });
  assert.equal(resets, 0); assert.equal(sends, 1);
  assert.equal(receipts[0].ok, false); assert.match(receipts[0].reason, /发送未被接受/);
});

test('rapid page submissions wait only for admission and choose separate topics while execution continues', async () => {
  let busy = false, topic = 0, admit;
  const sent = [], native = { isBusy: () => busy, reset() { topic++; busy = false; }, prepare() {},
    async send(text) { sent.push({ text, topic }); busy = true; if (text === 'first') await new Promise(resolve => { admit = resolve; }); return true; } };
  const { submit, receipts } = pageComposer(native);
  const first = submit({ id: '1', text: 'first' });
  const second = submit({ id: '2', text: 'second' });
  while (!admit) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, [{ text: 'first', topic: 0 }]);
  admit(); await Promise.all([first, second]);
  assert.deepEqual(sent, [{ text: 'first', topic: 0 }, { text: 'second', topic: 1 }]);
  assert.equal(receipts.length, 2); assert.ok(receipts.every(row => row.ok));
});

test('failed topic preparation returns a failed receipt and later submissions remain usable', async () => {
  let busy = true, sends = 0;
  const native = { isBusy: () => busy, reset() { throw Error('话题切换失败'); }, prepare() {}, async send() { sends++; return true; } };
  const { submit, receipts } = pageComposer(native);
  await submit({ id: 'failure', text: 'first' });
  assert.equal(receipts[0].ok, false); assert.match(receipts[0].reason, /话题切换失败/); assert.equal(sends, 0);
  busy = false;
  await submit({ id: 'retry', text: 'second' });
  assert.equal(receipts[1].ok, true); assert.equal(sends, 1);
});
