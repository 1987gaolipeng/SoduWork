'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createUsageReporter, usageFromSnapshot,
} = require('../main/agent-runtime/usage-reporter');

let checks = 0;
function ok(value, message) { assert.ok(value, message); checks += 1; }

async function main() {
  const pi = usageFromSnapshot({ messages: [
    { role: 'assistant', done: true,
      usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } },
    { role: 'assistant', done: true,
      usage: { input: 60, cacheRead: 20, output: 10, totalTokens: 90 } },
  ] });
  ok(pi.total === 200, 'message-level requests are summed without OpenAI cache duplication');
  ok(pi.cacheRead === 60, 'cache detail is retained');
  ok(pi.requests === 2, 'assistant responses become request count');
  const future = usageFromSnapshot({
    usage: { input: 5, output: 3, total: 8, requests: 4 },
  });
  ok(future.total === 8 && future.requests === 4,
    'future adapters can report one cumulative usage object');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-usage-'));
  const sent = [];
  const reporter = createUsageReporter({
    app: { getPath: () => root },
    identityOf: async () => ({
      hub: 'http://hub.example', clientId: 'device-1',
      secret: 'must-not-be-persisted', session: 'session-token',
    }),
    fetchImpl: async (url, options) => {
      sent.push({ url, options, body: JSON.parse(options.body) });
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    },
  });
  const handle = {
    sessionId: 'chat-stable', usageIdentity: {
      hub: 'http://hub.example', clientId: 'device-1',
    },
    usageAgentKey: 'future-agent', model: { id: 'model-x' },
  };
  reporter.observe(handle, { usage: { input: 80, output: 20, total: 100 } });
  reporter.observe(handle, { usage: { input: 20, output: 10, total: 30 } });
  // Saving is asynchronous; explicitly wait for the durability boundary.
  await reporter.persist();
  const persisted = fs.readFileSync(path.join(root, 'usage-outbox.json'), 'utf8');
  ok(!persisted.includes('must-not-be-persisted'), 'outbox never persists device keys');
  await reporter.flush();
  ok(sent.length === 1, 'same conversation is coalesced');
  ok(sent[0].body.agent === 'future-agent', 'agent identity is open-ended');
  ok(sent[0].body.usage.total === 100, 'stale snapshot cannot reduce cumulative total');
  ok(sent[0].options.headers.Authorization === 'Device session-token',
    'device session authenticates upload');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('usage reporter: ' + checks + ' assertions passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
