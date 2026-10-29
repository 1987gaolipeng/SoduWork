'use strict';
// NativeChat and the Runner adapter are production code. Runner replies and
// non-execution IPC inventory are isolated; no real model or account is used.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    {env, windowsHide:true, stdio:'inherit'});
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const {app, BrowserWindow, ipcMain} = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), {pathToFileURL} = require('node:url');
  const client = path.resolve(__dirname, '..');
  const out = path.resolve(process.argv[2] || path.join(client, '../outputs/new-chat-send-recovery'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-new-chat-send-'));
  const {createRunnerRuntimeAdapter, getRunnerSessionDetails, _uuidV5} = require('../main/agent-runtime/runner-adapter');
  const catalog = require('../main/agent-runtime/runtime-catalog');
  const localRunner = require('../main/runner-runtime');
  const handles = new Map(), sessions = [], calls = [], sendCalls = [], queueCalls = [];
  const support = {supported:true, schema:'soduwork.access-policy/v1', modes:['standard', 'readonly', 'full'],
    canChangeDuringSession:true, changeTakesEffect:'current-turn'};
  const report = {ok:false, cases:[], errors:[], screenshots:[],
    boundary:'Hidden isolated Electron; production preload, NativeChat renderer/composer mouse controls and main-process Runner adapter/turn queue. IPC routes delegate to real handle.submit/updateQueue and publish real snapshots. Model credentials, account/inventory and Runner RPC receipts are fixtures; the first offline error comes from the real unstarted Runner RPC. No installed profile, backend, model execution or physical-mouse evidence.'};
  let win, activeScenario, available = false;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = source => win.webContents.executeJavaScript(source, true);
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  async function until(check, label) {
    for (let n = 0; n < 240; n++) {
      if (await (typeof check === 'string' ? js(check) : check())) return;
      await delay(25);
    }
    throw Error('Timed out: ' + label);
  }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});
      if(!e||e.disabled||!e.checkVisibility())throw Error('Unavailable control: '+${JSON.stringify(selector)});
      e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
      if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded control: '+${JSON.stringify(selector)});return{x,y};})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type, ...point, button:'left', clickCount:1});
    await delay(40);
  }
  async function shot(name) {
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
    report.screenshots.push(file);
  }
  function css(file) {
    return fs.readFileSync(file, 'utf8').replace(/@import\s+url\(["']?([^"')]+)["']?\)\s*;/g,
      (_, relative) => css(path.resolve(path.dirname(file), relative)))
      .replace(/url\(["']?([^"')]+)["']?\)/g, (match, relative) =>
        /^(?:data:|https?:|file:)/.test(relative) ? match : 'url("' + pathToFileURL(path.resolve(path.dirname(file), relative)).href + '")');
  }
  function publish(handle, event, snapshot) {
    if (!win.isDestroyed()) win.webContents.send('pi-session-event', {ref:handle.ref, ...event, snapshot:snapshot || handle.snapshot()});
  }
  async function open(options) {
    assert.ok(!options.chatId, 'This fixture must create a new native session through the first send');
    assert.equal(options.adapterId, 'harness2');
    const scenario = activeScenario;
    assert.equal(scenario.opens++, 0, 'Only one native session may be opened per new conversation');
    const alias = 'first-send-' + scenario.name;
    const ref = _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', 'chat:' + alias + ':harness2');
    const cwd = path.join(root, scenario.name); fs.mkdirSync(cwd);
    const runtime = {async rpc(op, input, timeoutMs) {
      calls.push({scenario:scenario.name, op, ref:input.ref || '', dispatchId:input.dispatchId || ''});
      if (op === 'runtime.detect') return {ok:true, data:{installed:true, state:'ready', accessControl:support}};
      if (op === 'job.dispatch') {
        scenario.dispatchAttempts++;
        if (!available) {
          try { return await localRunner.rpc(op, input, timeoutMs); }
          catch (error) {
            scenario.offlineErrorCode = error.code;
            await scenario.failureGate;
            throw error;
          }
        }
        scenario.successfulDispatches++;
        scenario.sentAt = input.ctx.conversationSentAt;
        scenario.text = input.ctx.conversationUserText;
        if (scenario.name === 'unknown-ack') throw Error('Synthetic Runner dispatch ACK lost');
        return {ok:true, data:{ok:true, ref, state:'running'}};
      }
      if (op === 'job.session') {
        scenario.reads++;
        assert.equal(input.ref, ref, 'Recovery must query the original deterministic native reference');
        if (scenario.name === 'unknown-ack') await scenario.readGate;
        return {ok:true, data:{ok:true, ref, status:'done', items:[
          {seq:1, kind:'user', text:scenario.text, sentAt:scenario.sentAt},
          {seq:2, kind:'say', text:scenario.name === 'unknown-ack' ? '已核实原会话完成，没有重新发送。' : '你好，连接已恢复。'},
        ].filter(item => item.seq > Number(input.since || 0))}};
      }
      if (op === 'job.stop') return {ok:true, data:{ok:true}};
      if (op === 'job.comment') { scenario.comments++; throw Error('This fixture must not replay or continue a prior send'); }
      throw Error('Unexpected synthetic Runner operation: ' + op);
    }};
    const adapter = createRunnerRuntimeAdapter({runtimeSpec:catalog.runtime('harness2'), runnerRuntime:runtime,
      modelConfig:{fetchModel:async () => ({ok:true, model:{id:'fixture-model', key:'fixture-only', baseUrl:'http://fixture.invalid'}})}});
    const session = await adapter.createSession({identity:{}, native:{runner:{openOptions:{...options, ref:alias, cwd}}}});
    sessions.push(session);
    const handle = getRunnerSessionDetails(session).handle;
    scenario.handle = handle;
    handles.set(handle.ref, handle);
    handle.on((event, snapshot) => publish(handle, event, snapshot));
    return {ok:true, ref:handle.ref, sessionId:handle.sessionId, adapterId:handle.adapterId,
      displayName:handle.displayName, cwd:handle.cwd, accessControl:support,
      model:{id:'fixture-model', label:'Isolated fixture'}, snapshot:handle.snapshot()};
  }
  function scenario(name) {
    let releaseRead, releaseFailure;
    const value = {name, opens:0, dispatchAttempts:0, successfulDispatches:0, reads:0, comments:0,
      readGate:new Promise(resolve => { releaseRead = resolve; }), releaseRead:() => releaseRead(),
      failureGate:new Promise(resolve => { releaseFailure = resolve; }), releaseFailure:() => releaseFailure()};
    activeScenario = value; return value;
  }
  async function prepare() {
    await js(`NativeChat.reset();NativeChat.prepare({adapterId:'harness2',modelName:'fixture-model'});void 0;`);
    await until('Boolean(document.querySelector("#nchatInput"))', 'new composer');
    assert.equal(await js('NativeChat.hasSession()'), false, 'Preparing a new empty chat must not initialize an Agent');
    assert.equal(await js('document.querySelector("#nchatInput").value'), '');
  }
  app.disableHardwareAcceleration();
  app.setPath('userData', path.join(root, 'profile'));
  app.setPath('temp', path.join(root, 'temp'));
  app.whenReady().then(async () => {
    fs.mkdirSync(out, {recursive:true});
    fs.mkdirSync(path.join(root, 'temp'), {recursive:true});
    win = new BrowserWindow({show:false, width:1100, height:780, useContentSize:true, webPreferences:{
      preload:path.join(client, 'preload.js'), contextIsolation:true, nodeIntegration:false,
      backgroundThrottling:false, offscreen:true}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*', 'https://*/*']}, (_, done) => done({cancel:true}));
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    ipcMain.handle('pi-session-open', (_event, options) => open(options));
    ipcMain.handle('pi-session-snapshot', (_event, ref) => ({ok:true, snapshot:handles.get(ref).snapshot()}));
    ipcMain.handle('pi-session-send', (_event, ref, text, files, options) => {
      const handle = handles.get(ref); assert.ok(handle);
      sendCalls.push({ref, text, submissionId:options.submissionId});
      const submitted = handle.submit(text, files, options);
      if (!submitted.accepted) return submitted.result;
      Promise.resolve(submitted.completion).then(result => publish(handle, result?.ok
        ? {kind:'settled', submissionId:options.submissionId}
        : {kind:'error', reason:result?.reason, retrySafe:!!result?.retrySafe, failureKind:result?.failureKind,
          submissionId:options.submissionId}));
      return {ok:true, accepted:true, queued:submitted.queued, queueId:submitted.queueId, snapshot:handle.snapshot()};
    });
    ipcMain.handle('pi-session-queue-update', (_event, ref, id, action, value) => {
      queueCalls.push({ref, id, action}); return handles.get(ref).updateQueue(id, action, value);
    });
    for (const [channel, value] of Object.entries({
      'pi-session-history':{ok:true, chats:[]}, 'pi-session-release':{ok:true},
      'pi-session-outputs':{ok:true, items:[], artifacts:[]},
      'pi-session-runtimes':{ok:true, runtimes:[{id:'harness2', displayName:'Google Harness²', modelMode:'managed', accessControl:support}]},
      'access-preferences-get':{ok:true, mode:'standard', revision:0},
      'conversation-delivery-inspect':{ok:false, reason:'Not exercised by this isolated fixture'},
      'work-preview-show':{ok:true}, 'work-preview-hide':{ok:true}, 'work-preview-destroy':{ok:true}, 'work-preview-reset-embedded':{ok:true},
    })) ipcMain.handle(channel, () => value);
    const fixture = path.join(client, 'e2e/fixtures/workbench-annotations.html'), scripts = [];
    const html = fs.readFileSync(fixture, 'utf8').replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_, attrs, body) => {
      const src = attrs.match(/src=["']([^"']+)/);
      if (src?.[1].endsWith('chat-composer-controls.js')) scripts.push(read('components/panels/chat-runtime-picker.js'));
      scripts.push(src ? fs.readFileSync(path.resolve(path.dirname(fixture), src[1]), 'utf8') : body); return '';
    });
    const page = path.join(root, 'chat.html');
    fs.writeFileSync(page, html.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/gi, '')
      .replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="' + pathToFileURL(client + path.sep).href + '">'));
    await win.loadFile(page);
    for (const file of ['theme/variables.css', 'components/panels/work-composer.css', 'components/panels/panels-chat.css',
      'components/panels/chat-collaboration.css', 'components/panels/conversation-attachments.css', 'components/panels/agent-brand.css'])
      await win.webContents.insertCSS(css(path.join(client, file)));
    for (const file of ['agent-brand', 'compose-candidate-navigation', 'chat-plugin-mention-model', 'chat-plugin-mention'])
      await js(read('components/panels/' + file + '.js') + '\nvoid 0;');
    for (const script of scripts) await js(script + '\nvoid 0;');
    await js(`SoduWorkAPI.taskStorageKey=()=> 'isolated-first-send-recovery';void 0;`);

    const offline = scenario('offline-first');
    await prepare(); await click('#nchatInput'); await win.webContents.insertText('你好');
    assert.equal(offline.opens, 0);
    await click('#nchatSend');
    await until('Boolean(document.querySelector(".nmsg.user[data-chat-node=\\"message:0\\"]"))&&document.querySelector("#nchatInput").value===""', 'local echo before failure');
    offline.releaseFailure();
    await until('document.querySelector("#nchatInput").value==="你好"&&!NativeChat.isBusy()', 'offline first-send recovery');
    assert.equal(offline.offlineErrorCode, 'RUNNER_NOT_RUNNING');
    assert.equal(offline.dispatchAttempts, 1); assert.equal(offline.successfulDispatches, 0);
    assert.match(await js('document.querySelector(".nbad-copy").textContent'), /Runner is not running/);
    assert.equal(await js('Boolean(document.querySelector(".nqueue-paused"))'), false);
    await shot('01-offline-first-send-retained');
    available = true;
    await delay(150);
    assert.equal(offline.dispatchAttempts, 1, 'Runner availability alone cannot resubmit the draft');
    const priorRef = await js('NativeChat.sessionInfo().ref');
    await click('#nchatSend');
    await until('document.querySelector("#nchatList").textContent.includes("你好，连接已恢复。")&&!NativeChat.isBusy()', 'explicit same-view retry');
    assert.equal(await js('NativeChat.sessionInfo().ref'), priorRef);
    assert.equal(offline.opens, 1); assert.equal(offline.dispatchAttempts, 2); assert.equal(offline.successfulDispatches, 1);
    assert.equal(offline.comments, 0); assert.equal(sendCalls.length, 2);
    assert.notEqual(sendCalls[0].submissionId, sendCalls[1].submissionId);
    assert.equal(await js('document.querySelector("#nchatInput").value'), '');
    await shot('02-explicit-send-succeeded');
    report.cases.push('New empty chat opens its real Runner handle only on mouse send. The actual unstarted Runner rejects before write; input and failure remain visible without permanent busy. Making fixture Runner available does not auto-send; a second mouse send succeeds in the same view/ref with exactly one successful dispatch.');

    const unknown = scenario('unknown-ack');
    await prepare(); await click('#nchatInput'); await win.webContents.insertText('核实这一轮'); await click('#nchatSend');
    await until('Boolean(document.querySelector(".nqueue-paused [data-queue-action=resume]"))', 'unknown-ACK recovery control');
    await click('#nchatInput'); await win.webContents.insertText('核实时保留这条新草稿');
    assert.equal(unknown.dispatchAttempts, 1); assert.equal(unknown.successfulDispatches, 1);
    assert.equal(unknown.reads, 0, 'No automatic recovery poll should precede this explicit test action');
    await click('#nchatRuntime');
    assert.match(await js('notices.at(-1)'), /核实执行状态/);
    assert.doesNotMatch(await js('notices.at(-1)'), /等待本轮/);
    await shot('03-unknown-ack-verification');
    await click('.nqueue-paused [data-queue-action=resume]');
    await until(() => unknown.reads === 1, 'same-ref read');
    assert.equal(unknown.dispatchAttempts, 1); assert.equal(unknown.comments, 0);
    assert.equal(queueCalls.at(-1).action, 'resume');
    unknown.releaseRead();
    await until('document.querySelector("#nchatList").textContent.includes("已核实原会话完成")&&!NativeChat.isBusy()&&!document.querySelector(".nqueue-paused")', 'verified terminal original turn');
    assert.equal(unknown.dispatchAttempts, 1); assert.equal(unknown.successfulDispatches, 1); assert.equal(unknown.comments, 0);
    assert.equal(sendCalls.length, 3, 'Verification cannot submit the retained draft again');
    assert.equal(await js('document.querySelector("#nchatInput").value'), '核实时保留这条新草稿');
    await shot('04-original-turn-verified');
    report.cases.push('A lost dispatch ACK shows a visible verification action. Mouse Agent switching explains uncertainty; mouse verification queries only the original deterministic ref and reveals its terminal reply while preserving a newly typed unsent draft, without dispatch/comment replay or an automatic resend.');

    available = false;
    const newer = scenario('newer-draft'), beforeNewer = sendCalls.length;
    await prepare(); await click('#nchatInput'); await win.webContents.insertText('原始发送'); await click('#nchatSend');
    await until('Boolean(document.querySelector(".nmsg.user[data-chat-node=\\"message:0\\"]"))&&document.querySelector("#nchatInput").value===""', 'newer-draft local echo');
    await click('#nchatInput'); await win.webContents.insertText('保留我刚输入的新内容');
    newer.releaseFailure();
    await until('document.querySelector(".nbad-copy")?.textContent.includes("Runner is not running")&&!NativeChat.isBusy()', 'definite failure with newer input');
    assert.equal(await js('document.querySelector("#nchatInput").value'), '保留我刚输入的新内容');
    assert.equal(newer.offlineErrorCode, 'RUNNER_NOT_RUNNING');
    assert.equal(newer.dispatchAttempts, 1); assert.equal(newer.successfulDispatches, 0);
    assert.equal(sendCalls.length, beforeNewer + 1);
    await shot('05-newer-draft-preserved');
    report.cases.push('When a definite pre-write failure arrives after the local echo and after the user types a new draft, the original failed submission cannot overwrite or auto-send that newer input.');
    assert.deepEqual(await js('errors'), []);
    assert.deepEqual(report.errors, []);
    report.rpcCalls = calls;
    report.submissions = sendCalls;
    report.queueCalls = queueCalls;
    report.ok = true;
  }).catch(async error => {
    report.error = String(error.stack || error);
    report.rpcCalls = calls; report.submissions = sendCalls; report.queueCalls = queueCalls;
    if (win && !win.isDestroyed()) {
      try { report.ui = await js('({errors,notices,busy:NativeChat?.isBusy(),info:NativeChat?.sessionInfo(),input:document.querySelector("#nchatInput")?.value,text:document.body.innerText})'); await shot('failure'); } catch (_) {}
    }
  }).finally(async () => {
    for (const session of sessions) { try { await session.dispose(); } catch (_) {} }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
