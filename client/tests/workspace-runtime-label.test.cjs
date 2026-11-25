'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/workspace/workspace-chat-list.js'), 'utf8');
const firstSends = fs.readFileSync(path.join(__dirname, '../components/workspace/workspace-first-sends.js'), 'utf8');
const brand = require('../components/panels/agent-brand.js');

function fixture(withBrand = true) {
  const window = { AgentBrand: withBrand ? brand : undefined };
  vm.runInNewContext(firstSends, { window });
  vm.runInNewContext(source, { window });
  const nodes = new Map();
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { dataset: {}, className: '', hidden: false, innerHTML:'',
      setAttribute(name, value) { this[name] = value; }, querySelector: node });
    return nodes.get(selector);
  }
  const row = { dataset: {}, querySelector: node };
  const ctx = { active: 'create', activeChatId: '', chatState: c => c.state || 'completed',
    _chatUiKey: c => c.id || c.localId, wsT: (_key, fallback) => fallback, CHAT_STATE: { completed: '已完成', starting: '启动中' } };
  return { api: window.WorkspaceChatList.create(ctx), ctx, row, node };
}

test('only a durable first send or a formal session can open its sidebar row', () => {
  const f = fixture(), button = f.node('.ws-chat');
  f.api._paintChatRow(f.row, { localId: 'legacy-draft', pending: true }, false);
  assert.equal(button.disabled, true);
  f.api._paintChatRow(f.row, { localId: 'first-a', firstSend: { intentId: 'first-a', status: 'sending' } }, false);
  assert.equal(button.disabled, false); assert.equal(button.dataset.firstSend, 'first-a');
  f.api._paintChatRow(f.row, { id: 'actual-id' }, false);
  assert.equal(button.disabled, false); assert.equal(button.dataset.firstSend, '');
  assert.equal(button.dataset.chatId, 'actual-id');
});

test('the first-send link opens the real session with its current sidebar project', () => {
  let open, known, payload, active;
  const window = { WorkspaceFirstSends: { create(options) { open = options.openChat; known = options.hasHistory; } },
    WorkspaceHost: { open(_view, options) { payload = options; } } };
  vm.runInNewContext(source, { window });
  const ctx = { chatItems: [], setActiveChat(id) { active = id; } };
  window.WorkspaceChatList.create(ctx);
  const row = { sessionId: 'native-1', title: 'first request' };
  assert.equal(known(row.sessionId), false);
  ctx.chatItems = [{ id: row.sessionId, pending: true }, { id: 'other', title: row.title }];
  assert.equal(known(row.sessionId), false);
  ctx.chatItems = [{ id: 'canonical', historyAliasIds: [row.sessionId] }];
  assert.equal(known(row.sessionId), true);
  ctx.chatItems[0].deleted = true;
  assert.equal(known(row.sessionId), false);
  open(row);
  assert.equal(payload.chatId, row.sessionId);
  assert.equal(Object.hasOwn(payload, 'sidebarProjectId'), false);
  ctx.sidebarProjects = { projectForChat(id) {
    assert.equal(id, row.sessionId);
    return { id: 'moved', name: 'Current project', businessProjectId: 'project-2' };
  } };
  open(row);
  assert.equal(active, row.sessionId);
  assert.deepEqual({ ...payload }, { tab: 'chat', chatId: row.sessionId, chatTitle: row.title,
    sidebarProjectId: 'moved', sidebarProjectName: 'Current project', projectId: 'project-2' });
});

test('sidebar shows one icon per actual harness across the whole conversation, with exact accessible identities', () => {
  const f = fixture();
  f.api._paintChatRow(f.row, {id:'whole-chat',title:'多轮协作',adapterId:'claude',
    usedHarnesses:['pi','codex-harness','Pi','Google Harness²','harness2','codex','codex-harness']}, false);
  const icons = [...f.node('.ws-chat-runtime').innerHTML.matchAll(/data-agent-brand="([^"]+)"/g)].map(match=>match[1]);
  assert.deepEqual(icons, ['pi','codex-harness','custom','codex']);
  assert.equal(f.node('.ws-chat-runtime').hidden, false);
  assert.equal(f.node('.ws-chat-runtime').title, '');
  assert.equal(f.node('.ws-chat').title, '', 'Row details do not create a hover tooltip');
  assert.doesNotMatch(f.node('.ws-chat-runtime').innerHTML, / title=/);
  assert.match(f.node('.ws-chat')['aria-label'], /多轮协作.*Pi、Codex Harness、Google Harness²、Codex/);
  assert.doesNotMatch(f.node('.ws-chat-runtime').innerHTML, /agent-brand-claude|>Pi<|>Codex Harness</);
});

test('known legacy saved runtimes keep their distinct icons while unknown and unexecuted selections stay hidden', () => {
  const f = fixture();
  for (const [id, label] of Object.entries(brand.LABELS).filter(([id]) => id !== 'custom')) {
    f.api._paintChatRow(f.row, { id, adapterId: id, title: 'Saved chat' }, false);
    assert.match(f.node('.ws-chat-runtime').innerHTML, new RegExp('data-agent-brand="'+id+'"'));
    assert.ok(f.node('.ws-chat')['aria-label'].endsWith(label));
    assert.equal(f.node('.ws-chat-runtime').title, '');
    assert.equal(f.node('.ws-chat-runtime').hidden, false);
  }
  for (const item of [
    ...['','custom-runtime','unrelated-codex-wrapper','__proto__','constructor'].map(adapterId=>({adapterId})),
    {adapterId:'pi',usedHarnesses:[]}, {adapterId:'pi',pending:true}, {adapterId:'pi',workOnly:true},
    {adapterId:'codex-harness',count:0}, {adapterId:'pi',usedHarnesses:['unknown','constructor']},
  ]) {
    f.api._paintChatRow(f.row, { id: 'unknown', ...item }, false);
    assert.equal(f.node('.ws-chat-runtime').hidden, true);
    assert.equal(f.node('.ws-chat-runtime').innerHTML, '');
  }
});

test('minimal renderer boot preserves known provenance as labelled fallback icons', () => {
  const f = fixture(false);
  for (const [id, label] of Object.entries(brand.LABELS).filter(([id]) => id !== 'custom')) {
    f.api._paintChatRow(f.row, { id, runtime: id, title: 'Saved chat' }, false);
    assert.ok(f.node('.ws-chat')['aria-label'].endsWith(label));
    assert.equal(f.node('.ws-chat-runtime').title, '');
    assert.match(f.node('.ws-chat-runtime').innerHTML, /<svg/);
    assert.doesNotMatch(f.node('.ws-chat-runtime').innerHTML, new RegExp('>'+label+'<'));
  }
});

test('work drafts display their persisted selection separately from execution provenance', () => {
  const f = fixture();
  const draft = { id: 'automation-draft', title: '8分钟后提醒我', adapterId: 'pi', workOnly: true,
    usedHarnesses: [], count: 0, draftAdapterId: 'qwen' };
  f.api._paintChatRow(f.row, draft, false);
  assert.equal(f.node('.ws-chat-runtime').hidden, false);
  assert.match(f.node('.ws-chat-runtime').innerHTML, /data-agent-brand="qwen"/);
  assert.equal(f.node('.ws-chat-runtime').title, '');
  assert.match(f.node('.ws-chat')['aria-label'], /已选底座 · Qwen Code/);
  assert.deepEqual(draft.usedHarnesses, [], 'Selecting a draft runtime must not invent an execution');
  f.api._paintChatRow(f.row, { ...draft, draftAdapterId: 'codex-harness' }, false);
  assert.match(f.node('.ws-chat-runtime').innerHTML, /data-agent-brand="codex-harness"/);
  for (const patch of [{ workOnly: false }, { live: true }, { count: 1 }, { draftAdapterId: 'constructor' },
    { draftAdapterId: 'custom' }, { draftAdapterId: '' }]) {
    f.api._paintChatRow(f.row, { ...draft, ...patch }, false);
    assert.equal(f.node('.ws-chat-runtime').hidden, true);
  }
  f.api._paintChatRow(f.row, { ...draft, usedHarnesses: ['pi'] }, false);
  assert.match(f.node('.ws-chat')['aria-label'], /，Pi$/);
  assert.doesNotMatch(f.node('.ws-chat-runtime').innerHTML, /data-agent-brand="qwen"/);
});

test('reused sidebar rows preserve offline cache labels and draft runtime selection independently', () => {
  const f = fixture();
  const draft = { id: 'draft', title: 'Automation draft', workOnly: true, count: 0,
    usedHarnesses: [], draftAdapterId: 'codex-harness' };
  f.api._paintChatRow(f.row, draft, false);
  assert.match(f.node('.ws-chat')['aria-label'], /已选底座 · Codex Harness/);
  f.api._paintChatRow(f.row, { id: 'cached-cloud', title: 'Cloud chat', offlineCloudCache: true,
    displaySlotId: 'cloud-source', usedHarnesses: ['qwen'] }, false);
  assert.match(f.node('.ws-chat')['aria-label'], /本地缓存（只读）.*Qwen Code/);
  assert.doesNotMatch(f.node('.ws-chat')['aria-label'], /已选底座/);
  assert.equal(f.node('.ws-chat').dataset.sidebarChatId, 'cloud-source');
  assert.equal(f.node('.ws-chat-runtime').title, '');
  f.api._paintChatRow(f.row, draft, false);
  assert.match(f.node('.ws-chat')['aria-label'], /已选底座 · Codex Harness/);
  assert.doesNotMatch(f.node('.ws-chat')['aria-label'], /本地缓存/);
  assert.equal(f.node('.ws-chat').dataset.sidebarChatId, 'draft');
});

test('history restores a tool-only first runtime ahead of later replies', () => {
  const history = require('../main/conversation/runtime-segments');
  const prefix = { messages: [{ role: 'user' }, { role: 'user' },
    { role: 'assistant', sourceAgent: { agentId: 'qwen' } }],
    tools: [{ after: 0, sourceAgent: { agentId: 'opencode' } }] };
  const record = { id: 'tool-first', prefix, segments: [], deviceHistoryComplete: true,
    active: { adapterId: 'kimi', started: false, usedHarnesses: [] } };
  assert.deepEqual(history.row(record).usedHarnesses, ['opencode', 'qwen']);
});

test('persisted runtime manifest projects complete history icons without adding the selected unused runtime', () => {
  const history = require('../main/conversation/runtime-segments');
  const projected = history.row({id:'restored',title:'跨底座协作',cwd:'',at:1,
    prefix:{messages:[{role:'assistant',sourceAgent:{agentId:'pi'},text:'第一轮'},
      {role:'assistant',sourceAgent:{agentId:'qwen'},text:'第二轮'}],tools:[]},
    segments:[{adapterId:'pi',usedHarnesses:['pi']},{adapterId:'qwen',usedHarnesses:['qwen']}],
    active:{adapterId:'opencode',path:'',started:false,usedHarnesses:[]}});
  const f=fixture();
  f.api._paintChatRow(f.row,projected,false);
  const ids=[...f.node('.ws-chat-runtime').innerHTML.matchAll(/data-agent-brand="([^"]+)"/g)].map(match=>match[1]);
  assert.deepEqual(ids,['pi','qwen']);
  assert.match(f.node('.ws-chat')['aria-label'],/，Pi、Qwen Code$/);
  assert.doesNotMatch(f.node('.ws-chat')['aria-label'],/OpenCode/);
});
