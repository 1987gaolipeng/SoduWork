'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.resolve(__dirname, '..', 'components', 'panels', name), 'utf8');
const routeSource = read('panels-chat-work-actions.js');
const composeSource = read('panels-compose-work-actions.js');
const hostSource = read('plugin-ui-host.js');

test('work entry freezes one model selection for its new conversation and parser before attachment analysis', async () => {
  let selected = 'chosen-model', prepared, parsed, finish;
  const { scope, mention } = fixture({ NativeChat: {
    prepare(value) { prepared = value; },
    async openWorkAction(command, options) { parsed = options.model(); return true; },
  } });
  const input = { value: '整理需求', style: {}, dispatchEvent() {}, focus() {} };
  const pending = scope.window.ComposeWorkActions.route({ text: input.value, input, pluginMention: mention,
    panel: { dataset: { stage: 'compose' } }, hasAttachments: true,
    attachments: { analysis: () => new Promise(resolve => { finish = resolve; }) },
    model: () => selected,
    prepareSession: async () => ({ adapterId: 'qwen', modelName: selected, modelLabel: '所选模型', thinkingLevel: 'medium' }),
  });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  selected = 'later-model'; finish([]);
  assert.equal((await pending).accepted, true);
  assert.equal(prepared?.adapterId, 'qwen');
  assert.equal(prepared?.modelName, 'chosen-model');
  assert.equal(parsed, 'chosen-model');
});

test('work entry waits for model discovery and keeps the original draft if the selection is unavailable', async () => {
  let ready, mounted = 0;
  const { scope, mention } = fixture({ NativeChat: { prepare() { mounted++; }, async openWorkAction() { return true; } } });
  const input = { value: '整理需求', style: {}, dispatchEvent() {}, focus() {} };
  const pending = scope.window.ComposeWorkActions.route({ text: input.value, input, pluginMention: mention,
    prepareSession: () => new Promise(resolve => { ready = resolve; }),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(input.value, '整理需求');
  assert.equal(mounted, 0);
  ready(false);
  assert.equal((await pending).accepted, false);
  assert.equal(input.value, '整理需求');
});

test('work entry discards model preparation after navigation without clearing or mounting another conversation', async () => {
  let ready, current = true, mounted = 0;
  const { scope, mention } = fixture({ NativeChat: { prepare() { mounted++; }, async openWorkAction() { return true; } } });
  const input = { value: '整理需求', style: {}, dispatchEvent() {}, focus() {} };
  const pending = scope.window.ComposeWorkActions.route({ text: input.value, input, pluginMention: mention,
    isCurrent: () => current, prepareSession: () => new Promise(resolve => { ready = resolve; }),
  });
  await new Promise(resolve => setImmediate(resolve));
  current = false;
  assert.equal(typeof ready, 'function');
  ready({ adapterId: 'pi', modelName: 'old-account-model' });
  assert.equal((await pending).accepted, false);
  assert.equal(input.value, '整理需求');
  assert.equal(mounted, 0);
});

test('typing while model preparation is pending keeps the edited draft and does not submit its old contents', async () => {
  let ready, mounted = 0;
  const { scope, mention } = fixture({ NativeChat: { prepare() { mounted++; }, async openWorkAction() { return true; } } });
  const input = { value: '旧请求', style: {}, dispatchEvent() {}, focus() {} };
  const pending = scope.window.ComposeWorkActions.route({ text: input.value, input, pluginMention: mention,
    prepareSession: () => new Promise(resolve => { ready = resolve; }),
  });
  await new Promise(resolve => setImmediate(resolve));
  input.value = '用户修改后的请求';
  ready({ adapterId: 'pi', modelName: 'chosen' });
  assert.equal((await pending).accepted, false);
  assert.equal(input.value, '用户修改后的请求');
  assert.equal(mounted, 0);
});

function fixture(globals = {}, onInvoke = async () => true) {
  const scope = { window: { ...globals }, ...globals,
    Event: class Event { constructor(type, options) { this.type = type; this.options = options; } } };
  vm.runInNewContext(hostSource, scope);
  scope.PluginUIHost = scope.window.PluginUIHost;
  scope.PluginUIHost.registerAction({ id: 'work.requirement.create', command: '需求',
    aliases: ['沉淀需求', '任务', 'requirement'], open: onInvoke });
  const selected = scope.PluginUIHost.actions()[0];
  const mention = { action: () => selected };
  vm.runInNewContext(routeSource, scope);
  vm.runInNewContext(composeSource, scope);
  return { scope, mention, selected };
}

test('selected descriptions remain exact without collecting conversation history', async () => {
  const { scope, mention } = fixture();
  const input = { value: '修复登录页', style: { height: '68px' } };
  let routed = null;
  const result = await scope.window.ChatWorkActions.route({
    text: input.value, input, mention, attachmentNames: [], attachments: { analysis: async () => [] },
  }, {
    model: () => 'test-model',
    conversationContext: async () => { throw new Error('explicit requests must not collect history'); },
    open: async (command, options) => { routed = { command, options }; return true; },
  });
  assert.equal(result.handled, true);
  assert.equal(result.accepted, true);
  assert.equal(input.value, '');
  assert.equal(routed.command.id, 'work.requirement.create');
  assert.equal(routed.command.parseText, '修复登录页');
  assert.equal(routed.command.text, '修复登录页');
  assert.equal(routed.options.conversationContext, null);
});

test('selected chat requirement routing commits the cleared prompt to draft storage', async () => {
  const events = [];
  const { scope, mention } = fixture();
  const input = { value: '3D racing game', style: { height: '68px' },
    dispatchEvent(event) { events.push(event.type); } };
  const result = await scope.window.ChatWorkActions.route({
    text: input.value, input, mention, attachments: { analysis: async () => [] },
  }, { open: async () => true });
  assert.equal(result.accepted, true);
  assert.equal(input.value, '');
  assert.deepEqual(events, ['input']);
});

test('selected task requests carry only the current attachments', async () => {
  const { scope, mention } = fixture();
  const shared = { name: 'issue.png', size: 10, previewRef: 'preview-1' };
  const input = { value: '按上面的方案安排执行', style: { height: '68px' } };
  let routed = null;
  const result = await scope.window.ChatWorkActions.route({
    text: input.value, input, mention, attachmentNames: ['issue.png', 'spec.pdf'],
    attachments: { analysis: async () => [shared, { name: 'spec.pdf', size: 20, previewRef: 'preview-2' }] },
  }, {
    model: () => 'test-model',
    conversationContext: async () => ({ text: '你：登录页点击提交没有反馈\nSoduWork：建议修复并回归。',
      attachments: [shared, { name: 'history.docx', size: 30, previewRef: 'preview-3' }] }),
    open: async (command, options) => { routed = { command, options }; return true; },
  });
  assert.equal(result.handled, true);
  assert.equal(result.accepted, true);
  assert.equal(input.value, '');
  assert.deepEqual(Array.from(routed.options.attachmentContext, item => item.name), ['issue.png', 'spec.pdf']);
  assert.ok(routed.command.parseText.startsWith('按上面的方案安排执行'));
  assert.match(routed.command.parseText, /登录页点击提交没有反馈/);
  assert.ok(routed.options.conversationContext);
});

test('active chat keeps the selected action when context collection fails', async () => {
  const notices = [], events = [];
  const { scope, mention, selected } = fixture({ petSay: value => notices.push(value), console: { error() {} } });
  const input = { value: '', style: { height: '68px' },
    dispatchEvent(event) { events.push(event.type); }, focus() { events.push('focus'); } };
  const result = await scope.window.ChatWorkActions.route({
    text: input.value, input, mention, attachmentNames: [], attachments: { analysis: async () => [] },
  }, {
    conversationContext: async () => { throw new Error('history unavailable'); }, open: async () => true,
  });
  assert.equal(result.handled, true);
  assert.equal(result.accepted, false);
  assert.equal(input.value, '');
  assert.equal(mention.action(), selected);
  assert.deepEqual(events, ['input', 'input', 'focus']);
  assert.equal(notices.at(-1), '这次没有打开工作表单，内容已经保留，请重试');
});

test('blank compose entry restores selected content and stage when work sheet opening fails', async () => {
  const notices = [], events = [];
  const { scope, mention } = fixture({
    NativeChat: { prepare() {}, async openWorkAction() { throw new Error('sheet unavailable'); } },
    petSay: value => notices.push(value), console: { error() {} },
  });
  const input = { value: '整理需求', style: { height: '68px' },
    dispatchEvent(event) { events.push(event.type); }, focus() { events.push('focus'); } };
  const panel = { dataset: { stage: 'compose' } };
  const result = await scope.window.ComposeWorkActions.route({
    text: input.value, input, panel, pluginMention: mention, hasAttachments: false,
  });
  assert.equal(result.handled, true);
  assert.equal(result.accepted, false);
  assert.equal(input.value, '整理需求');
  assert.equal(panel.dataset.stage, 'compose');
  assert.deepEqual(events, ['input', 'input', 'focus']);
  assert.equal(notices.at(-1), '这次没有打开工作表单，内容已经保留，请重试');
});

test('selected blank compose requirement routing commits the cleared prompt', async () => {
  const { scope, mention } = fixture({ NativeChat: { prepare() {}, async openWorkAction() { return true; } } });
  const events = [];
  const input = { value: '3D racing game', style: { height: '68px' },
    dispatchEvent(event) { events.push(event.type); } };
  const result = await scope.window.ComposeWorkActions.route({
    text: input.value, input, panel: { dataset: { stage: 'compose' } }, pluginMention: mention, hasAttachments: false,
  });
  assert.equal(result.accepted, true);
  assert.equal(input.value, '');
  assert.deepEqual(events, ['input']);
});

test('selected empty task may parse the conversation without displaying history as the user message', async () => {
  let invoked, reads = 0;
  const input = { value: '', style: {}, focus() {} };
  const el = { querySelector: selector => selector === '#nchatInput' ? input : {} };
  const { scope, mention } = fixture({ document: { getElementById: () => input } }, seed => {
    invoked = { id: seed.actionId, seed }; return true;
  });
  const actions = scope.window.ChatWorkActions;
  const result = await actions.route({ text: input.value, input, mention, attachments: { analysis: async () => [] } }, {
    conversationContext: async () => { reads++; return { text: 'SoduWork：仅作为参考的历史信息', turnCount: 1,
      attachments: [{ name: 'history.pdf' }] }; },
    open: (command, options) => actions.open(command, options, { mount: () => el, dismissProposal() {}, bridge: () => ({}) }),
  });
  assert.equal(result.accepted, true);
  assert.equal(reads, 1);
  assert.equal(invoked.id, 'work.requirement.create');
  assert.equal(invoked.seed.text, '');
  assert.match(invoked.seed.parseText, /仅作为参考的历史信息/);
  assert.equal(invoked.seed.attachmentContext[0].name, 'history.pdf');
});

test('selected attachment-only task does not pick up unrelated historical files', async () => {
  let routed;
  const { scope, mention } = fixture();
  const result = await scope.window.ChatWorkActions.route({ text: '', mention,
    attachments: { analysis: async () => [{ name: 'current.pdf' }] } }, {
    conversationContext: async () => { throw Error('history must not be collected'); },
    open: async (command, options) => { routed = { command, options }; return true; },
  });
  assert.equal(result.accepted, true);
  assert.equal(routed.command.text, '');
  assert.equal(routed.options.conversationContext, null);
  assert.deepEqual(Array.from(routed.options.attachmentContext, row => row.name), ['current.pdf']);
  assert.match(routed.command.parseText, /本次附上的材料/);
});

for (const compose of [false, true]) {
  test((compose ? 'compose' : 'chat') + ' leaves slash/hash body literal without a selected action', async () => {
    const { scope } = fixture({ NativeChat: {
      prepare() { throw Error('must not mount'); }, openWorkAction() { throw Error('must not route'); },
      clearDraft() { throw Error('must not clear'); },
    } });
    const input = { value: '/需求 请核对 #3 与 /login，不要创建需求', style: {},
      dispatchEvent() { throw Error('must not clear'); } };
    const options = { text: input.value, input, attachments: { analysis: async () => [] }, hasAttachments: false };
    const result = compose ? await scope.window.ComposeWorkActions.route(options)
      : await scope.window.ChatWorkActions.route(options, { open() { throw Error('must not route'); } });
    assert.equal(result.handled, false);
    assert.equal(input.value, '/需求 请核对 #3 与 /login，不要创建需求');
  });
}
