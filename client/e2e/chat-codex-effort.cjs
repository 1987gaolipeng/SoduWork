'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit', timeout: 90000 });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict');
  const out = path.resolve(process.argv[2] || 'outputs/chat-codex-effort');
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-codex-effort-ui-')));
  app.disableHardwareAcceleration();
  const report = { ok: false, cases: [], layouts: [],
    boundary: 'Hidden isolated Electron with production composer/runtime picker, shared native effort view and styles; model/runtime APIs are local fixtures. No model execution or business profile.' };
  let win;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = source => win.webContents.executeJavaScript(source, true);
  async function captureFrame() {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const image = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        assert.equal(image.isEmpty(), false, 'A rendered screenshot is required');
        return image.toPNG();
      } catch (error) {
        if (!String(error.message).includes('UnknownVizError') || attempt === 2) throw error;
        // Offscreen Chromium can discard the compositor surface during a resize.
        win.webContents.invalidate();
        await delay(150 * (attempt + 1));
      }
    }
  }
  async function until(source) {
    for (let n = 0; n < 120; n++) { if (await js(source)) return; await delay(25); }
    throw Error('Timed out: ' + source);
  }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable: '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const b=e.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded: '+${JSON.stringify(selector)});return{x:Math.round(x),y:Math.round(y)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(70);
  }
  async function switchAgent(id) { await click('#nchatRuntime'); await until('document.querySelector("[data-session-agent=' + id + ']")'); await click('[data-session-agent=' + id + ']'); }
  async function slider(value) { await js(`(()=>{const e=document.querySelector('[data-effort-slider]');e.value=${value};e.dispatchEvent(new Event('input',{bubbles:true}))})()`); await delay(80); }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1160, height: 820, useContentSize: true,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, done) => done({ cancel: true }));
    await win.loadFile(path.join(__dirname, 'fixtures/compact-chat-model.html'));
    await until('window.fixtureReady');
    await js(`
      document.body.classList.add('compose-panel');document.body.dataset.stage='chat';
      window.nativeModels=[{id:'account-model',label:'Codex Current',reasoningLevels:['low','medium','high','xhigh'],defaultReasoning:'medium'},
        {id:'other-model',label:'Codex Other',reasoningLevels:['low','high'],defaultReasoning:'low'}];
      window.efforts=[];window.savedNative={name:'account-model',level:'medium'};
      window.nativeThinking=()=>{const m=nativeModels.find(m=>m.id===savedNative.name);return{supported:true,enabled:true,level:savedNative.level,levels:m.reasoningLevels,defaultLevel:m.defaultReasoning}};
      window.selection=()=>({name:savedNative.name,model:{id:savedNative.name,label:nativeModels.find(m=>m.id===savedNative.name).label}});
      soduWorkAPI.conversationSession.conversationRuntimes=async()=>({ok:true,runtimes:fixtureRuntimes});
      soduWorkAPI.conversationSession.selectAgent=async(ref,id)=>({ok:true,snapshot:{adapterId:id,selection:id==='codex'?selection():{name:models[0].name,model:models[0]},thinking:id==='codex'?nativeThinking():{supported:true,canDisable:true,enabled:false}}});
      soduWorkAPI.conversationSession.runtimeModels=async()=>({ok:true,models:nativeModels});
      soduWorkAPI.conversationSession.selectModel=async(ref,name)=>{savedNative.name=name;const m=nativeModels.find(m=>m.id===name);if(!m.reasoningLevels.includes(savedNative.level))savedNative.level=m.defaultReasoning;return{ok:true,selection:selection(),thinking:nativeThinking()}};
      soduWorkAPI.conversationSession.setThinking=async(ref,level)=>{efforts.push({ref,level});savedNative.level=level;return{ok:true,thinking:nativeThinking()}};
      controls.render();
    `);
    await switchAgent('codex');
    await click('.nmodel-button');
    await until('document.querySelector(".cp-effort-card")');
    assert.equal(await js('document.querySelector(".cp-native-model-trigger small").textContent.trim()'), 'Codex Current ›');
    assert.equal(await js('document.querySelector("[data-effort-slider]").value'), '1');
    assert.equal(await js('document.querySelector("[data-thinking-toggle]")'), null);
    report.cases.push('Started conversation switches to Codex and opens the same shared native effort card as new conversations, with current model and effort');
    await slider(3);
    assert.deepEqual(await js('efforts.at(-1)'), { ref: 'isolated-chat', level: 'xhigh' });
    assert.equal(await js('state.thinking.level'), 'xhigh');
    assert.equal(await js('document.querySelector("[data-effort-label]").textContent'), '极高');
    await click('[data-effort-reset]');
    assert.equal(await js('state.thinking.level'), 'medium');
    report.cases.push('Slider and reset send real effort strings through the existing thinking API and reflect acknowledged state');
    await click('[data-native-list]'); await until('document.querySelectorAll("[data-model-name]").length===2');
    await click('[data-model-name=other-model]'); await until('document.querySelector(".cp-effort-card")');
    assert.equal(await js('state.selection.name'), 'other-model');
    assert.equal(await js('state.thinking.level'), 'low');
    assert.equal(await js('document.querySelector("[data-effort-slider]").max'), '1');
    await slider(1);
    assert.equal(await js('state.thinking.level'), 'high');
    report.cases.push('Changing Codex model returns to the effort card, updates supported stops and uses the model-normalized effort');
    await click('.nmodel-button'); await switchAgent('pi'); await click('.nmodel-button');
    await until('document.querySelector("[data-thinking-toggle]")');
    assert.equal(await js('document.querySelector(".cp-effort-card")'), null);
    await click('.nmodel-button'); await switchAgent('codex'); await click('.nmodel-button');
    await until('document.querySelector(".cp-effort-card")');
    assert.equal(await js('state.selection.name'), 'other-model');
    assert.equal(await js('document.querySelector("[data-effort-slider]").value'), '1');
    report.cases.push('Switch away and back restores Codex model/effort while managed models retain their ordinary thinking toggle');
    await js(`window.normalThinking=soduWorkAPI.conversationSession.setThinking;window.releaseThinking=null;
      soduWorkAPI.conversationSession.setThinking=(ref,level)=>{efforts.push({ref,level});return new Promise(resolve=>{releaseThinking=()=>{releaseThinking=null;savedNative.level=level;resolve({ok:true,thinking:nativeThinking()})}})};window.beforeEfforts=efforts.length;`);
    await slider(0); await until('Boolean(releaseThinking)');
    await slider(1); await slider(0); await slider(1);
    assert.equal(await js('efforts.length-beforeEfforts'), 1);
    await js('window.sendReady=false;void controls.waitForAccess().then(value=>{sendReady=value});void 0');
    assert.equal(await js('sendReady'), false);
    await js('releaseThinking()'); await until('Boolean(releaseThinking)');
    assert.equal(await js('sendReady'), false);
    assert.deepEqual(await js('efforts.slice(beforeEfforts).map(row=>row.level)'), ['low', 'high']);
    await js('releaseThinking()'); await until('sendReady');
    assert.equal(await js('state.thinking.level'), 'high');
    await js('soduWorkAPI.conversationSession.setThinking=normalThinking;void 0');
    report.cases.push('Rapid slider input coalesces pending levels to the last requested stop and sending waits for the final acknowledged selection');
    await js('document.querySelector("[data-effort-slider]").focus()');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' });
    await until('state.thinking.level==="low"');
    await click('[data-native-list]');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until('document.querySelector(".cp-effort-card")');
    report.cases.push('Native range keyboard changes effort and Escape from the model list returns to the shared effort card');
    for (const [width, height] of [[1160, 820], [390, 600], [320, 480], [900, 400]]) {
      win.setContentSize(width, height); await delay(150);
      const geometry = await js(`(()=>{const e=document.querySelector('.nmodel-pop'),b=e.getBoundingClientRect(),s=e.querySelector('[data-effort-slider]').getBoundingClientRect();return{width:innerWidth,height:innerHeight,left:b.left,right:b.right,top:b.top,bottom:b.bottom,slider:s.width,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
      report.layouts.push(geometry);
      assert.ok(geometry.left >= 0 && geometry.right <= geometry.width && geometry.top >= 0 && geometry.bottom <= geometry.height && geometry.slider > 50 && !geometry.overflow, JSON.stringify(geometry));
      fs.writeFileSync(path.join(out, 'codex-' + width + 'x' + height + '.png'), await captureFrame());
    }
    report.cases.push('Shared effort card fits desktop, narrow and short windows without clipping model, slider or reset');
    await js(`soduWorkAPI.conversationSession.setThinking=(ref,level)=>new Promise(resolve=>{window.lateEffort=()=>resolve({ok:true,thinking:{supported:true,level:'high'}})});window.previousLevel=state.thinking.level`);
    await slider(1); await until('Boolean(window.lateEffort)');
    await js(`state.ref='another-chat';state.adapterId='pi';state.thinking={supported:true,enabled:false,level:'off'};controls.render();lateEffort();void 0`);
    await delay(100);
    assert.equal(await js('state.thinking.level'), 'off');
    assert.equal(await js('document.querySelector(".nmodel-pop").hidden'), true);
    assert.equal(await js('getComputedStyle(document.querySelector(".nmodel-pop")).display'), 'none');
    report.cases.push('A late effort acknowledgement cannot modify a subsequently opened conversation or Agent');
    await js(`window.raceEfforts=[];window.rejectOldEffort=null;window.finishNewLow=null;window.finishNewHigh=null;
      soduWorkAPI.conversationSession.setThinking=(ref,level)=>{raceEfforts.push({ref,level});
        if(ref==='race-a')return new Promise((_,reject)=>{rejectOldEffort=reject});
        return new Promise(resolve=>{const finish=()=>resolve({ok:true,thinking:{supported:true,enabled:true,level}});
          if(level==='low')finishNewLow=finish;else finishNewHigh=finish})};
      state.ref='race-a';state.adapterId='codex';state.thinking={supported:true,enabled:true,level:'low'};controls.render();void 0`);
    await click('.nmodel-button'); await until('document.querySelector(".cp-effort-card")');
    await slider(1); await until('Boolean(rejectOldEffort)');
    await js(`state.ref='race-b';state.thinking={supported:true,enabled:true,level:'high'};controls.render();void 0`);
    await click('.nmodel-button'); await until('document.querySelector(".cp-effort-card")');
    await slider(0); await until('Boolean(finishNewLow)'); await slider(1);
    await js('window.raceSendReady=false;void controls.waitForAccess().then(value=>{raceSendReady=value});rejectOldEffort(Error("Old conversation transport failed"));void 0');
    await delay(100);
    assert.equal(await js('raceSendReady'), false);
    await js('finishNewLow()'); await until('Boolean(finishNewHigh)');
    assert.equal(await js('raceSendReady'), false);
    assert.deepEqual(await js('raceEfforts'), [{ref:'race-a',level:'high'},{ref:'race-b',level:'low'},{ref:'race-b',level:'high'}]);
    await js('finishNewHigh()'); await until('raceSendReady');
    assert.equal(await js('state.thinking.level'), 'high');
    report.cases.push('Rejected transport from old conversation A cannot clear conversation B pending effort, show a stale error, or release sending before B high is acknowledged');
    assert.deepEqual(await js('errors'), []); assert.deepEqual(await js('notices'), []);
    report.ok = true;
  }).catch(async error => { report.error = error.stack; if (win) { try { fs.writeFileSync(path.join(out, 'failure.png'), await captureFrame()); } catch (shotError) { report.screenshotError = String(shotError); } } })
    .finally(() => { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); win?.destroy(); app.exit(report.ok ? 0 : 1); });
}
