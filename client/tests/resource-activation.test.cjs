'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { create } = require('../main/pi-session/resource-activation');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function state() { return { session: { sessionManager: {}, model: {}, thinkingLevel: 'medium' },
  resources: { extensionsDeferred: true }, policy: null }; }
for (const mutation of ['cancel', 'closed', 'policy', 'model', 'thinking', 'changing', 'replacement']) {
  test('deferred resource activation cannot overwrite ' + mutation, async () => {
    let live = state(), release, closed = false, commits = 0, prepared = 0, disposed = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const controller = create({ current: () => live, closed: () => closed,
      load: async () => ({ resourceLoader: { getExtensions: () => ({ runtime: { invalidate: () => { disposed++; } } }) } }),
      prepare: async (_, original) => { prepared++; await gate; return { session: {
        sessionManager: original.session.sessionManager, dispose: () => { disposed++; } } }; },
      commit: () => { commits++; } });
    const work = controller.ensure(); await delay(0); assert.equal(prepared, 1);
    if (mutation === 'cancel') controller.cancel();
    if (mutation === 'closed') closed = true;
    if (mutation === 'policy') live.policy = { mode: 'standard' };
    if (mutation === 'model') live.session.model = {};
    if (mutation === 'thinking') live.session.thinkingLevel = 'high';
    if (mutation === 'changing') live.changing = true;
    if (mutation === 'replacement') live = state();
    release(); const result = await work;
    assert.equal(result.ok, false); assert.equal(commits, 0); assert.equal(disposed, 2);
    assert.equal(controller.busy(), false);
  });
}
test('a restoration failure retains the old runtime and supports retry', async () => {
  let live = state(), loads = 0, commits = 0;
  const old = live.session;
  const controller = create({ current: () => live,
    load: async () => ({ degraded: ++loads === 1 }),
    prepare: async () => ({ session: { sessionManager: old.sessionManager } }),
    commit: next => { commits++; live = next; } });
  const failure = await controller.ensure(); assert.equal(failure.failureKind, 'session-resources');
  assert.equal(live.session, old); assert.equal(commits, 0);
  const first = controller.ensure(), second = controller.ensure(); assert.equal(first, second);
  assert.equal((await first).ok, true); assert.equal(commits, 1); assert.equal(loads, 2);
});
test('production history follow-up restores extensions and completes real tool execution once', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-resume-production-'));
  const fixture = await require('../e2e/fixtures/resumed-pi.cjs').create(root);
  t.after(async () => { await fixture.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const handle = await fixture.open();
  assert.equal(fs.existsSync(fixture.loaded), false, 'opening history remains lightweight');
  assert.equal(fixture.requests.length, 0);
  fixture.reply((body, count) => count === 1 ? { text: '现在立即执行补检索，一次到位。' }
    : body.messages.at(-1).role === 'tool' ? { text: '报告补充已完成，检索来源已核实。' }
      : { tool: 'web_search', args: { query: 'isolated report' } });
  const result = await handle.submit('继续完善报告，请补检索并完成。').completion;
  assert.equal(result.ok, true, result.reason);
  assert.ok(fixture.requests[0].tools.some(tool => tool.function.name === 'web_search'));
  assert.equal(fixture.requests.length, 3);
  assert.equal(fs.readFileSync(fixture.executed, 'utf8'), 'isolated report\n');
  assert.equal(fs.readFileSync(fixture.loaded, 'utf8'), 'loaded\n');
  assert.match(JSON.stringify(handle.snapshot()), /报告补充已完成/);
  assert.equal(handle.snapshot().status, 'idle');
  assert.equal(handle.sessionId, fixture.sdk.SessionManager.open(fixture.resumePath).getSessionId());
  assert.ok(fs.readFileSync(fixture.resumePath, 'utf8').startsWith(fixture.archivePrefix));
  const before = fixture.requests.length;
  fixture.reply(() => ({ text: '现在立即执行补检索，一次到位。' }));
  const incomplete = await handle.submit('继续完善报告，请实际检索。').completion;
  assert.equal(fixture.requests.length - before, 2, 'at most one semantic recovery when there is no progress');
  assert.equal(incomplete.ok, false); assert.equal(incomplete.failureKind, 'output-incomplete');
  assert.equal(incomplete.retrySafe, false); assert.equal(handle.snapshot().status, 'incomplete');
  assert.equal(fs.readFileSync(fixture.executed, 'utf8'), 'isolated report\n', 'old side effects are not replayed');
});
test('default permissions keep extensions isolated; upgrading restores them at the next idle send', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-resume-policy-'));
  const fixture = await require('../e2e/fixtures/resumed-pi.cjs').create(root);
  t.after(async () => { await fixture.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const rules = require('../main/access-control/policy');
  const policy = rules.create('standard', fixture.cwd);
  const handle = await fixture.open({ accessPolicy: policy });
  fixture.reply(() => ({ text: '这是普通说明。' }));
  assert.equal((await handle.submit('解释一下术语。').completion).ok, true);
  assert.equal(fs.existsSync(fixture.loaded), false);
  assert.ok(!fixture.requests[0].tools.some(tool => tool.function.name === 'web_search'));
  const changed = await handle.setAccessPolicy(rules.next('full', fixture.cwd, policy, policy.revision), policy.revision);
  assert.equal(changed.ok, true, changed.reason); assert.equal(fs.existsSync(fixture.loaded), false);
  assert.equal((await handle.submit('解释一下术语。').completion).ok, true);
  assert.ok(fixture.requests.at(-1).tools.some(tool => tool.function.name === 'web_search'));
  assert.equal(handle.snapshot().accessPolicy.mode, 'full');
});
test('cancelling production restoration does not send a model request and the next turn still works', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-resume-cancel-'));
  const fixture = await require('../e2e/fixtures/resumed-pi.cjs').create(root, { loadDelay: 180 });
  t.after(async () => { await fixture.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const handle = await fixture.open();
  const submitted = handle.submit('继续完善报告。');
  while (!handle.snapshot().execution.running) await delay(5);
  handle.cancel(); const result = await submitted.completion;
  assert.equal(result.cancelled, true); assert.equal(fixture.requests.length, 0);
  assert.equal(handle.snapshot().execution.running, false);
  assert.equal((await handle.submit('解释一下术语。').completion).ok, true);
  assert.equal(fixture.requests.length, 1);
  assert.ok(fixture.requests[0].tools.some(tool => tool.function.name === 'web_search'));
});
test('production restoration timeout is explicit, sends nothing and retains an intact retryable archive', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-resume-timeout-'));
  const fixture = await require('../e2e/fixtures/resumed-pi.cjs').create(root, { loadDelay: 400 });
  t.after(async () => { await fixture.close(); await delay(450); fs.rmSync(root, { recursive: true, force: true }); });
  const handle = await fixture.open({ resourceLoadTimeoutMs: 250 });
  const result = await handle.submit('继续完善报告。').completion;
  assert.equal(result.ok, false); assert.equal(result.failureKind, 'session-resources');
  assert.equal(result.retrySafe, true); assert.equal(fixture.requests.length, 0);
  assert.equal(handle.snapshot().execution.running, false);
  assert.match(result.reason, /恢复超时/);
  assert.ok(fs.readFileSync(fixture.resumePath, 'utf8').startsWith(fixture.archivePrefix));
});
