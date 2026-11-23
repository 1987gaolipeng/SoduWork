'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const entry = pathToFileURL(path.resolve(__dirname, '../../hub-backend/app/services/dsh_acp_settlement.mjs')).href;
const load = () => import(entry);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function idleAgent() {
  return { status: 'idle', session: { seq: 7 }, whenIdle: async () => {} };
}

test('DSH settlement joins descendants and waits for the parent turn they wake', { timeout: 3000 }, async () => {
  const { waitForSettlement } = await load();
  const child = deferred(), parent = deferred(), joined = deferred(), resumed = deferred();
  const agent = idleAgent();
  let idleCalls = 0, childCalls = 0, settled = false;
  agent.whenIdle = () => {
    idleCalls++;
    if (idleCalls === 1) return Promise.resolve();
    resumed.resolve();
    return parent.promise;
  };
  const subagents = { waitForChildren: async exactParent => {
    assert.equal(exactParent, agent);
    childCalls++;
    if (childCalls > 1) return false;
    joined.resolve();
    await child.promise;
    agent.status = 'running';
    agent.session.seq++;
    return true;
  } };
  const pending = waitForSettlement(agent, subagents, new AbortController().signal).then(() => { settled = true; });
  await joined.promise;
  await tick();
  assert.equal(settled, false, 'parent idle alone must not finish the prompt');
  child.resolve();
  await resumed.promise;
  assert.equal(settled, false, 'child completion must not skip its newly awakened parent');
  agent.status = 'idle';
  agent.session.seq++;
  parent.resolve();
  await pending;
  assert.equal(childCalls, 2, 'recheck the native descendant graph after the parent resumes');
});

test('DSH settlement leaves idle resident children alone and rechecks changed parent sequence', async () => {
  const { waitForSettlement } = await load();
  const agent = idleAgent();
  let checks = 0;
  await waitForSettlement(agent, { waitForChildren: async actual => {
    assert.equal(actual, agent);
    checks++;
    if (checks === 1) agent.session.seq++;
    // Native waitForChildren returns false for idle parked inboxes. Their
    // residency is not evidence of progressing work and must not block forever.
    return false;
  } }, new AbortController().signal);
  assert.equal(checks, 2);
});

test('DSH settlement trusts native nested-child progress even without a changed parent sequence', async () => {
  const { waitForSettlement } = await load();
  const agent = idleAgent();
  let checks = 0;
  await waitForSettlement(agent, { waitForChildren: async actual => {
    assert.equal(actual, agent);
    return ++checks < 3;
  } }, new AbortController().signal);
  assert.equal(checks, 3, 'each joined descendant generation requires another parent completion check');
});

test('DSH settlement propagates descendant failure and rejects a missing native contract', async () => {
  const { waitForSettlement } = await load();
  const failure = new Error('synthetic child join failure');
  await assert.rejects(waitForSettlement(idleAgent(), { waitForChildren: async () => { throw failure; } },
    new AbortController().signal), error => error === failure);
  await assert.rejects(waitForSettlement(idleAgent(), {}, new AbortController().signal));
  await assert.rejects(waitForSettlement({}, { waitForChildren: async () => false }, new AbortController().signal));
  for (const seq of [undefined, -1, NaN]) {
    const agent = idleAgent();
    agent.session.seq = seq;
    await assert.rejects(waitForSettlement(agent, { waitForChildren: async () => false }, new AbortController().signal));
  }
});

test('DSH settlement propagates parent failure and cancellation while the parent is still busy', { timeout: 3000 }, async () => {
  const { waitForSettlement } = await load();
  const failure = new Error('synthetic parent idle failure');
  const subagents = { waitForChildren: () => assert.fail('a busy or failed parent cannot settle descendants') };
  await assert.rejects(waitForSettlement({ ...idleAgent(), whenIdle: async () => { throw failure; } },
    subagents, new AbortController().signal), error => error === failure);
  const started = deferred(), never = deferred(), controller = new AbortController();
  const pending = waitForSettlement({ ...idleAgent(), whenIdle: () => {
    started.resolve();
    return never.promise;
  } }, subagents, controller.signal);
  const rejected = assert.rejects(pending, /synthetic parent cancellation/);
  await started.promise;
  controller.abort(new Error('synthetic parent cancellation'));
  await rejected;
  never.reject(new Error('late parent failure after cancellation'));
  await tick();
});

test('DSH settlement cancellation interrupts an unresolved descendant wait', { timeout: 3000 }, async () => {
  const { waitForSettlement } = await load();
  const started = deferred(), never = deferred(), controller = new AbortController();
  const pending = waitForSettlement(idleAgent(), { waitForChildren: () => {
    started.resolve();
    return never.promise;
  } }, controller.signal);
  const rejected = assert.rejects(pending, /synthetic cancellation/);
  await started.promise;
  controller.abort(new Error('synthetic cancellation'));
  await rejected;
});

// Verbatim prompt-settlement closure from @openma/deepseek-harness-acp
// 0.4.40 / 0.4.41, Copyright 2026 The @openma/deepseek-harness-acp authors.
// Licensed Apache-2.0; see ../../third-party/licenses/deepseek-harness-acp-LICENSE.txt.
// https://github.com/openma-ai/deepseek-harness-acp (dist/bridge.js).
// The two published builds differ only in this closure's resolve binding.
// Keeping the actual closure makes anchor/hash changes fail visibly.
function settlementBlock(version) {
  const block = [
    '        const stopReason = await new Promise((resolve2, reject) => {',
    '          const inflight = { resolve: resolve2, reject, messageId: message.id, turn: void 0 };',
    '          record.inflight = inflight;',
    '          try {',
    '            deliverPrompt(record.agent, message, false);',
    '          } catch (error) {',
    '            record.inflight = void 0;',
    '            const detail = error instanceof Error ? error.message : String(error);',
    '            throw internalError(`prompt was not queued: ${detail}`);',
    '          }',
    '          void record.agent.whenIdle().then(() => {',
    '            if (record.inflight !== inflight) return;',
    '            record.inflight = void 0;',
    '            if (record.cancelled) {',
    '              resolve2("cancelled");',
    '              return;',
    '            }',
    '            const end = inflight.turn !== void 0 ? record.projection.turnEndFor(inflight.turn) ?? record.projection.lastTurnEnd : record.projection.lastTurnEnd;',
    '            resolve2(end === void 0 ? "cancelled" : turnEndToStopReason(end));',
    '          });',
    '        });',
  ].join('\n');
  return version === '0.4.40' ? block.replace('resolve: resolve2', 'resolve').replaceAll('resolve2', 'resolve') : block;
}
function turnEndBlock() {
  return `  onTurnEnd(data) {
    const reason = data["reason"];
    const turn = data["turn"];
    if (reason !== null && typeof reason === "object") {
      const r = reason;
      if (typeof turn === "number") this.window.turnEnds.set(turn, r);
      this.window.lastTurnEnd = r;
      if (r.kind === "error" && this.window.error === void 0) {
        this.window.error = { message: r.error?.message ?? "model turn failed" };
      }
    }
    this.toolCallBlocks.clear();
    this.toolCalls.clear();
    this.streamedToolOutput.clear();
    this.toolResultValues.clear();
    return [];
  }`;
}
function fixtureSource(version) {
  return [
    'export class Projection {',
    turnEndBlock(),
    '}',
    'const internalError = detail => new Error(detail);',
    'const errorChain2 = error => error?.message || String(error);',
    'const looksLikeAuthFailure = () => false;',
    'const authError = internalError;',
    'const turnEndToStopReason = end => end.kind === "max-tokens" ? "max_tokens" : end.kind === "interrupted" ? "cancelled" : "end_turn";',
    'export async function prompt(record, subagents, deliverPrompt = () => {}) {',
    '  const message = { id: "synthetic-prompt" };',
    settlementBlock(version),
    '        const usage = record.projection.promptUsage();',
    '  return { stopReason };',
    '}',
  ].join('\n');
}
async function promptFixture(version) {
  const { transformBridgeSource } = await load();
  const transformed = transformBridgeSource(fixtureSource(version), version);
  return import('data:text/javascript;base64,' + Buffer.from(transformed).toString('base64'));
}
function recordFixture() {
  return { agent: idleAgent(), inflight: undefined, cancelled: false,
    projection: { lastTurnEnd: { kind: 'completed' }, turnError: undefined,
      promptUsage: () => undefined,
      turnEndFor: () => ({ kind: 'completed' }) } };
}

for (const version of ['0.4.40', '0.4.41']) {
  test('DSH ' + version + ' transformed prompt uses the last parent ending and reports errors', async () => {
    const { prompt } = await promptFixture(version);
    for (const outcome of ['max-tokens', 'error']) {
      const record = recordFixture();
      let calls = 0;
      const pending = prompt(record, { waitForChildren: async () => {
        if (++calls > 1) return false;
        record.agent.session.seq++;
        record.projection.lastTurnEnd = outcome === 'error'
          ? { kind: 'error', error: { message: 'synthetic resumed parent error' } }
          : { kind: outcome };
        return true;
      } }, () => { record.inflight.turn = 1; });
      if (outcome === 'error') await assert.rejects(pending, /synthetic resumed parent error/);
      else assert.equal((await pending).stopReason, 'max_tokens');
      assert.equal(record.inflight, undefined);
    }
  });

  test('DSH ' + version + ' cancelled prompt cannot settle or clear a replacement prompt', { timeout: 3000 }, async () => {
    const { prompt } = await promptFixture(version);
    const record = recordFixture(), joined = deferred(), child = deferred();
    const oldPrompt = prompt(record, { waitForChildren: () => { joined.resolve(); return child.promise; } });
    await joined.promise;
    const original = record.inflight;
    record.cancelled = true;
    record.inflight = undefined;
    original.resolve('cancelled');
    const replacement = { resolve: () => assert.fail('old waiter resolved the replacement'),
      reject: () => assert.fail('old waiter rejected the replacement') };
    record.inflight = replacement;
    record.cancelled = false;
    assert.equal((await oldPrompt).stopReason, 'cancelled');
    child.reject(new Error('late child failure after cancellation'));
    await tick();
    assert.equal(record.inflight, replacement);
  });

  test('DSH ' + version + ' transformed prompt rejects native join failure instead of hanging', async () => {
    const { prompt } = await promptFixture(version);
    const record = recordFixture();
    await assert.rejects(prompt(record, { waitForChildren: async () => {
      throw Error('synthetic native join failed');
    } }), /synthetic native join failed/);
    assert.equal(record.inflight, undefined);
  });

  test('DSH ' + version + ' prompt preserves earlier turn failure and admission failure', async () => {
    const { prompt } = await promptFixture(version);
    const failed = recordFixture();
    failed.projection.turnError = { message: 'synthetic earlier parent failure' };
    await assert.rejects(prompt(failed, { waitForChildren: async () => false }), /synthetic earlier parent failure/);
    assert.equal(failed.inflight, undefined);
    const unqueued = recordFixture();
    await assert.rejects(prompt(unqueued, { waitForChildren: () => assert.fail('unadmitted prompt cannot join') },
      () => { throw Error('synthetic admission failure'); }), /synthetic admission failure/);
    assert.equal(unqueued.inflight, undefined);
  });
}

test('DSH source transform fails closed for unknown versions and changed or duplicate settlement blocks', async () => {
  const { transformBridgeSource } = await load();
  assert.throws(() => transformBridgeSource(fixtureSource('0.4.41'), '0.4.42'));
  for (const version of ['0.4.40', '0.4.41']) {
    const source = fixtureSource(version);
    assert.throws(() => transformBridgeSource(source.replace('record.agent.whenIdle()', 'record.agent.changedWhenIdle()'), version));
    assert.throws(() => transformBridgeSource(source + '\n' + settlementBlock(version), version));
    assert.throws(() => transformBridgeSource('export const unrelated = true;', version));
    assert.throws(() => transformBridgeSource(source.replace('this.toolCalls.clear()', 'this.toolCalls.changedClear()'), version));
    assert.throws(() => transformBridgeSource(source + '\n' + turnEndBlock(), version));
  }
});

test('DSH Node preload patches all three packaged bridges and preserves unrelated modules', { timeout: 15000 }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork dsh 测试-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const adapter = path.join(temporary, 'node_modules', '@openma', 'deepseek-harness-acp');
  const unrelated = path.join(temporary, 'other vendor', 'deepseek-harness-acp');
  await Promise.all([adapter, unrelated].map(directory => fs.mkdir(path.join(directory, 'dist'), { recursive: true })));
  await fs.writeFile(path.join(unrelated, 'package.json'), JSON.stringify({ name: 'unrelated-fixture', type: 'module' }));
  await fs.writeFile(path.join(unrelated, 'dist', 'plugin.js'), fixtureSource('0.4.41'));
  const urls = ['bridge.js', 'server.js', 'plugin.js'].map(name => {
    const url = pathToFileURL(path.join(adapter, 'dist', name));
    url.searchParams.set('fixture', 'space and 中文');
    return url.href;
  });
  const outside = pathToFileURL(path.join(unrelated, 'dist', 'plugin.js')).href;
  const script = `
    import assert from 'node:assert/strict';
    const outcomes = [];
    for (const [url, expected] of [...${JSON.stringify(urls)}.map(url => [url, 'max_tokens']), [${JSON.stringify(outside)}, 'end_turn']]) {
      const { prompt } = await import(url);
      let joins = 0;
      const record = {
        agent: { status: 'idle', session: { seq: 1 }, whenIdle: async () => {} },
        cancelled: false,
        projection: { lastTurnEnd: { kind: 'max-tokens' }, turnError: undefined,
          turnEndFor: () => ({ kind: 'completed' }), promptUsage: () => undefined }
      };
      const result = await prompt(record, { waitForChildren: async actual => {
        assert.equal(actual, record.agent); joins++; return false;
      } }, () => { record.inflight.turn = 1; });
      assert.equal(result.stopReason, expected);
      assert.equal(joins, expected === 'max_tokens' ? 1 : 0);
      outcomes.push(result.stopReason);
    }
    assert.equal(process.env.SODUWORK_DSH_ACP_SETTLEMENT, undefined);
    assert.equal(process.env.NODE_OPTIONS, undefined);
    process.stdout.write(JSON.stringify(outcomes));
  `;
  const env = {};
  for (const key of ['PATH', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, { NODE_OPTIONS: '--import=' + entry, SODUWORK_DSH_ACP_SETTLEMENT: '1' });
  const run = () => spawnSync(process.execPath, ['--input-type=module', '--eval', script],
    { env, cwd: temporary, encoding: 'utf8', timeout: 5000, windowsHide: true });
  for (const version of ['0.4.40', '0.4.41']) {
    await fs.writeFile(path.join(adapter, 'package.json'), JSON.stringify({ name: '@openma/deepseek-harness-acp', type: 'module', version }));
    await Promise.all(['bridge.js', 'server.js', 'plugin.js'].map(name => fs.writeFile(path.join(adapter, 'dist', name), fixtureSource(version))));
    const result = run();
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['max_tokens', 'max_tokens', 'max_tokens', 'end_turn']);
  }
  await fs.writeFile(path.join(adapter, 'package.json'), JSON.stringify({ name: '@openma/deepseek-harness-acp', type: 'module', version: '0.4.42' }));
  const unsupported = run();
  assert.equal(unsupported.error, undefined);
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /prompt interface is unsupported \(0\.4\.42\)/);
  assert.equal(unsupported.stdout, '', 'an unreviewed adapter must fail before prompt execution');
});

for (const version of ['0.4.40', '0.4.41']) {
  test('DSH ' + version + ' truncation settles only discarded native pending previews', async () => {
    const { Projection } = await promptFixture(version);
    for (const reason of [{ kind: 'max-tokens' }, { kind: 'completed' }, { kind: 'interrupted' },
      { kind: 'error', error: { message: 'synthetic failure' } }, null]) {
      const projection = new Projection();
      const states = ['pending', 'in_progress', 'completed', 'failed'];
      Object.assign(projection, {
        window: { turnEnds: new Map() },
        toolCalls: new Map(states.map(status => [status, { callId: status, status }])),
        toolCallBlocks: new Map([['block', 'pending']]),
        streamedToolOutput: new Map([['completed', 'result']]),
        toolResultValues: new Map([['completed', {}]])
      });
      assert.deepEqual(projection.onTurnEnd({ turn: 3, reason }), reason?.kind === 'max-tokens' ? [{
        sessionUpdate: 'tool_call_update', toolCallId: 'pending', status: 'failed',
        _meta: { soduwork: { toolOutcome: 'not-executed', reason: 'output-limit' } }
      }] : []);
      for (const name of ['toolCalls', 'toolCallBlocks', 'streamedToolOutput', 'toolResultValues']) {
        assert.equal(projection[name].size, 0, name + ' retains its native cleanup');
      }
      if (reason) {
        assert.equal(projection.window.lastTurnEnd, reason);
        assert.equal(projection.window.turnEnds.get(3), reason);
      }
      if (reason?.kind === 'error') assert.equal(projection.window.error.message, 'synthetic failure');
      assert.deepEqual(projection.onTurnEnd({ turn: 3, reason }), [], 'no duplicate preview ending');
    }
  });
}
