'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const goal = require('../main/agent-runtime/runner-task-goal');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const catalog = require('../main/agent-runtime/runtime-catalog');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); } throw Error('Goal observation timed out'); }
const prompt = '请创建首页及 12 个内容页，每页至少 6 章节。\n请分阶段实际写入文件并验证页面链接，持续完成整个任务。\n保留 RUN_ID.txt，每完成阶段更新 PROGRESS.md。';
const receipt = (status, extra = {}) => ({ status, reason: '', objective: prompt, acceptance: '',
  elapsedMs: 120000, steps: 7, budgetMs: 240 * 60000, maxSteps: 1000, continuations: 1, ...extra });

test('explicit UI goal uses existing defaults and bounded user budget without changing Pi contracts', () => {
  assert.deepEqual(goal.fromOptions({ intent: 'goal', goal: 'Create site', acceptance: 'Verify links' }), {
    schemaVersion: 1, objective: 'Create site', acceptance: 'Verify links', budgetMinutes: 240, maxSteps: 1000,
  });
  assert.equal(goal.fromOptions({ intent: 'goal', goal: 'Site', budgetMinutes: 30, maxSteps: 90 }).budgetMinutes, 30);
  assert.equal(goal.fromOptions({ intent: 'goal', goal: 'Site', budgetMinutes: 9999, maxSteps: 9999 }).maxSteps, 5000);
  assert.equal(goal.fromOptions({ intent: 'chat', goal: 'Site' }), null);
  for (const agent of ['pi', 'claude', 'custom-runtime']) assert.equal(goal.supported(agent), false);
});

async function fixture(t, settings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-task-goal-'));
  const calls = [];
  let observed = settings.observed || { status: 'done', taskGoal: receipt('completed') };
  const runtime = { async rpc(op, input) {
    calls.push({ op, input });
    if (op === 'runtime.models') return { ok: true, data: { ok: true, catalogAvailable: true, models: [{ id: 'account-model' }] } };
    if (op === 'runtime.detect') return { ok: true, data: { accessControl: {
      schema: 'soduwork.access-policy/v1', supported: true, modes: ['standard', 'readonly', 'full'],
    } } };
    if (op === 'job.dispatch') return { ok: true, data: {
      ref: _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', input.dispatchId), state: 'running',
    } };
    if (op === 'job.comment') return { ok: true, data: { ok: true, state: 'running' } };
    if (op === 'job.stop') {
      if (settings.stop) return settings.stop(input);
      observed = { status: 'stopped', taskGoal: receipt(input.taskGoalControl === 'disable' ? 'disabled' : 'paused', { reason: '已暂停' }) };
      return { ok: true, data: { ok: true, taskGoal: observed.taskGoal } };
    }
    if (op === 'job.session') return settings.read ? settings.read(input) : { ok: true, data: { ok: true, ref: input.ref,
      items: [{ seq: 1, kind: 'say', text: 'Native progress' }], ...observed } };
    throw Error('Unexpected operation: ' + op);
  } };
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime(settings.agent || 'dsh'), runnerRuntime: runtime,
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'synthetic', baseUrl: 'http://fixture.invalid', key: 'fixture-key' } }) } });
  const session = await adapter[settings.resume ? 'resumeSession' : 'createSession']({ identity: {}, native: { runner: { openOptions: {
    cwd: root, ref: 'goal-fixture', ...(settings.resume ? {
      resumePath: 'persisted-goal', accessPolicy: {
        schema: 'soduwork.access-policy/v1', revision: 1, mode: 'standard', workspaceRoot: root,
      },
    } : {}), ...settings.options,
  } } } });
  const handle = getRunnerSessionDetails(session).handle;
  t.after(async () => { await session.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { calls, handle, session, setObserved(value) { observed = value; }, count: op => calls.filter(c => c.op === op).length };
}

function goalFixture(t, settings = {}) {
  return fixture(t, { ...settings, options: { intent: 'goal', goal: prompt, ...settings.options } });
}

for (const agent of ['dsh', 'kimi', 'qwen', 'opencode', 'codex-harness', 'codex']) {
  test(agent + ' keeps ordinary task instructions in chat without inferring a persistent goal', async t => {
    const f = await fixture(t, { agent });
    f.setObserved({ status: 'done' });
    for (const text of [prompt, 'Please keep working until the entire task is complete.']) {
      assert.equal((await f.handle.submit(text, []).completion).ok, true);
      assert.equal(f.handle.goalView().intent, '');
      assert.equal(f.handle.snapshot().execution.visible, false);
      assert.equal(f.handle.snapshot().taskGoal, undefined);
    }
    const dispatch = f.calls.find(c => c.op === 'job.dispatch').input;
    const comment = f.calls.find(c => c.op === 'job.comment').input;
    assert.equal(dispatch.ctx.taskGoal, undefined);
    assert.equal(dispatch.ctx.conversationMode, 'adaptive');
    assert.equal(comment.taskGoal, undefined);
    assert.equal(comment.taskGoalControl, undefined);
    assert.equal(f.count('job.dispatch'), 1);
    assert.equal(f.count('job.comment'), 1);
  });

  test(agent + ' does not promote a later ordinary message into a goal', async t => {
    const f = await fixture(t, { agent });
    f.setObserved({ status: 'done' });
    await f.handle.submit('介绍一下当前目录', []).completion;
    await f.handle.submit(prompt, []).completion;
    assert.equal(f.handle.goalView().intent, '');
    assert.equal(f.handle.snapshot().execution.visible, false);
    assert.equal(f.calls.find(c => c.op === 'job.comment').input.taskGoal, undefined);
    assert.equal(f.count('job.comment'), 1);
  });

  test(agent + ' passes one explicit goal to Runner and never creates a desktop continuation loop', async t => {
    const f = await fixture(t, { agent, options: { intent: 'goal', goal: prompt } });
    assert.equal((await f.handle.submit(prompt, []).completion).ok, true);
    const dispatch = f.calls.find(c => c.op === 'job.dispatch').input;
    assert.deepEqual(dispatch.ctx.taskGoal, goal.fromOptions({ intent: 'goal', goal: prompt }));
    assert.equal(dispatch.ctx.conversationMode, 'goal');
    assert.equal(f.handle.snapshot().taskGoal.status, 'completed');
    assert.equal(f.handle.snapshot().execution.elapsedMs, 120000);
    assert.equal(f.handle.snapshot().execution.step, 7);
    assert.equal(f.count('job.comment'), 0);
    assert.equal(f.count('job.dispatch'), 1);
  });
}

test('UI goal preserves its acceptance and user budgets in dispatch', async t => {
  const f = await fixture(t, { options: { intent: 'goal', goal: 'Deliver site', acceptance: '13 pages with verified links', budgetMinutes: 45, maxSteps: 80 } });
  await f.handle.submit('开始', []).completion;
  assert.deepEqual(f.calls.find(c => c.op === 'job.dispatch').input.ctx.taskGoal, {
    schemaVersion: 1, objective: 'Deliver site', acceptance: '13 pages with verified links', budgetMinutes: 45, maxSteps: 80,
  });
});

test('ordinary follow-up instructions do not reopen a completed configured goal', async t => {
  const f = await goalFixture(t);
  await f.handle.submit(prompt, []).completion;
  await f.handle.submit(prompt, []).completion;
  const comment = f.calls.find(c => c.op === 'job.comment').input;
  assert.equal(comment.taskGoal, undefined);
  assert.equal(comment.taskGoalControl, undefined);
  assert.equal(f.count('job.dispatch'), 1);
  assert.equal(f.count('job.comment'), 1);
  assert.equal(f.handle.snapshot().taskGoal.status, 'completed');
});

test('reopening a saved paused goal retains its contract and resumes without creating a new goal', async t => {
  const f = await fixture(t, { resume: true,
    observed: { status: 'stopped', taskGoal: receipt('paused', { reason: 'Awaiting user continuation' }) },
  });
  await until(() => f.handle.snapshot().taskGoal?.status === 'paused');
  assert.equal(f.handle.goalView().intent, 'goal');
  assert.equal(f.handle.goalView().goal, prompt);
  assert.equal(f.count('job.dispatch'), 0);
  f.setObserved({ status: 'done', taskGoal: receipt('completed', { elapsedMs: 180000 }) });
  const resumed = f.handle.continueGoal();
  assert.equal(resumed.accepted, true);
  assert.equal((await resumed.completion).ok, true);
  const comment = f.calls.find(c => c.op === 'job.comment').input;
  assert.equal(comment.ref, 'persisted-goal');
  assert.equal(comment.taskGoalControl, 'continue');
  assert.equal(comment.taskGoal, undefined);
  assert.equal(f.handle.snapshot().execution.budgetMs, 240 * 60000);
  assert.equal(f.handle.snapshot().execution.elapsedMs, 180000);
});

test('paused receipts remain paused and explicit continue retains the original cumulative budget', async t => {
  const f = await goalFixture(t);
  f.setObserved({ status: 'stopped', taskGoal: receipt('paused', { reason: '需要补充确认' }) });
  assert.equal((await f.handle.submit(prompt, []).completion).ok, true);
  await delay(0);
  assert.equal(f.handle.snapshot().execution.paused, true);
  assert.equal(f.handle.snapshot().execution.harness.phase, 'paused');
  assert.equal(f.handle.snapshot().execution.limitRequest.reason, '需要补充确认');
  f.setObserved({ status: 'done', taskGoal: receipt('completed', { elapsedMs: 180000, steps: 10, continuations: 2 }) });
  const continued = f.handle.continueGoal();
  assert.equal(continued.accepted, true);
  await continued.completion;
  const comment = f.calls.find(c => c.op === 'job.comment').input;
  assert.equal(comment.taskGoalControl, 'continue');
  assert.equal(comment.taskGoal, undefined, 'continuation cannot reset a task contract or budget');
  assert.equal(comment.recordUser, false);
  assert.equal(f.handle.snapshot().execution.elapsedMs, 180000);
  assert.equal(f.handle.snapshot().execution.budgetMs, 240 * 60000);
});

test('budget exhaustion cannot be reset by continue; disabling an idle goal does not launch a model', async t => {
  const f = await goalFixture(t);
  f.setObserved({ status: 'stopped', taskGoal: receipt('paused', { elapsedMs: 240 * 60000, reason: '达到任务时间预算' }) });
  await f.handle.submit(prompt, []).completion;
  await delay(0);
  assert.equal(f.handle.continueGoal().ok, false);
  assert.equal(f.handle.snapshot().execution.canContinue, false);
  assert.equal(f.handle.snapshot().execution.limitRequest.used, 240);
  assert.equal(f.handle.snapshot().execution.limitRequest.unit, '分钟');
  assert.equal(f.count('job.comment'), 0);
  assert.equal(f.handle.disableGoal().ok, true);
  await until(() => !f.handle.snapshot().execution.recoveryRequired);
  assert.equal(f.calls.find(c => c.op === 'job.stop').input.taskGoalControl, 'disable');
  assert.equal(f.handle.snapshot().execution.visible, false);
  assert.equal(f.handle.goalView().intent, '');
  assert.equal(f.count('job.comment'), 0);
  f.setObserved({ status: 'done', taskGoal: receipt('disabled') });
  await f.handle.submit('请列出文件', []).completion;
  assert.equal(f.calls.find(c => c.op === 'job.comment').input.taskGoal, undefined);
});

test('pause requires stop acknowledgment and native terminal observation before another goal turn', async t => {
  let ack;
  const f = await goalFixture(t, { stop: () => new Promise(resolve => { ack = resolve; }) });
  f.setObserved({ status: 'running', taskGoal: receipt('working') });
  const first = f.handle.submit(prompt, []);
  await until(() => f.count('job.session') > 0);
  assert.equal(f.handle.pauseGoal().ok, true);
  await first.completion;
  assert.equal(f.handle.continueGoal().ok, false);
  assert.equal(f.calls.find(c => c.op === 'job.stop').input.taskGoalControl, 'pause');
  f.setObserved({ status: 'stopped', taskGoal: receipt('paused') });
  ack({ ok: true, data: { ok: true, taskGoal: receipt('paused') } });
  await until(() => !f.handle.snapshot().execution.recoveryRequired);
  f.setObserved({ status: 'done', taskGoal: receipt('completed') });
  const next = f.handle.continueGoal();
  assert.equal(next.accepted, true);
  await next.completion;
  assert.equal(f.count('job.comment'), 1);
});

test('a new user message explicitly resumes a paused goal without adding an internal turn', async t => {
  const f = await goalFixture(t);
  f.setObserved({ status: 'stopped', taskGoal: receipt('paused') });
  await f.handle.submit(prompt, []).completion;
  await delay(0);
  f.setObserved({ status: 'done', taskGoal: receipt('completed', { elapsedMs: 180000 }) });
  const sent = f.handle.submit('补充要求：使用蓝色导航，并继续完成。', []);
  assert.equal(sent.accepted, true);
  assert.equal((await sent.completion).ok, true);
  const comments = f.calls.filter(c => c.op === 'job.comment');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].input.text, '补充要求：使用蓝色导航，并继续完成。');
  assert.equal(comments[0].input.taskGoalControl, 'continue');
  assert.equal(comments[0].input.recordUser, true);
  assert.equal(comments[0].input.taskGoal, undefined);
});

test('a stop acknowledgment arriving during an old poll schedules a fresh terminal confirmation', async t => {
  let completeRead, reads = 0;
  const f = await goalFixture(t, { read: input => ++reads === 1
    ? new Promise(resolve => { completeRead = () => resolve({ ok: true, data: { ok: true, ref: input.ref,
      status: 'running', items: [], taskGoal: receipt('working') } }); })
    : { ok: true, data: { ok: true, ref: input.ref, status: 'stopped', items: [], taskGoal: receipt('paused') } } });
  const initial = f.handle.submit(prompt, []);
  await until(() => Boolean(completeRead));
  f.handle.pauseGoal();
  await initial.completion;
  await delay(5);
  assert.equal(f.handle.snapshot().execution.recoveryRequired, true);
  assert.equal(f.handle.continueGoal().ok, false);
  completeRead();
  await until(() => !f.handle.snapshot().execution.recoveryRequired);
  assert.equal(reads, 2);
  assert.equal(f.handle.snapshot().execution.paused, true);
  assert.equal(f.count('job.comment'), 0);
});

test('failed preparation before a resumed goal admission keeps the original pause and the next user continue control', async t => {
  const f = await goalFixture(t);
  f.setObserved({ status: 'stopped', taskGoal: receipt('paused', { reason: '需要补充输入' }) });
  await f.handle.submit(prompt, []).completion;
  await delay(0);
  const blocked = f.handle.submit('补充条件并继续', [], { beforeTurn: async () => { throw Error('Preparation denied'); } });
  assert.equal((await blocked.completion).ok, false);
  await delay(0);
  assert.equal(f.count('job.comment'), 0);
  assert.equal(f.handle.snapshot().execution.paused, true);
  assert.equal(f.handle.snapshot().execution.limitRequest.reason, '需要补充输入');
  f.setObserved({ status: 'done', taskGoal: receipt('completed') });
  const retry = f.handle.submit('重新准备后继续', []);
  assert.equal(retry.accepted, true);
  assert.equal((await retry.completion).ok, true);
  const comments = f.calls.filter(c => c.op === 'job.comment');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].input.taskGoalControl, 'continue');
  assert.equal(comments[0].input.text, '重新准备后继续');
  assert.equal(comments[0].input.taskGoal, undefined);
});

test('continue button resumes the first queued user instruction once after a goal pauses', async t => {
  const f = await goalFixture(t);
  f.setObserved({ status: 'running', taskGoal: receipt('working') });
  const initial = f.handle.submit(prompt, []);
  await until(() => f.count('job.session') > 0);
  const queued = f.handle.submit('导航使用蓝色', []);
  f.setObserved({ status: 'stopped', taskGoal: receipt('paused') });
  await initial.completion;
  await delay(0);
  assert.equal(f.count('job.comment'), 0);
  assert.equal(f.handle.snapshot().queued, 1);
  f.setObserved({ status: 'done', taskGoal: receipt('completed') });
  const resumed = f.handle.continueGoal();
  assert.equal(resumed.accepted, true);
  await resumed.completion;
  assert.equal((await queued.completion).ok, true);
  const comments = f.calls.filter(c => c.op === 'job.comment');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].input.text, '导航使用蓝色');
  assert.equal(comments[0].input.taskGoalControl, 'continue');
  assert.equal(comments[0].input.recordUser, true);
});

test('failed disable retains visible retry controls and never admits another turn before confirmation', async t => {
  let attempts = 0;
  const f = await goalFixture(t, { stop: async () => {
    if (++attempts === 1) return { ok: false, error: 'Stop refused' };
    f.setObserved({ status: 'stopped', taskGoal: receipt('disabled') });
    return { ok: true, data: { ok: true, taskGoal: receipt('disabled') } };
  } });
  await f.handle.submit(prompt, []).completion;
  await delay(0);
  f.handle.disableGoal();
  await until(() => f.handle.snapshot().execution.visible);
  assert.equal(f.handle.snapshot().execution.canContinue, false);
  assert.equal(f.handle.submit('继续', []).accepted, false);
  assert.equal(f.count('job.comment'), 0);
  f.handle.disableGoal();
  await until(() => !f.handle.snapshot().execution.recoveryRequired);
  assert.equal(f.handle.snapshot().execution.visible, false);
  assert.equal(attempts, 2);
});

test('structured goal pauses suppress only their own error while unrelated native failures stay visible', async t => {
  for (const failureKind of ['task_goal', 'authentication']) {
    const f = await goalFixture(t);
    f.setObserved({ status: 'stopped', failureKind, error: 'Failure detail',
      taskGoal: receipt('blocked', { reason: 'Need verification' }) });
    const result = await f.handle.submit(prompt, []).completion;
    assert.equal(result.ok, failureKind === 'task_goal');
    assert.equal(f.handle.snapshot().status, failureKind === 'task_goal' ? 'idle' : 'unreachable');
  }
});

test('renderer restores dynamic Runner goal controls and leaves Pi snapshots untouched', () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-session-controller.js'), 'utf8'), { window });
  const ctx = { _sessionOptions: { adapterId: 'dsh', modelName: 'chosen' } };
  const controller = window.ChatSessionController.create(ctx);
  ctx._snap = { adapterId: 'dsh', taskGoal: receipt('paused') };
  controller._syncRunnerTaskGoal();
  assert.equal(ctx._sessionOptions.intent, 'goal');
  assert.equal(ctx._sessionOptions.goal, prompt);
  assert.equal(ctx._sessionOptions.budgetMinutes, 240);
  assert.equal(ctx._sessionOptions.modelName, 'chosen');
  const runnerOptions = ctx._sessionOptions;
  controller._syncRunnerTaskGoal({ adapterId: 'pi', taskGoal: receipt('disabled') });
  assert.equal(ctx._sessionOptions, runnerOptions);
  controller._syncRunnerTaskGoal({ adapterId: 'dsh', taskGoal: receipt('disabled') });
  assert.equal(ctx._sessionOptions.mode, 'chat');
  assert.equal(ctx._sessionOptions.goal, '');
});
