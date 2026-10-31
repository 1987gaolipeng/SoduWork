'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const deliveryContract = require('../main/conversation/delivery-contract');
const artifactRuntime = require('../main/conversation/artifact-runtime');
const outputs = require('../main/pi-session/outputs');
const { prepare } = require('../main/pi-session/task-input');

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-task-delivery-'));
}

test('测试方案文档会作为需求交付物保留', (t) => {
  const cwd = workspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, 'SoduWork测试方案.md');
  fs.writeFileSync(file, '# 测试方案\n');

  const scanned = outputs.scan(cwd, 0, 0);
  assert.equal(deliveryContract._isProcess(scanned.files[0]), false);
  assert.ok(scanned.delivery.items.some((item) => item.name === 'SoduWork测试方案.md'));

  const snapshot = artifactRuntime.snapshot({
    cwd,
    outputSnapshot: () => scanned,
  });
  const item = snapshot.items.find((row) => row.name === 'SoduWork测试方案.md');
  assert.ok(item, '交付物应出现在会话成果快照中');
  assert.equal(item.processEvidence, undefined);
});

test('测试报告仍作为过程证据排除', (t) => {
  const cwd = workspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, '测试报告.md');
  fs.writeFileSync(file, '# 测试报告\n');

  const scanned = outputs.scan(cwd, 0, 0);
  assert.equal(deliveryContract._isProcess(scanned.files[0]), true);
  assert.equal(scanned.delivery.items.some((item) => item.name === '测试报告.md'), false);
});

test('需求执行完成时会上传测试方案并绑定当前轮次', async (t) => {
  const cwd = workspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, 'SoduWork测试方案.md');
  fs.writeFileSync(file, '# 方案\n');
  t.mock.method(artifactRuntime, 'snapshot', () => ({
    items: [{ path: file, name: 'SoduWork测试方案.md', relative: 'SoduWork测试方案.md' }],
  }));
  const deliveries = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    const target = String(url);
    if (target.includes('/conversation-delivery')) {
      deliveries.push({
        path: options.body.get('paths'),
        file: options.body.get('files').name,
        outcome: options.body.get('outcome'),
        turnId: options.body.get('turnId'),
      });
      return Response.json({ ok: true, files: ['SoduWork测试方案.md'] });
    }
    if (target.includes('/conversation-turn')) return Response.json({ turn: { state: 'queued' }, task: { id: 't' } });
    return Response.json({ id: 't', title: '方案', description: '编写测试方案' });
  });
  const identity = { hub: 'http://fixture', clientId: 'd', secret: 'test-only' };
  const input = await prepare(identity, 't', 'chat', 'turn-delivery', '执行', {}, {
    handle: { sessionId: 'chat', cwd },
  });
  await input.beforeTurn();
  await input.afterTurn('completed');
  assert.deepEqual(deliveries, [{
    path: 'SoduWork测试方案.md',
    file: 'SoduWork测试方案.md',
    outcome: 'completed',
    turnId: 'turn-delivery',
  }]);
});
