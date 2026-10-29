'use strict';

const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict');
  const out = path.resolve(process.argv[2] || 'outputs/chat-model-picker-presentation');
  fs.mkdirSync(out, { recursive: true });
  app.disableHardwareAcceleration();
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-chat-picker-')));
  const report = { ok: false, checks: [], geometry: [],
    boundary: 'Isolated Electron, production chat composer and styles, synthetic model directories; no model execution.' };
  let win;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  async function until(code) {
    for (let i = 0; i < 100; i++) { if (await js(code)) return; await delay(30); }
    throw Error('Timeout: ' + code);
  }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded: '+${JSON.stringify(selector)});return{x,y}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(80);
  }
  async function key(keyCode) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await delay(60);
  }
  async function search(text) {
    await js(`(()=>{const e=document.querySelector('.nmodel-search input');e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  }
  async function open() {
    await click('.nmodel-button');
    await until('document.querySelectorAll("[data-model-name]").length > 0 || document.querySelector(".cp-effort-card")');
  }
  async function geometry(label) {
    await delay(180);
    const result = await js(`(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}},list=document.querySelector('.nmodel-options');return{width:innerWidth,height:innerHeight,pop:rect('.nmodel-pop'),close:rect('[data-model-close]'),footer:rect('.nmodel-thinking'),list:{...rect('.nmodel-options'),scroll:list.scrollHeight,client:list.clientHeight},overflow:document.documentElement.scrollWidth>innerWidth}})()`);
    report.geometry.push({ label, ...result });
    assert.ok(result.pop.left >= 0 && result.pop.right <= result.width && result.pop.top >= 0 && result.pop.bottom <= result.height, JSON.stringify(result));
    assert.ok(result.close.top >= result.pop.top && result.footer.bottom <= result.pop.bottom, 'Header and thinking footer remain visible');
    assert.ok(result.list.height > 20, 'List remains scrollable');
    assert.equal(result.overflow, false);
    for (const selector of ['.nmodel-search input', '[data-model-close]', '[data-thinking-toggle]']) {
      assert.ok(await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`), selector + ' is visible');
    }
    fs.writeFileSync(path.join(out, label + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1160, height: 820, useContentSize: true,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, done) => done({ cancel: true }));
    await win.loadFile(path.join(__dirname, 'fixtures/compact-chat-model.html'));
    await until('window.fixtureReady');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await js(`
      models=[{name:'qwen-max',label:'通义千问 Max',providerName:'阿里云百炼（通义）',keyFrom:'mine'},
        {name:'qwen-plus',label:'通义千问 Plus',providerName:'阿里云百炼（通义）',keyFrom:'enterprise'},
        ...Array.from({length:10},(_,i)=>({name:'other-'+i,label:'推理模型 '+i,providerName:'其他服务商'}))];
      state.selection={name:models[0].name,model:models[0]};state.thinking={supported:true,canDisable:true,enabled:false};
      window.thinkingCalls=[];soduWorkAPI.conversationSession.setThinking=async(ref,enabled)=>{thinkingCalls.push({ref,enabled});state.thinking.enabled=enabled;return{ok:true,thinking:state.thinking}};
      controls.render();void 0;
    `);
    await open();
    assert.equal(await js('document.querySelector(".nmodel-heading>span").textContent'), '用于本次会话');
    assert.equal(await js('document.querySelector(".nmodel-heading>b").textContent'), '选择模型');
    assert.equal(await js('document.querySelector("[data-model-name=qwen-max] .nmodel-row-subtitle").textContent'), '阿里云百炼（通义） · 自己的额度');
    assert.equal(await js('document.querySelector("[data-model-name=qwen-plus] .nmodel-row-subtitle").textContent'), '阿里云百炼（通义）');
    assert.equal(await js('document.querySelectorAll(".nmodel-symbol").length'), 12);
    assert.equal(await js('document.querySelector(".nmodel-pop>footer")'), null);
    await geometry('managed-1160');
    report.checks.push('Chat picker matches homepage header, icon rows, public provider/quota metadata, selected check and one thinking footer');
    for (const [width, height] of [[600, 700], [390, 600], [320, 480], [900, 400]]) {
      win.setContentSize(width, height); await delay(180);
      await geometry('managed-' + width + 'x' + height);
    }
    report.checks.push('Only model list scrolls; search, close and thinking switch stay reachable at narrow and short viewports');
    win.setContentSize(1160, 820); await delay(100);
    await search('自己的额度');
    assert.equal(await js('document.querySelectorAll("[data-model-name]").length'), 1);
    await search('qwen-plus');
    await click('[data-model-name=qwen-plus]');
    assert.deepEqual(await js('selected'), [{ ref: 'isolated-chat', name: 'qwen-plus' }]);
    assert.deepEqual(await js('sent'), []);
    assert.ok(await js('document.activeElement===document.querySelector(".nmodel-button")'));
    await open();
    await key('Down');
    assert.equal(await js('document.activeElement.dataset.modelName'), 'qwen-max');
    await key('Down');
    assert.equal(await js('document.activeElement.dataset.modelName'), 'qwen-plus');
    await key('Up');
    assert.equal(await js('document.activeElement.dataset.modelName'), 'qwen-max');
    await click('[data-thinking-toggle]');
    assert.deepEqual(await js('thinkingCalls'), [{ ref: 'isolated-chat', enabled: true }]);
    assert.equal(await js('document.querySelector("[data-thinking-toggle]").getAttribute("aria-checked")'), 'true');
    await js('state.thinking.canDisable=false;controls.render()');
    assert.equal(await js('document.querySelector("[data-thinking-toggle]").disabled'), true);
    assert.ok(await js('document.querySelector(".nmodel-pop").contains(document.activeElement)'), 'Disabling a focused toggle retains picker keyboard access');
    assert.match(await js('document.querySelector("[data-thinking-label]").textContent'), /固定思考/);
    await js('state.thinking.supported=false;controls.render()');
    assert.equal(await js('document.querySelector("[data-thinking-toggle]").disabled'), true);
    await key('Escape');
    await until('document.querySelector(".nmodel-pop").hidden');
    assert.ok(await js('document.querySelector(".nmodel-pop").hidden'));
    report.checks.push('Provider search, selection, focus restoration and thinking switch preserve existing next-message semantics; fixed/unsupported thinking cannot be toggled');
    await js(`state.adapterId='codex';soduWorkAPI.conversationSession.runtimeModels=async()=>({models:[{id:'account-model',label:'Account model'}]});SoduWorkAPI.myModels=async()=>{throw Error('Account models cannot use managed quota')};controls.render()`);
    await open();
    await click('[data-native-list]');
    assert.equal(await js('document.querySelector("[data-model-name]").dataset.modelName'), 'account-model');
    assert.doesNotMatch(await js('document.querySelector(".nmodel-options").textContent'), /自己的额度/);
    await key('Escape');
    report.checks.push('Native account catalog stays separate from managed credentials and quota metadata');
    await js(`state.adapterId='pi';SoduWorkModelChoice={imageKey:item=>'image:'+item.name};SoduWorkAPI.myModels=async()=>({usable:models,mediaUsable:{image:[{name:'paint',label:'Picture model',providerName:'Image provider',keyFrom:'mine'}]}});controls.render()`);
    await open(); await search('Image provider');
    assert.equal(await js('document.querySelector("[data-model-name]").dataset.modelName'), 'image:paint');
    assert.match(await js('document.querySelector(".nmodel-options").textContent'), /生成图片/);
    await click('[data-model-name="image:paint"]');
    assert.equal(await js('selected.at(-1).name'), 'image:paint');
    report.checks.push('Image models keep their typed selection key and explicit image label');
    await js(`window.resolveCatalog=null;SoduWorkAPI.myModels=()=>new Promise(resolve=>{resolveCatalog=resolve});controls.render()`);
    await click('.nmodel-button'); await until('Boolean(resolveCatalog)');
    await js(`state.ref='another-chat';controls.render();resolveCatalog({usable:[{name:'stale',label:'Stale private model'}]});void 0`);
    await delay(100);
    await until('document.querySelector(".nmodel-pop").hidden');
    assert.ok(await js('document.querySelector(".nmodel-pop").hidden'));
    assert.doesNotMatch(await js('document.querySelector(".nmodel-options").textContent'), /Stale private model/);
    report.checks.push('Changing chat while catalog is loading closes the picker and rejects stale results');
    assert.deepEqual(await js('errors'), []); assert.deepEqual(await js('notices'), []);
    report.ok = true;
  }).catch(async error => { report.error = error.stack; if (win) fs.writeFileSync(path.join(out, 'failure.png'), (await win.webContents.capturePage()).toPNG()); })
    .finally(() => { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); win?.destroy(); app.exit(report.ok ? 0 : 1); });
}
