'use strict';
/*
 * Load production chat and draft-recovery modules to verify unsent drafts survive sidebar
 * navigation from A to B and back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeGlobals, stubGlobals } = require('./fixture/chat-draft-harness.cjs');

const ROOT = path.join(__dirname, '..');

function loadChat(scripts, env) {
  const ctx = makeGlobals();
  stubGlobals(ctx.g, env || {});
  env?.setup?.(ctx.g);
  ctx.g.window = ctx.g;
  // Provide shared globals for unqualified identifiers used by panels-chat.
  for (const key of Object.keys(ctx.g)) {
    if (key === 'require' || key === 'setTimeout' || key === 'clearTimeout') continue;
    try { Object.defineProperty(globalThis, key, { value: ctx.g[key], configurable: true, writable: true }); } catch (_) {}
  }
  for (const file of scripts) {
    // Components initialize through window-bound module wrappers.
    new Function('window', require('node:fs').readFileSync(path.join(ROOT, file), 'utf8'))(ctx.g);
  }
  return ctx;
}

function boot(env) {
  return loadChat([
    'components/panels/chat-draft-recovery.js',
    'components/panels/chat-composer-bindings.js',
    'components/panels/chat-session-controller.js',
    'components/panels/panels-chat.js',
  ], env);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makePiSession() {
  // Return a live handle whose local session ID matches chatId.
  const opened = [];
  const listeners = new Set();
  return {
    opened,
    open(opts) {
      const id = String((opts && opts.chatId) || ('fresh-' + Math.random().toString(36).slice(2, 8)));
      opened.push(id);
      return Promise.resolve({ ok: true, ref: 'ref-' + id, sessionId: id, snapshot: { messages: [] } });
    },
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    snapshot() { return Promise.resolve({ ok: true, snapshot: { messages: [] } }); },
    release() { return Promise.resolve({ ok: true }); },
    history() { return Promise.resolve({ ok: true, chats: [] }); },
  };
}

async function typeInto(input, text) {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

test('A→B→A 切换保留草稿（本地会话同 id）', async () => {
  const pi = makePiSession();
  const ctx = boot({ piSession: pi });
  const NativeChat = ctx.g.NativeChat;
  assert.ok(NativeChat, 'NativeChat 应已加载');

  // Open conversation A from the sidebar without initial text.
  assert.equal(await NativeChat.enter('', 'sess-A'), true);
  await sleep(30);
  const input = ctx.document.getElementById('nchatInput');
  assert.ok(input, '输入框存在');
  // Enter unsent text in A.
  await typeInto(input, '帮我把周报整理成表格');
  await sleep(10);

  // Switch to B.
  assert.equal(await NativeChat.enter('', 'sess-B'), true);
  await sleep(30);
  const inputB = ctx.document.getElementById('nchatInput');
  // Enter unsent text in B.
  await typeInto(inputB, 'B 会话里的内容');

  // Return to A and restore its draft.
  assert.equal(await NativeChat.enter('', 'sess-A'), true);
  await sleep(30);
  const inputA = ctx.document.getElementById('nchatInput');
  assert.equal(inputA.value, '帮我把周报整理成表格', '切回 A 后草稿应保留');
});

test('A→B→A 切换保留草稿（打开较慢的历史会话）', async () => {
  const pi = makePiSession();
  // Delay opening A to simulate typing before initialization completes.
  const rawOpen = pi.open.bind(pi);
  pi.open = (opts) => sleep(120).then(() => rawOpen(opts));
  const ctx = boot({ piSession: pi });
  const NativeChat = ctx.g.NativeChat;

  assert.equal(await NativeChat.enter('', 'hist-A'), true);
  await sleep(200);
  const input = ctx.document.getElementById('nchatInput');
  await typeInto(input, '慢会话里的草稿');
  await sleep(10);

  await NativeChat.enter('', 'hist-B');
  await sleep(30);
  const inputB = ctx.document.getElementById('nchatInput');
  await typeInto(inputB, 'B 的内容');

  await NativeChat.enter('', 'hist-A');
  await sleep(200);
  assert.equal(ctx.document.getElementById('nchatInput').value, '慢会话里的草稿',
    '打开慢的会话切回后草稿也应保留');
});

test('A 未打开完成就切走，再切回仍保留输入', async () => {
  const pi = makePiSession();
  const rawOpen = pi.open.bind(pi);
  pi.open = (opts) => sleep(400).then(() => rawOpen(opts));
  const ctx = boot({ piSession: pi });
  const NativeChat = ctx.g.NativeChat;

  const pA = NativeChat.enter('', 'slow-A');
  await sleep(50); // Opening is still pending.
  const input = ctx.document.getElementById('nchatInput');
  await typeInto(input, '还没打开完就打字');
  // Switch to B before A finishes opening.
  const pB = NativeChat.enter('', 'slow-B');
  await sleep(30);
  await typeInto(ctx.document.getElementById('nchatInput'), 'B 内容');
  await Promise.all([pA, pB]);
  await sleep(30);
  // Return to A.
  await NativeChat.enter('', 'slow-A');
  await sleep(450);
  assert.equal(ctx.document.getElementById('nchatInput').value, '还没打开完就打字',
    '未打开完就切走，草稿不应丢');
});

/* Regression cases for observed draft loss. */

function makeHubSession() {
  // Hub and cloud conversations may have different public chatId and runtime sessionId values.
  const opened = [];
  const listeners = new Set();
  return {
    opened,
    open(opts) {
      const chatId = String((opts && opts.chatId) || '');
      const id = chatId ? 'pi-' + chatId.replace(/^[^a-z]+/i, '') : ('fresh-' + Math.random().toString(36).slice(2, 8));
      opened.push(chatId);
      return Promise.resolve({ ok: true, ref: 'ref-' + id, sessionId: id, snapshot: { messages: [] } });
    },
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    snapshot() { return Promise.resolve({ ok: true, snapshot: { messages: [] } }); },
    release() { return Promise.resolve({ ok: true }); },
    history() { return Promise.resolve({ ok: true, chats: [] }); },
  };
}

test('hub 会话（chatId≠sessionId）直接 A→B→A 草稿保留', async () => {
  const pi = makeHubSession();
  const ctx = boot({ piSession: pi });
  const NativeChat = ctx.g.NativeChat;

  assert.equal(await NativeChat.enter('', 'conv-A'), true);
  await sleep(30);
  await typeInto(ctx.document.getElementById('nchatInput'), 'hub 会话里的草稿');
  await sleep(10);

  await NativeChat.enter('', 'conv-B');
  await sleep(30);
  await typeInto(ctx.document.getElementById('nchatInput'), 'B 内容');

  await NativeChat.enter('', 'conv-A');
  await sleep(30);
  assert.equal(ctx.document.getElementById('nchatInput').value, 'hub 会话里的草稿',
    'hub 会话切换往返草稿应保留');
});

test('hub 会话经过一次 tab 往返（enter 空串）后再切回，草稿不丢', async () => {
  const pi = makeHubSession();
  const ctx = boot({ piSession: pi });
  const NativeChat = ctx.g.NativeChat;

  assert.equal(await NativeChat.enter('', 'conv-A'), true);
  await sleep(30);
  const input = ctx.document.getElementById('nchatInput');
  await typeInto(input, 'tab 往返前的草稿');
  await sleep(10);

  // Reenter the conversation tab after visiting another page.
  NativeChat.enter('');
  await sleep(30);
  // Switch to B and back to A through its public sidebar identity.
  await NativeChat.enter('', 'conv-B');
  await sleep(30);
  await typeInto(ctx.document.getElementById('nchatInput'), 'B 内容');
  await NativeChat.enter('', 'conv-A');
  await sleep(30);
  assert.equal(ctx.document.getElementById('nchatInput').value, 'tab 往返前的草稿',
    'tab 往返不得让草稿失联');
});

test('云交接以 sessionId 重入后，从侧栏原行切回草稿不丢', async () => {
  const pi = makeHubSession();
  const ctx = boot({ piSession: pi });
  const NativeChat = ctx.g.NativeChat;

  // Open from the sidebar and enter a draft.
  assert.equal(await NativeChat.enter('', 'conv-A'), true);
  await sleep(30);
  await typeInto(ctx.document.getElementById('nchatInput'), '云交接前的草稿');
  await sleep(10);
  // Reenter the same conversation through its runtime session ID.
  await NativeChat.enter('', 'pi-conv-A');
  await sleep(30);
  // Return through the original sidebar row.
  await NativeChat.enter('', 'conv-A');
  await sleep(30);
  assert.equal(ctx.document.getElementById('nchatInput').value, '云交接前的草稿',
    'sessionId 重入后原行切回，草稿应保留');
});

test('会话尚未打开就切走，附件、插件参数、技能都随正文恢复', async () => {
  const pi = makePiSession(), open = pi.open.bind(pi), controls = {};
  let finishA;
  pi.open = opts => opts.chatId === 'pending-a' && !finishA
    ? new Promise(resolve => { finishA = () => open(opts).then(resolve); }) : open(opts);
  const ctx = boot({ piSession: pi, setup(g) {
    g.ComposeSkills = { create(opts) {
      let names = [];
      return controls.skills = { selected: () => names,
        restore(value) { names = value.slice(); opts.onChange(names); },
        setError() {}, setLoading() {}, setItems() {}, clear() { names = []; opts.onChange(names); } };
    } };
    g.ChatPluginMention = { create(opts) {
      let rows = [];
      return controls.plugins = { selected: () => rows, draft: () => rows,
        restore(value) { rows = value; opts.onChange(); }, refresh() {}, destroy() {},
        clear() { rows = []; opts.onChange(); } };
    } };
    g.ConversationAttachments = { create(opts) {
      let files = [];
      return controls.attachments = { files: () => files,
        add(value) { files.push(...value); opts.onChange(); },
        clear() { files = []; opts.onChange(); } };
    } };
    // Production page-annotation binding also emits synchronous input changes during mount.
    g.ChatWorkbenchAnnotations.bind = el => el.querySelector('#nchatInput').dispatchEvent(new Event('input'));
  } });
  const pending = ctx.g.NativeChat.enter('', 'pending-a');
  await sleep(0);
  await typeInto(ctx.document.getElementById('nchatInput'), '尚未打开的会话草稿');
  controls.plugins.restore([{ pluginId: 'draft-a', inputValues: { roomId: 'private-room' } }]);
  controls.skills.restore(['report']);
  const file = { name: 'pending.png', type: 'image/png', size: 8 };
  controls.attachments.add([file]);
  await ctx.g.NativeChat.enter('', 'other-b');
  finishA(); assert.equal(await pending, false);
  await ctx.g.NativeChat.enter('', 'pending-a');
  assert.equal(ctx.document.getElementById('nchatInput').value, '尚未打开的会话草稿');
  assert.equal(controls.attachments.files()[0], file);
  assert.deepEqual(controls.plugins.draft()[0].inputValues, { roomId: 'private-room' });
  assert.deepEqual(controls.skills.selected(), ['report']);
  ctx.g.NativeChat.reset();
});
