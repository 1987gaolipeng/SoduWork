'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const window = {};
  window.window = window;
  window.document = { createElement: tag => ({ tagName: tag, dataset: {} }) };
  window.Event = class { constructor(type, options) { this.type = type; this.bubbles = options.bubbles; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,
    '../components/panels/chat-acceptance-results.js'), 'utf8'), window);
  const ctx = { _snap: {}, _sessionOptions: {}, _loadCollabTask: async () => {} };
  let invalidations = 0;
  const create = () => window.ChatAcceptanceResults.create(ctx, {
    rich: String, render() {}, invalidate() { invalidations++; },
  });
  return { window, ctx, create, invalidations: () => invalidations };
}

test('analysis result card recognizes a list-prefixed protocol heading', () => {
  const f = fixture();
  const html = f.create().html('- ### 【验收分析结果】\n\n建议结果：通过', 'analysis-1');
  assert.match(html, /nacceptance-result is-analysis/);
  assert.doesNotMatch(html, /- ### 【验收分析结果】/);
  assert.match(html, /建议结果：通过/);
});

test('supplemental analysis preserves the draft and uses a text node without submitting work', () => {
  const f = fixture();
  let sends = 0, listener, bindings = 0, inputEvent, focused = false;
  const prompt = '核对 <img src=x onerror=alert(1)> 的原始文字';
  const input = { value: '已有草稿', dispatchEvent(event) { inputEvent = event; }, focus() { focused = true; } };
  const actions = { children: [], replaceChildren(...nodes) { this.children = nodes; },
    set innerHTML(_) { throw Error('验收提示必须使用 DOM 文本'); } };
  f.ctx._mount = () => ({ querySelector: selector => selector === '#nchatInput' ? input : null });
  f.ctx._send = () => { sends++; };
  f.window.SoduWorkAPI = { decideApproval() { sends++; } };
  const card = Object.assign(actions, {
    getAttribute(name) { return name === 'data-acceptance-result-task' ? 'task-1' : 'review-1'; },
    querySelector(selector) {
      if (selector === '[data-acceptance-result-analysis]') return { value: prompt };
      return null; // querySelector searches descendants; this card is the actions container itself.
    },
  });
  const button = { closest: () => card, getAttribute: () => 'analyze' };
  const list = { dataset: {}, addEventListener(_name, callback) { listener = callback; bindings++; } };
  const helper = f.create(); helper.bind(list); helper.bind(list);
  listener({ target: { closest: () => button }, preventDefault() {} });
  assert.equal(bindings, 1);
  assert.equal(input.value, '已有草稿\n\n请补充验收分析：\n' + prompt);
  assert.equal(inputEvent.type, 'input'); assert.equal(inputEvent.bubbles, true);
  assert.equal(focused, true); assert.equal(sends, 0);
  assert.equal(actions.children.length, 1);
  assert.equal(actions.children[0].tagName, 'p');
  assert.equal(actions.children[0].className, 'nacceptance-result-followup');
  assert.equal(actions.children[0].textContent, '已填入对话框，请按需选择插件后发送。');
});

test('acceptance handoff state belongs to its renderer and resets with that conversation', () => {
  const f = fixture(); let options;
  f.window.TaskTraceApproval = { bind(_root, state) { options = state.opts; } };
  const entry = { taskId: 'task-1', task: {}, trace: { approvals: [{ id: 'review-1', status: 'pending' }] } };
  const first = f.create(), second = f.create();
  first.bindApproval({}, 'task-1', entry);
  options.onAcceptanceOpened('review-1');
  assert.equal(first.pendingApprovals(entry).length, 0);
  assert.equal(second.pendingApprovals(entry).length, 1);
  assert.equal(f.invalidations(), 1);
  first.reset();
  assert.equal(first.pendingApprovals(entry).length, 1);
});
