'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalUsage } = require('../main/agent-runtime/local-usage.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root };
  const identity = { hub: 'https://fixture.invalid', clientId: 'fixture-device', accountScope: 'fixture-owner' };
  const handle = { usageIdentity: identity, sessionId: 'private-session', adapterId: 'pi' };
  return { root, app, identity, handle, store: createLocalUsage(app) };
}

test('counts explicit local receipts once across partial snapshots, replay and restart', t => {
  const { root, app, identity, handle, store } = fixture(t);
  const at = Date.now() - 100;
  const pi = { localOnly: true, model: 'private-wire', agent: 'pi', provider: 'private-api-key', at,
    usage: { input: 20, output: 4, cacheRead: 2 } };
  const runner = { localOnly: true, reportable: false, provider: '', model: '', agent: 'qwen', at,
    usage: { input: 3, output: 1, inputIncludesCache: true, costUsd: '0.002', costKnown: true } };
  const ignored = [
    { ...pi, localOnly: false }, { ...pi, localOnly: undefined, reportable: false },
    { ...runner, agent: 'codex' }, { ...runner, cumulative: true },
    // Previously persisted Runner fallback, stamped from mutable session selection.
    { localOnly: true, reportable: false, agent: 'qwen', at, model: 'local:private-wire', usage: { input: 300 } },
  ];
  store.observe(handle, { usage: { total: 4000 }, usageReceipts: [pi, ...ignored] });
  store.observe(handle, { usageReceipts: [runner] });
  const reopened = createLocalUsage({ getPath: app.getPath });
  reopened.observe({ ...handle }, { usageReceipts: [pi, runner, ...ignored] });
  const result = reopened.read(identity, 7);
  assert.deepEqual([result.summary.tokens, result.summary.sessions, result.summary.requests], [30, 1, 2]);
  assert.equal(result.byAgent.length, 2);
  assert.equal(result.agentNames.pi, 'Pi');
  assert.equal(result.agentNames.qwen, 'Qwen Code');
  assert.equal(result.trend.length, 7);
  assert.equal(result.bySource[0].key, 'chat');
  assert.equal(result.quality.reported, 2);
  assert.equal(result.costQuality.unknown, 1);
  assert.equal(result.summary.costMicrousd, 2000);
  for (const key of ['hub', 'clientId', 'accountScope']) {
    const alternate = { ...identity, [key]: key === 'hub' ? 'https://else.invalid' : 'else' };
    // A reopened conversation may replay a native archive under another
    // enrollment. An already-attributed call stays with its original scope.
    reopened.observe({ ...handle, usageIdentity: alternate }, { usageReceipts: [pi, runner] });
    assert.equal(reopened.read(alternate, 7).summary.tokens, 0);
  }
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(row => row.isFile())) {
    const disk = fs.readFileSync(path.join(entry.parentPath, entry.name)).toString();
    assert.doesNotMatch(disk, /private-wire|private-api-key|private-session|fixture-device|fixture\.invalid|fixture-owner/);
  }
});

test('tracks one-shot provider totals and equal-time repeated calls, omits projections and undated usage', t => {
  const { identity, handle, store } = fixture(t);
  const model = 'local:model-' + 'f'.repeat(32);
  const row = { agent: 'app-ai', at: Date.now(), model, localOnly: true, usage: {
    prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 },
  } };
  const appHandle = { ...handle, usageSourceType: 'requirement' };
  store.observe(appHandle, { usageReceipts: [row, row, { ...row, at: 0 }] });
  store.observe(appHandle, { usageReceipts: [row] });
  store.observe({ ...handle, localReplica: true, sessionId: 'replica' }, { usageReceipts: [row] });
  store.observe({ ...handle, sessionId: 'cloud' }, { usageReceipts: [row], cloudHandoff: { phase: 'committed' } });
  const report = store.read(identity, 1);
  assert.deepEqual([report.summary.tokens, report.summary.cacheRead, report.summary.reasoning], [30, 6, 4]);
  assert.equal(report.byAgent[0].modelRef, require('../main/agent-runtime/local-usage.cjs').usageModelKey(model));
  const { rank } = require('../core/usage-metrics');
  assert.deepEqual(rank([report], 'agent'), []);
  assert.equal(rank([report], 'model')[0].tokens, 30);
  assert.equal(report.bySource[0].key, 'requirement');
});

test('counts simultaneous model checks delivered individually under one operation', t => {
  const { identity, handle, store } = fixture(t);
  handle.usageSourceType = 'model_check';
  const row = { agent: 'app-ai', localOnly: true, at: Date.now(), usage: { requests: 1, quality: 'unknown' } };
  for (const requestId of ['first', 'second', 'first']) {
    store.observe(handle, { usageReceipts: [{ ...row, requestId }] });
  }
  const report = store.read(identity, 1);
  assert.equal(report.summary.requests, 2);
  assert.equal(report.quality.unknown, 2);
  assert.equal(report.recent[0].tokens, null);
  assert.equal(report.bySource[0].key, 'model_check');
});

test('a confirmed Pi call with SDK placeholder counters has unknown usage', t => {
  const { identity, handle, store } = fixture(t);
  store.observe(handle, { usageReceipts: [{ localOnly: true, agent: 'pi', at: Date.now(),
    model: 'local:model-' + 'a'.repeat(32), usage: { input: 0, output: 0, totalTokens: 0,
      cost: { total: 0 }, costKnown: false } }] });
  const report = store.read(identity, 7);
  assert.equal(report.summary.requests, 1);
  assert.equal(report.summary.tokens, 0);
  assert.equal(report.quality.unknown, 1);
});

test('uses Beijing calendar days and counts one conversation across two models on separate days', t => {
  const { identity, handle, store } = fixture(t);
  const now = Date.parse('2026-11-21T16:03:00Z');
  t.mock.method(Date, 'now', () => now);
  const atMidnight = Date.parse('2026-11-21T16:00:00Z');
  const rows = [0, 1].map((n) => ({ agent: 'pi', localOnly: true, at: atMidnight - 1 + n,
    model: 'local:model-' + String(n).repeat(32), usage: { totalTokens: 10 + n } }));
  store.observe(handle, { usageReceipts: rows });
  const today = store.read(identity, 1), twoDays = store.read(identity, 2);
  assert.equal(today.summary.tokens, 11);
  assert.equal(twoDays.summary.sessions, 1);
  assert.deepEqual(twoDays.trend.map(row => [row.key, row.tokens]), [['2026-11-21', 10], ['2026-11-22', 11]]);
  assert.equal(twoDays.byAgent.length, 2);
  const { rank } = require('../core/usage-metrics');
  const [pi] = rank([twoDays], 'agent');
  assert.equal(pi.tokens, 21);
  assert.equal(pi.sessions, undefined);
  assert.deepEqual(rank([twoDays], 'model').map(row => row.sessions), [1, 1]);
  assert.equal(rank([today, today], 'scene')[0].sessions, undefined);
});

test('Hub 100, device 40, Hub 60 retain separate totals across replay', async t => {
  const { app, handle, store } = fixture(t);
  const identity = { hub: 'https://fixture.invalid', clientId: 'device',
    session: require('./helpers/platform-session-fixture.cjs').sessions().renewed };
  const scope = { ...identity, accountScope: require('../main/conversation/runtime-segments').scope(identity) };
  handle.usageIdentity = scope;
  const posted = [];
  const reporter = require('../main/agent-runtime/usage-reporter').createUsageReporter({
    app, identityOf: async () => identity, fetchImpl: async (_url, init) => {
      posted.push(JSON.parse(init.body));
      return Response.json({ ok: true });
    },
  });
  const at = Date.now() - 100;
  const receipts = [
    { agent: 'pi', provider: 'org', model: 'demo', at, usage: { total: 100 } },
    { agent: 'pi', localOnly: true, model: 'private-test-model', at: at+1, usage: { total: 40 } },
    { agent: 'opencode', provider: 'org', model: 'demo', at: at+2, usage: { total: 60 } },
  ];
  for (const length of [1, 2, 3, 3]) {
    const snapshot = { usageReceipts: receipts.slice(0, length) };
    store.observe(handle, snapshot);
    reporter.observe(handle, snapshot);
    await reporter.flush();
  }
  assert.deepEqual(posted.map(row => row.usage.total), [100,160]);
  assert.doesNotMatch(JSON.stringify(posted), /private-test-model/);
  const local = createLocalUsage(app).read(scope, 7);
  assert.equal(local.summary.tokens, 40);
  assert.equal(local.summary.tokens + posted.at(-1).usage.total, 200);
});

test('recovers owned first-dispatch Kimi receipts before reopening a chat', t => {
  const { root, app, identity } = fixture(t);
  const crypto = require('node:crypto');
  function archive(owner, hub, agent, localOnly, tokens) {
    const ref = crypto.randomUUID();
    const dir = path.join(root, 'runner/data/local-runs', ref);
    const bindings = path.join(root, 'session-memory-bindings');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(bindings, { recursive: true });
    const binding = crypto.createHash('sha256').update(ref).digest('hex') + '.json';
    fs.writeFileSync(path.join(bindings, binding), JSON.stringify({ owner, hub, ids: [] }));
    const receipt = { agent, localOnly, reportable: !localOnly, provider: '', at: Date.now(), usage: { total: tokens } };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ref, cli: agent, round: 1,
      admissionKey: 'dispatch:' + ref, taskId: 'chat-sample', eventDestination: 'local', usageReceipts: [receipt] }));
    return { ref, receipt };
  }
  const { ref, receipt } = archive(identity.accountScope, identity.hub, 'kimi', true, 120);
  archive('different-owner', identity.hub, 'kimi', true, 200);
  archive(identity.accountScope, 'https://other.invalid', 'kimi', true, 300);
  archive(identity.accountScope, identity.hub, 'kimi', false, 400);
  for (let i = 0; i < 2; i++) {
    const reopened = createLocalUsage(app);
    const report = reopened.read(identity, 7);
    assert.equal(report.summary.tokens, 120);
    assert.equal(report.byAgent[0].agent, 'kimi');
    reopened.observe({ sessionId: ref, usageIdentity: identity }, { usageReceipts: [receipt] });
    assert.equal(reopened.read(identity, 7).summary.tokens, 120);
  }
});
