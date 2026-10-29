'use strict';
// Real mouse → NativeChat queue → production preload/queue IPC → real Pi SDK.
// The model endpoint, profile and all files are isolated local fixtures.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-send-now-ui-'));
  const out = path.resolve(process.env.SODUWORK_QUEUE_E2E_OUTPUT || path.join(client, '../outputs/queue-send-now')); fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', path.join(root, 'profile'));
  const report = { ok: false, cases: [], layouts: [], errors: [] }, handles = new Map(), refs = new Map();
  let win, fixture, releaseReceipt;
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  async function until(check, label, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = typeof check === 'string' ? await js(check) : await check(); if (value) return value; await delay(30); }
    throw Error('Timed out: ' + label);
  }
  async function click(selector) {
    const point = await js(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)throw Error('unavailable button');b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!b.contains(document.elementFromPoint(x,y)))throw Error('occluded button');return{x,y}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  }
  function publish(handle, touched = {}) {
    if (win && !win.isDestroyed()) win.webContents.send('pi-session-event', {
      ref: refs.get(handle), kind: touched.kind || 'snapshot', snapshot: handle.uiSnapshot?.() || handle.snapshot(),
    });
  }
  async function enter(ref) {
    await js(`NativeChat.enter('',${JSON.stringify(ref)},{adapterId:'pi'})`);
    await until(`NativeChat.sessionInfo().ref===${JSON.stringify(ref)}`, 'enter ' + ref);
  }
  async function layout(width, lang, theme) {
    win.setSize(width, 800);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
    await js(`SoduWorkI18n.setLocale(${JSON.stringify(lang)});document.documentElement.dataset.theme=${JSON.stringify(theme)};`);
    await delay(180);
    const result = await js(`(()=>{const b=document.querySelector('[data-queue-action="send-now"]'),r=b.getBoundingClientRect(),row=b.closest('.nqueue-row'),s=getComputedStyle(b),icon=b.querySelector('svg'),p=document.createElement('span');p.style.color='var(--ink-3)';b.appendChild(p);const neutral=getComputedStyle(p).color;p.remove();return{text:b.textContent.trim(),title:b.title,disabled:b.disabled,minFont:parseFloat(s.fontSize),promptWidth:row.querySelector('.nqueue-copy').getBoundingClientRect().width,visible:r.width>0&&r.right<=innerWidth,overflow:document.documentElement.scrollWidth>innerWidth||row.scrollWidth>row.clientWidth,background:s.backgroundColor,color:s.color,neutral,iconColor:getComputedStyle(icon).stroke,iconSize:icon.getBoundingClientRect().width,cursor:s.cursor,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    assert.equal(result.text, lang === 'zh-CN' ? '引导' : 'Steer');
    assert.equal(await js('document.querySelectorAll(\'.nqueue-row[data-queue-state="queued"] .nqueue-state\').length'), 0,
      'Queued rows omit the redundant status label while keeping steering and removal controls.');
    assert.equal(result.visible, true); assert.equal(result.overflow, false); assert.ok(result.minFont >= 12); assert.ok(result.promptWidth >= 100);
    assert.equal(result.color, result.neutral); assert.equal(result.iconColor, result.color);
    assert.equal(result.iconSize, 16); assert.equal(result.cursor, 'default');
    report.layouts.push({ width, lang, theme, ...result });
    fs.writeFileSync(path.join(out, `queue-${width}-${lang}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
    win.webContents.sendInputEvent({ type: 'mouseMove', x: result.x, y: result.y }); await delay(180);
    const hover = await js(`(()=>{const b=document.querySelector('[data-queue-action="send-now"]'),p=document.createElement('span');p.style.color='var(--ink-2)';b.appendChild(p);const expected=getComputedStyle(p).color;p.remove();return{hover:b.matches(':hover'),color:getComputedStyle(b).color,iconColor:getComputedStyle(b.querySelector('svg')).stroke,expected}})()`);
    assert.equal(hover.hover, true); assert.equal(hover.color, hover.expected); assert.equal(hover.iconColor, hover.color);
    report.layouts[report.layouts.length - 1].hover = hover;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1100, height: 800,
      webPreferences: { preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
    // Use the exact production send and queue handlers. Authentication and
    // model discovery are fixture boundaries; queue mutation is not mocked.
    const ipcSource = read('main/pi-session/ipc.js');
    const snippet = ipcSource.slice(ipcSource.indexOf('  async function sendConversation('), ipcSource.indexOf("  ipcMain.handle('pi-session-select-model'"));
    const delayedReceiptIpc = { handle(channel, handler) {
      ipcMain.handle(channel, async (...args) => {
        const result = await handler(...args);
        // Deterministically deliver the old send receipt only after the user
        // has steered this already-accepted message into the active turn.
        if (channel === 'pi-session-send' && String(args[2]).includes('QUEUE_NOW'))
          await new Promise(resolve => { releaseReceipt = resolve; });
        return result;
      });
    } };
    vm.runInNewContext(snippet, { ipcMain: delayedReceiptIpc, app, path, BrowserWindow, console,
      require: require('node:module').createRequire(path.join(client, 'main/pi-session/ipc.js')),
      updateWorkloads: { guard: () => ({ ok: true }) },
      session: { get: ref => handles.get(ref) }, sendIdentityOf: async () => ({}), identityOf: async () => ({}),
      memories: { assertOwner() {} }, pluginDebug: { guard: () => null }, taskInput: {},
      attachments: require('../main/pi-session/attachments'), workDir: () => path.join(root, 'work'),
      _publish: (_windows, handle, touched) => publish(handle, touched), _scheduleRelease() {},
    });
    ipcMain.handle('pi-session-open', (_event, options) => {
      const ref = options.chatId, handle = handles.get(ref);
      return { ok: true, ref, sessionId: ref, adapterId: 'pi', displayName: 'Pi', cwd: root,
        model: { label: 'Local test model' }, snapshot: handle.snapshot() };
    });
    ipcMain.handle('pi-session-snapshot', (_event, ref) => ({ ok: true, snapshot: handles.get(ref).snapshot() }));
    for (const [channel, value] of Object.entries({ 'pi-session-history': { ok: true, chats: [] }, 'pi-session-outputs': { ok: true, items: [] },
      'pi-session-release': { ok: true }, 'pi-session-runtime-models': { ok: true, items: [] }, 'work-preview-hide': { ok: true }, 'work-preview-destroy': { ok: true } })) ipcMain.handle(channel, () => value);
    const source = path.join(__dirname, 'fixtures/workbench-annotations.html'), scripts = [];
    const html = fs.readFileSync(source, 'utf8').replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_match, attrs, body) => {
      const src = attrs.match(/src=["']([^"']+)/); scripts.push(src ? fs.readFileSync(path.resolve(path.dirname(source), src[1]), 'utf8') : body); return '';
    });
    const file = path.join(root, 'chat.html');
    fs.writeFileSync(file, html.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/gi, '')
      .replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '">'));
    await win.loadFile(file);
    for (const file of ['theme/variables.css', 'components/panels/work-composer.css', 'components/panels/panels-chat.css',
      'components/panels/chat-collaboration.css', 'components/panels/conversation-attachments.css', 'components/panels/agent-brand.css']) {
      await js(`(()=>{const link=document.createElement('link');link.rel='stylesheet';link.href=${JSON.stringify(pathToFileURL(path.join(client, file)).href)};document.head.appendChild(link)})()`);
    }
    for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
    for (const file of ['core/i18n-dom.js', 'core/i18n.js', 'components/panels/agent-brand.js']) await js(read(file) + '\nvoid 0;');
    for (const script of scripts) await js(script + '\nvoid 0;');
    // Static layout and disabled-state coverage use truthful fixture snapshots.
    const visual = { data: { status: 'streaming', messages: [{ role: 'user', text: '正在整理报告' }], tools: [],
      execution: { running: true, queue: [{ id: 'next', text: '请先核对这张图，再继续整理报告。' }],
        turnQueue: {}, queueImmediate: { supported: true, available: true, pending: false } } },
      snapshot() { return structuredClone(this.data); } };
    handles.set('layout', visual); refs.set(visual, 'layout'); await enter('layout');
    for (const width of [1100, 360, 300]) for (const lang of ['zh-CN', 'en-US']) await layout(width, lang, lang === 'zh-CN' ? 'azure' : 'ruby');
    visual.data.execution.queueImmediate = { supported: true, available: false, pending: false, reason: '当前任务正在执行' };
    publish(visual); await until('document.querySelector("[data-queue-action=send-now]")?.disabled', 'disabled task state');
    report.cases.push('Steer fits 300/360/1100 px in Chinese/English and both themes; text and refined 16px icon stay neutral gray on hover; unavailable runtime state disables the action.');
    // The native fixture supplies real SDK streaming and abort/continuation.
    fixture = await require('./fixtures/queue-send-now-sdk.cjs').create({ holdNow: true });
    const handle = fixture.handle; handles.set('real', handle); refs.set(handle, 'real');
    handle.on(touched => publish(handle, touched));
    win.setSize(1100, 800); await js('SoduWorkI18n.setLocale("zh-CN")'); await enter('real');
    await runNativeSequence({ fixture, handle, win, js, until, click, report, out,
      receiptReady: () => Boolean(releaseReceipt), releaseReceipt: () => { releaseReceipt(); releaseReceipt = null; } });
    await fixture.close(); fixture = null;
    for (const mode of ['compaction', 'slowTool']) {
      fixture = await require('./fixtures/steering-lifecycle.cjs').create(path.join(root, mode),
        mode === 'compaction' ? { largeTool: true } : { slowTool: true });
      const next = fixture.handle; handles.set(mode, next); refs.set(next, mode);
      next.on(touched => publish(next, touched)); await enter(mode);
      await require('./queue-steering-lifecycle.cjs').run({ mode, fixture, handle: next, js, until, click, win, report, out });
      await fixture.close(); fixture = null;
    }
    assert.deepEqual(await js('errors'), []); assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(async error => { report.error = error.stack || String(error); try {
    fs.writeFileSync(path.join(out, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  } catch {} }).finally(async () => {
    try { await fixture?.close(); } catch (error) { report.cleanup = String(error); report.ok = false; }
    if (win && !win.isDestroyed()) win.destroy();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, layouts: report.layouts.length, error: report.error, report: path.join(out, 'report.json') }));
    app.exit(report.ok ? 0 : 1);
  });
}

async function runNativeSequence({ fixture, handle, win, js, until, click, report, out, receiptReady, releaseReceipt }) {
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  async function compose(text) {
    await js(`(()=>{const input=document.querySelector('#nchatInput');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));input.focus()})()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until('document.querySelector("#nchatInput").value===""', 'composer submitted');
  }
  await compose(fixture.text.first); await fixture.waitForHold('first');
  const mtime = fs.statSync(fixture.output).mtimeMs;
  await compose(fixture.text.later);
  await until(() => handle.snapshot().execution.queue.some(item => item.text === fixture.text.later), 'later queued');
  // Populate the real file input. Production attachment/preload/staging code
  // then carries this temporary file into the original queued message.
  win.webContents.debugger.attach('1.3');
  try {
    const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument');
    const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
    assert.ok(nodeId, 'native attachment input exists');
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [fixture.note] });
  } finally { win.webContents.debugger.detach(); }
  await until('document.querySelector(".nbox").textContent.includes("note.txt")', 'attachment in composer');
  await compose(fixture.text.now);
  const queued = await until(() => handle.snapshot().execution.queue.find(item => item.text === fixture.text.now), 'immediate candidate queued');
  await until(receiptReady, 'send acknowledgement held');
  assert.ok(queued.attachments.includes('note.txt'));
  const selector = '[data-queue-action="send-now"][data-queue-id="' + queued.id + '"]';
  await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))&&!document.querySelector(${JSON.stringify(selector)}).disabled`, 'send-now enabled');
  fs.writeFileSync(path.join(out, 'real-pi-before.png'), (await win.webContents.capturePage()).toPNG());
  await click(selector);
  await fixture.waitForHold('now'); await until(() => fixture.firstClosed(), 'original stream stopped');
  const queue = handle.snapshot().execution.queue;
  assert.deepEqual(queue.map(item => item.text), [fixture.text.later]);
  assert.equal(fixture.received.filter(item => item.kind === 'now').length, 1);
  assert.equal(fixture.received.filter(item => item.kind === 'later').length, 0);
  const nowRequest = fixture.received.find(item => item.kind === 'now');
  assert.ok(JSON.stringify(nowRequest.body.messages).includes('note.txt'));
  assert.equal(fs.statSync(fixture.output).mtimeMs, mtime, 'completed tool output must not run again');
  await until('!document.querySelector(' + JSON.stringify(selector) + ')', 'selected row consumed');
  assert.equal(await js('Array.from(document.querySelectorAll(".nqueue-row")).some(row=>row.textContent.includes("QUEUE_NOW"))'), false,
    'the unacknowledged local placeholder cannot reappear after steering');
  releaseReceipt();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await js('Array.from(document.querySelectorAll(".nqueue-row")).some(row=>row.textContent.includes("QUEUE_NOW"))'), false,
    'the delayed send receipt cannot restore the old queue');
  fs.writeFileSync(path.join(out, 'real-pi-after.png'), (await win.webContents.capturePage()).toPNG());
  fixture.release('now');
  await until(() => fixture.received.some(item => item.kind === 'later') && !handle.inFlight(), 'remaining queue runs once');
  assert.equal(fixture.received.filter(item => item.kind === 'now').length, 1);
  assert.equal(fixture.received.filter(item => item.kind === 'later').length, 1);
  assert.equal(handle.snapshot().execution.queue.length, 0);
  assert.equal(fs.statSync(fixture.output).mtimeMs, mtime);
  report.cases.push('Real keyboard submissions and file input → production preload/send IPC → Pi SDK; mouse send-now interrupts the current stream, delivers the selected message with its attachment before the older queued message, and does not replay the completed write.');
  report.cases.push('The remaining queued message executes exactly once after the immediate message completes; the queue is empty and the original file is unchanged.');
  report.cases.push('Steering before the send acknowledgement: accepted local placeholder stays consumed and a delayed send snapshot cannot resurrect it.');
}
