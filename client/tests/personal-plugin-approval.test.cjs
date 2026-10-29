'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const approval = require('../main/personal-plugin-approval.cjs');
const core = require('../main/personal-plugin-debug');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-approval-'));
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = Buffer.from('verified delivery');
  fs.writeFileSync(path.join(cwd, 'result.txt'), data);
  const file = { key: 'document', label: '交付文档', kind: 'file', path: 'result.txt',
    size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  const record = { nodes: [
    { key: 'source', status: 'completed', dependsOn: [], outputsFound: [file] },
    { key: 'review', status: 'completed', dependsOn: ['source'], outputsFound: [
      { key: 'assessment', kind: 'evidence', text: 'reviewed' }] },
    { key: 'accept', type: 'human_review', status: 'waiting', dependsOn: ['review'], outputsFound: [] },
    { key: 'unrelated', status: 'pending', dependsOn: [], outputsFound: [] },
  ] };
  return { root, cwd, data, file, record, gate: record.nodes[2] };
}

test('approval captures all completed ancestor evidence and excludes unrelated unfinished nodes', t => {
  const f = fixture(t);
  const evidence = approval.verify(f.record, f.gate, f.cwd);
  assert.deepEqual(evidence[0], { nodeKey: 'source', key: 'document', path: 'result.txt',
    sha256: f.file.sha256, size: f.file.size });
  assert.equal(evidence[1].nodeKey, 'review');
  assert.equal(evidence[1].text, 'reviewed');
  assert.equal(evidence.length, 2);
  assert.equal(f.gate.status, 'waiting');
  assert.equal(f.gate.approvedEvidence, undefined);
});

test('same-length edits fail approval by hash, not just by file size', t => {
  const f = fixture(t), changed = Buffer.from(f.data);
  changed[0] ^= 1;
  fs.writeFileSync(path.join(f.cwd, f.file.path), changed);
  assert.equal(changed.length, f.file.size);
  assert.throws(() => approval.verify(f.record, f.gate, f.cwd), /成果文件已变化/);
  assert.equal(f.gate.status, 'waiting');
});

test('missing files and changed recorded sizes cannot be approved', t => {
  const f = fixture(t);
  f.file.size++;
  assert.throws(() => approval.verify(f.record, f.gate, f.cwd), /成果文件已变化/);
  fs.unlinkSync(path.join(f.cwd, f.file.path));
  assert.throws(() => approval.verify(f.record, f.gate, f.cwd), /缺少约定产出/);
});

test('approval rejects traversal and absolute paths even when outside content has the recorded hash', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'outside.txt'), f.data);
  for (const outside of ['../outside.txt', path.join(f.root, 'outside.txt'), '/outside.txt', 'C:/outside.txt']) {
    f.file.path = outside;
    assert.throws(() => approval.verify(f.record, f.gate, f.cwd), /路径/);
  }
});

test('approval rejects directory symlinks instead of following a replaced artifact path', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.cwd, 'target'));
  fs.writeFileSync(path.join(f.cwd, 'target', 'result.txt'), f.data);
  fs.symlinkSync(path.join(f.cwd, 'target'), path.join(f.cwd, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  f.file.path = 'alias/result.txt';
  assert.throws(() => approval.verify(f.record, f.gate, f.cwd), /符号链接/);
});

test('all transitive ancestors must exist and be completed before approval', t => {
  const f = fixture(t);
  for (const state of ['pending', 'running', 'failed', 'waiting', 'cancelled']) {
    f.record.nodes[0].status = state;
    assert.throws(() => approval.verify(f.record, f.gate, f.cwd), /上游步骤尚未完成/);
  }
  f.record.nodes[0].status = 'completed';
  f.record.nodes[1].dependsOn = ['missing'];
  assert.throws(() => approval.verify(f.record, f.gate, f.cwd), /上游步骤尚未完成/);
});

function workflow() {
  return { pluginId: 'local:approval-test', name: '审批验证', enabled: true, version: '1.0.0', checksum: 'fixture',
    localDraft: { key: 'approval-test', name: '审批验证', template: 'workflow', instructions: '验证真实交付文件',
      skills: [], mcpServers: [], runtime: [] } };
}
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('workflow did not reach the expected checkpoint');
}

test('human approval cannot be skipped and changed evidence blocks the real core transition', async t => {
  const f = fixture(t), record = core.createRecord(workflow(), 'approval-conversation', '交付文件');
  const dispatched = [], snapshots = [];
  const controller = core.create({ record, save: value => snapshots.push(value), stopNode: async () => {},
    validateApproval: (value, gate) => approval.verify(value, gate, f.cwd),
    executeNode: async node => {
      dispatched.push(node.key);
      return node.key === 'work' ? [{ ...f.file, key: node.outputs[0].key }]
        : [{ key: node.outputs[0].key, kind: 'evidence', text: 'source brief' }];
    } });
  await assert.rejects(controller.action('approve', record.revision, 'understand'), /当前状态不支持/);
  const done = controller.execute();
  t.after(async () => { if (!core.terminal.has(record.status)) await controller.cancel(); await done; });
  await until(() => record.status === 'waiting');
  const gate = record.nodes.find(node => node.key === 'accept');
  const complete = record.nodes.find(node => node.key === 'complete');
  assert.deepEqual(dispatched, ['understand', 'work']);
  assert.equal(complete.status, 'pending');
  assert.equal(gate.approvedAt, undefined);
  await assert.rejects(controller.action('retry', record.revision, gate.key), /当前状态不支持/);
  await assert.rejects(controller.action('approve', record.revision - 1, gate.key), /状态已更新/);
  const revision = record.revision;
  const changed = Buffer.from(f.data); changed[0] ^= 1;
  fs.writeFileSync(path.join(f.cwd, f.file.path), changed);
  await assert.rejects(controller.action('approve', revision, gate.key), /成果文件已变化/);
  assert.equal(record.revision, revision);
  assert.equal(record.status, 'waiting');
  assert.equal(gate.approvedAt, undefined);
  assert.equal(complete.status, 'pending');
  assert.deepEqual(dispatched, ['understand', 'work']);
  fs.writeFileSync(path.join(f.cwd, f.file.path), f.data);
  await controller.action('approve', record.revision, gate.key);
  assert.equal((await done).ok, true);
  assert.equal(record.status, 'completed');
  assert.equal(complete.status, 'completed');
  assert.equal(gate.approvedEvidence.find(item => item.path).sha256, f.file.sha256);
  assert.ok(gate.approvedAt);
  const approved = snapshots.find(snapshot => snapshot.nodes.find(node => node.key === 'accept').approvedAt);
  assert.equal(approved.nodes.find(node => node.key === 'complete').status, 'pending');
  assert.deepEqual(dispatched, ['understand', 'work']);
});

test('restoring a waiting approval rechecks real artifacts without rerunning or approving nodes', async t => {
  const f = fixture(t), record = core.createRecord(workflow(), 'restored-conversation', '恢复交付');
  record.status = 'waiting';
  record.nodes[0].status = 'completed'; record.nodes[0].outputsFound = [];
  record.nodes[1].status = 'completed'; record.nodes[1].outputsFound = [{ ...f.file }];
  record.nodes[2].status = 'waiting';
  let calls = 0;
  const controller = core.create({ record, save() {}, stopNode: async () => {},
    executeNode: async () => { calls++; return []; },
    validateApproval: (value, gate) => approval.verify(value, gate, f.cwd) });
  const done = controller.execute();
  t.after(async () => { if (!core.terminal.has(record.status)) await controller.cancel(); await done; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(record.status, 'waiting'); assert.equal(calls, 0);
  fs.writeFileSync(path.join(f.cwd, f.file.path), 'edited after restart');
  await assert.rejects(controller.action('approve', record.revision, 'accept'), /成果文件已变化/);
  assert.equal(record.status, 'waiting');
  assert.equal(record.nodes[3].status, 'pending');
  assert.equal(calls, 0);
});
