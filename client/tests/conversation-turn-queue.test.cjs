const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const { createTurnQueue } = require('../main/pi-session/turn-queue');

test('preflight failure belongs to its submission and survives snapshots until a fresh turn or explicit control', async () => {
  const queue = createTurnQueue();
  const failed = queue.add({text:'根据截图重新生成封面'});
  const error = '当前模型未启用原生图片输入';
  await queue.run(queue.take(), async () => {throw Error(error);});
  assert.equal(queue.state().paused, true);
  assert.deepEqual(queue.state().failure, {queueId:failed.id,reason:error});
  queue.state().failure.reason='不得覆盖内部回执';
  assert.equal(queue.state().failure.reason,error);
  assert.equal(queue.resetIfIdle(),true);
  assert.equal(queue.state().failure,null);
  queue.pause('用户明确暂停');
  assert.equal(queue.state().failure,null);
  assert.equal(queue.resetIfIdle(),false);
  queue.resume();
  const success=queue.add({text:'新的文字请求'});
  await queue.run(queue.take(),async()=>({ok:true}));
  assert.equal((await success.completion).ok,true);
  assert.equal(queue.state().paused,false);
  assert.equal(queue.state().failure,null);
});

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('conversation follow-ups remain FIFO and expose stable queue positions', async () => {
  let tick = 1000;
  const queue = createTurnQueue(() => ++tick);
  const first = queue.add({ text: '继续做前端', attachments: [{ name: '界面.png' }] });
  const second = queue.add({ text: '完成后再复核', attachments: [] });

  assert.deepEqual(queue.view().map((row) => [row.text, row.position]), [
    ['继续做前端', 1], ['完成后再复核', 2],
  ]);
  assert.deepEqual(queue.view()[0].attachments, ['界面.png']);
  assert.equal(queue.take(), first);
  assert.equal(queue.take(), second);
  queue.complete(first, { ok: true, round: 2 });
  queue.complete(second, { ok: true, round: 3 });
  assert.deepEqual(await first.completion, { ok: true, round: 2 });
  assert.deepEqual(await second.completion, { ok: true, round: 3 });
});

test('queued conversation turns can be cancelled without disturbing their neighbours', async () => {
  const queue = createTurnQueue(() => 2000);
  const keep = queue.add({ text: '保留这条' });
  const remove = queue.add({ text: '取消这条' });
  const cancelled = queue.cancel(remove.id);

  assert.equal(cancelled, remove);
  assert.deepEqual(queue.view().map((row) => row.text), ['保留这条']);
  assert.deepEqual(await remove.completion, { ok: true, cancelled: true, queued: true });
  queue.clear({ ok: false, reason: '会话已关闭' });
  assert.deepEqual(await keep.completion, { ok: false, reason: '会话已关闭' });
});

test('runtime, IPC and renderer share one queue contract instead of visually reordering events', () => {
  const session = read('main', 'pi-session', 'session.js');
  const runControl = read('main', 'pi-session', 'run-control.js');
  const runner = read('main', 'agent-runtime', 'runner-adapter.js');
  const ipc = read('main', 'pi-session', 'ipc.js');
  const preload = read('preload.js');
  const chat = read('components', 'panels', 'panels-chat.js');
  const tools = read('components', 'panels', 'panels-chat-tools.js');

  assert.match(session, /submit\(text, turnAttachments, sendOptions\)/);
  assert.match(session, /fromQueue: true/);
  assert.match(session, /queueMicrotask\((?:ctx\.)?_drainTurns\)/);
  assert.match(session, /queueView: \(\) => ctx\.turnQueue\.view\(\)/);
  assert.match(session, /turnQueue\.stopActive\(\)/);
  assert.match(runner, /manualStopRequested/);
  assert.match(runner, /turnQueue\.stopActive\(\)/);
  assert.match(runControl, /queue: ctx\.queueView\(\)/);
  assert.ok(session.indexOf('if ((ctx.inFlight || ctx.turnQueue.size())')
    < session.indexOf('await ctx.opts.resolvePlugins'),
  'queued turns must not mint plugin grants before reaching the queue head');
  assert.match(session, /pluginIds: effectivePluginIds/);
  assert.match(session, /pluginIds: ctx\.goalPluginIds\.slice\(\)/);
  assert.ok(session.indexOf('if ((ctx.inFlight || ctx.turnQueue.size())')
    < session.indexOf('if (turn.clearPluginSelection === true) ctx.persistPluginSelection'),
  'queued drafts must not change the conversation selection before execution');
  assert.match(ipc, /s\.submit\(text, staged\.files, sendOptions\)/);
  assert.match(ipc, /pi-session-queue-cancel/);
  assert.match(preload, /cancelQueued:.*pi-session-queue-cancel/);
  assert.match(chat, /id="nchatQueue"/);
  assert.match(chat, /data-queue-draggable draggable="true"/);
  assert.match(chat, /待发送队列/);
  assert.match(chat, /(?:ctx\.)?_runtimeBusy\(\) && !ChatTools\.composerHasPayload\(el, (?:ctx\.)?_messageAttachments\)/);
  assert.match(tools, /busy \? '\\u6392\\u961f\\u53d1\\u9001' : '\\u53d1\\u9001'/);
  assert.doesNotMatch(chat, /(?:ctx\.)?_snap && (?:ctx\.)?_snap\.status === 'streaming'\) \{ (?:ctx\.)?_cancel\(\)/);
  assert.doesNotMatch(chat, /sort\([^)]*tools/);
});

test('a failed turn names the item and the reason instead of an anonymous pause', async () => {
  /*
   * Identify both the paused queue item and its failure reason.
   */
  let tick = 0;
  const queue = createTurnQueue(() => ++tick);

  const thrown = queue.add({ text: '帮我看这张图', attachments: [{ name: '8f67b781-3f86-49.png' }] });
  const outcome = await queue.run(queue.take(), async () => {
    throw new Error('附件读取失败');
  });
  assert.equal(outcome.ok, false);
  const thrownState = queue.state();
  assert.equal(thrownState.paused, true);
  assert.match(thrownState.reason, /帮我看这张图/);
  assert.match(thrownState.reason, /附件读取失败/);
  queue.resume();
  assert.equal(queue.state().paused, false);

  const result = queue.add({ text: '排队指令', options: {} });
  await queue.run(queue.take(), async () => ({ ok: false, failureKind: 'output-incomplete' }));
  assert.equal(result.completion instanceof Promise, true);
  const state = queue.state();
  assert.equal(state.paused, true);
  assert.match(state.reason, /排队指令/);
  assert.match(state.reason, /output-incomplete|尚未完成/);
});

test('task turns surface their title in the pause banner', async () => {
  let tick = 0;
  const queue = createTurnQueue(() => ++tick);
  queue.add({ text: '', options: { taskId: 't1', taskTitle: '整理月报' } });
  await queue.run(queue.take(), async () => ({ ok: false, reason: '输出被截断' }));
  assert.match(queue.state().reason, /整理月报/);
  assert.match(queue.state().reason, /输出被截断|输出被截|月报/);
});

test('an explicit follow-up after a terminal stall runs before older queued work without overlapping', async () => {
  let release;
  const queue = createTurnQueue(() => 1000);
  const active = queue.add({ text: '原始请求' });
  const running = queue.run(queue.take(), () => new Promise(resolve => { release = resolve; }));
  queue.add({ text: '停滞前已排队' });
  const retry = queue.add({ text: 'go', options: { resumeAfterTerminalAt: 42 } });
  const followUp = queue.add({ text: '继续检查', options: { resumeAfterTerminalAt: 42 } });

  assert.deepEqual(queue.view().map(row => row.text), ['go', '继续检查', '停滞前已排队']);
  assert.equal(queue.active(), active);
  release({ ok: false, failureKind: 'agent-stall', terminalAt: 42 });
  await running;

  assert.equal(queue.state().paused, false);
  assert.equal(queue.take(), retry);
  assert.equal(queue.take(), followUp);
});

test('a follow-up submitted after the terminal stall settles clears only its automatic pause', async () => {
  const queue = createTurnQueue(() => 1000);
  queue.add({ text: '原始请求' });
  await queue.run(queue.take(), async () => ({
    ok: false,
    failureKind: 'agent-stall',
    terminalAt: 42,
  }));
  assert.equal(queue.state().paused, true);

  const retry = queue.add({ text: 'go', options: { resumeAfterTerminalAt: 42 } });
  assert.equal(queue.state().paused, false);
  assert.equal(queue.take(), retry);

  queue.pause('用户明确暂停');
  queue.add({ text: '不能越过明确暂停', options: { resumeAfterTerminalAt: 42 } });
  assert.equal(queue.state().paused, true);
  assert.match(queue.state().reason, /用户明确暂停/);
});
