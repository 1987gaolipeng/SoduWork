'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/workspace/workspace-chat-list.js'), 'utf8');
const brand = require('../components/panels/agent-brand.js');

function fixture(withBrand = true) {
  const window = { AgentBrand: withBrand ? brand : undefined };
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

test('sidebar shows one icon per actual harness across the whole conversation, with exact accessible identities', () => {
  const f = fixture();
  f.api._paintChatRow(f.row, {id:'whole-chat',title:'多轮协作',adapterId:'claude',
    usedHarnesses:['pi','codex-harness','Pi','Google Harness²','harness2','codex','codex-harness']}, false);
  const icons = [...f.node('.ws-chat-runtime').innerHTML.matchAll(/data-agent-brand="([^"]+)"/g)].map(match=>match[1]);
  assert.deepEqual(icons, ['pi','codex-harness','harness2','codex']);
  assert.equal(f.node('.ws-chat-runtime').hidden, false);
  assert.equal(f.node('.ws-chat-runtime').title, 'Pi、Codex Harness、Google Harness²、Codex');
  assert.match(f.node('.ws-chat')['aria-label'], /多轮协作.*Pi、Codex Harness、Google Harness²、Codex/);
  assert.doesNotMatch(f.node('.ws-chat-runtime').innerHTML, /agent-brand-claude|>Pi<|>Codex Harness</);
});

test('known legacy saved runtimes keep their distinct icons while unknown and unexecuted selections stay hidden', () => {
  const f = fixture();
  for (const [id, label] of Object.entries(brand.LABELS).filter(([id]) => id !== 'custom')) {
    f.api._paintChatRow(f.row, { id, adapterId: id, title: 'Saved chat' }, false);
    assert.match(f.node('.ws-chat-runtime').innerHTML, new RegExp('data-agent-brand="'+id+'"'));
    assert.equal(f.node('.ws-chat-runtime').title, label);
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
    assert.equal(f.node('.ws-chat-runtime').title, label);
    assert.match(f.node('.ws-chat-runtime').innerHTML, /<svg/);
    assert.doesNotMatch(f.node('.ws-chat-runtime').innerHTML, new RegExp('>'+label+'<'));
  }
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
  assert.equal(f.node('.ws-chat-runtime').title,'Pi、Qwen Code');
  assert.doesNotMatch(f.node('.ws-chat')['aria-label'],/OpenCode/);
});
