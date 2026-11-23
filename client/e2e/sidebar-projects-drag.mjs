// Dedicated headless Chromium drives native mouse/drag events to complement
// the Electron UI tests, using the identical production sidebar modules.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { CdpPage, listPages, delay } from './lib/cdp.mjs';
const output = process.argv[2];
assert.ok(output && path.isAbsolute(output), 'Absolute evidence directory required');
await fs.mkdir(output, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-sidebar-drag-'));
const browser = spawn(process.env.SIDEBAR_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let browserLog = '';
browser.stderr.on('data', data => { browserLog = (browserLog + data.toString()).slice(-2000); });
let page;
const report = { ok: false, cases: [] };
const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer(async (request, response) => {
  const urlPath = new URL(request.url, 'http://localhost').pathname;
  if (urlPath === '/favicon.ico') { response.writeHead(204).end(); return; }
  const assetPath = urlPath.replace(/^\/e2e\/fixtures\/(?=assets\/|icon.png$)/, '/');
  const file = path.resolve(clientRoot, '.' + assetPath);
  if (!file.startsWith(clientRoot + path.sep)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
    response.end(await fs.readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  let port;
  for (let n = 0; n < 100 && !port; n++) {
    try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
    if (!port) await delay(100);
  }
  assert.ok(port, 'Isolated Chrome did not start');
  let target, startupError;
  for (let i = 0; i < 40 && !target; i++) {
    try { target = (await listPages(port)).find(p => p.url === 'about:blank'); }
    catch (error) { startupError = error; }
    if (!target) await delay(100);
  }
  if (!target) throw startupError || Error('Isolated browser page unavailable');
  report.stage = 'connect'; page = await CdpPage.connect(target);
  await page.call('Page.enable');
  await page.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1080, height: 820, deviceScaleFactor: 1, mobile: false });
  report.stage = 'navigate';
  await page.call('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/e2e/fixtures/sidebar-projects.html' });
  await page.waitFor(() => !!document.querySelector('#wsProjectAdd'));
  await page.run(() => WorkspaceShell.setChats(window.fixtureRows = Array.from({ length: 30 }, (_, i) => ({
    id: 'chat-' + i, title: 'Project discussion ' + i, adapterId: 'pi', state: 'completed',
  }))));
  await page.waitFor(() => document.querySelectorAll('.ws-chat-row').length === 30);
  await page.run(() => {
    document.querySelector('#wsProjectAdd').click(); document.querySelector('#wsProjectName').value = '客户项目';
    document.querySelector('.ws-project-save').click();
  });
  async function drag(id, section, endpoint = '.ws-section-toggle,.ws-project-heading', lower = false) {
    let data;
    const listener = event => { const message = JSON.parse(event.data); if (message.method === 'Input.dragIntercepted') data = message.params.data; };
    page.ws.addEventListener('message', listener);
    await page.call('Input.setInterceptDrags', { enabled: true });
    try {
      await page.run(() => { window.dragEvents=[]; for(const type of ['pointerdown','dragstart','dragend','blur']) window.addEventListener(type,e=>dragEvents.push({type,target:e.target?.className,dragging:!!document.querySelector('.is-chat-dragging')}),true); });
      const point = await page.run(id => {
        row(id).scrollIntoView({ block: 'center' }); const r = row(id).querySelector('.ws-chat-title').getBoundingClientRect();
        return { x: r.x + 24, y: r.y + r.height / 2 };
      }, id);
      await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 8 && !data; i++) {
        await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 5 * i, y: point.y - 4 * i, button: 'left', buttons: 1 });
        await delay(50);
      }
      for (let i = 0; i < 30 && !data; i++) await delay(50);
      if (!data) report.dragEvents = await page.run(() => window.dragEvents);
      assert.ok(data, 'Native drag interception must carry the sidebar payload');
      assert.ok(data.items.some(item => item.mimeType === 'application/x-soduwork-sidebar-chat'));
      const target = await page.run(({ section, endpoint, lower }) => {
        const el = document.querySelector('[data-sidebar-section="' + section + '"]');
        const heading = el.querySelector(endpoint) || el;
        heading.scrollIntoView({ block: 'center' }); const r = heading.getBoundingClientRect();
        return { x: r.x + 40, y: lower ? r.bottom - 3 : r.y + 15 };
      }, { section, endpoint, lower });
      for (const type of ['dragEnter', 'dragOver', 'drop']) await page.call('Input.dispatchDragEvent', { type, ...target, data });
      await page.waitFor(({ id, section }) => row(id).closest('[data-sidebar-section]').dataset.sidebarSection === section, { id, section });
      await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...target, button: 'left', buttons: 0, clickCount: 1 });
      await delay(350);
    } finally { page.ws.removeEventListener('message', listener); }
  }
  report.stage = 'drag';
  const project = await page.run(() => projectId());
  async function dragDuringRefresh(endpoint) {
    // Keep Chromium's drag lifecycle intact: injecting a drop masks detached targets.
    await page.call('Input.setInterceptDrags', { enabled: false });
    const start = await page.run(() => {
      document.querySelector('#wsSideScroll').scrollTop = 0;
      const r = row('chat-0').querySelector('.ws-chat-title').getBoundingClientRect();
      window.refreshDuringDrag = setInterval(() => WorkspaceShell.setChats(fixtureRows), 100);
      return { x: r.x + 24, y: r.y + r.height / 2 };
    });
    let end = start;
    try {
      await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start });
      await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 5; i++) {
        await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + 8 * i, y: start.y, button: 'left', buttons: 1 });
        await delay(80);
      }
      end = await page.run(endpoint => {
        const r = document.querySelector('.ws-project').querySelector(endpoint).getBoundingClientRect();
        return { x: r.x + 40, y: r.y + 15 };
      }, endpoint);
      for (let i = 1; i <= 15; i++) {
        await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved',
          x: start.x + 40 + (end.x - start.x - 40) * i / 15,
          y: start.y + (end.y - start.y) * i / 15, button: 'left', buttons: 1 });
        await delay(80);
      }
      await delay(500);
      await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', buttons: 0, clickCount: 1 });
      await delay(150);
      assert.equal(await page.run(() => row('chat-0').closest('[data-sidebar-section]').dataset.sidebarSection), project,
        'An empty project must accept a mouse drop while history refreshes: ' + endpoint);
      assert.equal(await page.run(() => document.querySelectorAll('.ws-project-chats .ws-list-empty').length), 0);
    } finally {
      await page.run(() => clearInterval(window.refreshDuringDrag));
      await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', buttons: 0 });
    }
    await delay(350);
    await drag('chat-0', 'recent');
    await page.run(() => window.drag('chat-0', 'recent', 'chat-1'));
  }
  await dragDuringRefresh('.ws-list-empty');
  await dragDuringRefresh('.ws-project-heading');
  report.cases.push('unintercepted mouse drops into empty project hint and heading survive repeated history refreshes');
  await drag('chat-3', project);
  assert.equal(await page.run(() => document.querySelector('.ws-project-more').hidden), true);
  await drag('chat-3', 'recent');
  await drag('chat-3', project, '.ws-list-empty');
  await drag('chat-3', 'recent');
  await page.run(() => document.querySelector('.ws-project-toggle').click());
  await drag('chat-3', project);
  assert.equal(await page.run(() => document.querySelector('.ws-project-chats').hidden), false);
  await drag('chat-3', 'recent');
  report.cases.push('recent conversation drops on both the empty project heading and empty hint');
  // A displayed cloud/cache identity can differ from the saved sidebar slot.
  await page.run(() => { row('chat-4').querySelector('.ws-chat').dataset.chatId = 'display-only-chat-4'; });
  await drag('chat-4', project);
  await drag('chat-4', 'recent');
  report.cases.push('a projected conversation uses its sidebar membership ID when dropped into an empty project');
  await drag('chat-3', 'pinned');
  await drag('chat-3', project);
  await drag('chat-3', 'recent');
  assert.equal(await page.run(() => opens.length), 0);
  assert.equal(await page.run(() => document.querySelectorAll('.ws-chat-row').length), 30);
  assert.deepEqual(page.takeRuntimeErrors(), []);
  report.cases.push('native mouse drag recent → initially empty pinned → project → recent, no duplicates or accidental conversation opening');
  report.stage = 'project-preview';
  await page.run(project => {
    for (let i = 0; i < 8; i++) window.drag('chat-' + i, project);
    document.querySelector('.ws-project-more').click();
  }, project);
  const projectRows = () => page.run(() => [...document.querySelectorAll('.ws-project-chats .ws-chat')].map(el => el.dataset.sidebarChatId));
  assert.deepEqual(await projectRows(), ['chat-0', 'chat-1', 'chat-2', 'chat-3', 'chat-4']);
  assert.equal(await page.run(() => document.querySelectorAll('#wsChats .ws-chat-row').length), 22);
  const saved = await page.run(() => localStorage.getItem(WorkspaceSidebarState.storageKey(SoduWorkAPI)));
  const collapsedImage = await page.call('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(output, 'project-collapsed.png'), Buffer.from(collapsedImage.data, 'base64'));
  await page.run(() => document.querySelector('.ws-project-more').focus());
  await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert.equal((await projectRows()).length, 8);
  const expandedImage = await page.call('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(output, 'project-expanded.png'), Buffer.from(expandedImage.data, 'base64'));
  assert.equal(await page.run(() => document.querySelector('.ws-project-more').getAttribute('aria-expanded')), 'true');
  await page.run(() => { WorkspaceShell.setChats(fixtureRows); document.querySelector('.ws-project-more').click(); });
  assert.equal((await projectRows()).length, 5);
  assert.equal(await page.run(() => localStorage.getItem(WorkspaceSidebarState.storageKey(SoduWorkAPI))), saved);
  report.cases.push('project preview shows five rows; keyboard expansion and collapse preserve membership, order and recent exclusion');
  await drag('chat-20', project, '.ws-project-chats .ws-chat-row:last-child', true);
  assert.deepEqual(await projectRows(), ['chat-0', 'chat-1', 'chat-2', 'chat-3', 'chat-4', 'chat-20', 'chat-5', 'chat-6', 'chat-7']);
  await page.run(() => document.querySelector('.ws-project-more').click());
  await drag('chat-21', project);
  assert.equal((await projectRows()).at(-1), 'chat-21');
  assert.equal((await projectRows()).length, 10);
  report.cases.push('drop after the final preview row inserts before hidden members; header drop appends and reveals the moved conversation');
  await page.run(() => document.querySelector('.ws-project-more').click());
  await drag('chat-0', 'recent');
  assert.equal((await projectRows()).length, 5);
  assert.equal(await page.run(() => row('chat-0').parentElement.id), 'wsChats');
  await page.run(() => {
    document.querySelector('#wsProjectAdd').click(); document.querySelector('#wsProjectName').value = 'Second project';
    document.querySelector('.ws-project-save').click();
    window.secondProject = document.querySelectorAll('.ws-project')[1].dataset.projectId;
    for (let i = 8; i < 14; i++) window.drag('chat-' + i, secondProject);
  });
  assert.deepEqual(await page.run(() => [...document.querySelectorAll('.ws-project')].map(el => el.querySelectorAll('.ws-chat-row').length)), [5, 6]);
  await page.run(() => document.querySelectorAll('.ws-project-more')[1].click());
  assert.deepEqual(await page.run(() => [...document.querySelectorAll('.ws-project')].map(el => el.querySelectorAll('.ws-chat-row').length)), [5, 5]);
  await page.run(() => document.querySelector('.ws-project-toggle').click());
  assert.equal(await page.run(() => document.querySelector('.ws-project-more').checkVisibility()), false);
  await page.run(() => document.querySelector('.ws-project-toggle').click());
  report.cases.push('moving back to recent removes project membership; projects expand independently and their controls hide with the project');
  await page.run(() => { window.sidebarBeforeReload = true; });
  await page.call('Page.reload');
  await page.waitFor(() => !window.sidebarBeforeReload && !!window.WorkspaceShell &&
    document.querySelectorAll('.ws-project').length === 2);
  await page.run(() => WorkspaceShell.setChats(Array.from({ length: 30 }, (_, i) => ({ id: 'chat-' + i, title: 'Project discussion ' + i }))));
  assert.deepEqual(await page.run(() => [...document.querySelectorAll('.ws-project')].map(el => el.querySelectorAll('.ws-chat-row').length)), [5, 5]);
  assert.equal(await page.run(() => document.querySelectorAll('#wsChats .ws-chat-row').length), 15);
  report.cases.push('reload retains all project members and returns each project to its five-row preview');
  await page.run(() => { document.querySelector('.ws-project-more').click(); fixtureAccount = 'another-account'; WorkspaceShell.setChats([]); });
  assert.equal(await page.run(() => document.querySelectorAll('.ws-project').length), 0);
  await page.run(() => { fixtureAccount = 'employee'; WorkspaceShell.setChats([]); });
  assert.deepEqual(await page.run(() => [...document.querySelectorAll('.ws-project')].map(el => el.querySelectorAll('.ws-chat-row').length)), [5, 5]);
  report.cases.push('project expansion does not leak across account changes');
  assert.deepEqual(page.takeRuntimeErrors(), []);
  report.ok = true;
} catch (error) { report.error = error.stack; report.cause = String(error.cause || ''); report.browserLog = browserLog; report.runtimeErrors = page?.takeRuntimeErrors(); process.exitCode = 1; }
finally {
  await fs.writeFile(path.join(output, 'native-drag-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  page?.close(); browser.kill(); server.close();
}
