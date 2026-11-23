'use strict';
// NativeChat -> production preload -> isolated IPC routing -> real Pi SDK/session.
// Only model discovery/HTTP replies and unrelated shell services are fixtures.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
const client = path.resolve(__dirname, '..');
const args = process.argv.slice(2), out = path.resolve(args.find(value => !value.startsWith('--')) || path.join(client, '../outputs/plugin-repair-error-details'));
const baseline = args.find(value => value.startsWith('--baseline-source='))?.slice('--baseline-source='.length);
const expectRegression = args.includes('--expect-regression');
const prequeue = args.includes('--queued');
if (baseline) {
  const Module = require('node:module');
  for (const relative of ['main/pi-session/plugin-generation-gate.cjs', 'main/pi-session/session-send.js']) {
    const target = path.join(client, relative), original = path.join(path.resolve(baseline), relative);
    const loaded = new Module(target, module); loaded.filename = target; loaded.paths = Module._nodeModulePaths(path.dirname(target));
    require.cache[target] = loaded; loaded._compile(fs.readFileSync(original, 'utf8'), target); loaded.loaded = true;
  }
}
fs.mkdirSync(out, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-plugin-repair-ui-'));
app.setPath('userData', path.join(root, 'profile'));
const report = { ok: false, expectRegression, scenario: prequeue ? 'prequeued-resume' : 'manual-continue',
  baseline: baseline || null, source: client, cases: [], ipc: [], requests: [],
  boundaries: ['Real Windows Electron NativeChat composer, chat-session-controller error handler, panels-chat._fail, renderer and production preload.',
    'Real production Pi session, SDK, generation gate, worker preflight, archive and native write tool; loopback provider returns controlled HTTP 403.',
    'Open/send/queue IPC routing is isolated wiring to the real handle, with completion events shaped like production ipc.js. Hub admission/auth, attachment staging and utility-process transport are not installed.',
    'No production account, external authorization, macOS execution, or model-quality assertion.'] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => fs.readFileSync(path.join(client, file), 'utf8');
const resultSummary = result => ({ ok: result.ok, reason: result.reason, failureKind: result.failureKind,
  retrySafe: result.retrySafe, cancelled: result.cancelled, paused: result.paused, recovering: result.recovering,
  pluginValidation: result.pluginValidation, completion: result.snapshot?.completion });
let win, fixture, handle, unsubscribe, ready = false, sent = 0, toolOffers = 0, repairs = 0, initialRequested = false;
const receipts = [];
let releaseInitial;
const initialWait = new Promise(resolve => { releaseInitial = resolve; });
const js = code => win.webContents.executeJavaScript(code, true);
function publish(touched = { kind: 'snapshot' }, snapshot = handle.snapshot()) {
  if (ready && !win.isDestroyed()) win.webContents.send('pi-session-event', { ...touched, ref: handle.ref, snapshot });
}
async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(25); }
  throw Error('Timed out: ' + label);
}
async function click(selector) {
  const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.checkVisibility())throw Error('Unavailable '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Occluded '+${JSON.stringify(selector)});return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  await delay(60);
}
async function send(text) {
  const before = sent;
  await until(() => js('!document.querySelector("#nchatSend").disabled'), 'composer ready');
  await click('#nchatInput');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
  await win.webContents.insertText(text);
  // The active chat button is Stop; Enter uses NativeChat's real queue path.
  if (handle.inFlight()) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  } else await click('#nchatSend');
  await until(() => sent > before, 'native composer reaches IPC');
  return receipts[before];
}
async function visibility(selector) {
  return js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;
    const r=e.getBoundingClientRect(),s=getComputedStyle(e);return{text:e.textContent,display:s.display,visibility:s.visibility,opacity:s.opacity,
      checkVisibility:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),rect:{x:r.x,y:r.y,width:r.width,height:r.height},
      inViewport:r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth}})()`);
}
async function shot(name) { await delay(180); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
app.whenReady().then(async () => {
  report.runtime = { platform: process.platform, electron: process.versions.electron, node: process.versions.node };
  win = new BrowserWindow({ show: false, width: 1120, height: 850, webPreferences: {
    preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  fixture = await require('./fixtures/resumed-pi.cjs').create(root);
  const draft = path.join(fixture.cwd, 'soduwork-plugin-draft.json');
  const valid = { template: 'method', key: 'repair-ui-fixture', name: 'Repair UI fixture', version: '1.0.0',
    description: 'Controlled plugin repair regression', instructions: 'Summarize the supplied material.' };
  fixture.reply(async body => {
    const last = body.messages.at(-1), user = body.messages.findLast(row => row.role === 'user');
    const text = JSON.stringify(user?.content || '');
    const internal = text.includes('<soduwork-internal-plugin-repair>');
    report.requests.push({ internal, lastRole: last.role });
    if (internal) {
      repairs++;
      return { respond(response) { response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'PRIVATE_UPSTREAM_SENTINEL Bearer SYNTHETIC_SECRET_403 prompt=DO_NOT_DISPLAY' } })); } };
    }
    if (last.role === 'user') {
      if (!text.includes('CONTINUE_PLUGIN')) { initialRequested = true; if (prequeue) await initialWait; }
      toolOffers++;
      return { tool: 'write', args: { path: draft, content: text.includes('CONTINUE_PLUGIN') ? JSON.stringify(valid) : '{malformed' } };
    }
    return { text: text.includes('CONTINUE_PLUGIN') ? 'Plugin corrected. Earlier work is preserved.' : 'Draft generated. Earlier work is preserved.' };
  });
  handle = await fixture.open({ ref: 'plugin-repair-ui' }); handle.attachedWindow = win;
  unsubscribe = handle.on(publish);
  const runtime = require('../main/agent-runtime/runtime-catalog').runtime('pi');
  ipcMain.handle('pi-session-open', () => ({ ok: true, ref: handle.ref, sessionId: handle.sessionId, adapterId: 'pi', displayName: 'Pi', cwd: fixture.cwd,
    model: { label: 'Isolated loopback model' }, snapshot: handle.snapshot() }));
  ipcMain.handle('pi-session-snapshot', () => ({ ok: true, snapshot: handle.snapshot() }));
  ipcMain.handle('pi-session-runtimes', () => ({ ok: true, runtimes: [runtime], availableRuntimes: [runtime] }));
  ipcMain.handle('access-preferences-get', () => ({ ok: true, mode: 'standard', revision: 0 }));
  ipcMain.handle('pi-session-send', (_event, ref, text, files, options) => {
    assert.equal(ref, handle.ref); assert.equal(files.length, 0);
    const receipt = handle.submit(text, [], options); sent++; report.ipc.push({ channel: 'send', text, queued: receipt.queued });
    const completion = receipt.completion.then(result => {
      publish({ kind: result.ok ? 'settled' : 'error', reason: result.reason, failureKind: result.failureKind,
        retrySafe: Boolean(result.retrySafe), submissionId: options.submissionId }); return result;
    });
    receipts.push({ ...receipt, completion });
    return { ok: true, accepted: true, queued: receipt.queued, queueId: receipt.queueId, position: receipt.position,
      snapshot: handle.snapshot(), inputAttachments: [], attachmentWarnings: [] };
  });
  ipcMain.handle('pi-session-queue-update', (_event, ref, id, action, value) => {
    assert.equal(ref, handle.ref); report.ipc.push({ channel: 'queue-update', action }); return handle.updateQueue(id, action, value);
  });
  for (const [channel, value] of Object.entries({ 'pi-session-history': { ok: true, chats: [] }, 'pi-session-outputs': { ok: true, items: [] },
    'pi-session-release': { ok: true }, 'pi-session-runtime-models': { ok: true, items: [] }, 'work-preview-hide': { ok: true },
    'work-preview-destroy': { ok: true }, 'pi-session-work-cards': { ok: true, cards: [] }, 'pi-session-recent-plugin-draft': { ok: true },
    'pi-session-open-application': { ok: true, handled: false } })) ipcMain.handle(channel, () => value);
  const source = path.join(__dirname, 'fixtures/workbench-annotations.html'), scripts = [];
  const html = fs.readFileSync(source, 'utf8').replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_, attrs, body) => {
    const src = attrs.match(/src=["']([^"']+)/); scripts.push(src ? fs.readFileSync(path.resolve(path.dirname(source), src[1]), 'utf8') : body); return '';
  });
  const page = path.join(root, 'native-chat.html');
  fs.writeFileSync(page, html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="' + pathToFileURL(path.dirname(source) + path.sep).href + '">'));
  await win.loadFile(page);
  for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
  for (const file of ['core/i18n-dom.js', 'core/i18n.js']) await js(read(file) + '\nvoid 0;');
  for (const script of scripts) await js(script + '\nvoid 0;');
  await js('SoduWorkAPI.myModels=async()=>({usable:[{name:"fixture-model",id:"fixture-model",label:"Local regression model"}]});void 0;');
  ready = true;
  await js('SoduWorkI18n.setLocale("en-US");NativeChat.enter("",' + JSON.stringify(handle.sessionId) + ',{adapterId:"pi"});void 0;');
  await until(() => js('document.body.innerText.includes("Previous report is preserved.")'), 'prior history loaded');
  const firstReceipt = await send('CREATE_PLUGIN: create the requested plugin draft.');
  let secondReceipt;
  if (prequeue) {
    await until(() => initialRequested, 'first model request is held');
    secondReceipt = await send('CONTINUE_PLUGIN: correct the existing draft after access is restored.');
    assert.equal(secondReceipt.queued, true);
    await shot('followup-queued');
  }
  releaseInitial();
  const first = await firstReceipt.completion;
  assert.equal(first.ok, false); assert.equal(repairs, 1); assert.equal(toolOffers, 1);
  assert.equal(fs.readFileSync(draft, 'utf8'), '{malformed');
  await until(() => js('Boolean(document.querySelector("[data-chat-node=runtime-error].show"))'), 'production error banner');
  const banner = await js('document.querySelector("[data-chat-node=runtime-error] .nbad-copy").textContent');
  const visible = await js('document.body.innerText');
  report.first = { result: resultSummary(first), initialErrorText: banner, locale: await js('SoduWorkI18n.getLocale()'),
    status: handle.snapshot().status, inFlight: handle.inFlight(), malformedDraftPreserved: true };
  report.first.initialPresentation = {
    error: await visibility('[data-chat-node="runtime-error"]'),
    notice: await visibility('[data-chat-node="runtime-notice"]'),
    queue: await visibility('.nqueue-paused'),
  };
  // A subsequent production snapshot can replace _fail's transient text with
  // the longer safe model-interruption status. Record screenshot-time geometry
  // and text separately; neither a .show class nor hidden text proves visibility.
  await delay(200);
  report.first.presentation = {
    error: await visibility('[data-chat-node="runtime-error"]'),
    notice: await visibility('[data-chat-node="runtime-notice"]'),
    queue: await visibility('.nqueue-paused'),
  };
  const shownError = report.first.presentation.error;
  assert.equal(shownError?.checkVisibility, true, 'safe model status must be rendered');
  assert.equal(shownError.inViewport, true, 'safe model status must be in the screenshot viewport');
  assert.match(shownError.text, /model.*HTTP 403/i);
  assert.doesNotMatch(shownError.text, /[\u3400-\u9fff]/);
  assert.doesNotMatch(visible, /PRIVATE_UPSTREAM_SENTINEL|SYNTHETIC_SECRET_403|DO_NOT_DISPLAY/);
  assert.match(visible, /Previous report is preserved/);
  if (!prequeue) assert.equal(handle.inFlight(), false);
  else {
    assert.equal(handle.snapshot().execution.turnQueue.paused, true);
    assert.equal(handle.snapshot().execution.queue.length, 1);
    assert.equal(toolOffers, 1, 'paused follow-up must not perform another native write');
    const queue = report.first.presentation.queue;
    assert.equal(queue?.checkVisibility, true, 'queue failure reason must be rendered');
    assert.equal(queue.inViewport, true, 'queue failure reason must be in the screenshot viewport');
  }
  await shot('repair-http403');
  if (expectRegression) {
    assert.match(first.reason, /repair did not complete/);
    report.fixInvariantPassed = false;
    if (prequeue) {
      assert.match(report.first.presentation.queue.text, /repair did not complete/);
      assert.doesNotMatch(report.first.presentation.queue.text, /HTTP 403/);
    }
    report.cases.push('Baseline regression: completion reason loses HTTP 403; when prequeued, the visible queue failure reason also becomes generic. A later snapshot already restores HTTP 403 in the separate chat status banner.');
    report.ok = true; return;
  }
  if (prequeue) {
    assert.match(report.first.presentation.queue.text, /HTTP 403/);
    assert.doesNotMatch(report.first.presentation.queue.text, /repair did not complete/);
  }
  assert.match(first.reason, /HTTP 403/);
  assert.equal(report.first.locale, 'en-US');
  assert.equal(first.retrySafe, false);
  await delay(200); assert.equal(repairs, 1, 'permanent 403 must not automatically retry');
  report.cases.push('Malformed native write triggers hidden repair once; safe HTTP 403 is preserved in the completion result. The stable visible English HTTP 403 status already existed before this fix. Transient _fail text is recorded only, because a snapshot may replace it before inspection.');
  secondReceipt ||= await send('CONTINUE_PLUGIN: correct the existing draft after access is restored.');
  if (secondReceipt.queued && handle.snapshot().execution.turnQueue.paused) await click('[data-queue-action="resume"]');
  const second = await secondReceipt.completion;
  assert.equal(second.ok, true, second.reason);
  assert.deepEqual(JSON.parse(fs.readFileSync(draft, 'utf8')), valid);
  assert.equal(repairs, 1); assert.equal(toolOffers, 2); assert.equal(sent, 2);
  await until(() => js('document.body.innerText.includes("Plugin corrected.")'), 'follow-up rendered');
  assert.equal(handle.inFlight(), false);
  assert.equal(await js('NativeChat.isBusy()'), false);
  assert.match(await js('document.body.innerText'), /Previous report is preserved/);
  report.second = { result: resultSummary(second), writes: handle.snapshot().tools.filter(tool => tool.name === 'write').length,
    pluginValidation: handle.snapshot().pluginValidation, status: handle.snapshot().status };
  assert.equal(report.second.writes, 2, 'initial generation and explicit continuation each write exactly once');
  assert.deepEqual(await js('window.errors'), []);
  await shot(prequeue ? 'queue-resumed-success' : 'manual-continue-success');
  report.cases.push(prequeue
    ? 'Visible queue failure preserves HTTP 403; real NativeChat Resume executes only the prequeued continuation, reaches idle/not busy, and performs one additional native write.'
    : 'Manual composer continuation succeeds in the same archive, keeps history, passes production plugin preflight and performs one additional native write only.');
  report.fixInvariantPassed = true;
  report.ok = true;
}).catch(async error => {
  report.error = error.stack || String(error);
  if (handle) report.runtimeSnapshot = handle.snapshot();
  if (win && !win.isDestroyed()) { report.ui = await js('({text:document.body.innerText,errors:window.errors})').catch(() => null); await shot('failure').catch(() => {}); }
}).finally(async () => {
  releaseInitial();
  ready = false; unsubscribe?.();
  try { await fixture?.close(); await require('../main/app-resource-cache.cjs').close(); } catch (error) { report.cleanupError = String(error); report.ok = false; }
  if (win && !win.isDestroyed()) win.destroy();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('Unexpected cleanup root');
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Only this owned Chromium profile may remain locked until process exit. */ }
  app.exit(report.ok ? 0 : 1);
});
