'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], { env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
const client = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-chat-resume-e2e-'));
const out = path.resolve(client, '../outputs/conversation-stall-20260930'); fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(root, 'profile')); app.on('window-all-closed', () => {});
const read = file => fs.readFileSync(path.join(client, file), 'utf8'), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { ok: false, cases: [], boundary: 'Actual Electron/preload/NativeChat/sendConversation/production Pi session/SDK/streaming HTTP and extension tool execution. Isolated archive, local endpoint and auth fixture; no business data or paid model requests.' };
let win, fixture, handle, off, ready = false, cancellations = 0;
const results = [], runtimeErrors = [];
const js = code => win.webContents.executeJavaScript(code, true);
async function until(check, name) {
  const end = Date.now() + 12000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(30); }
  throw Error('Timed out: ' + (name || check));
}
function publish(_windows, _session, event, snapshot) {
  if (ready) win.webContents.send('pi-session-event', { ref: handle.ref, ...event, snapshot: snapshot || handle.uiSnapshot() });
}
async function click(selector) {
  const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded control');return{x,y}})()`);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
}
async function send(text) {
  await until(() => js("!!document.querySelector('#nchatSend')&&!document.querySelector('#nchatSend').disabled"), 'composer ready for send');
  await js(`(()=>{const i=document.querySelector('#nchatInput');i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('#nchatSend');
}
function installSend() {
  const source = read('main/pi-session/ipc.js');
  const code = source.slice(source.indexOf('  async function sendConversation('), source.indexOf("  ipcMain.handle('pi-session-send',"));
  const context = vm.createContext({ app, BrowserWindow, path, Promise, Date,
    _uiWindow: require('../main/pi-session/ui-window').create(),
    // Keep production routing: these isolated archived sessions run locally.
    _cloudHandoff: { guard: () => false },
    require: require('node:module').createRequire(path.join(client, 'main/pi-session/ipc.js')),
    updateWorkloads: { guard: () => ({ ok: true }) }, session: { get: ref => ref === handle.ref ? handle : null },
    sendIdentityOf: async () => ({}), identityOf: async () => ({}), memories: { assertOwner() {} },
    pluginDebug: { guard: () => null }, workDir: () => root,
    attachments: require('../main/pi-session/attachments'), _publish: publish, _scheduleRelease() {},
  });
  const snapshotCode = source.slice(source.indexOf('function _contextSnapshot('), source.indexOf('function _send('));
  vm.runInContext(snapshotCode + '\n' + code, context);
  ipcMain.handle('pi-session-send', (_event, ref, text, files, options) =>
    context.sendConversation(ref, text, files, options, completion => completion.then(result => results.push(result))));
}
app.whenReady().then(async () => {
  fixture = await require('./fixtures/resumed-pi.cjs').create(root, { loadDelay: 180 });
  handle = await fixture.open(); assert.equal(fs.existsSync(fixture.loaded), false);
  win = new BrowserWindow({ show: false, width: 1050, height: 800, webPreferences: {
    preload: path.join(client, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false,
    backgroundThrottling: false, offscreen: true } });
  win.webContents.on('console-message', event => { if (event.level === 'error') runtimeErrors.push(event.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_req, done) => done({ cancel: true }));
  installSend(); off = handle.on(event => publish(null, handle, event, handle.uiSnapshot()));
  ipcMain.handle('pi-session-open', () => ({ ok: true, ref: handle.ref, sessionId: handle.sessionId, adapterId: 'pi', displayName: 'Pi',
    cwd: fixture.cwd, model: { label: 'Local regression model' }, snapshot: handle.uiSnapshot() }));
  ipcMain.handle('pi-session-snapshot', () => ({ ok: true, snapshot: handle.uiSnapshot() }));
  ipcMain.handle('pi-session-queue-update', (_event, ref, id, action, value) => handle.updateQueue(id, action, value));
  ipcMain.on('pi-session-cancel', () => { cancellations++; handle.cancel(); });
  for (const [channel, value] of Object.entries({ 'pi-session-history': { ok: true, chats: [] }, 'pi-session-outputs': { ok: true, items: [] },
    'pi-session-runtimes': {ok:true,runtimes:[]}, 'access-preferences-get': {ok:true,mode:'default'},
    'work-preview-reset-embedded': {ok:true},
    'pi-session-release': { ok: true }, 'pi-session-runtime-models': { ok: true, items: [] },
    'work-preview-hide': { ok: true }, 'work-preview-destroy': { ok: true } })) ipcMain.handle(channel, () => value);
  const source = path.join(__dirname, 'fixtures/workbench-annotations.html'), scripts = [];
  const html = fs.readFileSync(source, 'utf8').replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_, attrs, body) => {
    const src = attrs.match(/src=["']([^"']+)/); scripts.push(src ? fs.readFileSync(path.resolve(path.dirname(source), src[1]), 'utf8') : body); return '';
  });
  const documentFile = path.join(out, 'resume-native-chat.html');
  fs.writeFileSync(documentFile, html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="' + pathToFileURL(path.dirname(source) + path.sep).href + '">'));
  await win.loadFile(documentFile);
  for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
  for (const file of ['core/i18n-dom.js', 'core/i18n.js']) await js(read(file) + '\nvoid 0;');
  for (const file of ['compose-candidate-navigation.js', 'chat-plugin-mention-model.js', 'chat-plugin-mention.js']) {
    await js(read('components/panels/' + file) + '\nvoid 0;');
  }
  for (const script of scripts) await js(script + '\nvoid 0;');
  ready = true; await js(`SoduWorkI18n.setLocale('zh-CN');NativeChat.enter('',${JSON.stringify(handle.sessionId)},{adapterId:'pi'});`);
  await until(() => js("document.querySelector('#nchatList')?.textContent.includes('Previous report is preserved.')"), 'history visible');
  assert.equal(fixture.requests.length, 0); assert.equal(fs.existsSync(fixture.loaded), false);
  report.cases.push('Opening archived history paints immediately without running configured extensions or a model request.');
  fixture.reply((body, count) => count === 1 ? { text: '现在立即执行补检索，一次到位。' }
    : body.messages.at(-1).role === 'tool' ? { text: '报告补充已完成，检索来源已核实。' }
      : { tool: 'web_search', args: { query: 'isolated report' } });
  await send('继续完善报告，请补检索并完成。'); await until(() => results.length === 1, 'continued result');
  assert.equal(results[0].ok, true, results[0].reason);
  await until(() => js("document.querySelector('#nchatList').textContent.includes('报告补充已完成')"), 'final answer visible');
  assert.equal(fixture.requests.length, 3); assert.ok(fixture.requests[0].tools.some(tool => tool.function.name === 'web_search'));
  assert.equal(fs.readFileSync(fixture.executed, 'utf8'), 'isolated report\n');
  assert.equal(await js("document.body.innerText.includes('soduwork-internal-output-continue')"), false);
  report.cases.push('Actual mouse send → production IPC → restores archived extension tools → local model stop promise → bounded hidden continuation → real search tool → final result; exactly one tool execution.');
  fs.writeFileSync(path.join(out, 'resumed-complete.png'), (await win.webContents.capturePage()).toPNG());
  const before = fixture.requests.length;
  fixture.reply(() => ({ text: '现在立即执行补检索，一次到位。' }));
  await send('继续完善报告，请实际检索。'); await until(() => results.length === 2, 'incomplete result');
  assert.equal(fixture.requests.length - before, 2); assert.equal(results[1].failureKind, 'output-incomplete');
  await until(() => js("document.body.innerText.includes('模型未能完成本轮请求')"), 'incomplete notice');
  assert.equal(handle.snapshot().status, 'incomplete');
  assert.equal(fs.readFileSync(fixture.executed, 'utf8'), 'isolated report\n');
  report.cases.push('Repeated promises stop after one recovery and display an explicit incomplete notice; earlier tools are never replayed.');
  await js("SoduWorkI18n.setLocale('en-US');void 0;");
  await until(() => js("document.body.innerText.includes('The model did not complete this request')"), 'translated incomplete notice');
  assert.equal(await js("document.querySelector('.nbad.show').textContent.includes('模型未能完成本轮请求')"), false);
  assert.equal(await js("!!document.querySelector('[data-queue-action=resume]')"), false, 'empty incomplete turn uses its error notice, not a queue resume action');
  report.cases.push('Incomplete state and recovery guidance translate when the active locale changes.');
  fs.writeFileSync(path.join(out, 'resumed-incomplete-en.png'), (await win.webContents.capturePage()).toPNG());
  fixture.reply(() => ({ text: 'Recovery completed.' }));
  await js("SoduWorkI18n.setLocale('zh-CN');void 0;");
  const freshStart = fixture.requests.length;
  await send('解释一下当前状态。');
  await until(() => results.length === 3, 'later send');
  assert.equal(results[2].ok, true); assert.equal(handle.snapshot().status, 'idle');
  assert.equal(fixture.requests.length, freshStart + 1, 'a fresh send runs exactly once without an extra resume click');
  assert.equal(handle.snapshot().execution.turnQueue.paused, false);
  await until(() => js("document.querySelector('#nchatList').textContent.includes('Recovery completed.')"), 'fresh answer visible');
  assert.equal(await js("Boolean(document.querySelector('[data-queue-action=resume]'))"), false);
  report.cases.push('After an incomplete turn with no queued work, a fresh user send runs exactly once and clears the automatic pause without requiring Continue queue.');
  let release; const gate = new Promise(resolve => { release = resolve; });
  fixture.reply(async () => { await gate; return { text: 'Cancelled response must not be retried.' }; });
  const oldCount = fixture.requests.length; await send('继续完成并检索。');
  await until(() => fixture.requests.length > oldCount, 'active request');
  await until(() => js("document.querySelector('#nchatInput').value === ''"), 'sent input cleared');
  await click('#nchatSend'); await until(() => cancellations === 1, 'stop IPC');
  release(); await until(() => results.length === 4, 'stop');
  assert.equal(results[3].cancelled, true); assert.equal(fixture.requests.length, oldCount + 1);
  assert.equal(handle.snapshot().execution.running, false);
  report.cases.push('Actual stop button cancels the active turn and never triggers an automatic continuation.');
  const reasoningStart = fixture.requests.length;
  fixture.reply((_body, count) => count === reasoningStart + 1 ? { respond: async response => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta, finish_reason) => 'data: ' + JSON.stringify({ id: 'reasoning-only', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    response.end(frame({ role: 'assistant', reasoning_content: '思考尚未形成答复。' }, null) + frame({}, 'stop') + 'data: [DONE]\n\n');
  } } : { text: '思考后的最终答复已补齐。' });
  await send('解释一下这个隔离样本。'); await until(() => results.length === 5, 'reasoning-only recovery');
  assert.equal(results[4].ok, true); assert.equal(fixture.requests.length, reasoningStart + 2);
  await until(() => js("document.querySelector('#nchatList').textContent.includes('思考后的最终答复已补齐')"), 'final after thinking');
  report.cases.push('Reasoning-only native stream receives one bounded follow-up and displays its actual final answer.');
  const protocolStart = fixture.requests.length;
  let releaseProtocol; const protocolGate = new Promise(resolve => { releaseProtocol = resolve; });
  fixture.reply(async (_body, count) => {
    if (count === protocolStart + 1) return { text: Array(8).fill('Let me read README now.').join('\n') };
    if (count === protocolStart + 2) { await protocolGate; return { text: '自动恢复后的答复完成。' }; }
    return { text: '后续排队消息已正常完成。' };
  });
  await send('检查这个隔离样本并给出结论。');
  await until(() => fixture.requests.length === protocolStart + 2, 'protocol recovery started');
  await send('解释一下后续结果。');
  await until(() => handle.snapshot().execution.queue.length === 1, 'queued follow-up');
  assert.equal(results.length, 5, 'original UI submission must stay pending through automatic recovery');
  releaseProtocol(); await until(() => results.length === 7, 'recovery and queue completion');
  assert.equal(fixture.requests.length, protocolStart + 3);
  assert.equal(handle.snapshot().execution.turnQueue.paused, false);
  await until(() => js("document.querySelector('#nchatList').textContent.includes('后续排队消息已正常完成')"), 'queued answer visible');
  assert.equal(await js("Boolean(document.querySelector('[data-queue-action=resume]'))"), false);
  report.cases.push('Protocol/narration recovery keeps the original UI submission open; queued follow-up starts afterwards without a stuck Resume queue banner.');
  fixture.reply(() => ({ respond: response => { response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Local fixture temporarily unavailable' } })); } }));
  await send('检查临时故障后能否继续。');
  await until(() => results.length === 8, 'provider failure');
  await until(() => js("Boolean(document.querySelector('[data-queue-action=retry-model]'))"), 'explicit restore action');
  const failedRequests = fixture.requests.length;
  fixture.reply(() => ({ text: '连接恢复后的答复完成。' }));
  await click('[data-queue-action=retry-model]');
  await until(() => js("document.querySelector('#nchatList').textContent.includes('连接恢复后的答复完成')"), 'restored answer');
  await until(() => !handle.snapshot().execution.running, 'recovery settled');
  assert.equal(fixture.requests.length, failedRequests + 1);
  assert.equal(handle.snapshot().execution.turnQueue.paused, false);
  report.cases.push('HTTP 503 is visible with the actual Restore turn action; clicking it resumes the same history exactly once and releases the queue.');
  const queuedStart = fixture.requests.length, queueResultsStart = results.length;
  let releaseQueued; const queuedGate = new Promise(resolve => { releaseQueued = resolve; });
  fixture.reply(async (_body, count) => {
    if (count === queuedStart + 1) await queuedGate;
    return { text: count <= queuedStart + 2 ? '现在立即执行补检索，一次到位。' : '已明确继续并完成排队消息。' };
  });
  await send('继续完善报告，请实际检索。');
  await until(() => fixture.requests.length === queuedStart + 1, 'gated incomplete turn');
  await send('解释一下现有结果。');
  await until(() => handle.snapshot().execution.queue.length === 1, 'follow-up queued before failure');
  releaseQueued(); await until(() => results.length === queueResultsStart + 1, 'incomplete turn settled with queued work');
  assert.equal(results.at(-1).failureKind, 'output-incomplete');
  assert.equal(fixture.requests.length, queuedStart + 2, 'the failed turn has one bounded continuation; queued work has not run');
  assert.equal(handle.snapshot().execution.turnQueue.paused, true);
  assert.equal(handle.snapshot().execution.queue.length, 1);
  await until(() => js("Boolean(document.querySelector('[data-queue-action=resume]'))"), 'explicit resume available for queued work');
  await click('[data-queue-action=resume]');
  await until(() => results.length === queueResultsStart + 2, 'explicitly resumed queue completion');
  assert.equal(results.at(-1).ok, true);
  assert.equal(fixture.requests.length, queuedStart + 3, 'one click executes the waiting message exactly once');
  assert.equal(handle.snapshot().execution.queue.length, 0);
  assert.equal(handle.snapshot().execution.turnQueue.paused, false);
  await until(() => js("document.querySelector('#nchatList').textContent.includes('已明确继续并完成排队消息。')"), 'resumed queued answer visible');
  report.cases.push('Already queued work remains paused after bounded incomplete recovery; the actual Continue queue button runs it once and clears the pause.');
  // A historical tool call is not evidence that its extension is still active.
  // Reopen that same archive under standard policy and use a real allowed read
  // instead of silently relying on its former web_search extension.
  const extensionLoads = fs.readFileSync(fixture.loaded, 'utf8');
  off(); handle.close();
  handle = await fixture.open({ accessPolicy: require('../main/access-control/policy').create('standard', fixture.cwd) });
  off = handle.on(event => publish(null, handle, event, handle.uiSnapshot()));
  await js(`NativeChat.reset();NativeChat.enter('',${JSON.stringify(handle.sessionId)},{adapterId:'pi'});`);
  await until(() => js("document.querySelector('#nchatList')?.textContent.includes('Previous report is preserved.')"), 'standard history visible');
  await until(() => js('NativeChat.sessionInfo().ref===' + JSON.stringify(handle.ref)), 'standard session identity ready');
  const proof = 'History continued through an available read tool.';
  fs.writeFileSync(path.join(fixture.cwd, 'resume-proof.txt'), proof);
  const restrictedStart = fixture.requests.length, completedStart = results.length;
  fixture.reply(body => {
    const system = body.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
    assert.ok(system.includes('web_search') && system.includes('read'), 'current and missing tool facts reach the actual request');
    assert.ok(!body.tools.some(tool => tool.function.name === 'web_search'), 'standard does not load configured extensions');
    assert.ok(!body.messages.some(message => message.tool_calls?.some(call => call.function.name === 'web_search')),
      'retired historical calls are data, not native calls to an unavailable tool');
    const nativeCallIds = new Set(body.messages.flatMap(message => (message.tool_calls || []).map(call => call.id)));
    assert.ok(body.messages.filter(message => message.role === 'tool').every(message => nativeCallIds.has(message.tool_call_id)),
      'remaining native tool results retain their matching calls');
    if (body.messages.at(-1).role === 'tool') {
      assert.ok(JSON.stringify(body.messages.at(-1)).includes(proof), 'actual read result reaches the model');
      return { text: '历史会话已通过当前可用工具继续完成。' };
    }
    return { tool: 'read', args: { path: 'resume-proof.txt' } };
  });
  await send('继续验证，读取当前目录的 resume-proof.txt 后回复实际结果。');
  await until(() => results.length === completedStart + 1, 'restricted history completion');
  assert.equal(results.at(-1).ok, true, results.at(-1).reason);
  assert.equal(fixture.requests.length, restrictedStart + 2, 'one real read and its final answer, no blind recovery');
  assert.equal(fs.readFileSync(fixture.loaded, 'utf8'), extensionLoads, 'uncontrolled extensions remain unloaded');
  assert.equal(handle.snapshot().accessPolicy.mode, 'standard');
  await until(() => js("document.querySelector('#nchatList').textContent.includes('历史会话已通过当前可用工具继续完成')"), 'restricted result visible');
  fs.writeFileSync(path.join(out, 'resumed-standard-tool-context.png'), (await win.webContents.capturePage()).toPNG());
  report.cases.push('The same history reopened in standard mode advertises current/missing tool facts, executes an allowed file read once and shows its final answer without loading uncontrolled extensions.');
  assert.ok(fs.readFileSync(fixture.resumePath, 'utf8').startsWith(fixture.archivePrefix));
  const image = path.join(fixture.cwd, 'reference.png');
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxqkAAAAASUVORK5CYII=', 'base64'));
  const imageStart = results.length, requestsBeforeImage = fixture.requests.length;
  await js(`NativeChat.send('根据截图重新生成封面',{attachments:[{path:${JSON.stringify(image)},name:'reference.png',mimeType:'image/png'}]});void 0;`);
  await until(() => results.length === imageStart + 1, 'image input preflight failure');
  assert.equal(results.at(-1).ok, false);
  assert.match(results.at(-1).reason, /未启用原生图片输入/);
  assert.equal(fixture.requests.length, requestsBeforeImage, 'unsupported image never reaches the model');
  await delay(100);
  const failedImage = handle.snapshot();
  assert.equal(failedImage.execution.queue.length, 0);
  assert.equal(failedImage.status, 'unreachable', 'later queue snapshots must retain the failed request, not revive the previous completed status');
  assert.match(failedImage.statusText, /未启用原生图片输入/);
  assert.equal(failedImage.execution.running, false);
  // Repeat the queue publication which used to overwrite the UI-only error.
  publish(null, handle, {kind:'queue-changed'});
  await until(() => js("document.querySelector('.nbad.show')?.textContent.includes('未启用原生图片输入')"), 'failure survives queue refresh');
  assert.equal(await js("!!document.querySelector('[data-queue-action=resume]')"), false, 'an empty queue has nothing to resume');
  assert.equal(await js("!!document.querySelector('[data-chat-node=runtime-status].show')"), false, 'paused work is not active thinking');
  fs.writeFileSync(path.join(out, 'image-preflight-no-phantom-queue.png'), (await win.webContents.capturePage()).toPNG());
  assert.equal(fs.existsSync(image), true);
  assert.ok(failedImage.messages.some(row => JSON.stringify(row).includes('历史会话已通过当前可用工具继续完成')));
  fixture.reply(() => ({text:'新的文字请求已经完成。'}));
  await send('只解释当前结果。');
  await until(() => results.length === imageStart + 2, 'fresh text after unsupported image');
  assert.equal(results.at(-1).ok, true);
  assert.equal(handle.snapshot().status, 'idle');
  assert.equal(handle.snapshot().execution.turnQueue.paused, false);
  assert.equal(fixture.requests.length, requestsBeforeImage + 1);
  report.cases.push('Completed reply plus a later unsupported image: zero model requests, stable failure after queue refresh, no empty Resume queue or thinking indicator, retained original image/history; a fresh text send clears only the automatic pause and runs once.');
  // An older successful screenshot must not lock every later text-only turn,
  // even while the current app connection itself is unavailable.
  off(); await fixture.close();
  fixture = await require('./fixtures/resumed-pi.cjs').create(path.join(root,'text-followup'), {historyImage:true});
  const localApp = require('../main/personal-plugins').create({isPackaged:false,getPath:()=>root}, {
    template:'connector',name:'Disconnected application',version:'0.1.0',description:'Fixture',
    instructions:'Respond to the current request. App operations require the application connection.',mcpServers:'app-business',
  }).plugin;
  let optionalConnections = 0;
  handle = await fixture.open({
    resolvePlugins: async (pluginIds,projectId,turnContext) => {
      const result=await require('../main/pi-session/plugin-grant').resolve({
      app:{isPackaged:false,getPath:()=>root},pluginIds,projectId,ref:'text-followup',cwd:fixture.cwd,
      appContext:{pluginId:localApp.pluginId,requiresMcp:true,pageUrl:'https://application.example/home'},
      allowUnavailableApp:turnContext?.allowUnavailableApp === true,
      identityOf:async()=>{throw Error('No fallback Hub grant allowed');},
      });
      (report.followupResolutions ||= []).push({pluginIds,turnContext,
        unavailable:result.applicationUnavailable,hasGuide:result.applicationGuide?.includes('本轮仅作文字沟通')});
      return result;
    },
    resolveConnectors:async()=>{optionalConnections++;throw Error('Do not seek another connector');},
  });
  off = handle.on(event => publish(null,handle,event,handle.uiSnapshot()));
  await js(`NativeChat.reset();NativeChat.enter('',${JSON.stringify(handle.sessionId)},{adapterId:'pi'});`);
  await until(() => js('NativeChat.sessionInfo().ref===' + JSON.stringify(handle.ref)), 'text follow-up identity');
  const followupStart=results.length;
  fixture.reply(body=>{
    report.followupRequest = { messages:body.messages.map(row=>({role:row.role,
      kinds:Array.isArray(row.content)?row.content.map(block=>block.type):['text'],
      hasPixels:/data:image|iVBORw0KGgo/.test(JSON.stringify(row))})),
      hasHistoryNotice:JSON.stringify(body).includes('历史图片不可见'),
      hasUnavailableNotice:JSON.stringify(body).includes('本轮仅作文字沟通') };
    const latest=JSON.stringify(body.messages.findLast(row=>row.role==='user'));
    assert.match(latest,/那就先不看截图/);
    assert.match(latest,/历史图片不可见/);
    assert.match(latest,/本轮仅作文字沟通/);
    assert.doesNotMatch(JSON.stringify(body),/data:image|iVBORw0KGgo|Bearer |appLease/);
    return {text:'可以，先不看截图，我按你补充的文字继续沟通。应用操作待连接恢复后再执行。'};
  });
  await js(`NativeChat.send('那就先不看截图',{plugins:[{pluginId:${JSON.stringify(localApp.pluginId)},name:'Disconnected application'}]});void 0;`);
  await until(()=>results.length===followupStart+1,'text correction with historical image and disconnected app');
  await until(()=>js("document.querySelector('#nchatList').textContent.includes('我按你补充的文字继续沟通')"),'text correction visible');
  await until(()=>!handle.snapshot().execution.turnQueue.activeQueueId,'text correction settled');
  assert.equal(results.at(-1).ok,true,results.at(-1).reason);
  assert.equal(fixture.requests.length,1);
  assert.equal(optionalConnections,0);
  assert.equal(handle.snapshot().execution.turnQueue.paused,false);
  assert.equal(await js("!!document.querySelector('[data-queue-action=resume]')"),false);
  assert.match(fs.readFileSync(fixture.resumePath,'utf8'),/iVBORw0KGgo/,'original image remains in archive');
  fs.writeFileSync(path.join(out,'text-followup-disconnected-application.png'),(await win.webContents.capturePage()).toPNG());
  const taskBlocked=await handle.submit('执行依赖应用连接的任务',[],{taskId:'fixture-app-task',pluginIds:[localApp.pluginId]}).completion;
  assert.equal(taskBlocked.ok,false);
  assert.match(taskBlocked.reason,/刷新云端页面并登录/);
  await until(()=>!handle.snapshot().execution.turnQueue.activeQueueId,'blocked app task settled');
  const goalBlocked=await handle.submit('执行应用目标',[],{goalMode:true,pluginIds:[localApp.pluginId]}).completion;
  assert.equal(goalBlocked.ok,false);
  assert.equal(fixture.requests.length,1,'task/goal execution still requires the actual application connection');
  report.cases.push('Historical screenshot + unavailable app MCP: actual text correction reaches the model once with explicit image/connection limitations, without image pixels or fallback connector credentials; original archive retained and the queue stays open.');
  assert.deepEqual(await js('window.errors'), []); assert.deepEqual(runtimeErrors, []);
  report.ok = true; report.modelRequests = fixture.requests.length;
}).catch(async error => {
  report.error = error.stack || String(error);
  report.runtime = handle?.snapshot();
  if (win && !win.isDestroyed()) report.composer = await js('({input:document.querySelector("#nchatInput")?.value,disabled:document.querySelector("#nchatSend")?.disabled,session:NativeChat.sessionInfo()})').catch(() => null);
  if (win && !win.isDestroyed()) report.ui = await js('({text:document.body.innerText,errors:window.errors})').catch(() => null);
}).finally(async () => {
  ready = false; off?.(); await fixture?.close(); win?.destroy();
  fs.writeFileSync(path.join(out, 'resume-e2e-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, error: report.error, report: path.join(out, 'resume-e2e-report.json') }));
  app.exit(report.ok ? 0 : 1);
});
