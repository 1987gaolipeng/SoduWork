'use strict';
// Production Pi session/SDK + local HTTP model fixture + real files. No account,
// remote model, or user workspace is used by this lifecycle regression.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const artifacts = require('../main/conversation/artifact-runtime');
const packages = require('../main/conversation/delivery-package');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 400; i++) { if (check()) return; await wait(10); }
  throw Error('Local delivery fixture did not reach the expected boundary');
}
function streamPartial(response, text) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write('data: ' + JSON.stringify({
    id: 'partial-fixture', object: 'chat.completion.chunk', model: 'fixture-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  }) + '\n\n');
  // Delivery fencing is under test, not an indefinitely open provider socket.
  // Bound this synthetic response even if the SDK delays transport teardown.
  const deadline = setTimeout(() => response.end('data: [DONE]\n\n'), 2000);
  response.once('close', () => clearTimeout(deadline));
}
function watchPartial(t, handle, text) {
  let seen = false;
  t.after(handle.on(event => { if (event.block?.text?.includes(text)) seen = true; }));
  return () => seen;
}
async function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-direct-delivery-'));
  const f = await require('../e2e/fixtures/resumed-pi.cjs').create(root);
  t.after(async () => { await f.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await f.open(overrides);
  return f;
}
async function capture(handle) {
  assert.equal(handle.snapshot().status, 'idle');
  assert.equal(handle.inFlight(), true, 'the next instruction is fenced until bytes are captured');
  const files = artifacts.snapshot(handle).items.filter(file => file.primary !== false && file.changedInTurn);
  assert.ok(files.length, 'the actual written file retains changedInTurn at the completion boundary');
  return packages.prepare(handle, files.map(file => file.artifactId), { completedTurn: true });
}

test('direct Pi completion captures immutable bytes before a queued turn overwrites the same file', { timeout: 20000 }, async t => {
  const f = await fixture(t), captured = [];
  f.reply((_body, count) => count % 2 ? { tool: 'write', args: { path: 'report.md', content: '# Revision ' + count } }
    : { text: '报告已经完成：report.md。' });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(release);
  f.handle.captureDelivery = async () => {
    const payload = await capture(f.handle); captured.push(payload.bytes.toString());
    if (captured.length === 1) await held;
  };
  const direct = f.handle.send('请生成第一份报告。', [], { internal: true });
  await until(() => captured.length === 1);
  const next = f.handle.submit('请把报告改为第二版。');
  assert.equal(next.queued, true);
  await wait(50);
  assert.equal(f.requests.length, 2, 'no second model request can run while direct capture is held');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'report.md'), 'utf8'), '# Revision 1');
  release();
  assert.equal((await direct).ok, true);
  assert.equal((await next.completion).ok, true);
  assert.deepEqual(captured, ['# Revision 1', '# Revision 3'], 'queued completion must not capture twice');
  assert.equal(f.handle.inFlight(), false);
});

test('explicit continueGoal captures only the accepted final answer after a blocked quality result', { timeout: 20000 }, async t => {
  const f = await fixture(t, { resumePath: '', intent: 'goal', goal: '用一句话回答用户', acceptance: '输出“你好。”' });
  const captured = [];
  let captureError;
  f.reply((_body, count) => {
    const file = path.join(f.cwd, 'goal-report.md');
    fs.writeFileSync(file, '# Goal revision ' + count);
    if (count === 2) {
      // Reproduce filesystem/JS clock precision drift without sleeping or
      // changing the turn boundary: the content journal must retain this edit.
      const at = new Date(f.handle.outputSnapshot().turnSince - 1);
      fs.utimesSync(file, at, at);
    }
    return { text: count === 1 ? '问候语尚未满足要求。' : '你好。' };
  });
  f.handle.captureDelivery = async () => {
    try { captured.push((await capture(f.handle)).bytes.toString()); }
    catch (error) { captureError = error; throw error; }
  };
  const first = f.handle.submit('请完成目标。');
  await first.completion;
  assert.equal(f.handle.snapshot().execution.quality.phase, 'blocked');
  assert.equal(captured.length, 0, 'failed quality is not a completed delivery');
  const continued = f.handle.continueGoal();
  assert.equal(continued.accepted, true);
  const result = await continued.completion;
  assert.equal(result.ok, true);
  assert.equal(f.handle.snapshot().execution.quality.phase, 'reviewed');
  assert.ifError(captureError); // Production treats optional capture errors as nonfatal.
  assert.deepEqual(captured, ['# Goal revision 2']);
  assert.equal((await f.handle.outputSnapshotAsync()).files.find(file => file.name === 'goal-report.md').changedInTurn, true);
  f.handle.captureDelivery = undefined;
  f.reply(() => ({ text: '本轮仅回答，没有修改文件。' }));
  await f.handle.send('无需修改文件。', [], { internal: true, goalMode: false });
  assert.equal(f.handle.outputSnapshot().files.find(file => file.name === 'goal-report.md').changedInTurn, false,
    'A subsequent unchanged turn must not inherit the completed journal');
});

test('failed or cancelled direct Pi requests never capture a partial result', { timeout: 20000 }, async t => {
  const f = await fixture(t); let captures = 0;
  f.handle.captureDelivery = async () => { captures++; };
  f.reply(() => ({ respond(response) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'isolated request rejected' } }));
  } }));
  const failed = await f.handle.send('请处理失败样本。', [], { internal: true });
  assert.notEqual(require('../main/pi-session/task-turn').resultState(failed), 'completed');
  assert.equal(captures, 0);
  const count = f.requests.length;
  const received = watchPartial(t, f.handle, 'isolated partial cancellation');
  f.reply(() => ({ respond(response) {
    streamPartial(response, 'isolated partial cancellation');
  } }));
  const pending = f.handle.send('请处理取消样本。', [], { internal: true });
  // Wait for actual streamed content, not just server-side request receipt.
  await until(() => f.requests.length > count && received());
  f.handle.cancel();
  await pending;
  assert.equal(captures, 0);
});

test('pausing an explicit goal continuation does not archive its partial files', { timeout: 20000 }, async t => {
  const f = await fixture(t, { resumePath: '', intent: 'goal', goal: '直接回答用户', acceptance: '输出“你好。”' });
  let captures = 0;
  f.handle.captureDelivery = async () => { captures++; };
  f.reply(() => ({ text: '还没有满足约定内容。' }));
  await f.handle.submit('请完成目标。').completion;
  assert.equal(f.handle.snapshot().execution.quality.phase, 'blocked');
  const count = f.requests.length;
  const received = watchPartial(t, f.handle, 'isolated partial goal continuation');
  f.reply(() => ({ respond(response) {
    fs.writeFileSync(path.join(f.cwd, 'partial.md'), '# Not a final delivery');
    streamPartial(response, 'isolated partial goal continuation');
  } }));
  const continued = f.handle.continueGoal();
  assert.equal(continued.accepted, true);
  await until(() => f.requests.length > count && received());
  f.handle.pauseGoal();
  const result = await continued.completion;
  assert.notEqual(require('../main/pi-session/task-turn').resultState(result), 'completed');
  assert.equal(captures, 0);
  assert.equal(f.handle.inFlight(), false);
});

test('optional direct delivery capture failure releases the turn without changing successful output', { timeout: 20000 }, async t => {
  const f = await fixture(t); let captures = 0;
  f.reply(() => ({ text: '本轮回复已经完成。' }));
  f.handle.captureDelivery = async () => { captures++; throw Error('isolated capture failure'); };
  assert.equal((await f.handle.send('第一轮', [], { internal: true })).ok, true);
  assert.equal(f.handle.inFlight(), false);
  assert.equal((await f.handle.send('第二轮', [], { internal: true })).ok, true);
  assert.equal(captures, 2);
  assert.equal(f.handle.inFlight(), false);
});

test('async output snapshots reject a journal from a later turn instead of mixing metadata', async t => {
  const f = await fixture(t), outputs = require('../main/pi-session/outputs');
  let release;
  t.mock.method(outputs, 'scanAsync', () => new Promise(resolve => { release = resolve; }));
  const pending = f.handle.outputSnapshotAsync();
  f.handle.fileChanges = { turnId: 'later-turn', files: [] };
  release({ files: [], since: 1, turnSince: 2 });
  await assert.rejects(pending, /轮次的成果已变化/);
});

test('stop, pause and disable during async goal evidence collection preserve their receipts', { timeout: 20000 }, async t => {
  for (const [kind, action] of [['conversation', 'cancel'], ['engineering', 'cancel'],
    ['conversation', 'pauseGoal'], ['conversation', 'disableGoal']]) await t.test(kind + ':' + action, async t => {
    const f = await fixture(t, { resumePath: '', intent: 'goal',
      goal: kind === 'conversation' ? '用一句话回答用户' : '创建可打开的 HTML 网站',
      acceptance: kind === 'conversation' ? '输出“你好。”' : '网站可用' });
    const outputs = require('../main/pi-session/outputs'), scan = outputs.scanAsync;
    let release, entered, captures = 0;
    const waiting = new Promise(resolve => { entered = resolve; });
    t.mock.method(outputs, 'scanAsync', async (...args) => {
      const got = await scan(...args);
      await new Promise(resolve => { release = resolve; entered(); });
      return got;
    });
    f.reply(() => ({ text: '你好。' }));
    f.handle.captureDelivery = async () => { captures++; };
    const sent = f.handle.submit('请完成目标。');
    await waiting; f.handle[action](); release();
    const result = await sent.completion;
    assert.notEqual(require('../main/pi-session/task-turn').resultState(result), 'completed');
    assert.equal(captures, 0);
    assert.equal(f.requests.length, 1, 'cancelled evidence must not start independent review or finalization');
    assert.notEqual(f.handle.snapshot().execution.quality.phase, 'reviewed');
    if (action === 'pauseGoal') assert.equal(f.handle.snapshot().execution.quality.phase, 'paused');
    if (action === 'disableGoal') assert.equal(f.handle.snapshot().execution.quality.phase, 'cancelled');
  });
});
