'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const { create: createWorkspaceState } = require('../main/workspace-state.cjs');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

test('team Escape preserves hosted and standalone pages while legacy overlays still close', () => {
  const source = read('components', 'team', 'team.js');
  const start = source.indexOf("document.addEventListener('keydown', (e) => {");
  const end = source.indexOf('\n    });', start) + '\n    });'.length;
  assert.ok(start >= 0 && end > start);
  for (const [page, hosted, prevented, expected] of [
    ['workspace', true, false, 0], ['team', false, false, 0], ['inbox', false, false, 0],
    ['', false, false, 1], ['', false, true, 0],
  ]) {
    let handler, closed = 0;
    const panel = { classList: { contains: name => name === 'show' || (name === 'workspace-hosted' && hosted) } };
    vm.runInNewContext(source.slice(start, end), {
      document: { documentElement: { dataset: { deskPanel: page } },
        getElementById: () => panel, addEventListener: (_name, callback) => { handler = callback; } },
      closeTeamPanel: () => closed++,
    });
    handler({ key: 'Escape', defaultPrevented: prevented });
    assert.equal(closed, expected, `${page || 'pet'} hosted=${hosted} prevented=${prevented}`);
  }
});

test('tray double click: settings take effect permanently, no transient reveal', () => {
  const main = read('main.js');


  assert.doesNotMatch(main, /_flags\.merge\(\{ dock: true, pet: true \}\)/,
    '双击不得改写用户偏好');
  assert.doesNotMatch(main, /applyDeskFlags\(true, \{ dock: true, pet: true \}\)/,
    '双击不得临时唤回球/竖条');
  assert.doesNotMatch(main, /_deskTransient/, '主进程不得残留临时唤回状态');
  assert.match(main, /openDeskWindow\(\{ panel: 'workspace' \}, null\)/,
    '双击仍要能找回主窗口');
});

test('renderer desk-flags receiver writes cfg directly, no transient channel', () => {
  const bridge = read('core', 'win-bridge.js');
  const start = bridge.indexOf('soduWorkAPI.onDeskFlags');
  const onFlags = bridge.slice(start, start + 900);
  assert.doesNotMatch(onFlags, /f\.transient|_deskTransient/,
    '临时唤回通道已退役，不得残留');
  assert.match(onFlags, /if \('dock' in f\) Store\._cfg\.dockVisible = !!f\.dock;/,
    '托盘/设置页改动直接落 cfg 真值');
  assert.match(onFlags, /saveCfg\(\)/, '收到改动必须 saveCfg 持久化');
});

test('desk visibility follows the preference only', () => {
  const settings = read('components', 'settings', 'settings.js');
  const pet = settings.slice(settings.indexOf('function applyPetVisible'), settings.indexOf('function applyDockVisible'));
  /* Pet visibility follows the persisted preference. */
  assert.ok(pet.includes('cfg.petVisible !== false'), '球显隐只认偏好');
  assert.doesNotMatch(pet, /_deskTransient/, '球显隐不得认会话覆盖');
  const dock = read('components', 'pet', 'pet-dock.js');
  assert.ok(dock.includes('cfg.dockVisible === false || cfg.tasksOn === false'),
    '竖条显隐只认偏好');
  assert.doesNotMatch(dock, /_deskTransient/, '竖条显隐不得认会话覆盖');
});

test('transient reveal mechanism is fully retired across the client', () => {
  /* Prevent retired transient desktop visibility state from returning. */
  for (const source of [read('main.js'), read('core', 'win-bridge.js'),
                        read('components', 'settings', 'settings.js'),
                        read('components', 'pet', 'pet-dock.js')]) {
    assert.doesNotMatch(source, /_deskTransient/, '不得残留 _deskTransient');
  }
  const main = read('main.js');
  assert.ok(main.includes('applyDeskFlags(true)'), '托盘菜单仍走显式偏好广播');
});

test('mac dock icon click reveals a minimized workspace, but pet-driven activation does not', () => {
  const main = read('main.js');
  /*
   * On macOS activation, restore, show, and focus a minimized workspace.
   */
  assert.match(main, /app\.on\('activate'\,? ?\(\) => \{[\s\S]*?process\.platform === 'darwin'[\s\S]*?openDeskWindow\(\{ panel: 'workspace' \}, null\)/,
    'activate 必须在 mac 上唤回工作区');
  /*
   * Ignore activation immediately after overlay interaction so clicking the pet does not
   * force workspace navigation.
   */
  assert.match(main, /browser-window-focus/);
  assert.match(main, /_overlayFocusAt/);
  assert.match(main, /overlayEngaged/);





  assert.match(main, /function revealWorkWindow\(win\) \{[\s\S]*?restore\(\)[\s\S]*?show\(\)[\s\S]*?focus\(\)/,
    '已存在的工作区用 restore+show+focus 带回（不做跨 Space 召唤）');
  assert.match(main, /revealWorkWindow\(existing\)/,
    '已存在的工作区走 revealWorkWindow');
  assert.doesNotMatch(main, /\.setVisibleOnAllWorkspaces\(/,
    '主窗口不得再做任何跨 Space 集合行为（全住第一个桌面）');
  assert.match(main, /app\.on\('activate'[\s\S]*?return;[\s\S]*?BrowserWindow\.getAllWindows\(\)\.length === 0\) \{[\s\S]*?_desktopOverlay\.createWindow\(\);/,
    'Windows 上 activate 原行为必须保留（darwin 分支后不可提前改写）');
  assert.match(main, /second-instance[\s\S]*?process\.platform === 'darwin'[\s\S]*?openDeskWindow\(\{ panel: 'workspace' \}, null\)/);
});

test('settings keeps an explicit quick dock visibility control', () => {
  const html = read('desk.html');
  const settings = read('components', 'settings', 'settings.js');
  assert.match(html, /id="dockVisibleChk"/);
  assert.match(html, /快捷竖条/);
  assert.match(settings, /cfg\.dockVisible = dv\.checked/);
  assert.match(settings, /applyDockVisible\(\)/);
});

test('workspace loads recent chats on first mount without opening create', () => {
  const shell = read('components', 'workspace', 'workspace-shell.js');
  const chat = read('components', 'panels', 'panels-chat.js');
  assert.match(shell, /subscribeConversationPresence\(\);\s*refreshConversationHistory\(\);/);
  assert.match(shell, /function refreshConversationHistory\(\)/);
  assert.match(shell, /api\.history\(\)/);
  assert.match(chat, /WorkspaceShell\.refreshConversationHistory\(\)/);
  assert.match(shell, /正在加载聊天…/);
  assert.doesNotMatch(shell, /renderNav\(\);\s*setChats\(\[\]\)/);
});

test('workspace cold start opens the home page and remembers the last page for tray reopen', () => {
  const head = read('desk.html').match(/<script>([\s\S]*?)<\/script>/)[1];
  const state = createWorkspaceState();
  const boot = current => {
    const args = current.resolve({ panel: 'workspace' });
    const context = { URLSearchParams, location: { search: '?' + new URLSearchParams(args) },
      localStorage: { getItem: () => 'skills' }, window: {},
      document: { documentElement: { setAttribute() {} }, addEventListener() {} } };
    vm.runInNewContext(head, context);
    return context.window.__deskArgs;
  };
  assert.equal(boot(state).view, 'create');
  state.set('skills');
  assert.equal(boot(state).view, 'skills');
  assert.equal(boot(createWorkspaceState()).view, 'create');
});

test('tray reveal without a target does not navigate an already open workspace', () => {
  const main = read('main.js');
  const start = main.indexOf('function openDeskWindow(');
  const end = main.indexOf('function _appIcon(', start);
  const sent = [], revealed = [];
  const win = { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } };
  const state = createWorkspaceState(); state.set('skills');
  const context = { _desktopOverlay: { notifyBlur() {} }, _WORK_SPEC: { workspace: {} },
    _workspaceState: state, _workWindows: new Map([['workspace', win]]),
    revealWorkWindow: value => revealed.push(value) };
  vm.runInNewContext(main.slice(start, end), context);
  context.openDeskWindow({ panel: 'workspace' }, null);
  assert.equal(revealed.length, 1);
  assert.deepEqual(sent, []);
  context.openDeskWindow({ panel: 'workspace', view: 'settings' }, null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'desk-open');
  assert.equal(sent[0][1].view, 'settings');
  assert.equal(sent[0][1].workspaceRestore, undefined);
});

test('AI office idle state stays centered with a clear first-work entry', () => {
  const office = read('components', 'panels', 'panels-aidesk-office.js');
  const css = read('components', 'panels', 'panels-aidesk-office.css');
  const idle = office.slice(office.indexOf('function _dkOfficeFlowEmpty'),
    office.indexOf('function _dkOfficeSceneHtml'));
  assert.doesNotMatch(idle, /打开任务中心/);
  assert.doesNotMatch(idle, /查看 Agent 状态/);
  assert.match(office, /aio-work-list' \+ \(visible\.length \? '' : ' is-empty'\)/);
  assert.match(css, /\.aio-work-list\.is-empty \{[^}]*grid-template-columns:minmax\(0,1fr\);[^}]*place-items:stretch;/);
  assert.match(css, /\.aio-flow-empty \{[^}]*min-height:360px;[^}]*place-items:center;/);
  assert.match(idle, /data-office-new-chat/);
});

test('AI employee strip and work cards reserve legible identity and content space', () => {
  const css = read('components', 'panels', 'panels-aidesk-office.css');
  assert.match(css, /\.aio-agent \{[^}]*min-height:68px;/);
  assert.match(css, /\.aio-work-item \{[^}]*min-height:156px;/);
});
test('task and AI execution details share the main workspace interaction model', () => {
  const bridge = read('core', 'win-bridge.js');
  const session = read('components', 'panels', 'task-execution-stream.js');
  const assignment = read('components', 'requirements', 'requirement-assignment.js');
  const requirement = read('components', 'requirements', 'requirements-detail.js');
  const detail = read('components', 'panels', 'panels-detail.js');
  const html = read('desk.html');
  const route = bridge.slice(bridge.indexOf('function routeToWorkWindow'),
    bridge.indexOf('global.openSettingsEntry'));
  const standalone = route.slice(route.indexOf('const standalone'),
    route.indexOf('if (!standalone'));

  assert.doesNotMatch(standalone, /panel === 'detail'/,
    'task detail stays in the main workspace instead of opening another window');
  assert.match(route, /WorkspaceHost\.open\(panel, extra \|\| \{\}\)/);
  assert.match(assignment, /openTaskConversation\?\.\(id, '', \{source: 'requirement', navigation: true, \.\.\.\(chatId \? \{chatId\} : \{\}\)\}\)/);
  assert.match(session, /class="nmsg user dks-message"/);
  assert.match(detail, /window\.openDetailEntry\?\.\(detailId\)/);
  assert.match(requirement, /returnFocus = previousFocus/);
  assert.doesNotMatch(html, /id="detailPanel"/);
});
