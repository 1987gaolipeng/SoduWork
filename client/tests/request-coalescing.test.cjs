'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runScript(file, context) {
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return (code) => vm.runInContext(code, context);
}

test('AI desk shares one request and performs only one trailing refresh', async () => {
  const listeners = new Map();
  const classes = new Set(['show']);
  const panel = { classList: { contains: (name) => classes.has(name) } };
  const body = { dataset: {}, innerHTML: '', isConnected: true };
  const context = {
    console,
    document: {
      visibilityState: 'visible',
      getElementById: (id) => id === 'aiDeskPanel' ? panel : (id === 'dkBody' ? body : null),
      addEventListener: (name, fn) => listeners.set('document:' + name, fn),
    },
    localStorage: { getItem: () => null, setItem() {} },
    SoduWorkAPI: { aiDesks: async () => ({ desks: [] }) },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    __calls: 0, __active: 0, __maxActive: 0, __resolvers: [], __focuses: [],
  };
  const run = runScript(path.join(__dirname, '../components/panels/panels-desk.js'), context);
  run(`_fetchDesks = async (_body, focus) => {
    __calls += 1; __active += 1; __maxActive = Math.max(__maxActive, __active);
    __focuses.push(focus);
    return new Promise((resolve) => __resolvers.push(() => {
      __active -= 1; resolve({ desks: [] });
    }));
  }`);

  const first = run('_loadDesks("task-first")');
  const joined = run('_loadDesks("task-latest")');
  assert.equal(context.__calls, 1);
  assert.equal(context.__maxActive, 1);

  context.__resolvers.shift()();
  await Promise.all([first, joined]);
  await sleep(210);

  assert.equal(context.__calls, 2);
  assert.equal(context.__maxActive, 1);
  assert.deepEqual(context.__focuses, ['task-first', 'task-latest']);
  context.__resolvers.shift()();
  await sleep(10);
  classes.delete('show');
  run('closeAIDesk()');
});

test('task trace merges event bursts and never overlaps forced refreshes', async () => {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const clock = { id: 0, now: 0, timers: [] };
  const trace = {
    schemaVersion: '1.0',
    task: { id: 'task-1', title: 'Performance regression', status: 'doing' },
    runs: [], stages: [], phases: [], approvals: [], deployments: [], artifacts: [],
    attachments: [], timeline: [], ai: [], execution: { sessions: [] },
    summary: { totalStages: 0, completedStages: 0 },
    card: { taskId: 'task-1', stage: {} },
    delivery: { state: 'running', manifest: { primary: [], supporting: [], evidence: [] }, blockers: [] },
  };
  const container = {
    isConnected: true,
    firstElementChild: {},
    innerHTML: '',
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const context = {
    console,
    document: {
      visibilityState: 'visible',
      addEventListener: (name, fn) => documentListeners.set(name, fn),
      removeEventListener: (name, fn) => {
        if (documentListeners.get(name) === fn) documentListeners.delete(name);
      },
    },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: {},
    SoduWorkAPI: {
      attachmentUrl: () => '',
      taskTrace: () => {
        context.__calls += 1;
        context.__active += 1;
        context.__maxActive = Math.max(context.__maxActive, context.__active);
        return new Promise((resolve) => context.__resolvers.push(() => {
          context.__active -= 1;
          resolve(trace);
        }));
      },
    },
    addEventListener: (name, fn) => windowListeners.set(name, fn),
    removeEventListener: (name, fn) => {
      if (windowListeners.get(name) === fn) windowListeners.delete(name);
    },
    setTimeout: (fn, ms) => {
      const timer = { id: ++clock.id, at: clock.now + ms, fn };
      clock.timers.push(timer);
      return timer.id;
    },
    clearTimeout: (id) => {
      const index = clock.timers.findIndex(timer => timer.id === id);
      if (index >= 0) clock.timers.splice(index, 1);
    },
    __calls: 0, __active: 0, __maxActive: 0, __resolvers: [],
  };
  runScript(path.join(__dirname, '../components/panels/task-trace-view.js'), context);
  runScript(path.join(__dirname, '../components/panels/task-trace-runtime.js'), context);
  await context.TaskExecutionJourney.mount(container, {
    trace, taskId: 'task-1', variant: 'task', refreshMs: 0,
  });

  const emit = () => windowListeners.get('soduwork-work-execution')({ detail: { taskId: 'task-1' } });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const advance = async ms => {
    clock.now += ms;
    const due = clock.timers.filter(timer => timer.at <= clock.now);
    for (const timer of due) {
      clock.timers.splice(clock.timers.indexOf(timer), 1);
      timer.fn();
      await tick();
    }
    await tick();
  };
  emit(); emit(); emit();
  await advance(160);
  assert.equal(context.__calls, 1);

  emit(); emit(); emit();
  await advance(160);
  assert.equal(context.__calls, 1);
  assert.equal(context.__maxActive, 1);

  context.__resolvers.shift()();
  await tick();
  await advance(140);
  assert.equal(context.__calls, 2);
  assert.equal(context.__maxActive, 1);

  context.__resolvers.shift()();
  await tick();
  context.TaskExecutionJourney.unmount(container);
  assert.equal(context.__active, 0);
});
