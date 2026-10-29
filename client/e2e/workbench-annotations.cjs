'use strict';
// Real NativeChat, production preload/IPC and sandboxed WebContentsView. Only
// the model send boundary is a deterministic fixture; no model or user profile.
const { app, BrowserWindow, WebContentsView, ipcMain, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw Error('Absolute evidence directory required');
fs.mkdirSync(root, { recursive: true }); app.setPath('userData', path.join(root, 'profile'));
const report = { ok: false, checks: [], screenshots: [], sends: [] };
let win, server, failSend = false, deferSend = null;
const sessions = new Map(), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = (wc, code) => wc.executeJavaScript(code, true);
const host = code => js(win.webContents, code);
const preview = () => win.contentView.children.find(child => child.webContents && child.webContents !== win.webContents).webContents;
const shadow = 'document.querySelector("#__soduwork-annotations").shadowRoot';
function previewView() {
  return win.contentView.children.find(child => child.webContents && child.webContents !== win.webContents);
}
function nativeClick(x, y) {
  // sendInputEvent is renderer-scoped and does not make a visible Electron
  // window the Windows foreground window.  That made the old E2E harness pass
  // only with Chromium focus emulation.  Use the same OS input path as a user
  // for the hosted page, then keep sendInputEvent for text so the test can
  // assert the resulting renderer focus/keyboard routing.
  const handle = win.getNativeWindowHandle();
  const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0));
  const script = `$h=[IntPtr]::new([long]${hwnd});[Win32]::SetThreadDpiAwarenessContext([IntPtr](-4))|Out-Null;[Win32]::SetForegroundWindow($h)|Out-Null;[Win32]::SetCursorPos(${Math.round(x)},${Math.round(y)})|Out-Null;[Win32]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero);[Win32]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)`;
  const type = 'using System; using System.Runtime.InteropServices; public static class Win32 { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context); [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra); }';
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Add-Type '${type}';${script}`], { stdio: 'ignore', windowsHide: true });
}
function screenPoint(wc, point) {
  const content = win.getContentBounds();
  const view = wc === win.webContents ? { x: 0, y: 0 } : (previewView() && previewView().getBounds()) || { x: 0, y: 0 };
  const dip = { x: content.x + view.x + point.x, y: content.y + view.y + point.y };
  return screen.dipToScreenPoint(dip);
}
async function until(wc, code) {
  for (let i = 0; i < 100; i++) { if (await js(wc, code)) return; await delay(35); }
  throw Error('Timed out: ' + code);
}
async function click(wc, selector, inShadow = false) {
  const p = await js(wc, `(()=>{const el=${inShadow ? shadow : 'document'}.querySelector(${JSON.stringify(selector)});if(!el)throw Error(${JSON.stringify(selector)});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  // Electron's synthetic input does not always promote an unfocused native
  // WebContentsView when the host window is visible. Promote the page target
  // before a page click; shadow-editor clicks intentionally skip this so the
  // regression still exercises the native focus hand-off.
  if (wc !== win.webContents) {
    win.show(); win.focus();
    if (typeof wc.focus === 'function') wc.focus();
    const point = screenPoint(wc, p);
    nativeClick(point.x, point.y);
  } else {
    if (typeof wc.focus === 'function') wc.focus();
    for (const type of ['mouseDown', 'mouseUp']) wc.sendInputEvent({ type, button: 'left', clickCount: 1, ...p });
  }
  await delay(70);
}
function key(wc, keyCode, modifiers) {
  for (const type of ['keyDown', 'keyUp']) wc.sendInputEvent({ type, keyCode, modifiers: modifiers || [] });
}
async function nativeText(wc, selector, value, inShadow = false) {
  await js(wc, `(()=>{const area=${inShadow ? shadow : 'document'}.querySelector(${JSON.stringify(selector)});if(!area)throw Error('focus trace target missing');area.__soduworkFocusTraceCleanup?.();const trace=[];const record=e=>trace.push({type:e.type,time:performance.now()});for(const type of ['focus','focusin','blur','focusout'])area.addEventListener(type,record,true);area.__soduworkFocusTraceCleanup=()=>{for(const type of ['focus','focusin','blur','focusout'])area.removeEventListener(type,record,true)};window.__soduworkFocusTrace=trace})()`);
  await click(wc, selector, inShadow);
  // Exercise the same trusted keyboard sequence a user generates.  A char
  // event alone can still update a textarea after native focus has been lost,
  // which masked the WebContentsView focus race this test is meant to catch.
  for (const ch of value) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: ch });
    wc.sendInputEvent({ type: 'char', keyCode: ch });
    wc.sendInputEvent({ type: 'keyUp', keyCode: ch });
  }
  await delay(30);
  const actual = await js(wc, `(()=>{const el=${inShadow ? shadow : 'document'}.querySelector(${JSON.stringify(selector)});return el&&el.value})()`);
  assert.equal(actual, value, 'annotation textarea accepts trusted native keyboard input');
  const trace = await js(wc, 'window.__soduworkFocusTrace || []');
  assert.equal(trace.some(event => /^focus/.test(event.type)), true,
    'annotation textarea receives a native focus event');
  assert.equal(trace.some(event => /^(?:blur|focusout)$/.test(event.type)), false,
    'annotation textarea keeps focus after the native click and keyboard sequence');
}
async function type(wc, selector, value, inShadow = false) {
  await click(wc, selector, inShadow); key(wc, 'A', ['control']); await wc.insertText(value); await delay(30);
}
async function note(selector, comment) {
  const wc = preview(); await click(wc, selector);
  await until(wc, `!${shadow}.querySelector('.editor').hidden`);
  const focusState = await js(wc, `({documentHasFocus:document.hasFocus(),activeTag:${shadow}.activeElement&&${shadow}.activeElement.tagName,activeIsTextarea:${shadow}.activeElement === ${shadow}.querySelector('textarea')})`);
  assert.equal(focusState.activeIsTextarea, true,
    'annotation editor focuses its textarea in the hosted WebContentsView');
  // Force the exact state reported by users: opening the editor succeeded but
  // the hosted page reclaimed focus before the real click into the editor.
  await js(wc, `${shadow}.querySelector('textarea').blur(); document.body.focus()`);
  await nativeText(wc, 'textarea', 'OK', true);
  // The native char path above is the regression check. Reset the fixture
  // field through the isolated DOM before exercising the production save
  // path so the test does not depend on platform-specific Ctrl+A handling.
  await js(wc, `${shadow}.querySelector('textarea').value=''`);
  await wc.insertText(comment); await delay(30);
  await click(wc, '.save', true);
  await until(wc, `${shadow}.querySelector('.editor').hidden`);
}
async function count(n) {
  await until(win.webContents, `ChatWorkbenchAnnotations.rows().length===${n}`);
  await until(preview(), `${shadow}.querySelectorAll('.pin').length===${n}`);
}
async function open(id, url) {
  await host(`NativeChat.enter('',${JSON.stringify(id)},{adapterId:'pi'})`);
  await host(`ChatWorkbench.openLink(${JSON.stringify(url)})`);
  await until(win.webContents, 'document.querySelector("[data-wb-inspect]") && !document.querySelector("[data-wb-inspect]").disabled');
  for (let i = 0; i < 100 && !win.contentView.children.some(child => child.webContents && child.webContents !== win.webContents); i++) await delay(35);
  const wc = preview();
  await until(wc, 'document.querySelector("#hero")!==null');
  await click(win.webContents, '[data-wb-inspect]');
  await until(wc, `Boolean(document.querySelector('#__soduwork-annotations'))`);
}
async function shot(name) {
  for (const [suffix, wc] of [['composer', win.webContents], ['page', preview()]]) {
    const file = path.join(root, name + '-' + suffix + '.png');
    fs.writeFileSync(file, (await wc.capturePage()).toPNG()); report.screenshots.push(file);
  }
}
app.whenReady().then(async () => {
  require('../main/work-preview').install({ ipcMain, BrowserWindow, WebContentsView, shell: { openExternal: async () => {} } });
  ipcMain.handle('pi-session-open', (_event, options) => {
    const id = options.chatId || 'fixture-a', ref = 'ref:' + id;
    const snapshot = sessions.get(ref) || { status: 'idle', messages: [], tools: [], usage: null };
    sessions.set(ref, snapshot);
    return { ok: true, ref, sessionId: id, title: id, cwd: root, snapshot,
      model: { name: 'fixture', label: '隔离模型替身', contextWindow: 128000 } };
  });
  for (const [name, reply] of Object.entries({
    'pi-session-history': { ok: true, items: [] }, 'pi-session-outputs': { ok: true, items: [] },
    'pi-session-release': { ok: true }, 'pi-session-workdir': { dir: root, name: '隔离测试' },
    'pi-session-runtime-models': { ok: true, models: [] },
  })) ipcMain.handle(name, () => reply);
  ipcMain.handle('pi-session-snapshot', (_e, ref) => ({ ok: true, snapshot: sessions.get(ref) }));
  ipcMain.handle('pi-session-send', async (_e, ref, text, attachments) => {
    report.sends.push({ ref, text, attachments, failed: failSend });
    if (deferSend) await new Promise(resolve => { deferSend.resolve = resolve; });
    if (failSend) return { ok: false, reason: '隔离回归：模拟发送失败' };
    const snapshot = { status: 'idle', messages: [{ role: 'user', text }, { role: 'assistant', blocks: [{ kind: 'text', text: '已接收注释批次' }] }], tools: [], usage: null };
    sessions.set(ref, snapshot); return { ok: true, snapshot };
  });
  server = require('node:http').createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>产品页面</title><style>body{font:18px system-ui;margin:40px;background:#f4f7fb;color:#21334e}section{padding:30px;background:white;border-radius:18px;margin-bottom:40px}button{padding:20px;background:#3178f8;color:white;border:0;border-radius:12px}</style><section><h1 id="hero">让 AI 与人协作</h1><p>批量修改这个页面。</p></section><button id="cta">开始体验</button><script>window.normalClicks=0;window.escapeCount=0;document.addEventListener("click",()=>normalClicks++);document.addEventListener("keydown",e=>{if(e.key==="Escape")escapeCount++});</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/page';
  win = new BrowserWindow({ show: true, width: 1440, height: 940, webPreferences: {
    preload: path.join(__dirname, '../preload.js'), offscreen: false, contextIsolation: true,
    nodeIntegration: false, backgroundThrottling: false,
  } });
  await win.loadFile(path.join(__dirname, 'fixtures/workbench-annotations.html'));
  await until(win.webContents, 'window.fixtureReady');
  win.show(); win.focus();
  await open('fixture-a', url);
  assert.equal(await js(preview(), 'typeof require'), 'undefined');
  assert.equal(await js(preview(), 'typeof soduWorkAPI'), 'undefined');
  await note('#hero', '标题改为「与 AI 一起完成工作」'); await count(1);
  await note('#cta', '按钮改为绿色'); await count(2);
  assert.deepEqual(await js(preview(), `${shadow}.querySelectorAll('.pin').length && [...${shadow}.querySelectorAll('.pin')].map(p=>p.textContent)`), ['1', '2']);
  assert.equal(await js(preview(), 'normalClicks'), 0);
  assert.equal(await host('document.querySelector("#nchatInput").value'), '');
  assert.match(await host('document.querySelector(".nannotation-chip").textContent'), /2 条注释/);
  assert.equal(await host('getComputedStyle(document.querySelector(".nannotation-list")).display'), 'none');
  await shot('two-annotations');
  report.checks.push('trusted native clicks create two numbered pins and one composer chip without triggering webpage clicks or injecting draft text');

  await click(win.webContents, '[data-annotation-toggle]');
  await type(win.webContents, '[data-annotation-edit]', '标题改为「企业协作」');
  await click(win.webContents, '#nchatInput');
  await until(preview(), `${shadow}.querySelector('.pin').title.includes('企业协作')`);
  await click(win.webContents, '[data-annotation-remove]'); await count(1);
  assert.equal(await js(preview(), `${shadow}.querySelector('.pin').textContent`), '1');
  report.checks.push('composer edits update native pin text; composer deletion removes the matching pin and renumbers the batch');

  await note('#hero', '标题字号改为 32 像素'); await count(2);

  failSend = true;
  await type(win.webContents, '#nchatInput', '请统一保持页面风格。');
  await click(win.webContents, '[data-annotation-send]');
  await until(win.webContents, 'document.querySelector("#nchatList").textContent.includes("这一轮没发出去")');
  assert.equal(report.sends.length, 1); assert.match(report.sends[0].text, /请统一保持页面风格。\n\n请按以下 2 条网页注释/);
  assert.match(report.sends[0].text, /注释 1：按钮改为绿色/);
  assert.match(report.sends[0].text, /注释 2：标题字号改为 32 像素/); await count(2);
  assert.equal(await host('document.querySelector("#nchatInput").value'), '请统一保持页面风格。');
  failSend = false; await click(win.webContents, '[data-wb-send-annotations]'); await count(0);
  assert.equal(report.sends.length, 2); assert.equal(report.sends[1].text, report.sends[0].text);
  assert.equal(await host('document.querySelector(".nannotation-tray").hidden'), true);
  report.checks.push('tray send uses the real composer IPC; failure retains batch and original text; top-right retry sends the same batch once and clears pins/chip');

  await note('#hero', '普通发送验证'); await count(1);
  await click(win.webContents, '#nchatSend'); await count(0);
  assert.equal(report.sends.length, 3); assert.match(report.sends[2].text, /普通发送验证/);
  await note('#cta', '托盘成功发送验证'); await count(1);
  await click(win.webContents, '[data-annotation-send]'); await count(0);
  assert.equal(report.sends.length, 4); assert.match(report.sends[3].text, /托盘成功发送验证/);
  report.checks.push('normal composer send and tray send both include annotation-only payloads and consume the accepted batch');

  await note('#hero', 'A 会话保留'); await count(1);
  await open('fixture-b', url); await count(0);
  await note('#cta', 'B 会话独立'); await count(1);
  await open('fixture-a', url); await count(1);
  assert.equal(await host('ChatWorkbenchAnnotations.rows()[0].comment'), 'A 会话保留');
  await click(win.webContents, '#nchatSend'); await count(0);
  await open('fixture-b', url); await count(1);
  assert.equal(await host('ChatWorkbenchAnnotations.rows()[0].comment'), 'B 会话独立');
  report.checks.push('switching/reopening conversations preserves each pending batch and renders only that conversation’s chip/pins');

  const wc = preview(); key(wc, 'ESC');
  await until(win.webContents, 'document.querySelector("[data-wb-inspect]").getAttribute("aria-pressed")==="false"');
  key(wc, 'ESC'); await until(wc, 'escapeCount===1');
  await click(wc, '#cta'); assert.equal(await js(wc, 'normalClicks'), 1);
  report.checks.push('Escape exits annotation mode; subsequent Escape and normal webpage clicks are no longer swallowed');
  await shot('final');
  assert.deepEqual(await host('errors'), []); report.ok = true;
}).catch(async error => { report.error = error.stack; if (win && !win.isDestroyed()) await shot('failure').catch(() => {}); })
  .finally(() => { fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); if (server) server.close(); if (win) win.destroy(); app.exit(report.ok ? 0 : 1); });
