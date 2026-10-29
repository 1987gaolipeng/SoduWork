'use strict';
/*
 * Ordinary new conversations do not inherit old workspaces; only explicit project or
 * directory choices seed drafts. Preserve history restoration and selected-directory
 * records.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

function fakeElement() {
  const cache = {};
  const node = {
    style: {}, dataset: {}, hidden: false, textContent: '', innerHTML: '', children: [],
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle() {}, contains(c) { return node.classList._s.has(c); } },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
    toggleAttribute() {}, addEventListener() {}, removeEventListener() {}, remove() {}, append() {},
    focus() {}, blur() {}, closest: () => null, contains: () => false,
    appendChild(child) { node.children.push(child); return child; },
    insertBefore(child) { node.children.push(child); return child; },
    querySelector: (selector) => cache[selector] || (cache[selector] = fakeElement()),
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  };
  return node;
}
function bootShell({ recent = { ok: true, dir: '', name: '' } } = {}) {
  const bridge = {
    get: async () => ({ ...recent }),
    set: async () => ({ ok: true }),
    clear: async () => ({ ok: true }),
  };
  const window = {
    document: {
      createElement: () => fakeElement(), querySelector: () => fakeElement(), querySelectorAll: () => [],
      addEventListener() {}, documentElement: { dataset: {} }, body: { appendChild() {} },
    },
    addEventListener() {}, removeEventListener() {},
    soduWorkAPI: { recentWorkspace: bridge },
  };
  vm.runInNewContext(read('components/workspace/workspace-chat-history.js'), { window }, { filename: 'workspace-chat-history.js' });
  vm.runInNewContext(read('components/workspace/workspace-shell.js'),
    { window, document: window.document, innerWidth: 1200, innerHeight: 800 }, { filename: 'workspace-shell.js' });
  return { window, bridge, shell: window.WorkspaceShell };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('纯新对话入口不继承活动会话工作目录和项目归属', () => {
  const { shell } = bootShell();
  shell.setChats([{ id: 'c1', cwd: 'D:/work/hezi', workspaceName: 'hezi',
    sidebarProjectId: 'proj-1', sidebarProjectName: '客户360' }]);
  shell.setActiveChat('c1');
  const payload = JSON.parse(JSON.stringify(shell.newSessionPayload()));
  assert.deepEqual(payload, { newSession: true });
  assert.equal('sidebarProjectId' in payload, false);
  assert.equal('sidebarProjectName' in payload, false);
  assert.equal('projectId' in payload, false);
});

test('云端会话的目录不延续（远端缓存路径不得串进本地草稿）', () => {
  const { shell } = bootShell();
  shell.setChats([{ id: 'c2', cloud: true, cwd: 'C:/cache/remote-only', workspaceName: '云端' }]);
  shell.setActiveChat('c2');
  const payload = shell.newSessionPayload();
  assert.equal(payload.cwd, undefined);
  assert.equal('workspaceSource' in payload, false);
});

test('冷启动即使记住最近手选目录也创建独立工作区', async () => {
  const { shell } = bootShell({ recent: { ok: true, dir: 'D:/work/hezi', name: 'hezi' } });
  shell.setActiveChat('');
  shell.refreshRecentWorkspace();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(shell.newSessionPayload())),
    { newSession: true });
});

test('最近目录已失效（主进程返回空）时不兜底，回落默认工作区', async () => {
  const { shell } = bootShell({ recent: { ok: true, dir: '', name: '' } });
  shell.refreshRecentWorkspace();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(shell.newSessionPayload())), { newSession: true });
});

test('显式传入优先：目录、归属与来源标注都不被继承覆盖', () => {
  const { shell } = bootShell({ recent: { ok: true, dir: 'D:/work/hezi', name: 'hezi' } });
  shell.setChats([{ id: 'c1', cwd: 'D:/work/hezi', workspaceName: 'hezi' }]);
  shell.setActiveChat('c1');
  const explicit = shell.newSessionPayload({ cwd: 'D:/other/project', workspaceLabel: 'other',
    sidebarProjectId: 'proj-9', sidebarProjectName: 'SoduWork' });
  assert.equal(explicit.cwd, 'D:/other/project');
  assert.equal(explicit.workspaceSource, undefined);
  assert.equal(explicit.sidebarProjectId, 'proj-9');
  assert.equal(explicit.sidebarProjectName, 'SoduWork');
  assert.equal(explicit.newSession, true);
});

test('newSessionWorkspace 透传目录来源且显式入口清空残留；归属只认显式传入', () => {
  const window = {};
  vm.runInNewContext(read('components/panels/compose-surface.js'), { window }, { filename: 'compose-surface.js' });
  const newSessionWorkspace = window.ComposeSurface.newSessionWorkspace;
  const carried = newSessionWorkspace({ dir: 'old', name: '旧目录', direct: true, workspaceSource: 'last-session' },
    { cwd: 'D:/next', workspaceLabel: 'next', workspaceSource: 'recent' });
  assert.equal(carried.dir, 'D:/next');
  assert.equal(carried.workspaceSource, 'recent');
  assert.equal(carried.projectId, '');
  const explicit = newSessionWorkspace({ dir: 'old', direct: true, workspaceSource: 'last-session' },
    { cwd: 'D:/proj-folder', workspaceLabel: '客户360', projectId: 'biz-1', sidebarProjectId: 'proj-1', sidebarProjectName: '客户360' });
  assert.equal(explicit.workspaceSource, '');
  assert.equal(explicit.projectId, 'biz-1');
  assert.equal(explicit.sidebarProjectId, 'proj-1');
  const cleared = newSessionWorkspace({ dir: 'old', direct: true, workspaceSource: 'recent' }, {});
  assert.equal(cleared.dir, '');
  assert.equal(cleared.direct, false);
  assert.equal(cleared.workspaceSource, '');
});

test('真实调用序：纯入口 payload 清空旧草稿目录并使用独立工作区', () => {
  const { shell } = bootShell({ recent: { ok: true, dir: 'D:/work/hezi', name: 'hezi' } });
  shell.setChats([{ id: 'c1', cwd: 'D:/work/hezi', workspaceName: 'hezi' }]);
  shell.setActiveChat('c1');
  const window = {};
  vm.runInNewContext(read('components/panels/compose-surface.js'), { window }, { filename: 'compose-surface.js' });
  const next = window.ComposeSurface.newSessionWorkspace(
    { dir: 'old', name: '旧目录', direct: true }, shell.newSessionPayload());
  assert.equal(next.dir, '');
  assert.notEqual(next.name, 'hezi');
  assert.equal(next.direct, false);
  assert.equal(next.workspaceSource, '');
  assert.equal(next.projectId, '');
});

test('主进程持久化模块：三个 IPC、来源校验与失效目录拦截齐备', () => {
  const source = read('main/workspace/recent-workspace.js');
  assert.match(source, /ipcMain\.handle\('recent-workspace-get'/);
  assert.match(source, /ipcMain\.handle\('recent-workspace-set'/);
  assert.match(source, /ipcMain\.handle\('recent-workspace-clear'/);
  assert.match(source, /isDirectory\(\)/);
  assert.match(source, /url\.protocol === 'file:'/);
  assert.match(source, /renameSync/);
  const preload = read('preload.js');
  assert.match(preload, /recentWorkspace: \{[\s\S]*recent-workspace-get[\s\S]*recent-workspace-set[\s\S]*recent-workspace-clear/);
  /*
   * Read recentWorkspace from top-level soduWorkAPI, not the conversation-session facade
   * returned by _setupApi.
   */
  const compose = read('components/panels/panels-compose.js');
  assert.match(compose, /function _syncRecentWorkspace[\s\S]*?const bridge = global\.soduWorkAPI;/);
  assert.doesNotMatch(compose, /_setupApi\(\)[\s\S]{0,80}recentWorkspace/);
});

test('目录延续不会回流到会话记录：发送链路只取 cwd 与名称', () => {
  const compose = read('components/panels/panels-compose.js');
  const surface = read('components/panels/panels-compose.js');
  assert.match(compose, /workspaceLabel: _workspace\.direct \? _workspace\.name : '默认工作区'/);
  assert.doesNotMatch(compose, /workspaceLabel:[^,]*workspaceSource/);
  assert.match(surface, /workspaceSource: String\(options\.workspaceSource \|\| ''\)\.trim\(\)/);
});

test('面板内 newChatSession 与全局独立工作区入口同源', () => {
  const source = read('components/panels/panels-compose.js');
  const section = source.slice(source.indexOf('function newChatSession'));
  assert.match(section, /WorkspaceShell\.newSessionPayload/);
  assert.doesNotMatch(section, /\{ tab: 'chat', newSession: true \}\s*\);\s*\n  \}/);
});
