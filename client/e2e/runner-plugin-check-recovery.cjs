'use strict';
// NativeChat/production preload and Runner adapter; only Runner RPC and one
// resource-worker failure are controlled. No real model, account or CLI runs.
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
const args = process.argv.slice(2), out = path.resolve(args.find(value => !value.startsWith('--')) || path.join(client, '../outputs/runner-plugin-check-recovery'));
const baseline = args.find(value => value.startsWith('--baseline-source='))?.slice('--baseline-source='.length);
const expectRegression = args.includes('--expect-regression');
const prequeue = args.includes('--queued');
if (baseline) {
  const Module = require('node:module'), target = path.join(client, 'main/agent-runtime/runner-adapter.js');
  const loaded = new Module(target, module); loaded.filename = target; loaded.paths = Module._nodeModulePaths(path.dirname(target));
  require.cache[target] = loaded; loaded._compile(fs.readFileSync(path.join(path.resolve(baseline), 'main/agent-runtime/runner-adapter.js'), 'utf8'), target); loaded.loaded = true;
}
fs.mkdirSync(out, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-runner-plugin-ui-'));
const cwd = path.join(root, 'workspace'), profile = path.join(root, 'profile'); fs.mkdirSync(cwd); fs.mkdirSync(profile);
app.setPath('userData', profile);
const report = { ok: false, expectRegression, scenario: prequeue ? 'prequeued-resume' : 'manual-continue',
  baseline: baseline || null, source: client, cases: [], ipc: [], rpc: [], worker: [],
  boundaries: ['Real Windows Electron NativeChat composer, production queue/busy/error rendering and production preload.',
    'Real Runner adapter, turn queue, plugin generation gate and resource worker; synthetic Runner RPC produces two deterministic successful native rounds.',
    'One final candidate-recollection request throws after a real draft preflight succeeds. No production code is changed for injection.',
    'Open/send/queue IPC routing is isolated wiring to the real handle. Hub admission/auth, external Runner process/CLI/model and macOS are outside this test.'] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => fs.readFileSync(path.join(client, file), 'utf8');
const cache = require('../main/app-resource-cache.cjs'), originalRequest = cache.request;
let win, session, handle, unsubscribe, ready = false, sent = 0, completedRound = 0, releaseFirst = false;
let checked = false, followingScans = 0, injected = false, dispatches = 0, comments = 0;
const receipts = [], js = code => win.webContents.executeJavaScript(code, true);
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
  await click('#nchatInput'); await win.webContents.insertText(text);
  // The running chat's button is Stop. NativeChat's real Enter handler queues
  // a nonempty composer payload without cancelling the active turn.
  if (handle.inFlight()) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  } else await click('#nchatSend');
  await until(() => sent > before, 'native composer reaches IPC');
  return receipts[before];
}
async function shot(name) { await delay(180); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
app.whenReady().then(async () => {
  report.runtime = { platform: process.platform, electron: process.versions.electron, node: process.versions.node };
  win = new BrowserWindow({ show: false, width: 1120, height: 850, webPreferences: {
    preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  const { createRunnerRuntimeAdapter, getRunnerSessionDetails, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
  const runtimeSpec = require('../main/agent-runtime/runtime-catalog').runtime('opencode');
  const draft = path.join(cwd, 'soduwork-plugin-draft.json'), sideEffect = path.join(cwd, 'continued.txt');
  const body = { template: 'method', key: 'runner-recovery-ui', name: 'Runner recovery fixture', version: '1.0.0',
    description: 'Controlled plugin completion scan', instructions: 'Summarize supplied material.' };
  cache.request = async input => {
    report.worker.push(input.action);
    if (input.action === 'draft-candidates' && checked && ++followingScans === 2) {
      injected = true; throw Error('Synthetic final plugin candidate worker failure');
    }
    const result = await originalRequest(input);
    if (input.action === 'draft-check') checked = true;
    return result;
  };
  const runtime = { async rpc(op, value) {
    report.rpc.push({ op, ...(op === 'job.comment' ? { text: value.text } : {}) });
    if (op === 'job.dispatch') {
      dispatches++; fs.writeFileSync(draft, JSON.stringify(body));
      return { ok: true, data: { ok: true, ref: _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', value.dispatchId) } };
    }
    if (op === 'job.comment') {
      comments++; completedRound = 2; fs.appendFileSync(sideEffect, 'CONTINUED_ONCE\n');
      return { ok: true, data: { ok: true, state: 'running' } };
    }
    if (op === 'job.session') {
      const done = releaseFirst || completedRound === 2;
      const items = [{ seq: 1, kind: 'user', text: 'CREATE_PLUGIN: generate the plugin.' },
        { seq: 2, kind: 'say', text: 'Draft generated. Existing work is preserved.' }];
      if (completedRound === 2) items.push({ seq: 3, kind: 'user', text: 'CONTINUE_PLUGIN: finish the follow-up.' },
        { seq: 4, kind: 'say', text: 'Follow-up completed after the worker recovered.' });
      return { ok: true, data: { ok: true, status: done ? 'done' : 'running', round: completedRound || 1, seq: items.length, items } };
    }
    return { ok: true, data: { ok: true, state: 'running' } };
  } };
  const model = { ok: true, model: { id: 'fixture', key: 'fixture', input: ['text'] } };
  const adapter = createRunnerRuntimeAdapter({ app: { getPath: () => profile }, runnerRuntime: runtime, runtimeSpec,
    modelConfig: { fetchModel: async () => model, fetchSelection: async () => model } });
  session = await adapter.createSession({ identity: {}, native: { runner: { openOptions: { app: { getPath: () => profile }, cwd, ref: 'runner-plugin-ui' } } } });
  handle = getRunnerSessionDetails(session).handle; handle.attachedWindow = win; unsubscribe = handle.on(publish);
  ipcMain.handle('pi-session-open', () => ({ ok: true, ref: handle.ref, sessionId: handle.sessionId, adapterId: 'opencode', displayName: 'OpenCode', cwd,
    model: { label: 'Synthetic Runner model' }, snapshot: handle.snapshot() }));
  ipcMain.handle('pi-session-snapshot', () => ({ ok: true, snapshot: handle.snapshot() }));
  ipcMain.handle('pi-session-runtimes', () => ({ ok: true, runtimes: [runtimeSpec], availableRuntimes: [runtimeSpec] }));
  ipcMain.handle('access-preferences-get', () => ({ ok: true, mode: 'standard', revision: 0 }));
  ipcMain.handle('pi-session-send', (_event, ref, text, files, options) => {
    assert.equal(ref, handle.ref); assert.equal(files.length, 0);
    const receipt = handle.submit(text, [], options); sent++; report.ipc.push({ channel: 'send', text, queued: receipt.queued });
    const completion = receipt.completion.then(result => { publish({ kind: result.ok ? 'settled' : 'error', reason: result.reason,
      failureKind: result.failureKind, retrySafe: Boolean(result.retrySafe), submissionId: options.submissionId }); return result; });
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
  await js('SoduWorkAPI.myModels=async()=>({usable:[{name:"fixture",id:"fixture",label:"Synthetic Runner model"}]});void 0;');
  ready = true;
  await js('SoduWorkI18n.setLocale("en-US");NativeChat.enter("",' + JSON.stringify(handle.sessionId) + ',{adapterId:"opencode"});void 0;');
  const first = await send('CREATE_PLUGIN: generate the plugin.');
  await until(() => dispatches === 1, 'first native dispatch');
  let second;
  if (prequeue) {
    second = await send('CONTINUE_PLUGIN: finish the follow-up.');
    assert.equal(second.queued, true);
  }
  assert.equal(comments, 0);
  await shot('first-turn-running');
  releaseFirst = true;
  const failed = await first.completion;
  await until(() => injected && js('Boolean(document.querySelector("[data-chat-node=runtime-error].show"))'), 'worker failure shown');
  const snap = handle.snapshot();
  report.first = { result: { ok: failed.ok, reason: failed.reason, failureKind: failed.failureKind, retrySafe: failed.retrySafe },
    status: snap.status, inFlight: handle.inFlight(), execution: { running: snap.execution.running, turnQueue: snap.execution.turnQueue, queue: snap.execution.queue },
    banner: await js('document.querySelector("[data-chat-node=runtime-error] .nbad-copy").textContent') };
  assert.equal(failed.ok, false); assert.equal(injected, true); assert.equal(dispatches, 1); assert.equal(comments, 0);
  assert.equal(fs.readFileSync(draft, 'utf8'), JSON.stringify(body));
  assert.match(await js('document.body.innerText'), /Existing work is preserved/);
  await shot('final-candidate-scan-failure');
  if (expectRegression) {
    assert.equal(snap.status, 'streaming'); assert.equal(handle.inFlight(), true);
    second ||= await send('CONTINUE_PLUGIN: finish the follow-up.');
    assert.equal(second.queued, true);
    await click('[data-queue-action="resume"]'); await delay(250);
    assert.equal(comments, 0); assert.equal(handle.inFlight(), true);
    report.fixInvariantPassed = false;
    report.cases.push('Baseline regression: final scan throws, adapter stays streaming/inFlight, and actual Resume queue click cannot execute the queued message.');
    report.ok = true; return;
  }
  assert.equal(snap.status, 'unreachable'); assert.equal(snap.execution.running, false);
  assert.equal(snap.execution.turnQueue.activeQueueId, '');
  report.first.nativeChatBusy = await js('NativeChat.isBusy()');
  if (!prequeue) {
    // No pending work exists: neither adapter nor visible activity may remain
    // busy after the completed turn's final scan failed.
    assert.equal(handle.inFlight(), false); assert.equal(report.first.nativeChatBusy, false);
  } else {
    // Pending queue ownership intentionally counts as inFlight/isBusy. Its
    // paused item must not be mistaken for active streaming execution.
    assert.equal(snap.execution.queue.length, 1); assert.equal(comments, 0);
  }
  assert.equal(failed.failureKind, 'plugin-validation'); assert.equal(failed.retrySafe, false);
  assert.equal(snap.execution.turnQueue.paused, true);
  report.cases.push(prequeue ? 'Completed native turn loses final plugin scan; queue remains paused with no active streaming execution and preserves prior work.'
    : 'Completed native turn loses final plugin scan; actual error banner retains earlier text/draft, adapter and NativeChat are not busy.');
  second ||= await send('CONTINUE_PLUGIN: finish the follow-up.');
  report.followupQueued = second.queued;
  if (second.queued && handle.snapshot().execution.turnQueue.paused) await click('[data-queue-action="resume"]');
  const recovered = await second.completion; assert.equal(recovered.ok, true, recovered.reason);
  await until(() => js('document.body.innerText.includes("Follow-up completed after the worker recovered.")'), 'queued follow-up rendered');
  assert.equal(comments, 1); assert.equal(dispatches, 1); assert.equal(handle.inFlight(), false);
  assert.equal(await js('NativeChat.isBusy()'), false);
  assert.deepEqual(report.rpc.filter(row => row.op === 'job.comment').map(row => row.text), ['CONTINUE_PLUGIN: finish the follow-up.']);
  assert.equal(fs.readFileSync(sideEffect, 'utf8'), 'CONTINUED_ONCE\n');
  assert.equal(fs.readFileSync(draft, 'utf8'), JSON.stringify(body));
  assert.deepEqual(await js('window.errors'), []);
  report.recovered = { ok: recovered.ok, status: handle.snapshot().status, inFlight: handle.inFlight(), dispatches, comments,
    queued: handle.snapshot().execution.queue.length, originalDraftPreserved: true };
  await shot('queue-resumed-success');
  report.cases.push(prequeue ? 'Actual NativeChat Resume queue click runs exactly the queued follow-up once, without replaying original dispatch; final state is idle and not busy.'
    : 'Manual NativeChat continuation reaches the production turn queue; exactly one follow-up RPC runs, without replaying original dispatch or losing its draft.');
  report.fixInvariantPassed = true;
  report.ok = true;
}).catch(async error => {
  report.error = error.stack || String(error);
  if (handle) report.runtimeSnapshot = handle.snapshot();
  if (win && !win.isDestroyed()) { report.ui = await js('({text:document.body.innerText,errors:window.errors})').catch(() => null); await shot('failure').catch(() => {}); }
}).finally(async () => {
  ready = false; unsubscribe?.(); cache.request = originalRequest;
  try { await session?.dispose(); await cache.close(); } catch (error) { report.cleanupError = String(error); report.ok = false; }
  if (win && !win.isDestroyed()) win.destroy();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('Unexpected cleanup root');
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Only this owned Chromium profile may remain locked until exit. */ }
  app.exit(report.ok ? 0 : 1);
});
