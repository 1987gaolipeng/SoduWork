'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'components', 'panels');
const office = fs.readFileSync(path.join(root, 'panels-aidesk-office.js'), 'utf8');
const state = fs.readFileSync(path.join(root, 'panels-desk-agent.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'panels-aidesk-office.css'), 'utf8');

test('AI team opens on all unfinished work and preserves a route back to every seat', () => {
  assert.match(state, /let _dkPhase = 'all'/);
  assert.match(office, /data-ros="__all__"/);
  assert.match(office, />全部席位</);
  assert.match(office, /next === _dkPick && next !== '__all__' \? '__all__' : next/);
  assert.match(office, /!available\.some\([\s\S]*?_dkPick = '__all__'/);
});

test('AI team keeps two rows of recent deliveries at desktop width', () => {
  assert.match(office, /_DK_OFFICE_MAX_DELIVERIES = 8/);
  assert.match(css, /\.aio-delivery-row \{display:grid; grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(css, /\.aio-delivery-item:nth-child\(n\+5\) \{border-top:/);
});

test('operation cards use readable hierarchy without a visible colored rail', () => {
  assert.match(css, /\.aio-work-item::before \{display:none/);
  assert.match(css, /\.aio-work-item h3 \{[^}]*font-size:16px/);
  assert.match(css, /\.aio-work-item h3 \{[^}]*-webkit-line-clamp:2/);
  assert.match(css, /\.aio-work-action \{[^}]*font-size:max\(var\(--font-min-readable,\s*14\.5px\),\s*12px\)/);
  assert.match(css, /\.aio-work-item \{[^}]*border-radius:12px/);
  assert.match(css, /\.aio-work-item:hover \{[^}]*transform:none/);
  assert.match(css, /\.aio-work-list \{[^}]*grid-auto-rows:max-content/);
  assert.match(css, /\.aio-work-footer \{[^}]*display:grid/);
});

test('responsive delivery rules retain complete grid separators', () => {
  assert.match(css, /\.aio-delivery-item:nth-child\(2n\) \{border-right:0/);
  assert.match(css, /\.aio-delivery-item:nth-child\(n\+3\) \{border-top:/);
});

test('task identities are compact without reducing text readability', () => {
  assert.match(css, /\.aio-agent-avatar\.agent-brand \{[^}]*--agent-brand-size:36px/);
  assert.match(css, /\.aio-work-bot\.agent-brand \{[^}]*--agent-brand-size:28px/);
  assert.match(css, /\.aio-delivery-item \{[^}]*min-height:94px/);
  assert.match(css, /\.aio-delivery-copy b \{[^}]*font-size:max\(var\(--font-min-readable,\s*14\.5px\),\s*14px\)/);
  assert.match(css, /\.aio-delivery-copy i \{[^}]*font-size:max\(var\(--font-min-readable,\s*14\.5px\),\s*12px\)/);
  assert.match(css, /container-name:ai-team/);
  assert.match(css, /@container ai-team \(max-width:1040px\)/);
});

test('task cards preserve identity, state and next action while keeping detail information out of the summary', () => {
  const vm = require('node:vm');
  const context = {
    _DK_PHASE: { running:{short:'运行中'}, waiting:{short:'待处理'}, failed:{short:'异常'} },
    esc: value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    _sinceTxt: () => '1 分钟',
    AgentBrand: { html: () => '<span class="aio-work-bot">Agent</span>' },
  };
  vm.createContext(context);
  vm.runInContext(office, context);
  const html = context._dkOfficeTaskHtml({
    id:'task-1', title:'测试 <标题>', agent:'Codex', machineLabel:'研发执行机',
    at:1, phase:'waiting', artifacts:3,
    workflow:{ nodeName:'审批', waitingOn:['审核人'], steps:[{name:'审批',state:'waiting'}] },
  });
  assert.ok(html.indexOf('aio-work-owner') < html.indexOf('<h3'));
  assert.ok(html.indexOf('<h3') < html.indexOf('aio-work-footer'));
  assert.match(html, /data-office-enter-task="task-1"/);
  assert.match(html, /tabindex="0" role="button"/);
  for (const value of ['Codex','待处理','等待 审核人 处理','&lt;标题>']) {
    assert.ok(html.includes(value), value);
  }
  assert.doesNotMatch(html, /<标题>/);
  assert.doesNotMatch(html, /研发执行机|3 项成果|aio-stage-track|<time>/);
  assert.match(context._dkOfficeTaskHtml({id:'missing',phase:'failed'}), /执行需要处理/);
  // Stale workflow detail must not replace the authoritative task phase.
  for (const [phase, label] of [['running', '运行中'], ['waiting', '待处理'], ['failed', '异常']]) {
    const current = context._dkOfficeTaskHtml({
      id: 'authoritative', phase,
      workflow: { state: 'done', progress: { state: 'done', percent: 100 },
        nodeName: '已完成的旧节点', steps: [{ state: 'done' }],
        waitingOn: ['审核人'], error: '校验失败' },
    });
    assert.match(current, new RegExp('aio-work-item is-' + phase));
    assert.ok(current.includes(label));
    if (phase === 'waiting') assert.match(current, /等待 审核人 处理/);
    if (phase === 'failed') assert.match(current, /校验失败/);
    assert.doesNotMatch(current, /100%|aio-stage-track/);
  }
});

test('empty operation intro spans the board instead of inheriting the task grid', () => {
  assert.match(css, /#aiDeskPanel \.aio-work-list\.is-empty \{[\s\S]*grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css, /\.aio-flow-empty \{[^}]*place-items:center;[^}]*background:var\(--bg-0\)/);
  assert.match(css, /\.aio-empty-content \{[^}]*width:min\(900px,100%\)/);
  assert.match(css, /@container ai-team \(max-width:760px\)/);
  assert.doesNotMatch(css, /gradient\(|aio-empty-route|aio-empty-kicker/);
});
