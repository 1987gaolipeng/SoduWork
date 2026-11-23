'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const html = read('desk.html');
const boot = read('desk-boot.js');

function fixture({ failMount = false, failOpen = false, view = 'create', taskId, openApproval, initData = async () => {},
  navigate = (_view, payload, open) => open(_view, payload) } = {}) {
  const events = new EventTarget();
  const classes = new Set();
  const blank = { style: {}, classList: { add: value => classes.add(value) } };
  const hint = { textContent: '正在载入…' };
  const retry = Object.assign(new EventTarget(), { hidden: true, textContent: '' });
  const elements = { deskBlank: blank, deskBlankHint: hint, deskBlankRetry: retry };
  let deadline, start, detailDrawer, reloads = 0;
  const scope = {
    __deskPanel: 'workspace', __deskArgs: { view, taskId }, navigator: { language: 'zh-CN' },
    addEventListener: events.addEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events), Event, initData,
    setTimeout: (callback, ms) => { deadline = { callback, ms }; },
    location: { reload: () => { reloads++; } },
    document: { readyState: 'loading', getElementById: id => elements[id], querySelectorAll: () => [],
      querySelector: selector => selector === '.rq-detail-backdrop' ? detailDrawer : null,
      documentElement: { setAttribute() {} },
      addEventListener(type, listener) { if (type === 'DOMContentLoaded') start = listener; } },
    openComposePanel() { if (failOpen) throw Error('fixture open failure'); },
    openApprovalsEntry(payload) { return openApproval(payload, () => { detailDrawer = {}; }); },
    WorkspaceShell: {
      mount() { if (failMount) throw Error('fixture mount failure'); },
      setTasks() {}, setConnected() {}, setActive() {},
    },
    WorkspaceNavigation: { open: navigate },
    console: { error() {}, warn() {} },
  };
  scope.window = scope;
  vm.createContext(scope);
  const recovery = html.match(/<script id="deskStartupRecovery">([\s\S]*?)<\/script>/)?.[1];
  if (recovery) vm.runInContext(recovery, scope);
  vm.runInContext(boot, scope);
  return { start, blank, hint, retry, classes, deadline, host: scope.WorkspaceHost, reloads: () => reloads };
}

test('a workspace mount failure exposes a reload action after the startup timeout', () => {
  const f = fixture({ failMount: true });
  assert.throws(f.start, /fixture mount failure/);
  assert.equal(f.retry.hidden, true);
  assert.equal(f.deadline?.ms, 15000);
  f.deadline.callback();
  assert.match(f.hint.textContent, /工作区尚未打开/);
  assert.equal(f.retry.hidden, false);
  assert.ok(f.classes.has('desk-startup-recovery'));
  f.retry.dispatchEvent(new Event('click'));
  assert.equal(f.reloads(), 1);
});

test('an initial page error shows reload without waiting for the timeout', () => {
  const f = fixture({ failOpen: true });
  f.start();
  assert.equal(f.retry.hidden, false);
  assert.match(f.hint.textContent, /工作区尚未打开/);
});

test('a successful open keeps the recovery action hidden past the deadline', () => {
  const f = fixture();
  f.start();
  assert.equal(f.blank.style.display, 'none');
  f.deadline?.callback();
  assert.equal(f.retry.hidden, true);
});

test('a slow workspace can still open and dismiss recovery without reloading', async () => {
  let finish;
  const f = fixture({ view: 'history', initData: () => new Promise(resolve => { finish = resolve; }) });
  f.start();
  f.deadline?.callback();
  assert.equal(f.retry.hidden, false);
  finish();
  await new Promise(setImmediate);
  assert.equal(f.blank.style.display, 'none');
  assert.equal(f.reloads(), 0);
});

test('a page selected while boot is pending wins over the startup route and timeout', async () => {
  let finish;
  const f = fixture({ view: 'history', initData: () => new Promise(resolve => { finish = resolve; }) });
  f.start();
  f.host.open('notices', {});
  f.deadline.callback();
  assert.equal(f.retry.hidden, true);
  finish();
  await new Promise(setImmediate);
  assert.equal(f.host.view, 'notices');
});

test('a pending restore is not treated as a mounted page or retried at boot', async () => {
  let finish, attempts = 0;
  const f = fixture({ navigate(view, payload, open) {
    attempts++;
    return new Promise(resolve => { finish = () => resolve(open(view, payload)); });
  } });
  f.start();
  await new Promise(setImmediate);
  assert.equal(attempts, 1);
  assert.notEqual(f.blank.style.display, 'none');
  f.deadline.callback();
  assert.equal(f.retry.hidden, false);
  finish();
  await new Promise(setImmediate);
  assert.equal(f.blank.style.display, 'none');
});

test('a rejected restored route exposes reload without waiting for the deadline', async () => {
  let fail;
  const f = fixture({ navigate: () => new Promise((_resolve, reject) => { fail = reject; }) });
  f.start();
  fail(Error('restore and fallback failed'));
  await new Promise(setImmediate);
  assert.equal(f.retry.hidden, false);
  assert.notEqual(f.blank.style.display, 'none');
});

test('a legacy approval opens the workspace as soon as its detail drawer mounts', async () => {
  let finish;
  const f = fixture({ view: 'approvals', taskId: 'task-1', openApproval(payload, mount) {
    assert.equal(payload.taskId, 'task-1');
    mount();
    return new Promise(resolve => { finish = resolve; });
  } });
  f.start();
  assert.equal(f.host.view, '');
  f.deadline.callback();
  assert.equal(f.retry.hidden, true);
  finish();
  await new Promise(setImmediate);
  assert.equal(f.blank.style.display, 'none');
});

test('a legacy approval that opens no detail still allows startup recovery', () => {
  const f = fixture({ view: 'approvals', taskId: 'task-1', openApproval: () => false });
  f.start();
  f.deadline.callback();
  assert.equal(f.retry.hidden, false);
});
