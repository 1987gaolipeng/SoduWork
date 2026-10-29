'use strict';
// Exercise production picker controls in isolated Electron without business APIs.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const run = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: 'inherit', timeout: 90000,
  });
  if (run.error) console.error(run.error.message);
  process.exit(run.status ?? 1);
}
const {app, BrowserWindow} = electron;
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const output = path.resolve(process.argv[2] || path.join(__dirname, '../../outputs/assignee-execution/picker'));
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = {ok: false, boundary: 'Hidden Electron with production renderer and isolated API fixtures', checks: [], layouts: []};
let win;
app.whenReady().then(async () => {
  const watchdog = setTimeout(() => finish(1, Error('Picker claim test timed out')), 60000);
  function finish(code, error) {
    clearTimeout(watchdog);
    if (error) report.error = error.stack || String(error);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    win?.destroy(); app.exit(code);
  }
  try {
    win = new BrowserWindow({width: 1280, height: 900, show: false,
      webPreferences: {offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false}});
    win.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_request, done) => done({cancel: true}));
    const js = source => win.webContents.executeJavaScript(source, true);
    const click = async selector => {
      const point = await js(`(async()=>{const n=document.querySelector(${JSON.stringify(selector)});
        if(!n||n.disabled||!n.getClientRects().length)throw Error('Unavailable: '+${JSON.stringify(selector)});
        n.scrollIntoView({block:'nearest',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const b=n.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);
        if(!n.contains(document.elementFromPoint(x,y)))throw Error('Occluded: '+${JSON.stringify(selector)});return{x,y}})()`);
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type, ...point,
        ...(type === 'mouseMove' ? {} : {button: 'left', clickCount: 1})});
      await wait(120);
    };
    await win.loadFile(path.join(__dirname, '../tests/task-picker.html'));
    await js(`window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      window.claimEvents=[];window.claimDenied=false;
      window.configureAssigned=()=>{resetFixture();claimEvents.length=0;claimDenied=false;
        tasks=[{id:'assigned',title:'同事指派的需求规格说明书',note:'保留原需求、完成标准和协作关系',status:'todo',triageStage:'ready',
          readOnly:true,canViewExecution:true,canClaimExecution:true,myRoles:['assignee'],ownerClientId:'sender',assigneeName:'当前负责人'},
          {id:'observer',title:'仅可查看',status:'todo',readOnly:true,canViewExecution:true,canClaimExecution:false},
          {id:'active',title:'已开始执行',status:'doing',readOnly:true,canViewExecution:true,canClaimExecution:true}];};
      SoduWorkAPI.prepareRequirementExecution=async id=>{claimEvents.push('claim:'+id);if(claimDenied)throw Error('负责人已变化，请刷新后重试');
        const t=tasks.find(t=>t.id===id);Object.assign(t,{readOnly:false,canClaimExecution:false,ownerClientId:'receiver'});return structuredClone(t)};
      const originalApi=ctx._api;ctx._api=()=>({...originalApi(),bindTask:async(ref,id)=>{claimEvents.push('bind:'+id);bindings.push({ref,id});return{ok:true}}});
      const originalSend=ctx._send;ctx._send=async(text,options)=>{claimEvents.push('send:'+options.taskId);return originalSend(text,options)};
      configureAssigned();`);
    await click('#add');
    assert.deepEqual(await js(`Array.from(document.querySelectorAll('[data-collab-task-select]')).map(n=>n.dataset.collabTaskSelect)`), ['assigned']);
    assert.deepEqual(await js('claimEvents'), []);
    report.checks.push('assigned ready task is visible; observer and executing tasks remain excluded; opening is read-only');
    await click('[data-collab-task-select="assigned"]');
    assert.deepEqual(await js('claimEvents'), []);
    for (const width of [1280, 420]) {
      win.setContentSize(width, 900); await wait(150);
      const layout = await js(`(()=>{const n=document.querySelector('.ncollab-picker'),b=n.getBoundingClientRect();return{left:b.left,right:b.right,overflow:n.scrollWidth-n.clientWidth}})()`);
      assert.ok(layout.left >= -1 && layout.right <= width + 1 && layout.overflow < 2, JSON.stringify(layout));
      report.layouts.push({width, ...layout});
      fs.writeFileSync(path.join(output, 'assigned-picker-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
    }
    report.checks.push('selecting is read-only and desktop/narrow layouts keep confirmation reachable');
    await click('[data-collab-picker-submit]');
    // Opening and starting each persist the same idempotent task binding.
    assert.deepEqual(await js('claimEvents'), ['claim:assigned', 'bind:assigned', 'bind:assigned', 'send:assigned']);
    assert.equal(await js('sent.length'), 1);
    assert.equal(await js('sent[0].options.taskId'), 'assigned');
    assert.equal(await js('ctx._sessionId'), 'chat-a');
    report.checks.push('explicit confirmation claims once before binding and sending the original requirement into the current conversation');
    await js('configureAssigned();claimDenied=true');
    await click('#add'); await click('[data-collab-task-select="assigned"]'); await click('[data-collab-picker-submit]');
    assert.deepEqual(await js('claimEvents'), ['claim:assigned']);
    assert.equal(await js('sent.length'), 0); assert.equal(await js('bindings.length'), 0);
    assert.equal(await js('ctx._collabPicker.open'), true);
    assert.match(await js(`document.querySelector('.ncollab-picker-error').textContent`), /负责人已变化/);
    assert.equal(await js(`document.querySelector('[data-collab-task-select="assigned"]').getAttribute('aria-checked')`), 'true');
    await js('claimDenied=false'); await click('[data-collab-picker-submit]');
    assert.deepEqual(await js('claimEvents'), ['claim:assigned', 'claim:assigned', 'bind:assigned', 'bind:assigned', 'send:assigned']);
    assert.equal(await js('sent.length'), 1);
    report.checks.push('a failed claim keeps selection and error visible; retry binds the same task and sends exactly once');
    assert.deepEqual(await js('errors'), []);
    report.ok = true; finish(0);
  } catch (error) { finish(1, error); }
});
