'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function snapshot(done, state, title) {
  return {
    task: { id: 'task-1', status: done === 4 ? 'done' : 'todo' },
    summary: { currentStageName: '需求与输入已记录', currentState: 'running', nextAction: '正在执行',
      totalStages: 9, completedStages: 1,
      lifecycle: { title, state, nextAction: done === 4 ? '查看成果与验收记录' : '安排执行',
        description: '需求记录、执行工作、结果确认、交付完成',
        progress: { done, total: 4, unit: '阶段' } } },
    card: { stage: { state: 'running', error: 'old execution error' } },
    runs: [], stages: [], phases: [], ai: [], execution: { sessions: [] },
  };
}

function fixture() {
  const listeners = new Map(), timers = new Map();
  let nextTimer = 0, calls = 0, held = null, current = snapshot(4, 'succeeded', '需求已完成');
  const context = {
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    SoduWorkAPI: { taskTrace: async () => {
      calls += 1; const value = current, wait = held; held = null;
      if (wait) await wait;
      return value;
    } },
  };
  context.window = context;
  vm.createContext(context);
  for (const name of ['task-trace-view.js', 'task-trace-rail-view.js', 'task-trace-runtime.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', name), 'utf8'), context);
  }
  const container = () => ({ isConnected: true, firstElementChild: {}, innerHTML: '',
    querySelectorAll: () => [], querySelector: () => null });
  return { api: context.TaskExecutionJourney, rail: context.TaskTraceRailView, container,
    calls: () => calls, set: value => { current = value; },
    hold() { let release; held = new Promise(resolve => { release = resolve; }); return release; },
    change: () => listeners.get('soduwork-work-task-change')({ detail: { taskId: 'task-1' } }),
    async flush() {
      const pending = [...timers.values()]; timers.clear();
      for (const fn of pending) await fn();
      await new Promise(resolve => setImmediate(resolve));
    } };
}

test('task hero and execution rail render one lifecycle title, state and four-stage progress', () => {
  const f = fixture(), trace = snapshot(4, 'succeeded', '需求已完成');
  const hero = f.api.html(trace, {}).match(/<section class="tfd-hero[\s\S]*?<\/section>/)[0];
  const rail = f.rail.html(trace, {}).match(/<section class="trv-now[\s\S]*?<\/section>/)[0];
  for (const html of [hero, rail]) {
    assert.match(html, /需求已完成/);
    assert.match(html, /查看成果与验收记录/);
    assert.match(html, /4\/4/);
    assert.match(html, /阶段/);
    assert.doesNotMatch(html, /正在执行|old execution error|\/ 9|is-live|is-run/);
  }
});

test('open trace refreshes after completion and reopening task events', async () => {
  const f = fixture(), root = f.container();
  await f.api.mount(root, { taskId: 'task-1', trace: snapshot(1, 'running', '执行工作'), refreshMs: 0 });
  f.change(); await f.flush();
  assert.match(root.innerHTML, /流程进度 4\/4/);
  f.set(snapshot(1, 'planned', '等待开始'));
  f.change(); await f.flush();
  assert.match(root.innerHTML, /流程进度 1\/4/);
  assert.match(root.innerHTML, /<h3>等待开始<\/h3>/);
  f.api.unmount(root);
});

test('forced remount bypasses fresh cache and a toggle mount keeps the same request', async () => {
  const f = fixture(), oldRoot = f.container(), root = f.container();
  await f.api.mount(oldRoot, { taskId: 'task-1', refreshMs: 0 });
  f.api.unmount(oldRoot);
  f.set(snapshot(1, 'planned', '等待开始'));
  const pending = f.api.mount(root, { taskId: 'task-1', refreshMs: 0, force: true });
  const toggle = f.api.mount(root, { taskId: 'task-1', refreshMs: 0 });
  await Promise.all([pending, toggle]);
  assert.equal(f.calls(), 2);
  assert.match(root.innerHTML, /<h3>等待开始<\/h3>/);
  f.api.unmount(root);
});

test('forced remount after a task change cannot reuse the pre-change in-flight response', async () => {
  const f = fixture(), oldRoot = f.container(), root = f.container(), release = f.hold();
  const oldRequest = f.api.mount(oldRoot, { taskId: 'task-1', refreshMs: 0 });
  f.api.unmount(oldRoot);
  f.set(snapshot(1, 'planned', '等待开始'));
  const freshRequest = f.api.mount(root, { taskId: 'task-1', refreshMs: 0, force: true });
  release(); await Promise.all([oldRequest, freshRequest]);
  assert.equal(f.calls(), 2);
  assert.match(root.innerHTML, /<h3>等待开始<\/h3>/);
  f.api.unmount(root);
});
