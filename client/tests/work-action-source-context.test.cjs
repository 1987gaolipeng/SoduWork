'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.resolve(__dirname, '../components/panels', name), 'utf8');
function fixture(messages) {
  const scope = { window: {}, Event: class {}, console: { error() {} } };
  vm.createContext(scope);
  vm.runInContext(read('chat-work-intent.js'), scope);
  const ctx = { _snap: { messages } };
  const intent = scope.window.ChatWorkIntent.create(ctx);
  scope.window.PluginUIHost = {
    commandFromSelection: (selected, text) => selected ? { id: selected.id, text } : null,
  };
  vm.runInContext(read('panels-chat-work-actions.js'), scope);
  return { scope, ctx, intent };
}
const list = '# 缺陷清单\n首项：保存失败\n' + '缺陷细节与复现步骤\n'.repeat(2600) + '尾项：撤销授权后不可执行';
test('conversation material retains complete multiline source and excludes internal content', () => {
  const { intent } = fixture([
    { role: 'user', text: '检查代码', attachments: [{ name: 'current.txt' }] },
    { role: 'assistant', blocks: [{ kind: 'text', text: list },
      { kind: 'text', text: 'hidden secret', hidden: true }, { kind: 'tool', text: 'tool secret' }] },
    { role: 'assistant', hidden: true, blocks: [{ kind: 'text', text: 'audit secret' }] },
    { role: 'assistant', blocks: [{ kind: 'text', text: '<soduwork-internal-test>internal secret</soduwork-internal-test>' }] },
  ]);
  const result = intent._workConversationContext();
  assert.ok(result.text.includes(list), 'complete source, including first and last items, must survive');
  assert.doesNotMatch(result.text, /secret/);
  assert.equal(result.turnCount, 2);
});
test('historical files follow the selected recent messages instead of leaking from older turns', () => {
  const { intent } = fixture([{ role: 'user', text: 'old unrelated request', attachments: [{ name: 'old.txt' }] },
    ...Array.from({ length: 10 }, (_, i) => ({ role: 'user', text: 'recent ' + i }))]);
  assert.equal(intent._workConversationContext().attachments.length, 0);
});
for (const text of ['请将这个缺陷清单转给高示例成员', '按上面的方案创建自动化任务']) {
  test('explicit selected action resolves conversation reference: ' + text, async () => {
    const { intent, scope } = fixture([{ role: 'assistant', blocks: [{ kind: 'text', text: list }] }]);
    let routed;
    const result = await scope.window.ChatWorkActions.route({ text,
      mention: { action: () => ({ id: 'work.requirement.create' }) },
    }, { conversationContext: intent._workConversationContext,
      open: async (command, options) => { routed = { command, options }; return true; } });
    assert.equal(result.accepted, true);
    assert.equal(routed.command.text, text);
    assert.ok(routed.command.parseText.includes(list));
    assert.ok(routed.options.conversationContext.text.includes(list));
  });
}
test('reference context cannot open a form in another session after a delayed response', async () => {
  const { scope } = fixture([]);
  let resolve, current = true, opens = 0;
  const pending = scope.window.ChatWorkActions.route({ text: '请将这个缺陷清单转给高示例成员',
    isCurrent: () => current, mention: { action: () => ({ id: 'work.requirement.create' }) },
  }, { conversationContext: () => new Promise(done => { resolve = done; }), open: () => { opens++; return true; } });
  await Promise.resolve();
  current = false;
  resolve?.({ text: list });
  await pending;
  assert.equal(opens, 0);
});

for (const text of ['在登录按钮上面增加一行帮助说明', '把列表前面的图标换成蓝色', '修复刚才新建的登录按钮']) {
  test('standalone spatial or temporal details do not borrow unrelated history: ' + text, async () => {
    const { scope } = fixture([]);
    let reads = 0, routed;
    await scope.window.ChatWorkActions.route({ text,
      mention: { action: () => ({ id: 'work.requirement.create' }) },
    }, { conversationContext: () => { reads++; return { text: '无关历史材料' }; },
      open: async command => { routed = command; return true; } });
    assert.equal(reads, 0);
    assert.equal(routed.parseText, text);
  });
}
test('an unavailable referenced source preserves the request and asks for material', async () => {
  const { intent, scope } = fixture([]);
  const notices = [], input = { value: '转交这个缺陷清单', style: {}, dispatchEvent() {}, focus() {} };
  scope.window.petSay = text => notices.push(text);
  scope.petSay = scope.window.petSay;
  const result = await scope.window.ChatWorkActions.route({ text: input.value, input,
    mention: { action: () => ({ id: 'work.requirement.create' }) },
  }, { conversationContext: intent._workConversationContext, open: () => { throw Error('must not invent missing material'); } });
  assert.equal(result.accepted, false);
  assert.equal(input.value, '转交这个缺陷清单');
  assert.match(notices.at(-1), /所指.*材料/);
});
