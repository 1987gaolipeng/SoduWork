'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const os = require('node:os');
const messages = require('../main/agent-runtime/runner-messages');
const catalog = require('../main/agent-runtime/runtime-catalog');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails } = require('../main/agent-runtime/runner-adapter');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const kind of ['text', 'say', 'thinking']) test('Codex ' + kind + ' hides split diagnostics without losing the answer', () => {
  const state = { messages: [], adapterId: 'codex-harness' }, view = messages.create(state);
  const warning = 'Warning: Model metadata for `private-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.';
  for (const text of warning) {
    view.apply({ kind, streamId: 'warning', delta: true }, text);
    assert.equal(state.messages.length, 0, 'diagnostic prefixes never flash in chat');
  }
  view.apply({ kind, streamId: 'warning', delta: true }, '\n\nReport ');
  view.apply({ kind, streamId: 'warning', delta: true }, 'ready.');
  view.apply({ kind, streamId: 'warning', done: true }, '');
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].blocks[0].text, 'Report ready.');
  assert.equal(state.messages[0].done, true);
  view.finish();
  view.apply({ kind, streamId: 'warning', delta: true, done: true }, 'Next turn');
  assert.equal(state.messages.at(-1).blocks[0].text, 'Next turn');
});

test('diagnostic filtering preserves unrelated warnings, quoted logs and other runtimes', () => {
  const warning = 'Warning: Model metadata for `private-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.';
  for (const [adapterId, text] of [['codex', 'Warning: destructive command'], ['codex-harness', 'Quoted log:\n' + warning], ['qwen', warning]]) {
    const state = { messages: [], adapterId }, view = messages.create(state);
    for (const chunk of text) view.apply({ kind: 'text', streamId: 'reply', delta: true }, chunk);
    view.apply({ kind: 'text', streamId: 'reply', done: true }, '');
    assert.equal(state.messages[0].blocks[0].text, text);
  }
});

test('terminal completion flushes ambiguous prefixes and keeps exact diagnostics hidden', () => {
  for (const kind of ['text', 'thinking']) {
    const state = { messages: [], adapterId: 'codex-harness' }, view = messages.create(state);
    view.apply({ kind, streamId: 'short', delta: true }, 'Warning:');
    assert.equal(state.messages.length, 0);
    view.finish(1720000000000);
    assert.equal(state.messages[0].blocks[0].text, 'Warning:');
    assert.equal(state.messages[0].blocks[0].kind, kind);
    assert.equal(state.messages[0].done, true);
    assert.equal(state.messages[0].completedAt, 1720000000000);
  }
  const state = { messages: [], adapterId: 'codex' }, view = messages.create(state);
  view.apply({ kind: 'text', streamId: 'warning' }, 'Warning: Model metadata for `private-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.');
  view.finish();
  assert.equal(state.messages.length, 0);
});

test('archived Codex streamed warnings stay hidden across history pages', async t => {
  let polls = 0;
  const warning = 'Warning: Model metadata for `private-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.';
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime('codex-harness'),
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
    runnerRuntime: { async rpc(op, payload) {
      if (op === 'job.session' && payload.limit === 1) return { ok: true, data: { status: 'done' } };
      if (op === 'job.session') return { ok: true, data: { status: 'done', seq: 4, items: ++polls === 1 ? [
        { seq: 1, kind: 'user', text: 'Create a report' },
        { seq: 2, kind: 'text', streamId: 'reply', text: warning.slice(0, 60), delta: true },
      ] : [
        { seq: 3, kind: 'text', streamId: 'reply', text: warning.slice(60), delta: true },
        { seq: 4, kind: 'text', streamId: 'reply', text: '\n\nReport ready.', delta: true, done: true },
      ] } };
      return { ok: true, data: {} };
    } }
  });
  const session = await adapter.resumeSession({ native: { runner: { openOptions: { cwd: os.tmpdir(), resumePath: 'archived-diagnostic' } } } });
  t.after(() => session.dispose());
  await until(() => session.snapshot().status === 'idle');
  assert.equal(polls, 2);
  assert.deepEqual(session.snapshot().messages.map(message => message.text || message.blocks[0].text), ['Create a report', 'Report ready.']);
});
async function until(check) { for (let i = 0; i < 300; i++) { if (check()) return; await delay(10); } throw Error('Timeout'); }
test('Harness2 raw and bounded snapshots preserve separate completed-turn token receipts after reopening', async t => {
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime('harness2'),
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
    runnerRuntime: { async rpc(op) {
      if (op === 'job.session') return { ok: true, data: { status: 'done', usage: { output: 9999 }, tokens: { input: 3000 }, items: [
        { seq: 1, kind: 'user', text: 'first', at: 1000 },
        { seq: 2, kind: 'say', text: 'first answer', at: 2000 },
        { seq: 3, kind: 'usage', usageScope: 'turn', usage: { input: 50, output: 13 }, at: 2000 },
        { seq: 4, kind: 'user', text: 'second', at: 3000 },
        { seq: 5, kind: 'say', text: 'second answer', at: 4000 },
        { seq: 6, kind: 'usage', usageScope: 'turn', usage: { input: 60, output: 21 }, at: 4000 },
      ] } };
      return { ok: true, data: {} };
    } }
  });
  const open = async () => {
    const session = await adapter.resumeSession({ native: { runner: { openOptions: { cwd: os.tmpdir(), resumePath: 'turn-token-fixture' } } } });
    t.after(() => session.dispose());
    await until(() => session.snapshot().status === 'idle');
    return session;
  };
  const session = await open(), snapshot = session.snapshot();
  assert.deepEqual(snapshot.turnMetrics.map(row => row.tokens), [13, 21]);
  assert.equal(session.snapshot().turnMetrics, snapshot.turnMetrics, 'unchanged token snapshots reuse settled receipt aggregation');
  const handle = getRunnerSessionDetails(session).handle;
  assert.deepEqual(handle.uiSnapshot({ messageLimit: 1 }).turnMetrics.map(row => row.tokens), [13, 21]);
  assert.deepEqual((await open()).snapshot().turnMetrics, snapshot.turnMetrics);
  assert.equal(snapshot.usage.output, 9999, 'cumulative billing remains separate from output display');
});
test('native reasoning snapshots update, repeated deltas stay and final snapshot does not duplicate', () => {
  const state = { messages: [], round: 1 };
  const view = messages.create(state);
  view.apply({ kind: 'thinking', streamId: 'r', done: false }, 'one');
  view.apply({ kind: 'thinking', streamId: 'r', done: false }, 'one two');
  assert.equal(state.messages.length, 1); assert.equal(state.messages[0].done, false);
  assert.equal(state.messages[0].blocks[0].done, false);
  view.apply({ kind: 'thinking', streamId: 'r', delta: true, done: false }, ' two');
  view.apply({ kind: 'thinking', streamId: 'r', done: true }, 'one two two');
  assert.equal(state.messages[0].blocks[0].text, 'one two two');
  assert.equal(state.messages[0].done, true);
  assert.equal(state.messages[0].blocks[0].done, true);
  view.apply({ kind: 'thinking', streamId: 'r', done: true }, '');
  assert.equal(state.messages[0].blocks[0].text, 'one two two', 'completion-only event preserves exposed reasoning');
  view.finish();
  view.apply({ kind: 'thinking', streamId: 'r', done: false }, 'next turn');
  assert.equal(state.messages.length, 2);
  view.finish();
  assert.equal(state.messages[1].blocks[0].done, true, 'terminal snapshot closes the same shared reasoning block');
});
test('ACP text deltas render immediately and settle the same assistant block', () => {
  const state = { messages: [], round: 1 };
  const view = messages.create(state);
  view.apply({ kind: 'text', streamId: 'acp:m1', delta: true, done: false }, 'Hello');
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].blocks[0].text, 'Hello');
  assert.equal(state.messages[0].done, false);
  view.apply({ kind: 'text', streamId: 'acp:m1', delta: true, done: false }, ' world');
  assert.equal(state.messages[0].blocks[0].text, 'Hello world');
  view.apply({ kind: 'text', streamId: 'acp:m1', delta: true, done: true }, '');
  assert.equal(state.messages[0].blocks[0].text, 'Hello world');
  assert.equal(state.messages[0].done, true);
  assert.equal(state.messages[0].blocks[0].done, true);
});

for (const adapterId of ['harness2', 'opencode']) test(adapterId + ' publishes closed activity in its first terminal snapshot', async t => {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime(adapterId),
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
    runnerRuntime: { async rpc(op, payload) {
      if (op === 'job.session' && payload.limit === 1) return { ok: true, data: { status: 'done' } };
      if (op === 'job.session') {
        await ready;
        return { ok: true, data: { status: 'done', items: [
          { seq: 1, kind: 'user', text: 'make a report' },
          { seq: 2, kind: 'thinking', streamId: 'acp:thought:1', text: 'checking', done: false },
          { seq: 3, kind: 'do', tool: 'Plan', text: 'prepare report' },
          { seq: 4, kind: 'do', tool: 'Run command', callId: 'failed' },
          { seq: 5, kind: 'out', callId: 'failed', text: 'validation failed', isError: true },
          { seq: 6, kind: 'text', streamId: 'acp:message:1', text: 'report ready', done: true },
        ] } };
      }
      return { ok: true, data: {} };
    } }
  });
  const session = await adapter.resumeSession({ native: { runner: { openOptions: {
    cwd: os.tmpdir(), resumePath: 'terminal-view-' + adapterId,
  } } } });
  t.after(() => { release(); return session.dispose(); });
  const handle = getRunnerSessionDetails(session).handle, frames = [];
  handle.on((event, snapshot) => { if (event.kind === 'settled') frames.push(snapshot); });
  release();
  await until(() => frames.length);
  const first = frames[0];
  assert.equal(first.status, 'idle');
  assert.deepEqual(first.tools.map(tool => tool.state), ['done', 'error'],
    'the renderer must never receive a terminal snapshot containing running tools');
  assert.equal(first.messages.find(message => message.blocks?.[0]?.kind === 'thinking').blocks[0].done, true);
});
test('authoritative usage covers thought/text once and turn aggregate replaces earlier step billing', () => {
  const state = { messages: [{ role: 'user', text: 'first' }], round: 1 }, view = messages.create(state);
  view.apply({ kind: 'thinking', streamId: 'r' }, 'thought');
  state.messages.push({ role: 'assistant', blocks: [{ kind: 'text', text: 'answer' }], done: true });
  view.apply({ kind: 'usage', usageScope: 'message', usage: { input: 30, output: 10, reasoning: 4 } });
  assert.equal(state.messages[1].usage.totalTokens, 0); assert.equal(state.messages[1].done, true);
  assert.equal(state.messages[2].usage.totalTokens, 40);
  state.messages.push({ role: 'assistant', blocks: [{ kind: 'text', text: 'more' }], done: true });
  view.apply({ kind: 'usage', usageScope: 'step', usage: { input: 40, output: 20 } });
  assert.equal(state.messages.reduce((n, m) => n + (m.usage?.totalTokens || 0), 0), 100);
  view.apply({ kind: 'usage', usageScope: 'turn', usage: { input: 70, output: 30 } });
  assert.equal(state.messages.reduce((n, m) => n + (m.usage?.totalTokens || 0), 0), 100);
  assert.equal(state.messages.slice(1).every(m => m.usage && m.done), true);
  state.messages.push({ role: 'user', text: 'second' });
  view.apply({ kind: 'usage', usageScope: 'turn', usage: { input: 2, output: 0, reasoning: 3 } });
  assert.equal(state.messages.at(-1).usage.totalTokens, 5);
  assert.equal(state.messages[3].usage.totalTokens, 100);
});
test('unknown cumulative usage is not attached and tool args omit file contents', () => {
  const state = { messages: [], round: 1 }, view = messages.create(state);
  view.apply({ kind: 'usage', usageScope: 'session', usage: { input: 999, output: 99 } });
  assert.equal(state.messages.length, 0);
  assert.deepEqual(view.argumentsOf({ arguments: { filePath: 'report.md', content: 'secret', command: 'cat report.md' } }), { filePath: 'report.md', command: 'cat report.md' });
});
for (const adapterId of ['opencode', 'codex-harness', 'qwen']) test(adapterId + ' live polling preserves native thinking, matching tools and per-turn billing', async t => {
  let phase = 0, polls = 0;
  const base = [
    { seq: 1, kind: 'user', text: 'old', at: new Date(Date.now() - 86400000).toISOString() },
    { seq: 2, kind: 'say', text: 'old response' },
    { seq: 3, kind: 'usage', usageScope: 'turn', usage: { input: 500, output: 50 } },
    { seq: 4, kind: 'user', text: 'current', at: new Date(Date.now() - 1000).toISOString() },
    { seq: 5, kind: 'thinking', streamId: 'r', delta: true, done: false, text: 'One' },
    { seq: 6, kind: 'thinking', streamId: 'r', delta: true, done: false, text: ' more' },
    { seq: 7, kind: 'do', callId: 'a', tool: 'Update report', toolKind: 'edit', text: 'first.md', arguments: { path: 'first.md' } },
    { seq: 8, kind: 'do', callId: 'b', tool: 'bash', text: 'pwd', arguments: { command: 'pwd' } },
    { seq: 9, kind: 'out', callId: 'a', text: 'failed', isError: true }
  ];
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime(adapterId),
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
    runnerRuntime: { async rpc(op) {
      if (op === 'runtime.detect') return { ok: true, data: {} };
      if (op === 'job.session') { polls++;
        return { ok: true, data: { status: phase ? 'done' : 'running', firstStarted: (Date.now() - 86400000) / 1000,
          usage: { input: 99999, output: 1111 }, tokens: { input: 3000 }, items: [...base, ...(phase ? [
            { seq: 10, kind: 'thinking', streamId: 'r', delta: true, done: true, text: '' },
            { seq: 11, kind: 'out', callId: 'b', text: 'workspace' },
            { seq: 12, kind: 'say', text: 'final' },
            { seq: 13, kind: 'usage', usageScope: 'turn', usage: { input: 20, output: 8, reasoning: 5 } }
          ] : [])] } };
      }
      return { ok: true, data: { ok: true } };
    } }
  });
  const session = await adapter.resumeSession({ native: { runner: { openOptions: { cwd: os.tmpdir(), resumePath: 'stream-fixture' } } } });
  t.after(() => session.dispose());
  const handle = getRunnerSessionDetails(session).handle;
  await until(() => handle.snapshot().messages.some(m => m.blocks?.[0]?.kind === 'thinking'));
  const live = handle.snapshot();
  assert.ok(live.messages.filter(m => m.role === 'assistant').every(m => m.sourceAgent.agentId === adapterId));
  assert.ok(live.tools.every(tool => tool.sourceAgent.agentId === adapterId));
  const thought = live.messages.find(m => m.blocks?.[0]?.kind === 'thinking');
  assert.equal(thought.blocks[0].text, 'One more'); assert.equal(thought.done, false);
  assert.equal(live.tools[0].state, 'error'); assert.equal(live.tools[1].state, 'running');
  assert.deepEqual(live.tools[0].args, { path: 'first.md' });
  assert.equal(live.tools[0].toolKind, 'edit');
  assert.ok(live.execution.elapsedMs < 10000, 'must not display a day of session history');
  assert.equal(thought.usage, undefined);
  phase = 1;
  await until(() => handle.snapshot().status === 'idle');
  const final = handle.snapshot();
  assert.ok(final.messages.filter(m => m.role === 'assistant').every(m => m.sourceAgent.agentId === adapterId));
  assert.ok(final.tools.every(tool => tool.sourceAgent.agentId === adapterId));
  assert.equal(final.messages.find(m => m.blocks?.[0]?.kind === 'thinking').done, true);
  assert.equal(final.messages.at(-1).usage.totalTokens, 28);
  assert.equal(final.messages[1].usage.totalTokens, 550);
  assert.equal(final.tools[1].state, 'done');
  const elapsed = final.execution.elapsedMs;
  await delay(25); assert.equal(handle.snapshot().execution.elapsedMs, elapsed);
  assert.ok(polls >= 2);
});

test('restored timing uses the last user turn, freezes on stop and resets before continuation emits', async t => {
  const started = Date.now() - 7000;
  let status = 'running', followup = false, calls = 0;
  const adapter = createRunnerRuntimeAdapter({
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
    runnerRuntime: { async rpc(op) {
      if (op === 'job.session') { calls++; return { ok: true, data: { status, started: started / 1000,
        firstStarted: (started - 86400000) / 1000,
        items: [{ seq: 1, kind: 'user', text: 'current', at: new Date(started).toISOString() },
          { seq: 2, kind: 'thinking', streamId: 't', text: 'active', done: false }] } }; }
      if (op === 'job.stop') { status = 'done'; return { ok: true, data: { ok: true } }; }
      if (op === 'job.comment') { followup = true; status = 'done'; return { ok: true, data: { ok: true } }; }
      return { ok: true, data: {} };
    } }
  });
  const session = await adapter.resumeSession({ native: { runner: { openOptions: { cwd: os.tmpdir(), resumePath: 'timing-fixture' } } } });
  t.after(() => session.dispose());
  const handle = getRunnerSessionDetails(session).handle;
  await until(() => handle.snapshot().messages.length === 2);
  assert.ok(handle.snapshot().execution.elapsedMs >= 7000);
  assert.ok(handle.snapshot().execution.elapsedMs < 12000);
  session.cancel();
  const stopped = handle.snapshot().execution.elapsedMs;
  await delay(30); assert.equal(handle.snapshot().execution.elapsedMs, stopped);
  assert.equal(handle.snapshot().messages.at(-1).done, true);
  await until(() => !handle.snapshot().running);
  let firstFrame;
  handle.on((event, snapshot) => { if (event.kind === 'started') firstFrame = snapshot; });
  await session.send({ text: 'followup' }).completion;
  assert.equal(followup, true); assert.ok(firstFrame.execution.elapsedMs < 1000);
});

test('restoring a settled paginated archive drains all thinking chunks before settling', async t => {
  let calls = 0;
  const adapter = createRunnerRuntimeAdapter({
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
    runnerRuntime: { async rpc(op, payload) {
      if (op === 'job.session') {
        if (payload.limit === 1) return { ok: true, data: { status: 'done' } };
        calls++;
        return { ok: true, data: { status: 'done', seq: 3, items: calls === 1 ?
          [{ seq: 1, kind: 'thinking', streamId: 'old', text: 'partial', done: false }] :
          [{ seq: 2, kind: 'thinking', streamId: 'old', text: 'complete', done: true },
           { seq: 3, kind: 'say', text: 'last answer' }] } };
      }
      return { ok: true, data: {} };
    } }
  });
  const session = await adapter.resumeSession({ native: { runner: { openOptions: { cwd: os.tmpdir(), resumePath: 'paginated' } } } });
  t.after(() => session.dispose());
  const handle = getRunnerSessionDetails(session).handle;
  await until(() => handle.snapshot().messages.at(-1)?.blocks?.[0]?.text === 'last answer');
  assert.equal(calls, 2);
  assert.equal(handle.snapshot().messages[0].blocks[0].text, 'complete');
  assert.equal(handle.snapshot().messages[0].done, true);
});

test('paginated restoration never publishes an earlier turn timer before the final page', async t => {
  let calls = 0, releasePage;
  const pendingPage = new Promise(resolve => { releasePage = resolve; });
  const previous = Date.now() - 86400000, current = Date.now() - 30000, ended = current + 7000;
  const frames = [], cursors = [];
  const adapter = createRunnerRuntimeAdapter({
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'fixture' } }) },
    runnerRuntime: { async rpc(op, payload) {
      if (op === 'job.session') {
        if (payload.limit === 1) return { ok: true, data: { status: 'done' } };
        calls++; cursors.push(payload.since);
        if (calls === 1) return { ok: true, data: { status: 'done', seq: 4, started: previous / 1000,
          ended: ended / 1000, items: [
            { seq: 1, kind: 'user', text: 'yesterday', at: new Date(previous).toISOString() },
            { seq: 2, kind: 'say', text: 'previous answer' }
          ] } };
        await pendingPage;
        return { ok: true, data: { status: 'done', seq: 4, started: current / 1000,
          ended: ended / 1000, items: [
            { seq: 3, kind: 'user', text: 'latest request', at: new Date(current).toISOString() },
            { seq: 4, kind: 'say', text: 'latest answer' }
          ] } };
      }
      return { ok: true, data: {} };
    } }
  });
  const session = await adapter.resumeSession({ native: { runner: { openOptions: { cwd: os.tmpdir(), resumePath: 'timed-pages' } } } });
  t.after(() => { releasePage(); return session.dispose(); });
  const handle = getRunnerSessionDetails(session).handle;
  handle.on((event, snapshot) => frames.push({ event, snapshot }));
  await until(() => calls === 2);
  assert.equal(handle.snapshot().messages.length, 0, 'snapshot() must retain the opening state while history is incomplete');
  assert.equal(handle.snapshot().execution.elapsedMs, 0);
  assert.equal(frames.filter(frame => frame.snapshot.messages.length).length, 0);
  releasePage();
  await until(() => handle.snapshot().messages.length === 4);
  const visible = frames.filter(frame => frame.snapshot.messages.length);
  assert.equal(visible.length, 1, 'history is published once after draining all pages');
  assert.equal(visible[0].snapshot.execution.elapsedMs, 7000);
  assert.equal(visible[0].event.kind, 'settled');
  assert.deepEqual(cursors, [0, 2]);
});
