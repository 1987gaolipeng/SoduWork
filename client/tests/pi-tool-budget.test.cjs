'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const runControl = require('../main/pi-session/run-control');
const events = require('../main/pi-session/session-events');

// Run the bundled native loop with an in-memory provider. No model gateway,
// user workspace, archive or paid API participates in these boundary cases.
async function fixture(mode, count, limit = 2, behavior = 'progress') {
  const { Agent } = await import('../node_modules/@earendil-works/pi-agent-core/dist/agent.js');
  const executed = [], notices = [];
  let replies = 0, aborted = 0;
  const run = runControl.createState();
  const agent = new Agent({
    toolExecution: mode,
    initialState: {
      model: { id: 'fixture', api: 'fixture', provider: 'fixture' },
      tools: [{ name: 'probe', description: 'Isolated probe',
        parameters: { type: 'object', properties: {} },
        async execute(id) {
          executed.push(id);
          if (behavior === 'failure') throw new Error('temporary failure');
          return { content: [{ type: 'text', text: behavior.startsWith('empty') ? '' : 'done' }] };
        } }],
    },
    streamFn() {
      const call = replies++ === 0;
      const message = { role: 'assistant', api: 'fixture', provider: 'fixture', model: 'fixture',
        content: call ? Array.from({ length: count }, (_, i) =>
          ({ type: 'toolCall', id: 'probe-' + i, name: 'probe', arguments:
            ['repeat', 'empty-repeat'].includes(behavior) ? {} : behavior === 'cycle' ? { index: i % 3 } : { index: i } }))
          : [{ type: 'text', text: 'Finished after all tools.' }],
        stopReason: call ? 'toolUse' : 'stop', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', message }; },
        result: async () => message };
    },
  });
  const ctx = {
    shared: { runControl, toolGuard: { executionPolicy: () => ({ hardLimitMs: 1000 }) },
      messageTime: { stampPiEvent() {} }, mediaArtifacts: { fromToolEvent() {} } },
    goal: { intent: 'chat' }, goalEnabled: false, maxToolSteps: limit, run,
    acc: { push() {}, abort() {}, appendNotice(reason) { notices.push(reason); } },
    turnQueue: { active() {} }, _emit() {},
    piSession: { abort() { aborted++; agent.abort(); return agent.waitForIdle(); } },
  };
  const handler = events.create(ctx);
  agent.subscribe(handler.onPiEvent);
  async function send() {
    replies = 0;
    runControl.resetTurn(run, true);
    await agent.prompt('Run the probes then answer.');
  }
  return { send, executed, notices, run, agent, get aborted() { return aborted; } };
}

for (const mode of ['sequential', 'parallel']) {
  test(`exact tool budget permits every tool and final answer (${mode})`, async () => {
    const f = await fixture(mode, 2);
    await f.send();
    assert.deepEqual(f.executed, ['probe-0', 'probe-1']);
    assert.equal(f.aborted, 0);
    assert.equal(f.run.toolSteps, 2);
    assert.equal(f.agent.state.messages.at(-1).content[0].text, 'Finished after all tools.');
    await f.send();
    assert.equal(f.executed.length, 4, 'a new user turn gets its own budget');
  });

  test(`overflow stops before an extra tool can execute (${mode})`, async () => {
    const f = await fixture(mode, 3);
    await f.send();
    assert.ok(f.executed.length <= 2);
    if (mode === 'sequential') assert.deepEqual(f.executed, ['probe-0', 'probe-1']);
    assert.equal(f.executed.includes('probe-2'), false);
    assert.equal(f.run.toolSteps, 2);
    assert.equal(f.aborted, 1);
    assert.equal(f.notices.length, 1);
    assert.equal(f.agent.state.isStreaming, false);
  });
}

test('an explicit 256-call budget is still enforced and resets for the next user message', async () => {
  const f = await fixture('sequential', 257, 256);
  for (let turn = 1; turn <= 2; turn++) {
    await f.send();
    assert.equal(f.executed.length, 256 * turn);
    assert.equal(f.run.toolSteps, 256);
    assert.equal(f.run.activeTools.size, 0);
    assert.equal(f.aborted, turn);
    assert.equal(f.notices.length, turn);
    assert.match(f.notices.at(-1), /256/);
  }
});

test('ordinary long turns with distinct successful work finish beyond 256 tool calls', async () => {
  const f = await fixture('sequential', 300, 0);
  await f.send();
  assert.equal(f.executed.length, 300);
  assert.equal(f.aborted, 0);
  assert.equal(f.agent.state.messages.at(-1).content[0].text, 'Finished after all tools.');
});

for (const behavior of ['failure', 'empty-repeat', 'repeat', 'cycle']) {
  test(`ordinary turns still bound tools making no progress (${behavior})`, async () => {
    const f = await fixture('sequential', 300, 0, behavior);
    for (let turn = 1; turn <= 2; turn++) {
      await f.send();
      assert.ok(f.executed.length < 40 * turn, 'no-progress loop must stop before another large burst');
      assert.equal(f.aborted, turn);
      assert.equal(f.notices.length, turn);
      assert.equal(f.run.activeTools.size, 0);
    }
  });
}

test('distinct successful tools with no stdout are real work, not a stalled loop', async () => {
  const f = await fixture('sequential', 300, 0, 'empty');
  await f.send();
  assert.equal(f.executed.length, 300);
  assert.equal(f.aborted, 0);
});
