'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const spec = require('../../tools/contracts/model-capability-probe-v1.json');
const probe = require('../main/model-capability-probe.cjs');
const request = require('../main/model-capability-request.cjs');

const conf = { name: 'synthetic-alias', baseUrl: 'https://fixture.invalid/v1', authMode: 'none', config: {} };
for (const vector of spec.cases) test('shared probe contract: ' + vector.name, async () => {
  const requests = [];
  let challenge;
  const report = await probe.run(conf, [vector.check], {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const result = body.messages.find(row => row.role === 'tool');
      if (result) {
        assert.equal(body.stream, spec.policy.followupStream);
        assert.deepEqual(body.tools, [spec.policy.tool]);
        assert.equal(body.tool_choice, undefined);
        assert.equal(body.messages.at(-1).role, 'tool');
        assert.match(result.content, /^[a-f0-9]{16}$/);
        if (vector.replayedReasoning) assert.equal(body.messages.find(row => row.role === 'assistant').reasoning_content, vector.replayedReasoning);
        const choice = JSON.parse(JSON.stringify(vector.followup).replaceAll('{{receipt}}', result.content)).choices[0];
        return streamEvent(choice.message, choice.finish_reason);
      }
      challenge = body.messages[0].content.match(/value ([a-f0-9]{16})/)[1];
      assert.equal(body.messages[0].content, spec.policy.toolPrompt.replaceAll('{{value}}', challenge));
      assert.deepEqual(body.tools, [spec.policy.tool]);
      assert.equal(body.tool_choice, spec.policy.toolChoice);
      const raw = vector.requireAuto && body.tool_choice !== 'auto'
        ? 'data: {"choices":[{"index":0,"delta":{"content":"ordinary text"},"finish_reason":"stop"}]}\n\n'
        : vector.initialChunks.join('').replaceAll('{{value}}', challenge);
      const bytes = Buffer.from(raw), size = vector.byteChunkSize || 7;
      return new Response(new ReadableStream({ start(controller) {
        for (let offset = 0; offset < bytes.length; offset += size) controller.enqueue(bytes.subarray(offset, offset + size));
        controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const actual = report.checks[vector.check];
  assert.equal(actual.status, vector.expect.status);
  assert.equal(actual.stage, vector.expect.stage);
  if (vector.expect.detailCode) assert.equal(actual.detailCode, vector.expect.detailCode);
  assert.equal(requests.length, vector.expect.requestCount);
  assert.doesNotMatch(JSON.stringify(report), /synthetic private response|synthetic thought/);
  assert.ok(!JSON.stringify(report).includes(challenge), 'Challenge values stay outside the public report');
});

for (const vector of spec.failureCases) test('shared failure classification: ' + vector.name, () => {
  assert.deepEqual(request.failure({ status: vector.status, error: vector.error }, vector.check), vector.expect);
});

test('optional control rejection cannot declare the associated capability unsupported', async () => {
  const report = await probe.run(conf, ['toolCalling'], {
    fetchImpl: async () => Response.json({ error: { code: 'unsupported_tools', param: 'tool_choice',
      message: 'tool_choice is unsupported' } }, { status: 400 }),
  });
  assert.equal(report.checks.toolCalling.status, 'inconclusive');
});

test('connection and stream transport proof accept meaningful text or reasoning', async () => {
  for (const check of ['connection', 'streaming']) for (const delta of [{ content: 'Acknowledged.' }, { reasoning_content: 'synthetic reasoning' }]) {
    const report = await probe.run(conf, [check], {
      fetchImpl: async () => check === 'connection'
        ? Response.json({ choices: [{ message: delta, finish_reason: 'stop' }] })
        : new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: 'stop' }] }) + '\n\n',
          { headers: { 'content-type': 'text/event-stream' } }),
    });
    assert.equal(report.checks[check].status, 'passed');
  }
});

for (const vector of spec.outputCases) test('shared output verification: ' + vector.name, async () => {
  const report = await probe.run(conf, [vector.check], {
    challenge: () => ({ expected: '582941', url: 'data:image/png;base64,fixture' }),
    fetchImpl: async () => vector.initialResponse ? Response.json(vector.initialResponse)
      : new Response(vector.initialChunks.join(''), { headers: { 'content-type': 'text/event-stream' } }),
  });
  const row = report.checks[vector.check];
  for (const key of ['status', 'code', 'stage']) assert.equal(row[key], vector.expect[key]);
  if ('detailCode' in vector.expect) assert.equal(row.detailCode ?? null, vector.expect.detailCode);
  assert.equal(report.requestCount, vector.expect.requestCount);
});

test('the body deadline survives a transport that ignores the abort signal', async t => {
  const keepAlive = setTimeout(() => {}, 2000);
  t.after(() => clearTimeout(keepAlive));
  const report = await probe.run(conf, ['streaming'], {
    timeoutMs: 30, totalMs: 1000,
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n'));
    } }), { headers: { 'content-type': 'text/event-stream' } }),
  });
  assert.equal(report.checks.streaming.status, 'inconclusive');
  assert.equal(report.checks.streaming.code, 'timeout');
  assert.deepEqual(report.compatibility, {});
});

function streamEvent(delta, finish = 'stop') {
  return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) +
    '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
function toolStream(body, options = {}) {
  const value = body.messages[0].content.match(/value ([a-f0-9]{16})/)[1];
  return streamEvent({ tool_calls: [{ index: 0, id: 'call-fixture', type: 'function', function: {
    name: options.name || 'soduwork_capability_echo', arguments: options.arguments ?? JSON.stringify({ value }),
  } }] }, options.finish || 'tool_calls');
}
const namedCompatibility = { toolChoice: 'named', streamOptions: false, maxTokensField: 'max_completion_tokens' };

test('cached named plain stop text retries auto and confirms only the safe receipt', async () => {
  const requests = [];
  const report = await probe.run({ ...conf, compatibility: namedCompatibility }, ['toolCalling'], {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      const result = body.messages.find(row => row.role === 'tool');
      if (result) return streamEvent({ content: result.content });
      if (typeof body.tool_choice === 'object') return streamEvent({ content: 'Use automatic tool selection.' });
      return toolStream(body);
    },
  });
  assert.equal(report.checks.toolCalling.status, 'passed');
  assert.equal(report.compatibility.toolChoice, 'auto');
  assert.equal(requests.length, 3);
  assert.equal(typeof requests[0].tool_choice, 'object');
  assert.equal(requests[1].tool_choice, 'auto');
  assert.deepEqual(requests[0].messages, requests[1].messages);
  assert.deepEqual(requests[2].tools, requests[1].tools);
});

test('ambiguous text never confirms a tool choice or retries auto again', async () => {
  for (const previous of [namedCompatibility, {}]) {
    const requests = [];
    const report = await probe.run({ ...conf, compatibility: previous }, ['toolCalling'], {
      fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return streamEvent({ content: 'ordinary text' }); },
    });
    assert.equal(report.checks.toolCalling.detailCode, 'tool_call_count_mismatch');
    assert.equal(requests.length, previous.toolChoice === 'named' ? 2 : 1);
    assert.equal(report.compatibility.toolChoice, previous.toolChoice);
    for (const [key, value] of Object.entries(previous)) assert.equal(report.compatibility[key], value);
  }
});

test('a failed receipt preserves confirmed tool choice after text or HTTP fallback', async () => {
  for (const rejection of ['text', 'http']) {
    const requests = [];
    const report = await probe.run({ ...conf, compatibility: namedCompatibility }, ['toolCalling'], {
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body); requests.push(body);
        if (body.messages.some(row => row.role === 'tool')) return streamEvent({ content: 'unrelated receipt' });
        if (typeof body.tool_choice === 'object') return rejection === 'http'
          ? Response.json({ error: { code: 'unsupported_parameter', param: 'tool_choice' } }, { status: 400 })
          : streamEvent({ content: 'ordinary text' });
        return toolStream(body);
      },
    });
    assert.equal(report.checks.toolCalling.detailCode, 'tool_receipt_mismatch');
    assert.deepEqual(report.compatibility, namedCompatibility);
    assert.equal(requests.length, 3);
  }
});

test('named partial wrong or legacy calls never trigger the plain-text fallback', async () => {
  for (const kind of ['partial', 'wrong', 'legacy']) {
    const requests = [];
    const report = await probe.run({ ...conf, compatibility: namedCompatibility }, ['toolCalling'], {
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body); requests.push(body);
        if (kind === 'legacy') return streamEvent({ content: 'ordinary text', function_call: { name: 'other', arguments: '{}' } });
        return toolStream(body, { finish: 'stop', ...(kind === 'partial' ? { arguments: '{"value":' } : { name: 'other' }) });
      },
    });
    assert.equal(report.checks.toolCalling.status, 'inconclusive');
    assert.equal(requests.length, 1);
    assert.equal(report.compatibility.toolChoice, 'named');
  }
});

test('named text repair obeys the shared seven-request and two-negotiation limits', async () => {
  const requests = [];
  const report = await probe.run({ ...conf, compatibility: { toolChoice: 'named' } },
    ['connection', 'imageInput', 'toolCalling', 'streaming'], {
      challenge: () => ({ expected: '582941', url: 'data:image/png;base64,fixture' }),
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body); requests.push(body);
        if ('max_tokens' in body) return Response.json({ error: { code: 'unsupported_parameter', param: 'max_tokens' } }, { status: 400 });
        const result = body.messages.find(row => row.role === 'tool');
        if (result) return streamEvent({ content: result.content });
        if (body.tools) return typeof body.tool_choice === 'object' ? streamEvent({ content: 'ordinary text' }) : toolStream(body);
        if (body.stream) return streamEvent({ content: 'OK' });
        return Response.json({ choices: [{ message: { content: Array.isArray(body.messages[0].content) ? '582941' : 'OK' }, finish_reason: 'stop' }] });
      },
    });
  assert.ok(Object.values(report.checks).every(row => row.status === 'passed'));
  assert.equal(requests.length, 7);
  assert.equal(report.requestCount, 7);
  assert.equal(report.compatibility.toolChoice, 'auto');
});

test('named text repair cannot spend a third negotiation', async () => {
  const requests = [];
  const report = await probe.run({ ...conf, compatibility: { toolChoice: 'named' } }, ['connection', 'toolCalling'], {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      const rejected = 'max_tokens' in body ? 'max_tokens' : 'stream_options' in body ? 'stream_options' : '';
      if (rejected) return Response.json({ error: { code: 'unsupported_parameter', param: rejected } }, { status: 400 });
      if (body.stream) return streamEvent({ content: 'ordinary text' });
      return Response.json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] });
    },
  });
  assert.equal(report.checks.toolCalling.detailCode, 'tool_call_count_mismatch');
  assert.equal(requests.length, 4);
  assert.ok(requests.filter(body => body.tools).every(body => typeof body.tool_choice === 'object'));
  assert.equal(report.compatibility.toolChoice, 'named');
});

test('an absent optional parameter cannot spend a negotiation or alter later stream settings', async () => {
  const requests = [];
  const report = await probe.run(conf, ['connection', 'streaming'], {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      if (!body.stream) return Response.json({ error: { code: 'unsupported_parameter', param: 'stream_options' } }, { status: 400 });
      return streamEvent({ content: 'OK' });
    },
  });
  assert.equal(report.checks.connection.status, 'inconclusive');
  assert.equal(report.checks.connection.code, 'parameter_not_supported');
  assert.equal(report.checks.streaming.status, 'passed');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].stream_options, { include_usage: true });
  assert.equal(report.compatibility.streamOptions, true);
});

test('omitted continuation control rejection is not retried using cached named policy', async () => {
  const requests = [];
  const report = await probe.run({ ...conf, compatibility: namedCompatibility }, ['toolCalling'], {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      if (body.messages.at(-1).role === 'tool') return Response.json({ error: {
        code: 'unsupported_parameter', param: 'tool_choice' } }, { status: 400 });
      return toolStream(body);
    },
  });
  assert.equal(report.checks.toolCalling.status, 'inconclusive');
  assert.equal(report.checks.toolCalling.stage, 'tool_result');
  assert.equal(report.compatibility.toolChoice, 'named');
  assert.equal(requests.length, 2);
});
