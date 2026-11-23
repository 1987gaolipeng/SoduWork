'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const catalog = require('../main/agent-runtime/runtime-catalog');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, fixes, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-plugin-gate-'));
  const file = path.join(root, 'soduwork-plugin-draft.json'), calls = [], observed = [];
  let round = 1, exposedInvalidCompletion = false;
  const body = { template: 'method', key: 'draft-check', name: 'Draft check', version: '1.0.1', description: 'Fixture', instructions: 'Summarize input' };
  const write = valid => {
    fs.writeFileSync(file, valid ? JSON.stringify(body) : '{"name":"invalid "quote""}');
    if (Number.isFinite(options.writeAt)) fs.utimesSync(file, options.writeAt / 1000, options.writeAt / 1000);
    else if (options.fileTime) fs.utimesSync(file, options.fileTime, options.fileTime);
  };
  if (options.existingInvalid) write(false);
  const runtime = { async rpc(op, value) {
    calls.push({ op, value });
    if (op === 'job.dispatch') {
      fs.writeFileSync(path.join(root, 'requested-report.txt'), 'Requested report');
      if (options.htmlOnly) {
        fs.writeFileSync(path.join(root, 'report.html'), '<!doctype html><h1>Preview</h1>');
        if (options.htmlOnly === 'manifest') {
          fs.mkdirSync(path.join(root, '.soduwork'));
          fs.writeFileSync(path.join(root, '.soduwork/delivery.json'), JSON.stringify({
            schemaVersion: 1, deliverables: [{ path: 'report.html' }],
          }));
        }
      } else if (!options.leaveDraftUntouched) write(Boolean(options.validFirst));
      return { ok: true, data: { ok: true, ref: _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', value.dispatchId) } };
    }
    if (op === 'job.comment') { round++; write(options.goalScenario && round === 2 ? false : fixes); if (options.switchOwnerOnRepair) handle.deliveryOwner = 'changed-owner'; return { ok: true, data: { ok: true, state: 'running' } }; }
    if (op === 'job.session') return { ok: true, data: { ok: true, status: 'done', round, seq: round + 1, items: [
      ...(round === 1 ? [{ seq: 1, kind: 'user', text: 'Make a plugin' }] : []),
      { seq: round + 1, kind: 'say', text: 'Draft produced' },
    ] } };
    return { ok: true, data: { ok: true } };
  } };
  const model = { ok: true, model: { id: 'fixture', key: 'fixture', input: ['text'] } }, app = { getPath: () => root };
  const adapter = createRunnerRuntimeAdapter({ app, runnerRuntime: runtime, runtimeSpec: { ...catalog.runtime('opencode'), goalMode: 'native' },
    modelConfig: { fetchModel: async () => model, fetchSelection: async () => model } });
  const session = await adapter.createSession({ identity: {}, native: { runner: { openOptions: {
    app, cwd: root, ref: 'chat-plugin-gate', intent: options.goalScenario ? 'goal' : '',
    resolvePlugins: async ids => ({ items: ids.map(pluginId => ({ pluginId, name: 'Plugin Developer', context: 'Create a reusable plugin package.' })) }),
  } } } });
  const handle = getRunnerSessionDetails(session).handle;
  handle.on((_event, snapshot) => {
    if (snapshot.status === 'idle' && fs.existsSync(file)) {
      try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { exposedInvalidCompletion = true; }
    }
  });
  t.after(async () => { await session.dispose(); await delay(20); fs.rmSync(root, { recursive: true, force: true }); });
  const turn = handle.submit('Make a plugin', [], { pluginIds: options.htmlOnly ? ['local:plugin-builder'] : [],
    afterTurn: (state, result) => observed.push({ state, result }) });
  return { turn, handle, calls, observed, file, invalidCompletion: () => exposedInvalidCompletion };
}

for (const source of ['manifest', 'inferred']) test('Runner selected authoring plugin cannot complete with only ' + source + ' HTML', async t => {
  const f = await fixture(t, true, { htmlOnly: source }), result = await f.turn.completion;
  assert.equal(result.ok, true, result.reason);
  assert.equal(f.calls.filter(row => row.op === 'job.comment').length, 1);
  assert.equal(f.calls.find(row => row.op === 'job.comment').value.recordUser, false);
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).key, 'draft-check');
  assert.equal(f.handle.outputSnapshot().pluginValidation[0].state, 'ready');
  assert.equal(f.observed.length, 1);
  assert.match(fs.readFileSync(path.join(path.dirname(f.file), 'report.html'), 'utf8'), /Preview/);
});
test('Runner repairs the final draft before logical success and without a duplicate user message', async t => {
  const f = await fixture(t, true), result = await f.turn.completion;
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.status, 'idle');
  assert.equal(result.snapshot.execution.running, false);
  assert.deepEqual(result.snapshot.fileChanges.files.map(row => [row.path,row.action]),
    [['requested-report.txt','created'],['soduwork-plugin-draft.json','created']]);
  assert.equal(result.snapshot.messages.length, f.handle.snapshot().messages.length);
  assert.equal(f.invalidCompletion(), false, 'invalid drafts must not publish completed presence before validation');
  assert.equal(f.calls.filter(row => row.op === 'job.comment').length, 1);
  assert.equal(f.calls.find(row => row.op === 'job.comment').value.recordUser, false);
  assert.equal(f.handle.snapshot().messages.filter(row => row.role === 'user').length, 1);
  assert.equal(f.observed.length, 1);
  assert.equal(f.observed[0].state, 'completed');
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).key, 'draft-check');
  assert.equal(f.handle.outputSnapshot().pluginValidation[0].state, 'ready');
});
test('Runner stops after two invalid repairs and reports logical failure', async t => {
  const f = await fixture(t, false), result = await f.turn.completion;
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, 'plugin-validation');
  assert.equal(f.calls.filter(row => row.op === 'job.comment').length, 2);
  assert.equal(f.observed.length, 1);
  assert.equal(f.observed[0].state, 'failed');
  assert.equal(f.handle.outputSnapshot().pluginValidation[0].state, 'invalid');
});
test('Runner validates draft writes at the rounded session boundary', async t => {
  const since = 1700000000123;
  t.mock.method(Date, 'now', () => since);
  for (const fixes of [false, true]) {
    const f = await fixture(t, fixes, { writeAt: since - 0.125 });
    const result = await f.turn.completion;
    const mtime = fs.statSync(f.file).mtimeMs;
    assert.ok(mtime < since && Math.round(mtime) === since, 'The fixture must exercise fractional filesystem precision');
    assert.equal(result.ok, fixes);
    assert.equal(f.calls.filter(row => row.op === 'job.comment').length, fixes ? 1 : 2);
    assert.equal(f.observed[0].state, fixes ? 'completed' : 'failed');
    assert.equal(f.handle.outputSnapshot().pluginValidation[0].state, fixes ? 'ready' : 'invalid');
    if (!fixes) assert.equal(result.failureKind, 'plugin-validation');
  }
});
test('Runner identity change during draft repair ends validation as cancelled', async t => {
  const f = await fixture(t, true, { switchOwnerOnRepair: true }), result = await f.turn.completion;
  assert.equal(result.cancelled, true);
  assert.equal(f.handle.snapshot().status, 'aborted');
  assert.equal(f.observed[0].state, 'stopped');
});

test('new invalid drafts cannot bypass Runner validation when file time precedes the conversation', async t => {
  const fileTime = new Date(Date.now() - 60000);
  const f = await fixture(t, false, { fileTime }), result = await f.turn.completion;
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, 'plugin-validation');
  assert.equal(f.calls.filter(row => row.op === 'job.comment').length, 2);
  assert.equal(f.observed[0].state, 'failed');
  assert.equal(f.handle.outputSnapshot().pluginValidation[0].state, 'invalid');
});

test('backdated draft repair still cancels when the Runner owner changes', async t => {
  const f = await fixture(t, true, { fileTime: new Date(Date.now() - 60000), switchOwnerOnRepair: true });
  assert.equal((await f.turn.completion).cancelled, true);
  assert.equal(f.handle.snapshot().status, 'aborted');
  assert.equal(f.observed[0].state, 'stopped');
});

test('an untouched invalid draft predating a Runner conversation is not repaired or exposed', async t => {
  const f = await fixture(t, false, { fileTime: new Date(Date.now() - 60000),
    existingInvalid: true, leaveDraftUntouched: true });
  assert.equal((await f.turn.completion).ok, true);
  assert.equal(f.calls.filter(row => row.op === 'job.comment').length, 0);
  const snapshot = f.handle.outputSnapshot();
  assert.equal(snapshot.files.some(row => row.path === f.file), false);
  assert.deepEqual(snapshot.pluginValidation, []);
});
test('Runner resumed native goal validates the generated draft before completing', async t => {
  const f = await fixture(t, true, { validFirst: true, goalScenario: true });
  assert.equal((await f.turn.completion).ok, true);
  assert.equal(f.handle.pauseGoal().ok, true);
  await waitFor(() => f.handle.snapshot().execution.terminalConfirmed);
  const continuation = f.handle.continueGoal();
  assert.equal(continuation.ok, true);
  const result = await continuation.completion;
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.filter(row => row.op === 'job.comment').map(row => row.value.taskGoalControl),
    ['continue', undefined]);
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).key, 'draft-check');
  assert.equal(f.handle.outputSnapshot().pluginValidation[0].state, 'ready');
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('Timed out waiting for the Runner state transition');
}

for (const control of ['pause', 'disable']) {
  test(control + ' during follow-up baseline scanning reaches the existing native goal', async t => {
    const f = await fixture(t, true, { goalScenario: true, validFirst: true });
    await f.turn.completion;
    const outputs = require('../main/pi-session/outputs'), scan = outputs.scanAsync;
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    t.mock.method(outputs, 'scanAsync', async (...args) => {
      enter();
      await blocked;
      return scan(...args);
    });
    const next = f.handle.submit('Review the plugin', []);
    await entered;
    const queued = control === 'pause' ? f.handle.submit('Check the report', []) : null;
    assert.equal(f.handle[control + 'Goal']().ok, true);
    assert.equal(f.calls.some(row => row.op === 'job.stop'), false);
    release();
    await next.completion;
    await waitFor(() => f.calls.some(row => row.op === 'job.stop') && f.handle.snapshot().execution.terminalConfirmed);
    assert.deepEqual(f.calls.filter(row => row.op === 'job.stop').map(row => row.value.taskGoalControl), [control]);
    assert.equal(f.calls.some(row => row.op === 'job.comment'), false);
    if (queued) {
      const resume = f.handle.continueGoal();
      assert.equal(resume.accepted, true);
      assert.equal((await resume.completion).ok, true);
      assert.equal((await queued.completion).ok, true);
      const messages = f.calls.filter(row => row.op === 'job.comment' && row.value.recordUser !== false);
      assert.deepEqual(messages.map(row => [row.value.text, row.value.taskGoalControl]),
        [['Review the plugin', 'continue'], ['Check the report', undefined]]);
      assert.equal(f.handle.snapshot().messages.filter(row => row.role === 'user' && row.text === 'Review the plugin').length, 1);
    }
  });
}

test('a goal paused before dispatch resumes the original request with one user message', async t => {
  const outputs = require('../main/pi-session/outputs');
  const scan = outputs.scanAsync;
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  t.mock.method(outputs, 'scanAsync', async (...args) => {
    enter();
    await pending;
    return scan(...args);
  });
  const f = await fixture(t, true, { goalScenario:true, validFirst:true });
  await entered;
  assert.equal(f.handle.pauseGoal().ok, true);
  release();
  assert.equal((await f.turn.completion).paused, true);
  assert.equal(f.calls.some(row => row.op.startsWith('job.')), false);
  const continued = f.handle.continueGoal();
  assert.equal(continued.accepted, true);
  assert.equal((await continued.completion).ok, true);
  assert.equal(f.calls.filter(row => row.op === 'job.dispatch').length, 1);
  assert.equal(f.calls.find(row => row.op === 'job.dispatch').value.ctx.conversationUserText, 'Make a plugin');
  assert.equal(f.calls.some(row => row.op === 'job.comment'), false);
  assert.equal(f.handle.snapshot().messages.filter(row => row.role === 'user').length, 1);
});

test('a paused goal cannot resume while its original draft validation is still active', async t => {
  const cache = require('../main/app-resource-cache.cjs'), request = cache.request;
  let entered, release, waiting = true;
  const checking = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  t.mock.method(cache, 'request', async input => {
    if (input.action === 'draft-check' && waiting) {
      waiting = false; entered(); await pending;
    }
    return request(input);
  });
  const f = await fixture(t, true, { goalScenario: true });
  await checking;
  assert.equal(f.handle.pauseGoal().ok, true);
  await delay(10);
  assert.ok(f.calls.some(row => row.op === 'job.stop'));
  assert.ok(f.handle.snapshot().execution.turnQueue.activeQueueId);
  const continued = f.handle.continueGoal();
  release();
  const result = await f.turn.completion;
  if (continued.completion) await continued.completion;
  assert.equal(continued.ok, false, 'resume must not revive a paused validation callback');
  assert.equal(result.cancelled, true);
  assert.equal(f.calls.filter(row => row.op === 'job.comment').length, 0);
});

function blockFirstCall(t, target, method, matches) {
  const original = target[method];
  let enter, release, blocked = false;
  const entered = new Promise(resolve => { enter = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  t.mock.method(target, method, async function (...args) {
    if (!blocked && matches(...args)) {
      blocked = true;
      enter();
      await pending;
    }
    return original.apply(this, args);
  });
  t.after(release);
  return { entered, release };
}

test('disabling a goal before its first dispatch releases the next ordinary message', async t => {
  const baseline = blockFirstCall(t, require('../main/pi-session/outputs'), 'scanAsync', () => true);
  const f = await fixture(t, true, { goalScenario: true, validFirst: true });
  await baseline.entered;
  assert.equal(f.handle.disableGoal().ok, true);
  baseline.release();
  assert.equal((await f.turn.completion).cancelled, true);
  assert.deepEqual(f.calls.filter(row => row.op.startsWith('job.')), []);

  const next = f.handle.submit('List the available files', []);
  assert.equal(next.accepted, true);
  await waitFor(() => f.calls.some(row => row.op === 'job.dispatch'));
  assert.equal((await next.completion).ok, true);
  const dispatches = f.calls.filter(row => row.op === 'job.dispatch');
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].value.ctx.conversationUserText, 'List the available files');
  assert.equal(dispatches[0].value.ctx.conversationMode, 'adaptive');
  assert.equal(dispatches[0].value.ctx.taskGoal, undefined);
});

test('confirmed native goal disable prevents a delayed invalid draft check from starting a repair', async t => {
  const validation = blockFirstCall(t, require('../main/app-resource-cache.cjs'), 'request',
    input => input.action === 'draft-check');
  const f = await fixture(t, true, { goalScenario: true });
  await validation.entered;
  let confirmed = false;
  const unsubscribe = f.handle.on(event => {
    if (event.kind === 'goal-stop-confirmed') confirmed = true;
  });
  t.after(unsubscribe);
  assert.equal(f.handle.disableGoal().ok, true);
  await waitFor(() => confirmed);
  const stop = f.calls.findIndex(row => row.op === 'job.stop' && row.value.taskGoalControl === 'disable');
  assert.ok(stop >= 0);
  assert.ok(f.calls.slice(stop + 1).some(row => row.op === 'job.session'));
  assert.equal(f.handle.snapshot().execution.visible, false);
  validation.release();
  assert.equal((await f.turn.completion).cancelled, true);
  assert.equal(f.calls.filter(row => row.op === 'job.comment').length, 0);
});
