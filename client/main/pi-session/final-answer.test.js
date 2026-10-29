'use strict';

const assert = require('node:assert/strict');
const finalAnswer = require('./final-answer');

function fakeSdk(responses, observed) {
  return {
    SessionManager: { inMemory: () => ({ memory: true }) },
    async createAgentSession(args) {
      observed.args.push(args);
      let listener = null;
      return {
        session: {
          subscribe(fn) { listener = fn; return () => { listener = null; }; },
          async prompt(value, options) {
            observed.prompts.push({ value, options });
            const answer = String(responses.shift() || '');
            listener({ type: 'agent_start' });
            listener({ type: 'message_start', message: { role: 'assistant' } });
            listener({ type: 'message_update', assistantMessageEvent: {
              type: 'text_end', contentIndex: 0, content: answer,
            } });
            listener({ type: 'message_end', message: {
              role: 'assistant', usage: { totalTokens: 12 }, stopReason: 'stop',
            } });
            listener({ type: 'agent_settled' });
          },
          dispose() { observed.disposed += 1; },
        },
      };
    },
  };
}

function options(responses) {
  const observed = { args: [], prompts: [], resources: [], disposed: 0 };
  return {
    observed,
    value: {
      sdk: fakeSdk(responses, observed),
      model: { id: 'same-pi-model' },
      runtime: {},
      cwd: 'C:/safe/workspace',
      agentDir: 'C:/safe/agent',
      goal: { goal: '生成月报', acceptance: '可打开' },
      reviewed: { phase: 'reviewed', reason: '验收通过' },
      evidence: { verification: true, changedFileCount: 1, deliverableCount: 1 },
      outputSnapshot: {
        delivery: { items: [{ relative: '月报.docx', name: '月报.docx',
          title: '月报', kind: 'document' }] },
      },
      async resourceFactory(prompts) {
        observed.resources.push(prompts);
        return { settingsManager: {}, resourceLoader: {} };
      },
    },
  };
}

async function run() {
  {
    const fixture = options([JSON.stringify({
      title: '月报已完成',
      summary: '月报已经完成交付。',
      deliverables: [{ name: '月报', path: '月报.docx' }],
      verification: ['已完成格式校验'],
      limitations: [],
    })]);
    const result = await finalAnswer.compose(fixture.value);
    assert.equal(result.source, 'model');
    assert.equal(fixture.observed.args.length, 1);
    assert.deepEqual(fixture.observed.args[0].tools, []);
    assert.equal(fixture.observed.args[0].customTools, undefined);
    assert.equal(fixture.observed.resources[0][0].includes('never the worker transcript'), true);
    assert.doesNotMatch(fixture.observed.prompts[0].value, /bash|system_warning|C:\/safe/);
    assert.equal(fixture.observed.disposed, 1);
    process.stdout.write('  PASS  最终整理会话无工具、无命令历史且使用同一模型\n');
  }

  {
    const fixture = options([
      JSON.stringify({
        title: '月报', summary: '我调用 bash。system_warning',
        deliverables: [], verification: [], limitations: [],
      }),
      JSON.stringify({
        title: '月报已完成', summary: '月报已经完成交付。',
        deliverables: [{ name: '月报', path: '月报.docx' }],
        verification: ['已完成格式校验'], limitations: [],
      }),
    ]);
    const result = await finalAnswer.compose(fixture.value);
    assert.equal(result.source, 'model-retry');
    assert.equal(fixture.observed.args.length, 2);
    assert.equal(fixture.observed.disposed, 2);
    process.stdout.write('  PASS  首次质量门禁未过会在新干净会话中重整一次\n');
  }

  {
    const fixture = options(['not json', 'still not json']);
    const result = await finalAnswer.compose(fixture.value);
    assert.equal(result.source, 'deterministic-fallback');
    assert.match(result.rendered, /月报\.docx/);
    assert.doesNotMatch(result.rendered, /not json|still not json/);
    process.stdout.write('  PASS  两次不合格时按真实证据生成确定性回执\n');
  }
}

run().then(() => process.stdout.write('\n  3 项全过\n')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
