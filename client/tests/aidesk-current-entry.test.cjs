'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const state = read('components/panels/panels-desk-agent.js');
const office = read('components/panels/panels-aidesk-office.js');

function fixture(tasks = [], desks = []) {
  const calls = [];
  const context = {
    _deskData: { tasks, desks }, _deskTaskId: '', _deskFocusTid: '', tasks: [],
    esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    _sinceTxt: () => '刚刚', _renderDesks: () => calls.push(['render']),
    openTaskConversation: (...args) => calls.push(['conversation', ...args]),
    openCreateEntry: options => calls.push(['create', options]),
    openAgentsEntry: () => calls.push(['agents']),
    openHistoryEntry: () => calls.push(['history']),
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(state + '\n' + office, context);
  const listeners = new Map();
  const scene = {
    contains: () => true,
    addEventListener: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
  };
  function click(attr, value = '1') {
    const button = { hasAttribute: key => key === attr, getAttribute: key => key === attr ? value : null };
    for (const listener of listeners.get('click') || []) listener({ target: { closest: () => button } });
  }
  return { context, calls, scene, listeners, click, get: code => vm.runInContext(code, context) };
}

test('both production windows load the current office renderer and do not retain a fallback overview', () => {
  for (const file of ['index.html', 'desk.html']) {
    const html = read(file);
    assert.equal((html.match(/src="components\/panels\/panels-aidesk-office\.js"/g) || []).length, 1, file);
  }
  const desk = read('components/panels/panels-desk.js');
  assert.match(desk, /const sig = _dkOfficeSceneHtml\(desks\)/);
  assert.doesNotMatch(desk + state + office, /_dkRosterHtml|_dkAgentHtml|_dkRenameBoxHtml|_dkSaveName|_dkInspectorHidden|_DK_INSPECTOR_KEY|_robotSvg|_dkOfficeBindInspector/);
});

test('delegated office entries bind once and preserve conversation, history, setup and creation routes', () => {
  const f = fixture();
  f.context._dkOfficeBindScene(f.scene);
  f.context._dkOfficeBindScene(f.scene);
  assert.equal(f.listeners.get('click').length, 1);
  assert.equal(f.listeners.get('keydown').length, 1);
  f.click('data-office-enter-task', 'task-1');
  f.click('data-open-history');
  f.click('data-open-task-center');
  f.click('data-open-agents');
  f.click('data-office-new-chat');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [
    ['conversation', 'task-1', '', { source: 'ai-workbench', navigation: true }],
    ['history'], ['history'], ['agents'], ['create', { newSession: true }],
  ]);
  assert.equal(f.get('_dkView'), 'board');
});

test('seat filtering keeps machine identity and returns to all seats on a second click', () => {
  const tasks = [
    { id: 'first', deskKey: 'machine-a|pi', agent: 'Pi', phase: 'running' },
    { id: 'second', deskKey: 'machine-b|pi', agent: 'Pi', phase: 'running' },
  ];
  const desks = [{ key: 'machine-a|pi', name: 'Pi' }, { key: 'machine-b|pi', name: 'Pi' }];
  const f = fixture(tasks, desks);
  f.context._dkOfficeBindScene(f.scene);
  f.click('data-ros', desks[0].key);
  assert.equal(f.get('_dkPick'), desks[0].key);
  let html = f.context._dkOfficeSceneHtml(desks);
  assert.match(html, /data-office-enter-task="first"/);
  assert.doesNotMatch(html, /data-office-enter-task="second"/);
  f.click('data-ros', desks[0].key);
  html = f.context._dkOfficeSceneHtml(desks);
  assert.equal(f.get('_dkPick'), '__all__');
  assert.match(html, /data-office-enter-task="second"/);
});

test('retired seats remain in deliveries without leaking into active seat filters', () => {
  const tasks = [{ id: 'delivered', title: '保留历史成果', phase: 'done', deskKey: 'retired' }];
  const desks = [{ key: 'retired', name: '旧执行机', historyOnly: true }];
  const f = fixture(tasks, desks);
  f.context._dkOfficeBindScene(f.scene);
  f.click('data-ros', 'retired');
  const html = f.context._dkOfficeSceneHtml(desks);
  assert.equal(f.get('_dkPick'), '__all__');
  assert.doesNotMatch(html, /data-ros="retired"/);
  assert.match(html, /保留历史成果/);
  assert.match(html, /data-office-enter-task="delivered"/);
  assert.match(html, /id="aioDeliveryContent" hidden/);
  f.click('data-office-deliveries-toggle');
  assert.doesNotMatch(f.context._dkOfficeSceneHtml(desks), /id="aioDeliveryContent" hidden/);
});


test('current Agent management can still rename the exact machine and clear its alias', async () => {
  const calls = [];
  const context = { window: {}, SoduWorkAPI: { setExecutionName: async (...args) => calls.push(args) } };
  vm.createContext(context);
  vm.runInContext(read('components/panels/panels-runners.js'), context);
  vm.runInContext("_rnNaming['runner-1'] = '  开发机  '", context);
  await context._rnSaveName('runner-1', [{ runnerId: 'runner-1', machineKey: 'machine-stable' }]);
  vm.runInContext("_rnNaming['runner-1'] = ''", context);
  await context._rnSaveName('runner-1', [{ runnerId: 'runner-1', machineKey: 'machine-stable' }]);
  assert.deepEqual(calls, [['machine', 'machine-stable', '开发机'], ['machine', 'machine-stable', '']]);
  assert.equal(vm.runInContext("_rnNaming['runner-1']", context), undefined);
});
