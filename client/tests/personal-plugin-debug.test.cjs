'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../main/personal-plugin-debug');
const { verify, safeFile } = require('../main/personal-plugin-debug-runner');
function plugin() {
  return { pluginId: 'local:debug-test', enabled: true, name: '调试示例', version: '1.0.0', checksum: 'checksum',
    localDraft: { key: 'debug-test', name: '调试示例', template: 'workflow', instructions: '完成用户目标',
      skills: [], mcpServers: [], runtime: [] } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.fail('state not reached'); }
function setup(options = {}) {
  const calls = [], snapshots = [];
  const record = core.createRecord(plugin(), 'conversation-a', '验证示例');
  const controller = core.create({ record, save: value => snapshots.push(value),
    executeNode: async node => { calls.push(node.key); return [{ key: node.outputs[0].key, kind: 'evidence', text: '真实正文' }]; },
    stopNode: async () => {}, ...options });
  return { controller, record, calls, snapshots };
}
test('local workflow really pauses before human confirmation and only then completes', async () => {
  const { controller, record, calls, snapshots } = setup();
  const done = controller.execute();
  await until(() => record.status === 'waiting');
  assert.deepEqual(calls, ['understand', 'work']);
  assert.equal(record.nodes.find(node => node.key === 'complete').status, 'pending');
  await assert.rejects(controller.action('approve', record.revision - 1, 'accept'), /状态已更新/);
  await assert.rejects(controller.action('approve', record.revision, 'work'), /步骤已改变/);
  await controller.action('approve', record.revision, 'accept');
  assert.equal((await done).ok, true);
  assert.equal(record.status, 'completed');
  assert.ok(record.nodes.find(node => node.key === 'accept').approvedAt);
  assert.ok(snapshots.every((value, i) => !i || value.revision > snapshots[i - 1].revision));
});
test('node failure holds the existing conversation queue; retry runs only the failed node', async () => {
  let workAttempts = 0;
  const calls = [];
  const { controller, record } = setup({ executeNode: async node => {
    calls.push(node.key);
    if (node.key === 'work' && ++workAttempts === 1) throw new Error('缺少文件');
    return [{ key: node.outputs[0].key, kind: 'evidence', text: '完成' }];
  } });
  const queue = require('../main/pi-session/turn-queue').createTurnQueue();
  const first = queue.add({ text: '调试', options: {} });
  const next = queue.add({ text: '普通对话', options: {} });
  const done = queue.run(queue.take(), () => controller.execute());
  await until(() => record.status === 'failed');
  assert.equal(queue.blocked(), true);
  assert.equal(next.settled, false);
  await controller.action('retry', record.revision, 'work');
  await until(() => record.status === 'waiting');
  assert.deepEqual(calls, ['understand', 'work', 'work']);
  await controller.action('approve', record.revision, 'accept');
  await done;
  assert.equal(first.settled, true);
  assert.equal(queue.blocked(), false);
  await queue.run(queue.take(), async () => ({ ok: true }));
  assert.equal(next.settled, true);
});
test('retry limit is enforced and unknown stop acknowledgement cannot release the queue', async () => {
  const { controller, record } = setup({ executeNode: async () => { throw new Error('模型失败'); },
    stopNode: async () => { throw new Error('停止未确认'); } });
  const done = controller.execute();
  await until(() => record.status === 'failed');
  await assert.rejects(controller.action('cancel', record.revision), /停止未确认/);
  assert.equal(record.status, 'failed');
  record.nodes[0].attempt = record.nodes[0].retry.maxAttempts;
  await assert.rejects(controller.action('retry', record.revision, 'understand'), /重试上限/);
  // No dispatched job exists in this fixture; allow a verified local cancellation.
  delete record.nodes[0].dispatchId;
  await controller.cancel();
  assert.equal((await done).cancelled, true);
});
test('restoring a human checkpoint does not repeat completed nodes or approve itself', async () => {
  const first = setup();
  const originalDone = first.controller.execute();
  await until(() => first.record.status === 'waiting');
  const recovered = JSON.parse(JSON.stringify(first.record)), calls = [];
  await first.controller.cancel(); await originalDone;
  const restored = core.create({ record: recovered, save() {}, stopNode: async () => {},
    executeNode: async node => { calls.push(node.key); return []; } });
  const done = restored.execute();
  await tick();
  assert.equal(recovered.status, 'waiting');
  assert.deepEqual(calls, []);
  await restored.action('approve', recovered.revision, 'accept');
  await done;
  assert.equal(recovered.status, 'completed');
});
test('dispatch identity is durable before execution and stable when reconnecting', async () => {
  const { controller, record, snapshots } = setup({ executeNode: async node => {
    assert.equal(snapshots.at(-1).nodes[0].dispatchId, node.dispatchId);
    throw new Error('连接中断');
  } });
  const done = controller.execute();
  await until(() => record.status === 'failed');
  assert.match(record.nodes[0].dispatchId, /^plugin-debug:/);
  await controller.cancel(); await done;
});
test('journal writes are recoverable and malformed journals fail closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-journal-'));
  const journal = core.store(dir, 'conversation-a');
  const record = core.createRecord(plugin(), 'conversation-a', '示例');
  journal.write(record);
  assert.deepEqual(journal.read(), record);
  fs.writeFileSync(path.join(dir, fs.readdirSync(dir)[0]), '{');
  assert.throws(() => journal.read(), /记录无法读取/);
  // Test-owned temporary files only.
  fs.rmSync(dir, { recursive: true });
});
test('required files, empty files and blank evidence never pass validation', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-output-'));
  t.after(() => fs.rmSync(cwd, { recursive: true }));
  const node = { type: 'ai', outputs: [{ key: 'ppt', kind: 'file', label: '演示文稿', path: 'out.pptx', required: true }] };
  await assert.rejects(verify(node, cwd, cwd, '已经做好'), /缺少约定产出/);
  fs.writeFileSync(path.join(cwd, 'out.pptx'), '');
  await assert.rejects(verify(node, cwd, cwd, '已经做好'), /文件为空/);
  fs.writeFileSync(path.join(cwd, 'out.pptx'), 'actual-file');
  const result = await verify(node, cwd, cwd, '已经做好');
  assert.equal(result[0].size, 11);
  assert.match(result[0].sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(verify({ type: 'ai', outputs: [{ key: 'body', kind: 'evidence' }] }, cwd, cwd, ''), /正文/);
});
test('review nodes require a structured affirmative decision, not an AI claim', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-review-'));
  t.after(() => fs.rmSync(cwd, { recursive: true }));
  const node = { type: 'ai_review', outputs: [] };
  await assert.rejects(verify(node, cwd, cwd, '审核通过'), /缺少/);
  fs.writeFileSync(path.join(cwd, 'review-decision.json'), JSON.stringify({ schemaVersion: 1, outcome: 'blocked', summary: '缺测试', reasonCode: 'missing_input', nextAction: '补齐测试', evidence: [] }));
  await assert.rejects(verify(node, cwd, cwd, ''), /审查未通过/);
  fs.writeFileSync(path.join(cwd, 'review-decision.json'), JSON.stringify({ schemaVersion: 1, outcome: 'proceed', summary: '测试通过', reasonCode: 'ready', evidence: ['测试报告'] }));
  await verify(node, cwd, cwd, '');
});
test('path escape, absolute paths and symlink handoffs are rejected', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-path-'));
  t.after(() => fs.rmSync(cwd, { recursive: true }));
  assert.throws(() => safeFile(cwd, '../elsewhere', false), /越过/);
  assert.throws(() => safeFile(cwd, 'C:/secrets', false), /路径/);
  assert.throws(() => safeFile(cwd, '/secrets', false), /路径/);
  fs.mkdirSync(path.join(cwd, 'target'));
  fs.symlinkSync(path.join(cwd, 'target'), path.join(cwd, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => safeFile(cwd, 'alias/result.txt', false), /符号链接/);
});
test('normalizing personal workflows rejects absolute output paths instead of silently rewriting them', () => {
  const body = plugin().localDraft;
  const graph = require('../main/personal-plugin-workflow').normalize(body);
  for (const bad of ['/outside.txt', '//server/share/file', 'C:outside.txt']) {
    graph.nodes[0].outputs = [{ key: 'out', kind: 'file', path: bad }];
    assert.throws(() => require('../main/personal-plugin-workflow').normalize({ ...body, workflow: graph }), /工作目录内/);
  }
});

test('enterprise release nodes are authorable but never simulated as a local deployment', () => {
  const item = plugin();
  item.localDraft.workflow = { nodes: [
    { key: 'prepare', type: 'ai', name: '准备', outputs: [{ key: 'result', kind: 'evidence' }],
      config: { prompt: '核对上线材料' } },
    { key: 'release', type: 'deploy_chain', name: '企业发布链', dependsOn: ['prepare'], config: {} },
    { key: 'complete', type: 'publish', name: '完成', dependsOn: ['release'], config: {} },
  ] };
  assert.throws(() => core.createRecord(item, 'conversation-release', '上线'), /提交企业审核并绑定项目/);
});

test('whole-flow preflight blocks before the first node, recheck preserves attempts and cancellation wins', async () => {
  let ready = false;
  const f = setup({ preflight: async () => ({ ok: ready, issues: ready ? [] : [{ nodeKey: 'work', nodeName: '制作', message: '缺少 OpenCode' }] }) });
  const done = f.controller.execute(); await until(() => f.record.status === 'blocked');
  assert.deepEqual(f.calls, []); assert.equal(f.record.nodes[0].attempt, 0);
  ready = true; await f.controller.action('recheck', f.record.revision);
  await until(() => f.record.status === 'waiting');
  assert.deepEqual(f.calls, ['understand', 'work']);
  await f.controller.action('approve', f.record.revision, 'accept'); await done;
  let completeCheck;
  const g = setup({ preflight: () => new Promise(resolve => { completeCheck = resolve; }) });
  const cancelDone = g.controller.execute(); await until(() => Boolean(completeCheck));
  await g.controller.cancel(); completeCheck({ ok: true, nodes: [] });
  await cancelDone; assert.equal(g.record.status, 'cancelled'); assert.deepEqual(g.calls, []);
});
test('reconnect preserves the running attempt and does not reexecute completed predecessors', async () => {
  let fail = true; const attempts = [];
  const f = setup({ executeNode: async node => {
    attempts.push([node.key, node.attempt, node.dispatchId]);
    if (node.key === 'work' && fail) { node.ref = 'durable-runner-ref'; fail = false; throw Error('连接中断'); }
    return [{ key: node.outputs[0].key, kind: 'evidence', text: '产出' }];
  } });
  const done = f.controller.execute(); await until(() => f.record.status === 'failed');
  await f.controller.action('reconnect', f.record.revision, 'work');
  await until(() => f.record.status === 'waiting');
  assert.equal(attempts.filter(item => item[0] === 'understand').length, 1);
  assert.deepEqual(attempts[1], attempts[2]);
  await f.controller.action('approve', f.record.revision, 'accept'); await done;
});

test('restored blocked preflight retains a failed checkpoint across repeated checks', async () => {
  let ready = false; const f = setup({preflight: async () => ({ok: ready, issues: [{message: 'runtime unavailable'}]})});
  f.record.status = 'blocked'; f.record.resumeStatus = 'failed'; f.record.nodes[0].status = 'failed'; f.record.nodes[0].attempt = 1;
  const done = f.controller.execute(); await until(() => f.record.revision > 0);
  assert.equal(f.record.resumeStatus, 'failed');
  ready = true; await f.controller.action('recheck', f.record.revision);
  await until(() => f.record.status === 'failed' && f.record.revision > 2);
  assert.deepEqual(f.calls, []); assert.equal(f.record.nodes[0].attempt, 1);
  await f.controller.cancel(); await done;
});
