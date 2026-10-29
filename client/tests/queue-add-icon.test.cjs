'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8');

test('stale running aliases cannot spin; only the live active task spins', () => {
  const sandbox = { window: {}, document: { activeElement: null } };
  vm.runInNewContext(read('chat-send-queue.js'), sandbox);
  const host = { dataset: {}, classList: { add() {}, toggle() {} } };
  const ctx = { _snap: { execution: { queue: [], turnQueue: {} } }, _localQueue: [], _collabEntries: () => [],
    _collabTasks: new Map(), esc: s => String(s) };
  const queue = sandbox.window.ChatSendQueue.create(ctx);
  for (const status of ['running', 'doing', 'executing', 'streaming']) {
    ctx._snap.execution.queue = [{ id: 'one', taskId: 'task-a', text: 'One task', status }];
    queue._renderQueue({ querySelector: () => host });
    assert.match(host.innerHTML, /data-queue-state="queued"/);
    assert.doesNotMatch(host.innerHTML, /class="nqueue-progress"/);
  }
  ctx._snap.execution.queue[0].status = 'queued';
  ctx._snap.execution.turnQueue.activeTaskId = 'task-a';
  ctx._snap.execution.running = true;
  queue._renderQueue({ querySelector: () => host });
  assert.match(host.innerHTML, /data-queue-state="running"/);
  assert.equal((host.innerHTML.match(/class="nqueue-progress"/g) || []).length, 1);
  assert.doesNotMatch(host.innerHTML, /data-queue-action="remove"/);
  ctx._collabTasks.set('task-a', { task: { readOnly: true } });
  queue._renderQueue({ querySelector: () => host });
  assert.match(host.innerHTML, /已转交 · 查看进展/);
  assert.doesNotMatch(host.innerHTML, /class="nqueue-progress"/);
});

test('add-task entry is icon-only but retains a name, tooltip and original picker action', async () => {
  const sandbox = { window: {}, document: { activeElement: null } };
  vm.runInNewContext(read('chat-send-queue.js'), sandbox);
  let opened = 0;
  const host = { dataset: {}, classList: { add() {}, toggle() {} } };
  const ctx = { _snap: { execution: { queue: [] } }, _localQueue: [], _collabEntries: () => [],
    _collabTasks: new Map(), esc: s => String(s), _openTaskPicker: () => opened++ };
  const queue = sandbox.window.ChatSendQueue.create(ctx);
  for (const rows of [[], [{ id: 'message', text: 'Pending follow-up' }]]) {
    ctx._snap.execution.queue = rows;
    queue._renderQueue({ querySelector: () => host });
    const button = host.innerHTML.match(/<button[^>]*data-queue-action="add"[^>]*>(.*?)<\/button>/s);
    assert.ok(button);
    assert.match(button[0], /aria-label="添加需求" title="添加需求"/);
    assert.match(button[1], /<svg/);
    assert.equal(button[1].replace(/<[^>]+>/g, '').trim(), '');
    await queue._queueAction('add');
  }
  assert.equal(opened, 2);
});

test('neutral add-task icon retains contrast, themed focus, touch and reduced-motion support', () => {
  const css = read('panels-chat.css');
  assert.match(css, /button\[data-queue-action="add"\]\{[^}]*width:28px;height:28px/);
  assert.match(css, /button\[data-queue-action="add"\]:focus-visible\{outline:2px solid var\(--accent\)/);
  assert.match(css, /@media\(pointer:coarse\)\{[^}]*width:44px;height:44px/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{[^}]*data-queue-action="add"[^}]*transition:none/);
  assert.doesNotMatch(css, /button\[data-queue-action="add"\]:hover\{[^}]*transform:/);
  assert.match(css, /\.nqueue-add-dock\{position:absolute;[^}]*pointer-events:none/);
  assert.match(css, /\.nqueue-curve-fill\{fill:var\(--bg-0\)/);
  assert.match(css, /\.nqueue-toolbar\{position:relative;[^}]*min-height:var\(--task-dock-rise,30px\)/);
  assert.doesNotMatch(css, /\.nqueue-toolbar>div:first-child\{[^}]*position:absolute/);
  const rule = css.match(/button\[data-queue-action="add"\]\{([^}]+)\}/)[1];
  assert.match(rule, /border-radius:999px/);
  const background = rule.match(/(?:^|;)background:(#[0-9a-f]{6})(?:;|$)/i)?.[1];
  const foreground = rule.match(/(?:^|;)color:(#[0-9a-f]{6})(?:;|$)/i)?.[1];
  assert.ok(background && foreground, 'Neutral button supplies both foreground and background');
  const luminance = hex => hex.slice(1).match(/../g).map(part => parseInt(part, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const colors = [luminance(background), luminance(foreground)].sort((a, b) => b - a);
  assert.ok((colors[0] + .05) / (colors[1] + .05) >= 4.5, 'Add-task glyph remains readable');
  assert.match(css, /\.nqueue-add-dock\{[^}]*width:88px;height:30px;padding-top:4px/);
  assert.match(read('chat-send-queue.js'), /viewBox="0 0 88 30"/);
  assert.match(read('chat-send-queue.js'), /M0 28C18 28 23 25 27 15C31 5 35 1 44 1C53 1 57 5 61 15C65 25 70 28 88 28/);
});
