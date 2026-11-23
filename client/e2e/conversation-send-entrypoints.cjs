'use strict';

// Exercise entrypoints through production NativeChat and trusted Chromium input, with synthetic IPC receipts.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)],
    { env, stdio: 'inherit', timeout: 180000 });
  process.exit(child.status ?? 1);
}
const { app, BrowserWindow } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
const client = path.resolve(__dirname, '..'), output = process.argv[2];
assert.ok(output && path.isAbsolute(output), 'Absolute evidence directory required');
const read = file => fs.readFileSync(path.join(client, file), 'utf8');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-send-entrypoints-'));
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile')); app.disableHardwareAcceleration();
const report = { ok: false, platform: process.platform, electron: process.versions.electron, chromium: process.versions.chrome, checks: [], errors: [], network: [], cleanup: { ok: false },
  boundary: 'Real Electron Chromium, production NativeChat entry/openTask, archive restoration, composer bindings, controls, task controller, attachments, Skill/plugin pickers, send controller and queue renderer. Real mouse/keyboard and CDP file-input events. Hub, native IPC, archive snapshots, permissions and acknowledgements are synthetic. Shell, goal rail, work-form controllers and collaboration rendering use existing unit-fixture doubles. No native inference, actual provider, OS permission dialog, remote dispatch, task approval persistence or production account.' };
let win;
const js = code => win.webContents.executeJavaScript(code, true);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = () => js(`({input:document.querySelector('#nchatInput')?.value,disabled:document.querySelector('#nchatSend')?.disabled,
 title:document.querySelector('#nchatSend')?.title,ref:fixtureContext?._ref,sendState:fixtureContext?._sendState,
 stopState:fixtureContext?._stopState,snapshot:fixtureContext?._snap,session:fixtureContext?._sessionOptions,selection:fixtureContext?._snap?.modelSelection,
 calls,errors,toasts,notice:document.querySelector('.nbad.show')?.textContent})`);
async function until(code, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await js(code)) return; await delay(25); }
  throw Error('Timed out: ' + code + '\nState: ' + JSON.stringify(await state()));
}
async function click(selector) {
  const previous = await js('clicks.length');
  const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');
    e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect(),p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
    if(e.disabled||!e.contains(document.elementFromPoint(p.x,p.y)))throw Error('Control unavailable: '+${JSON.stringify(selector)});return p})()`);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  await until('clicks.length>'+previous);
}
async function type(text) { await click('#nchatInput'); await until("document.activeElement?.id==='nchatInput'"); await win.webContents.insertText(text); await until("document.querySelector('#nchatInput').value.includes("+JSON.stringify(text)+")"); }
const enter = () => { for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Return' }); };
const mark = value => { report.checks.push(value); console.log('PASS ' + value); };
async function setup(kind = 'hub', options = {}) {
  await js(`NativeChat.reset();calls=[];toasts=[];modelCalls=0;catalogMode='ok';catalogWaiters=[];
    window.releaseSend=null;window.releaseAccess=null;window.releaseRuntime=null;window.releaseCancel=null;
    window.holdNextSend=false;window.holdAccess=false;window.holdRuntime=false;window.holdCancel=false;
    window.runtimeId=${JSON.stringify(['codex'].includes(kind) ? kind : 'pi')};
    model=${JSON.stringify(kind === 'local' ? { id: 'local:model-' + 'c'.repeat(32), label: 'Private fixture', localOnly: true }
      : { id: ['codex'].includes(kind) ? kind + '-account' : 'hub-fixture', label: kind + ' fixture' })};
    window.currentAccess='standard';window.activeTask=false;window.queueReply=false;
    task={id:'task-fixture',title:'Synthetic task',status:'doing',canViewExecution:true,acceptanceCriteria:['Review the saved artifact'],
      workRouting:{conversationTurn:{conversationId:'matrix-chat',state:'completed',executor:'native'}}};
    void 0;`);
  if (options.task) {
    await js(`activeTask=true;task.status=${JSON.stringify(options.rework ? 'todo' : 'reviewing')};
      ${options.rework ? "task.workRouting.reworkPending={feedback:'Correct the missing section'};" : ''}
      void 0;`);
    const launch = { task: null, chatId: options.rework ? '' : 'matrix-chat', source: options.acceptance ? 'acceptance' : 'requirement',
      ...(options.acceptance ? { acceptanceExecutionSession: true, acceptanceMode: options.acceptance, approvalId: 'review-fixture' } : {}),
      ...(options.rework ? { forceNew: true, reworkSession: true } : {}) };
    assert.equal(await js(`NativeChat.openTask(task.id,task.title,{...${JSON.stringify(launch)},task})`), true);
  } else assert.equal(await js(`NativeChat.enter('',${JSON.stringify(options.resumed ? 'matrix-chat' : '')},
    {adapterId:runtimeId,modelName:model.id,accessMode:'standard',...${JSON.stringify(options.goal ? { intent: 'goal', goal: 'Complete the synthetic goal', acceptance: 'Keep the saved evidence' } : {})}})`), true);
  await until(`fixtureContext._ref&&fixtureContext._sendState==='idle'`);
}
async function send(text, { keyboard = false, expected = 1 } = {}) {
  if (text) await type(text);
  if (keyboard) enter(); else await click('#nchatSend');
  await until(`calls.filter(row=>row.kind==='send').length===${expected}&&fixtureContext._sendState==='idle'`);
  assert.equal((await state()).input, '');
  return js(`calls.filter(row=>row.kind==='send').at(-1)`);
}
app.whenReady().then(async () => {
  try {
    const css = [...read('desk.html').matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(match => match[1]);
    const html = path.join(temporary, 'fixture.html');
    fs.writeFileSync(html, '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' + css.map(file =>
      '<link rel="stylesheet" href="' + pathToFileURL(path.join(client, file)).href + '">').join('') +
      '<style>body{margin:0;padding:20px;background:#fafafa}#composePanel{height:900px;display:block}#cpChat{display:block;height:100%}.nchat{height:100%}</style>' +
      '</head><body><main id="composePanel"><div id="cpChat"></div></main></body></html>');
    win = new BrowserWindow({ show: false, width: 1360, height: 1020,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => { report.network.push(request.url); done({ cancel: true }); });
    await win.loadFile(html); win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await require('./lib/conversation-send-harness.cjs').install(win, read,
      ['compose-candidate-navigation', 'panels-compose-skills', 'chat-plugin-mention-model', 'chat-plugin-mention', 'chat-send-queue']);
    await js(`window.runtimeId='pi';window.currentAccess='standard';window.activeTask=false;
      window.ac={supported:true,schema:'soduwork.access-policy/v1',modes:['standard','readonly','full'],canChangeDuringSession:true};
      window.runtimeRows=['pi','qwen','codex'].map(id=>({id,displayName:id,modelMode:['codex'].includes(id)?'account':'managed',accessControl:ac}));
      idle=()=>({status:'idle',messages:[{role:'assistant',text:'Synthetic archive content',done:true}],tools:[],adapterId:runtimeId,
        execution:{running:false,taskExecutions:[]},modelSelection:{name:model.id,model},accessPolicy:{mode:currentAccess,revision:1},accessControl:ac});
      low.open=async options=>{calls.push({kind:'open',options});return {ok:true,ref:'matrix-ref',sessionId:'matrix-chat',adapterId:runtimeId,model,
        workdir:{dir:'',name:'Synthetic workspace'},snapshot:idle(),taskIds:activeTask?[task.id]:[],
        ...(options.intent==='goal'?{goal:{intent:'goal',goal:options.goal,acceptance:options.acceptance}}:{})};};
      low.send=async(ref,text,attachments,options)=>{calls.push({kind:'send',ref,text,attachments:attachments.map(file=>({...file,data:file.data?Array.from(file.data):undefined})),options});
        if(holdNextSend){holdNextSend=false;await new Promise(resolve=>releaseSend=resolve);}
        return queueReply?{ok:true,queued:true,queueId:'queue-fixture',snapshot:{...idle(),status:'streaming',execution:{running:true,
          queue:[{id:'queue-fixture',text,submissionId:options.submissionId,taskId:options.taskId||''}]}}}:{ok:true,snapshot:idle()};};
      low.runtimes=async()=>({ok:true,runtimes:runtimeRows,availableRuntimes:runtimeRows});low.conversationRuntimes=low.runtimes;
      low.runtimeModels=async id=>{calls.push({kind:'accountCatalog',id});return {ok:true,models:[{id:id+'-account',label:id+' account'}]};};
      low.capabilities=async()=>({ok:true,policyOk:true,skills:[{name:'review-skill',description:'Review synthetic material',selectable:true}]});
      low.setAccessMode=async(ref,mode)=>{calls.push({kind:'access',ref,mode});if(holdAccess)await new Promise(resolve=>releaseAccess=resolve);
        currentAccess=mode;return {ok:true,snapshot:idle()};};
      low.selectAgent=async(ref,id)=>{calls.push({kind:'runtime',ref,id});if(holdRuntime)await new Promise(resolve=>releaseRuntime=resolve);
        runtimeId=id;return {ok:true,adapterId:id,displayName:id,snapshot:idle()};};
      low.cancel=async ref=>{calls.push({kind:'cancel',ref});if(holdCancel)await new Promise(resolve=>releaseCancel=resolve);
        return {ok:true,stopped:true,snapshot:idle()};};
      low.cancelQueued=async(ref,id)=>{calls.push({kind:'cancelQueued',ref,id});return {ok:true,snapshot:idle()};};
      SoduWorkAPI.pluginCatalog=async()=>({items:[{pluginId:'fixture-plugin',key:'fixture-plugin',name:'Fixture plugin',personal:true,enabled:true,
        inputs:[{key:'format',type:'text',label:'Format',default:'fixture-format'}]}]});void 0;`);

    for (const kind of ['hub', 'local', 'codex']) for (const resumed of [false, true]) {
      await setup(kind, { resumed });
      const selected = await js('model.id'), sent = await send((resumed ? 'Resume ' : 'New ') + kind + ' conversation', { keyboard: resumed });
      assert.equal(sent.text, (resumed ? 'Resume ' : 'New ') + kind + ' conversation');
      assert.equal(sent.options.taskId, ''); assert.equal(sent.options.taskExecution, undefined);
      assert.equal(await js('fixtureContext._snap.modelSelection.name'), selected);
      assert.equal(Boolean(await js('calls.find(row=>row.kind==="open").options.chatId')), resumed);
      assert.equal(await js('modelCalls>0'), !['codex'].includes(kind));
      mark((resumed ? 'Resumed' : 'New') + ' ' + kind + ' conversation sends once through real ' + (resumed ? 'Enter' : 'mouse') + ' input');
    }
    for (const resumed of [false, true]) {
      await setup('local', { resumed, goal: true });
      const sent = await send('Continue goal with retained evidence');
      assert.equal(await js('calls.find(row=>row.kind==="open").options.intent'), 'goal');
      assert.equal(sent.options.taskExecution, undefined);
      mark((resumed ? 'Resumed' : 'New') + ' goal conversation retains its goal context and sends a normal follow-up');
    }
    for (const kind of ['hub', 'local']) {
      await setup(kind, { task: true });
      const followup = await send('Clarify the current requirement');
      assert.equal(followup.options.taskId, 'task-fixture'); assert.equal(followup.options.taskExecution.reuseConversation, true);
      assert.equal(followup.options.taskExecution.followUp, true); assert.equal(followup.options.taskExecution.acceptanceOnly, undefined);
      mark(kind + ' requirement follow-up retains task ownership without becoming acceptance');
      for (const acceptance of ['manual', 'auto']) {
        await setup(kind, { task: true, acceptance });
        await until(`document.querySelector('#nchatInput').value.startsWith(${JSON.stringify(acceptance === 'auto' ? '【自动验收】' : '【验收分析】')})`);
        const sent = await send('');
        assert.equal(sent.options.taskExecution.acceptanceOnly, true); assert.equal(sent.options.taskExecution.acceptanceMode, acceptance);
        assert.equal(sent.options.taskExecution.approvalId, 'review-fixture');
        mark(kind + ' ' + acceptance + ' acceptance prefills and sends exactly once with pinned review metadata');
      }
      await setup(kind, { task: true, rework: true });
      await until(`document.querySelector('#nchatInput').value.includes('Correct the missing section')`);
      const rework = await send('');
      assert.equal(rework.options.taskExecution.reworkSession, true); assert.equal(rework.options.taskExecution.followUp, false);
      assert.equal(rework.options.taskExecution.acceptanceOnly, undefined);
      const later = await send('Explain the rework result', { expected: 2 });
      assert.equal(later.options.taskExecution.reworkSession, undefined); assert.equal(later.options.taskExecution.followUp, true);
      mark(kind + ' rework preserves feedback on the first send and clears the one-time rework flag for later messages');
    }

    await setup('local');
    const attachment = path.join(temporary, 'evidence.txt'); fs.writeFileSync(attachment, 'Synthetic attachment evidence');
    const document = await win.webContents.debugger.sendCommand('DOM.getDocument');
    const input = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#nchatFile' });
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [attachment] });
    await until(`document.querySelector('[data-catt-name="evidence.txt"]')`);
    const attached = await send('Review the attached evidence');
    assert.equal(attached.attachments.length, 1); assert.equal(attached.attachments[0].name, 'evidence.txt');
    assert.equal(Buffer.from(attached.attachments[0].data).toString(), 'Synthetic attachment evidence');
    assert.equal(await js('fixtureContext._messageAttachments.files().length'), 0);
    mark('A real file-input change passes attachment bytes through the production attachment controller with ordinary text');

    await setup('hub'); await type('#review');
    await until(`document.querySelector('[data-skill-name="review-skill"]')`); await click('[data-skill-name="review-skill"]');
    const skilled = await send('Apply the selected skill');
    assert.deepEqual(skilled.options.skills, ['review-skill']); assert.equal(await js('fixtureContext._skillPicker.selected().length'), 0);
    mark('A real Skill picker selection reaches the send payload and is consumed after the turn');

    await setup('local'); await type('/Fixture');
    await until(`document.querySelector('.nplugin-menu .nplugin-option:not(.is-action)')`); await click('.nplugin-menu .nplugin-option:not(.is-action)');
    await until(`document.querySelector('.nplugin-chip')`);
    const plugin = await send('Apply the selected plugin');
    assert.equal(plugin.options.plugins[0].pluginId, 'fixture-plugin'); assert.equal(plugin.options.plugins[0].inputValues.format, 'fixture-format');
    assert.equal(await js('fixtureContext._pluginMention.selected().length'), 0);
    mark('A real slash-plugin picker resolves structured inputs and passes them once through production send binding');

    await setup('hub'); await type('Wait for the permission acknowledgement');
    await js('holdAccess=true;void 0;'); await click('#nchatMode'); await click('[data-access-mode="readonly"]');
    await until('!!releaseAccess'); await click('#nchatInput'); await until("document.activeElement?.id==='nchatInput'"); enter();
    await until(`fixtureContext._sendState==='sending'`);
    assert.equal(await js('calls.filter(row=>row.kind==="send").length'), 0);
    assert.equal((await state()).input, 'Wait for the permission acknowledgement');
    await js('releaseAccess();holdAccess=false;void 0;'); await until(`calls.filter(row=>row.kind==='send').length===1&&fixtureContext._sendState==='idle'`);
    assert.equal(await js('fixtureContext._snap.accessPolicy.mode'), 'readonly');
    mark('Send waits for the real permission-control acknowledgement without dropping the draft');

    await setup('local'); await type('Wait for the runtime acknowledgement'); await js('holdRuntime=true;void 0;');
    await click('#nchatRuntime'); await until(`document.querySelector('[data-runtime="qwen"]')`); await click('[data-runtime="qwen"]');
    await until('!!releaseRuntime'); await click('#nchatInput'); await until("document.activeElement?.id==='nchatInput'"); enter();
    await until(`fixtureContext._sendState==='sending'`);
    assert.equal(await js('calls.filter(row=>row.kind==="send").length'), 0);
    await js('releaseRuntime();holdRuntime=false;void 0;'); await until(`calls.filter(row=>row.kind==='send').length===1&&fixtureContext._sendState==='idle'`);
    assert.equal(await js('fixtureContext._snap.adapterId'), 'qwen');
    mark('Send follows a confirmed same-conversation Agent switch and keeps the selected local model');

    await setup('hub'); await js(`fixtureContext._snap={...idle(),status:'streaming',execution:{running:true}};fixtureContext._render();holdCancel=true;void 0;`);
    await type('Keep this text while stopping'); await click('#nchatSend'); await until(`fixtureContext._stopState==='requested'&&!!releaseCancel`);
    await click('#nchatInput'); enter(); await delay(50);
    assert.equal(await js('calls.filter(row=>row.kind==="send").length'), 0); assert.equal(await js('calls.filter(row=>row.kind==="cancel").length'), 1);
    assert.equal((await state()).input, 'Keep this text while stopping');
    await js('releaseCancel();holdCancel=false;void 0;'); await until(`fixtureContext._stopState==='idle'&&!document.querySelector('#nchatSend').disabled`);
    await send('');
    mark('The stop action waits for its receipt, blocks Enter during requested stop and restores Send without losing typed text');

    await setup('local'); await js(`fixtureContext._snap={...idle(),status:'streaming',execution:{running:true}};fixtureContext._render();queueReply=true;void 0;`);
    await send('Queue a local follow-up', { keyboard: true });
    await until(`document.querySelector('[data-queue-row="queue-fixture"]')`);
    assert.match(await js('document.querySelector("#nchatQueue").textContent'), /Queue a local follow-up/);
    mark('A confirmed queued IPC receipt is rendered by the production queue after a real busy-session Enter send');

    await setup('hub'); await type('Keep ordinary text after catalog rejection');
    await js("catalogMode='reject';void 0;"); await click('#nchatSend');
    await until(`document.querySelector('.nbad.show')?.textContent.includes('模型列表')&&fixtureContext._sendState==='idle'`);
    assert.equal(await js('calls.filter(row=>row.kind==="send").length'), 0);
    assert.equal((await state()).input, 'Keep ordinary text after catalog rejection');
    await js("catalogMode='ok';void 0;"); await send('');
    mark('A new ordinary Hub chat reports a rejected directory and preserves its draft for one explicit retry');

    await setup('local', { resumed: true }); await type('Keep resumed local text across directory refresh');
    await js("catalogMode='hang';void 0;"); await click('#nchatSend'); await until('catalogWaiters.length===1');
    assert.equal((await state()).input, 'Keep resumed local text across directory refresh');
    assert.equal(await js('calls.filter(row=>row.kind==="send").length'), 0);
    await js("catalogMode='ok';modelsChanged();void 0;");
    await until(`calls.filter(row=>row.kind==='send').length===1&&fixtureContext._sendState==='idle'`);
    await js('for(const resolve of catalogWaiters.splice(0))resolve({usable:[]});void 0;');
    await delay(50);
    assert.equal(await js('fixtureContext._snap.modelSelection.name'), 'local:model-' + 'c'.repeat(32));
    assert.equal(await js('calls.filter(row=>row.kind==="send").length'), 1);
    mark('A resumed ordinary local chat follows the latest directory and ignores the late obsolete empty result');

    for (const kind of ['hub', 'local']) {
      await setup(kind); await js(`window.completeCatalog=SoduWorkAPI.myModels;
        SoduWorkAPI.myModels=async()=>({...await completeCatalog(),
          usable:[{name:'local:model-'+ 'c'.repeat(32),label:'Private fixture',localOnly:true}],managedCatalogUnavailable:true});void 0;`);
      await type('Use only the proven available model');
      try {
        if (kind === 'hub') {
          await click('#nchatSend');
          await until(`document.querySelector('.nbad.show')?.textContent.includes('模型列表')&&fixtureContext._sendState==='idle'`);
          assert.equal(await js('calls.filter(row=>row.kind==="send").length'), 0);
          assert.equal((await state()).input, 'Use only the proven available model');
        } else await send('');
      } finally { await js('SoduWorkAPI.myModels=completeCatalog;void 0;'); }
      mark('A partial managed directory ' + (kind === 'local' ? 'allows the proven local selection' : 'blocks an unverified Hub selection without losing text'));
      if (kind === 'hub') await send('');
    }

    await setup('local');
    await js(`fixtureContext._snap={...idle(),status:'streaming',execution:{running:true}};fixtureContext._render();holdNextSend=true;void 0;`);
    await type('First ordinary queued message'); enter();
    await until(`calls.filter(row=>row.kind==='send').length===1&&!!releaseSend`);
    await type('Second ordinary queued message'); enter();
    await until(`document.querySelector('#nchatInput').value===''`);
    assert.equal(await js('calls.filter(row=>row.kind==="send").length'), 1);
    assert.equal(await js('document.querySelectorAll("[data-queue-row]").length'), 0);
    await js('releaseSend();releaseSend=null;void 0;');
    await until(`calls.filter(row=>row.kind==='send').length===2&&fixtureContext._sendState==='idle'`);
    assert.deepEqual(await js('calls.filter(row=>row.kind==="send").map(row=>row.text)'),
      ['First ordinary queued message', 'Second ordinary queued message']);
    mark('Two distinct ordinary drafts preserve order while the first IPC receipt is pending without inventing a confirmed queue row');

    assert.deepEqual(await js('errors'), []); assert.deepEqual(report.network, []);
    const enterEvents = await js('enterPresses'); assert.ok(enterEvents.length > 0);
    assert.ok(enterEvents.every(trusted => trusted === true), 'Keyboard submissions must originate from Chromium input events');
    report.trustedEnterEvents = enterEvents.length;
    const screenshot = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(output, 'final.png'), Buffer.from(screenshot.data, 'base64'));
    report.ok = true;
  } catch (error) {
    report.errors.push(error.stack || String(error));
    try { report.failureState = await state(); fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); }
    catch (failure) { report.errors.push(failure.stack || String(failure)); }
  } finally {
    try { win?.destroy(); fs.rmSync(temporary, { recursive: true, force: true }); report.cleanup.ok = true; }
    catch (error) { report.cleanup.error = error.stack || String(error); report.ok = false; }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, output, errors: report.errors }));
    app.exit(report.ok ? 0 : 1);
  }
});
