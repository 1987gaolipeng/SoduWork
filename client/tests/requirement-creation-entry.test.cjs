'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function fixture(panel, withBridge = true) {
  const calls = [], events = new Map(), data = panel ? { deskPanel: panel } : {};
  const document = {
    readyState: 'loading', documentElement: { dataset: data, setAttribute() {} },
    addEventListener: (name, fn) => events.set(name, [...(events.get(name) || []), fn]),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  };
  const scope = { console, document, __deskPanel: panel, __deskArgs: {},
    addEventListener() {}, dispatchEvent() {}, Event: class {}, setTimeout, clearTimeout,
    initData: async () => {}, TaskPriority: { labels: {} },
    WorkEntrySheet: { openTask: opts => { calls.push({ kind: 'form', opts }); return true; } },
    RequirementsDetail: { open: id => { calls.push({ kind: 'detail', id }); return true; } },
    openTaskCenter: opts => calls.push({ kind: 'pool', opts }),
    openAdd: () => calls.push({ kind: 'legacy-add' }),
    closeAdd() {}, close: () => calls.push({ kind: 'close-window' }),
  };
  if (withBridge) scope.soduWorkAPI = {
    openDeskWindow: payload => calls.push({ kind: 'window', payload }),
    closeDeskWindow: () => calls.push({ kind: 'close-window' }),
  };
  scope.window = scope;
  vm.createContext(scope);
  vm.runInContext(read('core/win-bridge.js'), scope);
  return { scope, calls, events, loadBoot: () => vm.runInContext(read('desk-boot.js'), scope),
    loadPanels: () => vm.runInContext(read('components/panels/panels.js'), scope) };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('桌宠新建入口进入主工作区的统一创建卡，不再打开历史派发窗口', () => {
  const f = fixture(''); f.scope.openAddEntry();
  assert.deepEqual(plain(f.calls), [{ kind: 'window', payload: {
    panel: 'workspace', view: 'history', createRequirement: true,
  } }]);
});

test('首次启动主工作区时，新建意图经原生窗口 URL 保留到渲染层', () => {
  const f = fixture(''); f.scope.openAddEntry();
  const payload = f.calls[0].payload;
  const state = require('../main/workspace-state.cjs').create();
  const main = read('main.js'), start = main.indexOf('  const q = { panel: panel };');
  const end = main.indexOf('  attachWorkWindowRecovery', start);
  let query;
  vm.runInNewContext(main.slice(start, end), { panel: payload.panel, p: state.resolve(payload),
    _workspaceState: state, path, rendererDirectory: '.', win: { loadFile: (_path, options) => { query = options.query; } } });
  const scope = { URLSearchParams, location: { search: '?' + new URLSearchParams(query) }, window: {},
    document: { documentElement: { setAttribute() {} }, addEventListener() {} } };
  vm.runInNewContext(read('desk.html').match(/<script>([\s\S]*?)<\/script>/)[1], scope);
  assert.equal(scope.window.__deskArgs.view, 'history');
  assert.equal(scope.window.__deskArgs.createRequirement, true);
});

test('主工作区新建入口在需求池打开只保存的创建卡', () => {
  const f = fixture('workspace'); f.loadBoot(); f.scope.openAddEntry();
  assert.equal(f.scope.WorkspaceHost.view, 'history');
  assert.deepEqual(f.calls.map(x => x.kind), ['pool', 'form']);
  assert.equal(f.calls[1].opts.saveOnly, true);
  assert.equal(f.calls[1].opts.requirement, true);
  assert.equal(f.calls[1].opts.triageStage, 'intake');
});

test('主工作区待验收快捷入口将阶段参数传入需求池', () => {
  const f = fixture('workspace'); f.loadBoot();
  f.scope.WorkspaceHost.open('history', {phase: 'reviewing'});
  assert.equal(f.calls.find(call => call.kind === 'pool').opts.phase, 'reviewing');
});

test('历史工作区 add 路由仍使用统一创建卡并保留需求池背景', () => {
  const f = fixture('workspace'); f.loadBoot(); f.scope.WorkspaceHost.open('add', {});
  assert.equal(f.scope.WorkspaceHost.view, 'history');
  assert.deepEqual(f.calls.map(x => x.kind), ['pool', 'form']);
  assert.equal(f.calls[1].opts.saveOnly, true);
});

test('历史独立 add 窗口打开同一创建卡，取消时关闭窗口', async () => {
  const f = fixture('add'); f.loadBoot();
  for (const fn of f.events.get('DOMContentLoaded') || []) fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.map(x => x.kind), ['form']);
  assert.equal(f.calls[0].opts.saveOnly, true);
  f.calls[0].opts.onClose();
  assert.equal(f.calls.at(-1).kind, 'close-window');
});

test('无 Electron 桥的新建入口也不回落到历史执行表单', () => {
  const f = fixture('', false); f.scope.openAddEntry();
  assert.deepEqual(f.calls.map(x => x.kind), ['form']);
  assert.equal(f.calls[0].opts.saveOnly, true);
});

test('桌宠 Ctrl+N 保留统一创建入口，主工作区不重复处理新对话快捷键', () => {
  for (const panel of ['', 'workspace']) {
    const f = fixture(panel); f.loadPanels();
    for (const fn of f.events.get('DOMContentLoaded') || []) fn();
    let prevented = false;
    const event = { key: 'n', ctrlKey: true, preventDefault() { prevented = true; } };
    for (const fn of f.events.get('keydown') || []) fn(event);
    assert.equal(prevented, !panel);
    assert.equal(f.calls.length, panel ? 0 : 1);
    if (!panel) assert.equal(f.calls[0].payload.createRequirement, true);
  }
});

test('既有需求详情和编辑入口仍定位原需求，不能被新建路由接管', () => {
  const f = fixture('workspace'); f.loadBoot(); f.scope.openDetailEntry('existing-bug');
  assert.deepEqual(plain(f.calls), [{ kind: 'detail', id: 'existing-bug' }]);
});

test('独立创建卡重复打开不触发旧关闭回调，用户取消只关闭一次', () => {
  let dismissed = 0;
  const f = fixture('add');
  f.scope.document.createElement = () => ({ isConnected: false, querySelector: () => ({}) });
  f.scope.ComposeDraft = { openWith() {}, clear() {} };
  f.scope.PluginUIHost = { registerAction() {}, mount() {
    let layer;
    return { content: { appendChild: el => { layer = el; layer.isConnected = true; } },
      destroy: () => { layer.isConnected = false; } };
  } };
  vm.runInContext(read('components/panels/work-entry-sheet.js'), f.scope);
  const options = { saveOnly: true, onClose: () => dismissed++ };
  f.scope.WorkEntrySheet.openTask(options);
  f.scope.WorkEntrySheet.openTask(options);
  assert.equal(dismissed, 0);
  assert.equal(f.scope.WorkEntrySheet.active().mode, 'task');
  f.scope.WorkEntrySheet.close();
  assert.equal(dismissed, 1);
});
