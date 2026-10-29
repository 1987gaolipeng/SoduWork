'use strict';

/*
 * Show approval cards only after server authorization. Hide nonreviewers, retain retry for
 * transient failures, show submitted reviewers read-only results, and skip details for
 * direct cards.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/task-trace-approval.js'), 'utf8');

const LOADING = '正在核对审批权限与证据…';
const DENIED = '由指定审批人处理';
const RETRYABLE = '暂时无法核对权限与证据，可重试';

function runtime(approvalDetail) {
  let approvalCalls = 0;
  const hint = {textContent: ''};
  const errorEl = {textContent: '', hidden: true};
  const proof = {innerHTML: ''};
  const block = {
    dataset: {}, isConnected: true,
    getAttribute: (name) => name === 'data-tfd-approval-id' ? 'approval-1' : null,
    setAttribute() {},
    querySelector: (sel) => sel === '.tfd-inline-hint' ? hint
      : sel === '[data-tfd-approval-error]' ? errorEl
      : sel === '[data-tfd-proof-body]' ? proof : null,
    querySelectorAll: () => [],
  };
  const root = {querySelectorAll: () => [block], addEventListener() {}};
  const ctx = {console,
    SoduWorkAPI: {approvalDetail: async (id) => { approvalCalls++; return approvalDetail(id); }},
    document: {activeElement: null}};
  ctx.window = ctx;
  vm.runInNewContext(source, ctx);
  const state = {trace: {approvals: [{id: 'approval-1', status: 'pending'}]}, refresh: async () => {}};
  const flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
  return {ctx, block, root, hint, errorEl, proof, state, flush, calls: () => approvalCalls};
}

test('403 权限拒绝：非验收人移除卡片，不显示错误弹窗', async () => {
  const x = runtime(async () => { const e = new Error('forbidden'); e.status = 403; throw e; });
  x.ctx._humanErr = (error) => error && error.status === 403
    ? '这项审批没有分配给你；请由流程指定的负责人处理' : '';
  x.ctx.TaskTraceApproval.bind(x.root, x.state);
  assert.equal(x.hint.textContent, LOADING);          // Enter permission-checking state while loading.
  await x.flush();
  assert.equal(x.block.dataset.approvalAccess, 'denied');
  assert.equal(x.block.hidden, true);
  assert.equal(x.hint.textContent, LOADING);           // Keep unauthorized cards hidden without displaying irrelevant permission prompts.
});

test('404 审批不存在：同样移除不可用的验收卡', async () => {
  const x = runtime(async () => { const e = new Error('gone'); e.status = 404; throw e; });
  x.ctx.TaskTraceApproval.bind(x.root, x.state);
  await x.flush();
  assert.equal(x.block.dataset.approvalAccess, 'denied');
  assert.equal(x.block.hidden, true);
});

test('网络类错误：中性提示 + 保留重试入口，不冒充权限结论', async () => {
  const x = runtime(async () => { throw new Error('网络中断'); });
  x.ctx.TaskTraceApproval.bind(x.root, x.state);
  await x.flush();
  assert.equal(x.block.dataset.approvalAccess, 'error');
  assert.equal(x.hint.textContent, RETRYABLE);
  assert.match(x.proof.innerHTML, /重新加载/);
  assert.equal(x.errorEl.textContent, '确认信息暂时未加载完整，请展开证据后重试。');
});

test('成功且分配给我：提示进入「由你确认」且 access=allowed（修复不伤成功路径）', async () => {
  const x = runtime(async () => ({item: {id: 'approval-1', status: 'pending',
    assignment: {reasons: [{label: '验收人'}]}, myDecision: null}}));
  x.ctx.TaskTraceApproval.bind(x.root, x.state);
  await x.flush();
  assert.equal(x.block.dataset.approvalAccess, 'allowed');
  assert.equal(x.hint.textContent, '由你确认 · 验收人');
  assert.equal(x.errorEl.textContent, '');
});

test('成功但已提交过意见：提示等待其余确认（回归）', async () => {
  const x = runtime(async () => ({item: {id: 'approval-1', status: 'pending',
    assignment: {reasons: []}, myDecision: 'approve'}}));
  x.ctx.TaskTraceApproval.bind(x.root, x.state);
  await x.flush();
  assert.equal(x.block.dataset.approvalAccess, 'allowed');
  assert.equal(x.hint.textContent, '你的意见已提交，等待其余确认');
});

test('direct 卡（创建人直验）不拉详情：approvalDetail 零调用', async () => {
  let calls = 0;
  const x = runtime(async () => { calls++; return {item: {id: 'direct:task-1'}}; });
  const directBlock = {
    dataset: {}, isConnected: true,
    getAttribute: (name) => name === 'data-tfd-approval-id' ? 'direct:task-1' : null,
    setAttribute() {}, querySelector: () => null, querySelectorAll: () => []};
  const root = {querySelectorAll: () => [directBlock], addEventListener() {}};
  x.ctx.TaskTraceApproval.bind(root, x.state);
  await x.flush();
  assert.equal(directBlock.dataset.approvalAccess, 'allowed');
  assert.equal(calls, 0);
});

test('记录不匹配（返回别人的审批单）按错误处理并复位提示', async () => {
  const x = runtime(async () => ({item: {id: 'other-approval', status: 'pending'}}));
  x.ctx.TaskTraceApproval.bind(x.root, x.state);
  await x.flush();
  assert.equal(x.block.dataset.approvalAccess, 'error');
  assert.equal(x.hint.textContent, RETRYABLE);
});
