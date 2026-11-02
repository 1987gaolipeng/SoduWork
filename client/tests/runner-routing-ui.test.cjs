'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const context = {
    window: {},
    esc: value => String(value ?? '').replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'components', 'panels',
    'panels-runners.js'), 'utf8'), context);
  const desktop = { runnerId: 'desktop', label: '本机', owned: true, online: true, embedded: true,
    scope: 'current-instance', isCurrentDevice: true,
    mode: 'accepting', accepting: true, agents: [], sessions: [], busy: 4 };
  const server = { runnerId: 'server', label: '远程节点', owned: true, online: true,
    scope: 'personal-cloud',
    mode: 'accepting', accepting: true, agents: [], sessions: [], busy: 0 };
  return { context, desktop, server, render: nodes => context.window.RunnerManager.render(nodes) };
}

function preferredId(html) {
  return Array.from(html.matchAll(/<article id="rn-card-([^"]+)" class="([^"]+)"/g))
    .filter(match => match[2].split(' ').includes('is-preferred')).map(match => match[1]);
}

test('empty Runner view exposes escaped local connection diagnostics', () => {
  const f = fixture();
  f.context._agData = { localRunnerReason: '后台未确认上线 <fixture>' };
  const html = f.render([]);
  assert.match(html, /后台未确认上线 &lt;fixture>/);
  assert.doesNotMatch(html, /<fixture>/);
});

test('personal Runner view excludes foreign machines and never renders a cached organization directory', () => {
  const f = fixture();
  f.context._agData = { runnerDirectory: {
    items: [{ id: 'other', name: 'Other employee', orgName: 'Private department' }],
    mates: [{ id: 'other', name: 'Other employee' }],
    orgUnits: [{ id: 'private', name: 'Private department' }],
  } };
  f.context.window.__teamCap = { name: 'Other employee' };
  const foreign = { ...f.server, runnerId: 'foreign', label: 'Other computer', owned: false };
  const unknown = { ...f.server, runnerId: 'unknown', label: 'Unverified computer', owned: undefined };
  const html = f.render([foreign, f.desktop, unknown]);
  assert.match(html, /我的执行机/);
  assert.match(html, /id="rn-card-desktop"/);
  assert.deepEqual(preferredId(html), ['desktop']);
  assert.doesNotMatch(html, /Other employee|Private department|Other computer|Unverified computer|rn-card-foreign|组织与执行资源/);
  assert.match(html, /1 个节点在线/);
});

test('Runner management renders one preferred embedded node despite a lower remote load', () => {
  const f = fixture();
  const html = f.render([f.server, f.desktop]);
  assert.deepEqual(preferredId(html), ['desktop']);
  assert.match(html, /当前优先使用「本机」/);
  assert.equal((html.match(/class="rn-preferred">首选/g) || []).length, 1);
});

test('an unavailable current instance never silently selects a different environment', () => {
  for (const unavailable of [{ mode: 'draining' }, { mode: 'disabled' },
    { online: false }, { accepting: false }]) {
    const f = fixture();
    Object.assign(f.desktop, unavailable);
    const html = f.render([f.desktop, f.server]);
    assert.deepEqual(preferredId(html), [], JSON.stringify(unavailable));
    assert.match(html, /使用其他环境时，请明确选择云端或指定执行机/);
    assert.match(html, /个人云端/);
    assert.doesNotMatch(html, /新任务会自动绕行/);
    if (unavailable.online === false) assert.match(html, /等待此执行环境恢复/);
    if (unavailable.mode === 'draining') assert.match(html, /暂不接收新任务/);
  }
});

test('Runner management preserves offline records and explains waiting when no node accepts work', () => {
  const f = fixture();
  f.desktop.online = false;
  f.server.mode = 'draining';
  const html = f.render([f.desktop, f.server]);
  assert.deepEqual(preferredId(html), []);
  assert.match(html, /当前没有可接单节点，任务会保留等待/);
  assert.match(html, /id="rn-card-desktop"/);
  assert.match(html, /id="rn-card-server"/);
  assert.match(html, /现有记录仍保留/);
});

test('same-host or older-client embedded flags never identify the current instance or default Runner', () => {
  const f = fixture();
  const other = { ...f.desktop, runnerId: 'other-instance', scope: 'bound-runner', isCurrentDevice: false };
  const unknown = { ...f.desktop, runnerId: 'old-inventory', scope: undefined, isCurrentDevice: undefined };
  const html = f.render([other, unknown]);
  assert.deepEqual(preferredId(html), []);
  assert.match(html, /关联执行机/); assert.match(html, /远程执行环境/);
  assert.match(html, /id="rn-card-other-instance"/); assert.match(html, /id="rn-card-old-inventory"/);
});

test('pause confirmation preserves sessions and requires an explicit environment choice', () => {
  const f = fixture();
  vm.runInContext("_rnConfirm = 'desktop';", f.context);
  const html = f.render([f.desktop, f.server]);
  assert.match(html, /暂停接收新任务？/);
  assert.match(html, /现有 0 个会话不会中断/);
  assert.match(html, /使用其他环境执行新任务时，请明确选择云端或指定执行机/);
  assert.doesNotMatch(html, /新任务会自动选择其他节点/);
});
