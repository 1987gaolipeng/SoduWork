'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const probePath = path.join(__dirname, '../main/model-capability-probe.cjs');
function probe() { assert.equal(fs.existsSync(probePath), true, 'the real local probe must exist'); return require(probePath); }

async function fixture(t, mode = '') {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString()); requests.push({ body, headers: req.headers });
    if (mode === 'hang-before-headers') return;
    if (mode === 'invalid-value') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Invalid value', param: 'max_tokens', code: 'invalid_value' } }));
    }
    if (mode === 'parameter' && body.tool_choice?.type === 'function') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'unsupported parameter: tool_choice', param: 'tool_choice', code: 'unsupported_parameter' } }));
    }
    const content = body.messages[0].content;
    const result = body.messages.find(row => row.role === 'tool');
    if (result && body.stream && (mode === 'receipt-rejected' || mode === 'receipt-requires-choice' && body.tool_choice === undefined)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'synthetic refusal' } }));
    }
    if (result && body.stream && mode === 'receipt-truncated') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: result.content }, finish_reason: null }] }) + '\n\n');
    }
    const nonce = typeof content === 'string' ? content.match(/[a-f0-9]{16}/)?.[0] : '';
    let message = { content: result ? result.content : Array.isArray(content) ? '582941' : nonce || 'OK' };
    if (body.tools && !result) message = { content: null, tool_calls: [{ id: 'call-fixture', type: 'function',
      function: { name: 'soduwork_capability_echo', arguments: JSON.stringify({ value: nonce }) } }] };
    if (mode === 'force-tool-choice' && result && body.tool_choice?.type === 'function') message = {
      content: null, tool_calls: [{ id: 'forced-again', type: 'function', function: { name: 'soduwork_capability_echo', arguments: '{}' } }] };
    if (mode === 'extra-tool' && message.tool_calls) message.tool_calls.push({ ...message.tool_calls[0], id: 'extra-fixture' });
    if (body.stream && mode !== 'json-stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = message.tool_calls ? { tool_calls: message.tool_calls.map((row, index) => ({ ...row, index })) } : message;
      const event = { choices: [{ index: 0, delta, finish_reason: null }] };
      if (mode === 'split-tool' && message.tool_calls) {
        for (const part of [{ index: 0, id: 'call-', function: { name: 'soduwork_', arguments: '{"value":' } },
          { index: 0, id: 'fixture', function: { name: 'capability_echo', arguments: JSON.stringify(nonce) + '}' } }])
          res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [part] }, finish_reason: null }] }) + '\n\n');
      } else if (mode === 'multiline') res.write('data: {"choices":\r\ndata: ' + JSON.stringify(event.choices) + '}\r\n\r\n');
      else res.write('data: ' + JSON.stringify(event) + '\n\n');
      if (mode === 'stream-error') return res.end('data: {"error":{"message":"synthetic private error","code":"upstream_failed"}}\n\n');
      if (mode !== 'truncated') res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\n');
      if (mode === 'hang-after-terminal') return;
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, conf: { name: 'wire-model', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    key: '', kind: 'openai-compat', authMode: 'none', config: {} } };
}
const challenge = () => ({ expected: '582941', url: 'data:image/png;base64,iVBORw0KGgo=' });

test('real local HTTP probes send images, streamed tool calls, a safe tool result and text streams', async t => {
  const p = probe(), f = await fixture(t);
  const result = await p.run(f.conf, ['connection', 'imageInput', 'toolCalling', 'streaming'], { challenge });
  assert.deepEqual(Object.values(result.checks).map(row => row.status), ['passed', 'passed', 'passed', 'passed']);
  assert.equal(f.requests.length, 5);
  assert.ok(f.requests.some(row => Array.isArray(row.body.messages[0].content)));
  assert.ok(f.requests.some(row => row.body.tools && row.body.stream));
  assert.ok(f.requests.some(row => row.body.messages.some(message => message.role === 'tool')));
  assert.ok(f.requests.every(row => !row.headers.authorization && row.body.model === 'wire-model'));
});

test('a named tool-choice parameter rejection negotiates auto and confirms tools instead of disabling them', async t => {
  const p = probe(), f = await fixture(t, 'parameter'); f.conf.compatibility = { toolChoice: 'named' };
  const result = await p.run(f.conf, ['toolCalling'], { challenge });
  assert.equal(result.checks.toolCalling.status, 'passed');
  assert.equal(result.compatibility.toolChoice, 'auto');
  assert.equal(f.requests.length, 3);
});

for (const mode of ['truncated', 'stream-error', 'json-stream']) test(`a ${mode} response is never complete streaming evidence`, async t => {
  const p = probe(), f = await fixture(t, mode);
  const result = await p.run(f.conf, ['streaming']);
  assert.equal(result.checks.streaming.status, 'inconclusive');
  assert.doesNotMatch(JSON.stringify(result), /synthetic private error/);
});

test('valid multiline SSE data is decoded by the transport', async t => {
  const p = probe(), f = await fixture(t, 'multiline');
  assert.equal((await p.run(f.conf, ['streaming'])).checks.streaming.status, 'passed');
});

test('unsupported protocols produce an explicit untested result without calling a vendor', async () => {
  const result = await probe().run({ kind: 'anthropic' }, ['imageInput']);
  assert.equal(result.checks.imageInput.code, 'protocol_not_tested');
  assert.equal(result.checks.imageInput.status, 'inconclusive');
});

test('a request timeout after a terminal delta is not accepted as completed streaming evidence', async t => {
  const p = probe(), f = await fixture(t, 'hang-after-terminal');
  const report = await p.run(f.conf, ['streaming'], { timeoutMs: 100, totalMs: 1000 });
  assert.equal(report.checks.streaming.status, 'inconclusive');
  assert.equal(report.checks.streaming.code, 'timeout');
});

test('connection deadlines retain a timeout diagnostic through SDK error wrapping', async t => {
  const f = await fixture(t, 'hang-before-headers');
  const report = await probe().run(f.conf, ['connection'], { connectMs: 40, timeoutMs: 1000, totalMs: 2000 });
  assert.equal(report.checks.connection.status, 'inconclusive');
  assert.equal(report.checks.connection.code, 'timeout');
});

test('bounded responses retain the size-limit diagnostic through the real SDK', async t => {
  const f = await fixture(t);
  const report = await probe().run(f.conf, ['connection'], { maxBytes: 32 });
  assert.equal(report.checks.connection.code, 'response_too_large');
});

test('split tool IDs, names and arguments form the exact safe receipt exchange', async t => {
  const f = await fixture(t, 'split-tool');
  const report = await probe().run(f.conf, ['toolCalling']);
  assert.equal(report.checks.toolCalling.status, 'passed');
  assert.equal(f.requests[1].body.messages.find(row => row.role === 'tool').tool_call_id, 'call-fixture');
});

test('an extra streamed tool call never counts as verified single-tool capability', async t => {
  const f = await fixture(t, 'extra-tool');
  const report = await probe().run(f.conf, ['toolCalling']);
  assert.equal(report.checks.toolCalling.status, 'inconclusive');
  assert.equal(f.requests.length, 1, 'No tool result should be sent for an invalid exchange');
});

test('a successful named tool choice is not forced again when reading the safe tool result', async t => {
  const f = await fixture(t, 'force-tool-choice'); f.conf.compatibility = { toolChoice: 'named' };
  const report = await probe().run(f.conf, ['toolCalling']);
  assert.equal(report.checks.toolCalling.status, 'passed');
  assert.equal(f.requests[1].body.tool_choice, undefined);
});

test('invalid parameter values do not trigger dialect negotiation', async t => {
  const p = probe(), f = await fixture(t, 'invalid-value');
  const report = await p.run(f.conf, ['connection']);
  assert.equal(report.checks.connection.status, 'inconclusive'); assert.equal(f.requests.length, 1);
});

for (const baseUrl of ['https://PROVIDER.example.test/v1', 'https://provider.example.test:443/v1']) {
  test(`equivalent saved endpoint spelling is accepted: ${baseUrl}`, async () => {
    let calls = 0;
    const report = await probe().run({ name: 'model', baseUrl, authMode: 'none', config: {} }, ['connection'], {
      fetchImpl: async (_url, options) => {
        calls++; const body = JSON.parse(options.body), value = body.messages[0].content.match(/[a-f0-9]{16}/)[0];
        return new Response(JSON.stringify({ choices: [{ message: { content: value }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
      },
    });
    assert.equal(calls, 1); assert.equal(report.checks.connection.status, 'passed');
  });
}


test('a cold connection timeout cannot publish unverified transport defaults to runtime compatibility', async t => {
  const f = await fixture(t, 'hang-before-headers');
  const report = await probe().run(f.conf, ['connection'], { connectMs: 40, timeoutMs: 1000, totalMs: 2000 });
  assert.equal(report.checks.connection.code, 'timeout');
  assert.deepEqual(report.compatibility, {}, 'No request accepted these defaults; preserve the runtime default transport');
});

test('a connection-only success confirms its output field without inventing untested stream or tool options', async t => {
  const f = await fixture(t);
  const report = await probe().run(f.conf, ['connection']);
  assert.equal(report.checks.connection.status, 'passed');
  assert.deepEqual(report.compatibility, { maxTokensField: 'max_tokens' });
});

for (const mode of ['receipt-rejected', 'receipt-truncated', 'receipt-requires-choice']) test(`streamed receipt ${mode} cannot pass toolCalling`, async t => {
  const f = await fixture(t, mode);
  const result = await probe().run(f.conf, ['connection', 'toolCalling', 'streaming']);
  assert.equal(result.checks.connection.status, 'passed');
  assert.equal(result.checks.streaming.status, 'passed');
  assert.notEqual(result.checks.toolCalling.status, 'passed');
  assert.equal(result.checks.toolCalling.stage, 'tool_result');
});
test('tool continuation keeps tools and ends on the receipt without forcing another call', async t => {
  const f = await fixture(t); f.conf.compatibility = { toolChoice: 'named' };
  const report = await probe().run(f.conf, ['toolCalling']);
  assert.equal(report.checks.toolCalling.status, 'passed');
  const body = f.requests[1].body;
  assert.equal(body.stream, true);
  assert.deepEqual(body.tools, f.requests[0].body.tools);
  assert.equal(body.tool_choice, undefined);
  assert.equal(body.messages.at(-1).role, 'tool');
});
test('v2 tool success is retired without dropping independent evidence on partial recheck', () => {
  const c = require('../main/model-capability-contract.cjs');
  const old = { reportVersion: 2, configRevision: 'same', checks: Object.fromEntries(
    ['connection', 'imageInput', 'toolCalling', 'streaming'].map(k => [k, { status: 'passed' }])) };
  old.verifiedChecks = { ...old.checks };
  assert.equal(c.profile({}, old).toolCalling.state, 'unknown');
  const merged = c.mergeEvidence(old, { reportVersion: 3, configRevision: 'same', checks: { connection: { status: 'passed' } } });
  assert.equal(c.profile({}, merged).toolCalling.state, 'unknown');
  assert.equal(merged.verifiedChecks.toolCalling, undefined);
  assert.equal(c.profile({}, merged).streaming.state, 'supported');
  assert.equal(c.profile({}, merged).imageInput.state, 'supported');
});

test('verified-only v2 tools retain a recheck notice through a partial check', () => {
  const c = require('../main/model-capability-contract.cjs');
  const old = { reportVersion: 2, configRevision: 'same', checks: {}, verifiedChecks: {
    toolCalling: { status: 'passed', checkedAt: '2026-11-17' } } };
  const projected = c.publicEvidence(old);
  assert.equal(projected.checks.toolCalling?.code, 'legacy_recheck_required');
  assert.equal(projected.verifiedChecks.toolCalling, undefined);
  const merged = c.mergeEvidence(old, { reportVersion: 3, configRevision: 'same', checks: { connection: { status: 'cancelled' } } });
  assert.equal(merged.checks.toolCalling?.code, 'legacy_recheck_required');
  assert.equal(c.profile({}, merged).toolCalling.state, 'unknown');
});

test('mandatory reasoning probes explicitly request supported low effort without disabling thinking', async () => {
  for (const model of [
    { name: 'glm_5.3_flash', config: { thinkingMode: 'auto' } },
    { name: 'private-alias', config: { thinkingMode: 'always', thinkingFormat: 'zai', supportsReasoningEffort: true } },
  ]) {
    let body;
    const report = await probe().run({ ...model, baseUrl: 'https://fixture.invalid/v1', authMode: 'none' }, ['connection'], {
      fetchImpl: async (_url, options) => {
        body = JSON.parse(options.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }),
          { headers: { 'content-type': 'application/json' } });
      },
    });
    assert.equal(report.checks.connection.status, 'passed');
    assert.deepEqual(body.thinking, { type: 'enabled', clear_thinking: false });
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.max_tokens, 2048);
  }
  await assert.rejects(probe().run({ name: 'glm-5.3', config: { thinkingMode: 'none' } }, ['connection'], {
    fetchImpl: () => { throw Error('A conflicting declaration must not reach the provider'); },
  }), /不支持关闭思考/);
});

test('reasoning probes select the lowest available configured effort and preserve remapping', () => {
  const request = require('../main/model-capability-request.cjs');
  for (const [thinkingLevelMap, expected] of [
    [{ low: null, high: 'high', max: 'max' }, 'high'],
    [{ low: 'high', high: 'max' }, 'high'],
    [{ low: null, high: null, max: 'max' }, 'max'],
  ]) {
    const state = request.policy({ name: 'glm-5.3', config: { thinkingLevelMap } });
    const body = request.payload({ name: 'glm-5.3' }, state, [], false);
    assert.equal(body.reasoning_effort, expected);
    assert.equal(body.thinking.type, 'enabled');
  }
  const unknown = request.policy({ name: 'gateway-model', config: { thinkingMode: 'auto' } });
  const body = request.payload({ name: 'gateway-model' }, unknown, [], false);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.thinking, undefined);
  assert.throws(() => request.policy({ name: 'glm-5.3', config: {
    thinkingLevelMap: { low: null, high: null, max: null },
  } }), /至少需要一个可用思考强度/);
});

for (const [level, effort] of [['minimal', 'low'], ['medium', 'high'], ['xhigh', 'max']]) {
  test(`mandatory reasoning probes accept ${level} as the only explicitly mapped level`, () => {
    const request = require('../main/model-capability-request.cjs');
    const state = request.policy({ name: 'glm-5.3', config: {
      thinkingLevelMap: { low: null, high: null, max: null, [level]: effort },
    } });
    const body = request.payload({ name: 'glm-5.3' }, state, [], false);
    assert.equal(body.reasoning_effort, effort);
    assert.equal(body.thinking.type, 'enabled');
  });
}
