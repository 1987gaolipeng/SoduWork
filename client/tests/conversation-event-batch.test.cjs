'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { makeGlobals, stubGlobals } = require('./fixture/chat-draft-harness.cjs');

test('NativeChat consumes ordered batches once for output/history/proposal work and ignores stale refs', async () => {
  const calls = { outputs: 0, history: 0, proposals: 0, settled: 0 }, statuses = [];
  let subscriber, activeContext;
  const api = {
    open: async () => ({ ok: true, ref: 'active-ref', sessionId: 'active', snapshot: { status: 'streaming', messages: [] } }),
    onEvent() { throw Error('batched API should be selected'); },
    onEventBatch(fn) { subscriber = fn; return () => { subscriber = null; }; },
    outputs: async () => { calls.outputs++; return { files: [] }; },
    history: async () => { calls.history++; return { ok: true, chats: [] }; },
    release: async () => ({ ok: true }),
  };
  const context = makeGlobals(); stubGlobals(context.g, { piSession: api }); context.g.window = context.g;
  const renderer = context.g.ChatMessageRenderer.create, work = context.g.ChatWorkIntent.create;
  context.g.ChatMessageRenderer.create = ctx => {
    activeContext = ctx;
    return { ...renderer(ctx), _render() { statuses.push(ctx._snap?.status); } };
  };
  context.g.ChatWorkIntent.create = ctx => ({ ...work(ctx), _maybeProposal() { calls.proposals++; } });
  context.g.ChatOutputLinks = { shouldRefresh: event => ['task-message', 'settled'].includes(event.kind),
    load: async (...args) => (await args[0].outputs()).files };
  context.g.ChatDeliveries = { settled() { calls.settled++; } };
  for (const [key, value] of Object.entries(context.g)) {
    if (['require', 'setTimeout', 'clearTimeout'].includes(key)) continue;
    try { Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); } catch (_) {}
  }
  for (const file of ['chat-draft-recovery.js', 'chat-composer-bindings.js', 'chat-session-controller.js', 'panels-chat.js']) {
    new Function('window', fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8'))(context.g);
  }
  try {
    assert.equal(await context.g.NativeChat.enter('', 'active'), true);
    await new Promise(resolve => setTimeout(resolve, 20));
    for (const key of Object.keys(calls)) calls[key] = 0;
    const snapshot = { status: 'idle', messages: [{ role: 'assistant', blocks: [{ kind: 'text', text: 'Synthetic answer' }] }] };
    subscriber({ ref: 'active-ref', snapshot, events: [...Array.from({ length: 30 }, () => ({ kind: 'task-message' })),
      { kind: 'error', reason: 'Synthetic failure' }, { kind: 'settled' }] });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(calls, { outputs: 1, history: 1, proposals: 1, settled: 1 });
    assert.ok(statuses.includes('unreachable'), 'the error event is applied before the settled state');
    assert.equal(activeContext._snap, snapshot);
    assert.equal(statuses.at(-1), 'idle');
    subscriber({ ref: 'old-ref', snapshot, events: [{ kind: 'settled' }] });
    assert.deepEqual(calls, { outputs: 1, history: 1, proposals: 1, settled: 1 });
  } finally { context.g.NativeChat.reset(); }
});
