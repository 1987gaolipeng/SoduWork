// Dedicated headless Chromium drives native mouse/drag events to complement
// the Electron UI tests, using the identical production sidebar modules.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1080, height: 820, deviceScaleFactor: 1, mobile: false });
  await page.call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.soduWorkAPI={conversationSession:{history:async()=>({ok:true,chats:Array.from({length:30},(_,i)=>({id:"chat-"+i,title:"项目讨论 "+i,adapterId:"pi",state:"completed"}))}),onEvent:()=>()=>{}}};' });
  report.stage = 'navigate';
  await page.call('Page.navigate', { url: pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/sidebar-projects.html')).href });
  await page.waitFor(() => document.querySelectorAll('.ws-chat-row').length === 30);
  await page.run(() => {
    document.querySelector('#wsProjectAdd').click(); document.querySelector('#wsProjectName').value = '客户项目';
    document.querySelector('.ws-project-save').click();
  });
  async function drag(id, section) {
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
      const target = await page.run(section => {
        const el = document.querySelector('[data-sidebar-section="' + section + '"]');
        const heading = el.querySelector('.ws-section-toggle,.ws-project-heading') || el;
        heading.scrollIntoView({ block: 'center' }); const r = heading.getBoundingClientRect();
        return { x: r.x + 40, y: r.y + 15 };
      }, section);
      for (const type of ['dragEnter', 'dragOver', 'drop']) await page.call('Input.dispatchDragEvent', { type, ...target, data });
      await page.waitFor(({ id, section }) => row(id).closest('[data-sidebar-section]').dataset.sidebarSection === section, { id, section });
      await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...target, button: 'left', buttons: 0, clickCount: 1 });
      await delay(350);
    } finally { page.ws.removeEventListener('message', listener); }
  }
  report.stage = 'drag';
  await drag('chat-3', 'pinned');
  const project = await page.run(() => projectId());
  await drag('chat-3', project);
  await drag('chat-3', 'recent');
  assert.equal(await page.run(() => opens.length), 0);
  assert.equal(await page.run(() => document.querySelectorAll('.ws-chat-row').length), 30);
  assert.deepEqual(page.takeRuntimeErrors(), []);
  report.cases.push('native mouse drag recent → initially empty pinned → project → recent, no duplicates or accidental conversation opening');
  report.ok = true;
} catch (error) { report.error = error.stack; report.cause = String(error.cause || ''); report.browserLog = browserLog; process.exitCode = 1; }
finally {
  await fs.writeFile(path.join(output, 'native-drag-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  page?.close(); browser.kill();
}
