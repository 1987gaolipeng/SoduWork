'use strict';

// Run with: npx electron e2e/workspace-startup-recovery.cjs -- <loopback Hub URL> <absolute evidence directory>
// Use a disposable Hub and set SODUWORK_TEST_ACCOUNT and SODUWORK_TEST_PASSWORD for its test user.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { fileURLToPath } = require('node:url');
const { app, BrowserWindow, globalShortcut, ipcMain, net, session } = require('electron');

const [hub, output] = process.argv.slice(process.argv[2] === '--' ? 3 : 2);
const { SODUWORK_TEST_ACCOUNT: account, SODUWORK_TEST_PASSWORD: password } = process.env;
assert.match(hub || '', /^http:\/\/127\.0\.0\.1:\d+$/);
assert.ok(path.isAbsolute(output || '') && account && password, 'An evidence directory and disposable credentials are required');
const client = path.resolve(__dirname, '..');
const desk = path.join(client, 'desk.html');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'profile-'));
process.env.SODUWORK_USER_DATA = profile;
process.env.SODUWORK_TEST_HUB_URL = hub;
delete process.env.SODUWORK_TEST_PASSWORD;
app.setPath('userData', profile);
const documents = path.join(profile, 'documents');
fs.mkdirSync(documents);
app.setPath('documents', documents);
fs.writeFileSync(path.join(profile, 'autostart-initialized'), 'workspace e2e');
app.setLoginItemSettings = () => {};
globalShortcut.register = () => false;

// Exercise the real workspace and authentication without starting execution runtimes or updates.
require('../main/runner-runtime').install = () => {
  for (const channel of ['runner-status', 'runner-configure', 'runner-capability-set', 'runner-component-confirm']) {
    ipcMain.handle(channel, () => ({ ok: false, running: false, state: 'stopped', capabilityGrants: [] }));
  }
};
require('../main/client-updater').install = () => {
  for (const channel of ['client-update-status', 'client-update-check']) {
    ipcMain.handle(channel, () => ({ state: 'idle', phase: 'idle' }));
  }
};

const report = { electron: process.versions.electron, platform: process.platform,
  os: require('node:os').release(), cases: [] };
let win, owner, nextFault;
const js = source => win.webContents.executeJavaScript(source, true);
const visible = selector => `document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`;
const opened = view => `window.WorkspaceHost?.view === ${JSON.stringify(view)}`;
const retry = '#deskBlankRetry';
const notices = '.ws-rail-button[data-rail-view="notices"]';
const settings = '.ws-rail-button[data-rail-view="settings"]';

async function until(get, label, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await get();
    if (value) return value;
    await wait(75);
  }
  throw Error('Timed out waiting for ' + label);
}

function findWindow(page, panel) {
  return BrowserWindow.getAllWindows().find(candidate => {
    const url = candidate.webContents.getURL();
    if (!url.startsWith('file:')) return false;
    const { pathname, searchParams } = new URL(url);
    return pathname.endsWith('/' + page) && (!panel || searchParams.get('panel') === panel);
  });
}

async function point(selector) {
  return js(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element?.checkVisibility()) throw Error('Control is hidden');
    const bounds = element.getBoundingClientRect();
    const x = Math.round(bounds.x + bounds.width / 2), y = Math.round(bounds.y + bounds.height / 2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, clickable: element.contains(hit), hit: hit?.id || hit?.className || hit?.tagName };
  })()`);
}

async function click(selector) {
  const { x, y, clickable, hit } = await point(selector);
  assert.ok(clickable, `${selector} was covered by ${hit}`);
  for (const type of ['mouseDown', 'mouseUp']) {
    win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
  }
}

async function checkOwner() {
  await until(() => js(`window.ClientAuth?.snapshot().user?.id === ${JSON.stringify(owner)}
    && !document.documentElement.classList.contains('soduwork-auth-pending')`), 'authenticated workspace');
  assert.equal(await js('SoduWorkAPI.clientAuthMe().then(result => result.user.id)'), owner);
}

async function health() {
  const response = await fetch(hub + '/readyz', { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, 'the isolated Hub must be ready');
}

async function shot(name) {
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}

async function loadWithFault(install, view) {
  nextFault = install;
  try {
    if (view) await win.loadFile(desk, { query: { panel: 'workspace', view } });
    else {
      const loaded = once(win.webContents, 'did-finish-load');
      win.webContents.reload();
      await loaded;
    }
    assert.equal(nextFault, null, 'the new workspace document must receive the fault');
  } finally {
    nextFault = null;
  }
}

function stallStartup() {
  const initialize = window.initData;
  window.addEventListener('soduwork-workspace-ready', () => { window.workspaceBootFinished = true; }, { once: true });
  window.initData = (...args) => new Promise((resolve, reject) => {
    window.releaseWorkspaceBoot = () => Promise.resolve(initialize(...args)).then(resolve, reject);
  });
}

async function clickRetryAndCheckWorkspace() {
  const id = win.id;
  const before = await js('performance.timeOrigin');
  const loaded = once(win.webContents, 'did-finish-load');
  await click(retry);
  await loaded;
  await until(() => js(opened('create')), 'reloaded composer');
  assert.equal(win.id, id);
  assert.notEqual(await js('performance.timeOrigin'), before);
  assert.equal(await js(visible(retry)), false);
  await checkOwner();
}

async function record(name, run) {
  await health();
  try {
    const details = await run();
    await health();
    report.cases.push({ name, passed: true, ...details });
  } catch (error) {
    report.cases.push({ name, passed: false, error: error.message });
  }
  console.log(JSON.stringify(report.cases.at(-1)));
}

let exitCode = 1;
const watchdog = setTimeout(() => app.exit(1), 150000);
app.whenReady().then(async () => {
  session.defaultSession.protocol.handle('file', request => {
    if (nextFault && fileURLToPath(request.url) === desk) {
      const fault = nextFault;
      nextFault = null;
      const script = `<script>document.addEventListener('DOMContentLoaded', (${fault.toString()}),
        { capture: true, once: true });</script>`;
      const html = fs.readFileSync(desk, 'utf8').replace('<meta charset="UTF-8">', '<meta charset="UTF-8">' + script);
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return net.fetch(request, { bypassCustomProtocolHandlers: true });
  });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    ({ url }, respond) => respond({ cancel: new URL(url).host !== new URL(hub).host }));
  await health();
  // The application's file launcher should receive only Electron's app entry.
  process.argv.splice(2);
  require('../main.js');
  win = await until(() => findWindow('desk.html', 'workspace'), 'native workspace');
  win.setContentSize(1140, 800);
  await until(() => js(`${visible('#soduWorkAuthAccount')} &&
    !document.querySelector('.soduwork-auth-submit')?.disabled`), 'enabled sign-in form');
  // Submitting the actual form exercises renderer, preload, device binding and Hub authentication.
  await js(`(() => {
    const account = document.querySelector('#soduWorkAuthAccount');
    const password = document.querySelector('#soduWorkAuthPassword');
    account.value = ${JSON.stringify(account)};
    account.dispatchEvent(new Event('input', { bubbles: true }));
    if (!password.checkVisibility()) document.querySelector('.ac-auth-tabs [data-auth-mode="password"]')?.click();
    password.value = ${JSON.stringify(password)};
    password.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await click('.soduwork-auth-submit');
  try {
    owner = await until(() => js('window.ClientAuth?.snapshot().user?.id'), 'test account sign-in', 35000);
  } catch (error) {
    const status = await js(`[...document.querySelectorAll('.soduwork-auth-status, .ac-field-error:not([hidden])')]
      .map(node => node.textContent.trim()).filter(Boolean).join('; ')`);
    throw Error(status ? error.message + ' (' + status + ')' : error.message);
  }
  await checkOwner();
  // Initial login relaunches the renderer so the new device and account scope take effect.
  await wait(1200);
  await checkOwner();

  await record('partially drawn composer keeps retry and rail clickable', async () => {
    await loadWithFault(function () {
      const refresh = NativeChat.refreshHistory;
      NativeChat.refreshHistory = function (...args) {
        if (!new Error().stack.includes('openComposePanel')) return refresh.apply(this, args);
        window.workspaceFaultObserved = document.querySelector('#composePanel.show') !== null;
        throw Error('Test error after displaying the composer');
      };
    }, 'create');
    await until(() => js('window.workspaceFaultObserved'), 'fault after showing composer');
    await until(() => js(visible(retry)), 'startup retry');
    await checkOwner();
    const button = await point(retry), rail = await point(notices);
    assert.ok(button.clickable, 'retry center hits ' + button.hit);
    assert.ok(rail.clickable, 'notice button center hits ' + rail.hit);
    await shot('01-partial-composer-retry');
    await clickRetryAndCheckWorkspace();
    return { retryHit: button.hit, railHit: rail.hit, authenticatedAfterReload: true };
  });

  await record('notification navigation survives the original startup deadline', async () => {
    await loadWithFault(stallStartup, 'history');
    await until(() => js('typeof window.releaseWorkspaceBoot === "function"'), 'blocked initialization');
    await checkOwner();
    await click(notices);
    await until(() => js(`${opened('notices')} && ${visible('#noticePanel.show')}`), 'notifications');
    const clickedAtMs = await js('Math.round(performance.now())');
    assert.ok(clickedAtMs < 15000, 'notifications must open before the startup deadline');
    await until(() => js('performance.now() >= 16500'), 'real startup deadline');
    const afterMs = await js('Math.round(performance.now())');
    assert.equal(await js(visible(retry)), false);
    assert.equal(await js(opened('notices')), true);
    assert.ok((await point(notices)).clickable);
    await click(settings);
    await until(() => js(opened('settings')), 'settings after startup deadline');
    await js('releaseWorkspaceBoot()');
    await until(() => js('window.workspaceBootFinished'), 'completion of the original startup');
    assert.equal(await js(opened('settings')), true);
    return { clickedAtMs, checkedAfterMs: afterMs, navigationAfterTimeout: true };
  });

  await record('real window restore and fallback failure expose a usable retry', async () => {
    const overlay = await until(() => findWindow('index.html'), 'desktop overlay');
    await win.loadFile(desk, { query: { panel: 'workspace', view: 'create' } });
    await checkOwner();
    await until(() => js(opened('create')), 'composer before native close');
    assert.equal(await js('WorkspaceNavigation.record("create")'), true);
    const oldWindow = win.id;
    const closed = once(win, 'closed');
    win.close();
    await closed;
    await overlay.webContents.executeJavaScript('soduWorkAPI.openDeskWindow({ panel: "workspace" })');
    win = await until(() => findWindow('desk.html', 'workspace'), 'a new native workspace window');
    assert.notEqual(win.id, oldWindow);
    const restored = new URL(win.webContents.getURL()).searchParams.get('workspaceRestore');
    assert.equal(JSON.parse(restored).view, 'create');
    await until(() => js(opened('create')), 'normal composer restoration');
    await checkOwner();
    await loadWithFault(function () {
      window.workspaceFaultCount = 0;
      window.openComposePanel = function () {
        window.workspaceFaultCount++;
        throw Error('Test error during restoration and fallback');
      };
    });
    await until(() => js('window.workspaceFaultCount >= 2'), 'restore and fallback attempts');
    await until(() => js(visible(retry)), 'retry after failed restore');
    await checkOwner();
    await shot('03-window-restore-retry');
    await clickRetryAndCheckWorkspace();
    return { nativeWindowReopened: true, restoreRouteGenerated: true, authenticatedAfterReload: true };
  });

  await record('a real startup timeout clears when the delayed initial page opens', async () => {
    await loadWithFault(stallStartup, 'history');
    await until(() => js(visible(retry)), 'retry after actual startup deadline');
    assert.ok(await js('performance.now() >= 15000'));
    const origin = await js('performance.timeOrigin');
    await js('releaseWorkspaceBoot()');
    await until(() => js(opened('history')), 'requirements after delayed initialization');
    assert.equal(await js(visible(retry)), false);
    assert.equal(await js('performance.timeOrigin'), origin);
    await checkOwner();
    return { reloaded: false };
  });

  await record('legacy approval details do not trigger workspace recovery', async () => {
    const task = { id: randomUUID(), kind: 'requirement', title: '审批入口回归验证',
      note: '隔离 Hub 中的合成测试任务', status: 'todo', visibility: 'related', triageStage: 'intake',
      source: '工作区回归测试', createdAt: Date.now() };
    assert.equal(await js(`(async () => {
      const task = ${JSON.stringify(task)};
      tasks.push(task);
      save();
      if (!await Store.persistTask(task.id)) throw Error('The Hub did not persist the test task');
      return (await SoduWorkAPI.getTask(task.id)).title;
    })()`), task.title);

    const overlay = await until(() => findWindow('index.html'), 'desktop overlay');
    const oldWindow = win.id;
    const closed = once(win, 'closed');
    win.close();
    await closed;
    const route = { panel: 'workspace', view: 'approvals', taskId: task.id };
    await overlay.webContents.executeJavaScript(`soduWorkAPI.openDeskWindow(${JSON.stringify(route)})`);
    win = await until(() => findWindow('desk.html', 'workspace'), 'native legacy approval workspace');
    assert.notEqual(win.id, oldWindow);
    const query = new URL(win.webContents.getURL()).searchParams;
    assert.equal(query.get('view'), route.view);
    assert.equal(query.get('taskId'), route.taskId);
    await checkOwner();

    const correctTitle = `document.querySelector('#rqDetailTitle')?.textContent === ${JSON.stringify(task.title)}`;
    const detailRetry = '#rqLoadRetry';
    await until(() => js(`${correctTitle} || ${visible(detailRetry)}`), 'task title or detail retry');
    if (await js(visible(detailRetry))) await click(detailRetry);
    await until(() => js(correctTitle), 'task title from the Hub');
    await until(() => js('performance.now() >= 16500'), 'real startup deadline with task details open');
    const checkedAfterMs = await js('Math.round(performance.now())');
    assert.equal(await js(correctTitle), true);
    assert.equal(await js(visible(retry)), false, 'recovery must stay hidden behind the open detail drawer');
    await shot('05-approval-detail-after-deadline');

    await click('[data-rq-dismiss]');
    await until(() => js('!document.querySelector(".rq-detail-backdrop")'), 'closed task details');
    assert.equal(await js(visible(retry)), false, 'closing details must not expose startup recovery');
    await click(notices);
    await until(() => js(`${opened('notices')} && ${visible('#noticePanel.show')}`), 'notifications after closing details');
    await shot('06-approval-detail-closed-sidebar');
    await checkOwner();
    return { checkedAfterMs, nativeWindowReopened: true, titleLoaded: true, navigationAfterClose: true };
  });

  exitCode = report.cases.every(row => row.passed) ? 0 : 1;
}).catch(error => {
  console.error(error);
  report.error = error.message;
}).finally(() => {
  clearTimeout(watchdog);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  app.exit(exitCode);
});
