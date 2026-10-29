'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict');
  const out = path.resolve(__dirname, '../../outputs/concrete-default-model');
  fs.mkdirSync(out, { recursive: true });
  app.disableHardwareAcceleration();
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-default-picker-')));
  const report = { ok: false, cases: [], boundary: 'Actual Electron and production model controls with synthetic catalogs. No live model calls or business data.' };
  let win;
  const js = code => win.webContents.executeJavaScript(code, true).catch(error => { throw Error(error.message + '\nCode: ' + code.slice(0, 800)); });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) {
    for (let i = 0; i < 150; i++) { if (await js(code)) return; await delay(20); }
    throw Error('Timeout: ' + code);
  }
  async function click(selector) {
    const p = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded control');return{x,y}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...p, button: 'left', clickCount: 1 });
    await delay(50);
  }
  async function run() {
    win = new BrowserWindow({ show: false, width: 1160, height: 850,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, done) => done({ cancel: true }));
    await win.loadFile(path.join(__dirname, 'fixtures/compact-chat-model.html'));
    await until('window.fixtureReady');
    // An old session has an empty preference but already knows its real model.
    await js("state.selection={name:'',model:{id:'vision',label:'GLM 5.3 Flash'}};controls.render();document.querySelector('#nchatInput').value='keep this draft';");
    for (const adapter of ['pi', 'opencode', 'qwen', 'codex-harness', 'dsh', 'codex', 'claude']) {
      await js(`state.adapterId=${JSON.stringify(adapter)};soduWorkAPI.conversationSession.runtimeModels=async()=>({models:models.map(m=>({id:m.name,label:m.label}))});void 0;`);
      await click('.nmodel-button');
      await until('document.querySelectorAll("[data-model-name]").length===3');
      assert.equal(await js('document.querySelector("[data-model-name=vision]").getAttribute("aria-selected")'), 'true');
      assert.equal(await js(`document.querySelectorAll('[data-model-name=""]').length`), 0);
      await click('[data-model-close]');
    }
    assert.deepEqual(await js('selected'), [], 'opening old sessions must not mutate their model');
    assert.equal(await js('document.querySelector("#nchatInput").value'), 'keep this draft');
    await click('.nmodel-button'); await until('document.querySelectorAll("[data-model-name]").length===3');
    await click('[data-model-name=short]');
    assert.deepEqual(await js('selected'), [{ ref: 'isolated-chat', name: 'short' }]);
    assert.equal(await js('sent.length'), 0);
    report.cases.push('Seven runtime menus: resolved historical model checked; no empty choice; explicit switching and drafts preserved');

    await js(`
      document.querySelector('main').style.display='none';
      document.body.insertAdjacentHTML('beforeend','<section class="compose-panel" style="display:block;position:static"><div class="cp-modelwrap" style="position:absolute;bottom:40px;left:160px"><button id="cpModelBtn" class="cp-modelbtn"><span id="cpModelName"></span></button><div id="cpModelPop" class="cp-modelpop"></div></div></section>');
      for(const file of ['workspace/workspace-shell.css','panels/panels-compose-model-picker.css']){const css=document.createElement('link');css.rel='stylesheet';css.href='../../components/'+file;document.head.append(css);}
      const style=document.createElement('style');style.textContent='#cpModelPop:not(.show){display:none}#cpModelPop.show{display:block}';document.head.append(style);
      window.adapter='pi';window.catalog={usable:models,defaultModel:'long-model',defaultModels:{pi:'vision',opencode:'short',qwen:'',dsh:'long-model','codex-harness':'short'},defaultModelErrors:{qwen:'Unavailable'},mediaUsable:{image:[{providerId:'image-service',name:'image-one',label:'Image One'}]}};
      window.changes=[];window.offline=false;window.slow=false;
      SoduWorkAPI.myModels=async()=>{if(offline)throw Error('Offline');if(slow)return new Promise(resolve=>window.finishCatalog=()=>resolve(structuredClone(catalog)));return structuredClone(catalog)};
      window.ComposeRuntime={value:()=>adapter,catalog:()=>[{id:adapter,modelMode:['codex','claude'].includes(adapter)?'account':'managed'}]};
      void 0;
    `);
    await js(fs.readFileSync(path.join(__dirname, '../core/model-choice.js'), 'utf8'));
    await js(fs.readFileSync(path.join(__dirname, '../components/panels/panels-compose-model-picker.js'), 'utf8'));
    await js("ComposeModelPicker.bind({api:()=>soduWorkAPI.conversationSession,onChange:x=>changes.push(x)});void 0;");
    await until("ComposeModelPicker.value().modelName==='vision'");
    assert.equal(await js('document.querySelector("#cpModelName").textContent'), 'GLM 5.3 Flash');
    await click('#cpModelBtn');
    assert.equal(await js(`document.querySelectorAll('[data-model=""]').length`), 0);
    assert.equal(await js('document.querySelector(".cp-mrow.on").dataset.model'), 'vision');
    await click('[data-model=short]');
    await js('ComposeModelPicker.refresh(true)');
    assert.equal(await js('ComposeModelPicker.value().modelName'), 'short');
    await js("adapter='opencode';ComposeModelPicker.refresh()");
    assert.equal(await js('ComposeModelPicker.value().modelName'), 'short');
    await js("adapter='codex-harness';ComposeModelPicker.refresh()");
    assert.equal(await js('ComposeModelPicker.value().modelName'), 'short');
    await js("adapter='dsh';ComposeModelPicker.refresh()");
    assert.equal(await js('ComposeModelPicker.value().modelName'), 'long-model');
    report.cases.push('New chats select each Agent’s actual default and preserve manual selections across refresh and runtime switches');

    await js("adapter='qwen';ComposeModelPicker.refresh()");
    assert.equal(await js('ComposeModelPicker.ready()'), false);
    assert.equal(await js('ComposeModelPicker.value().modelName'), '');
    await click('#cpModelBtn'); await click('[data-model=vision]');
    assert.equal(await js('ComposeModelPicker.ready()'), true);
    await js('offline=true;ComposeModelPicker.refresh(true)');
    assert.equal(await js('ComposeModelPicker.value().modelName'), 'vision');
    await js("offline=false;adapter='pi';ComposeModelPicker.refresh()");
    await click('#cpModelBtn'); await click('[data-model="image::image-service::image-one"]');
    await js('ComposeModelPicker.refresh(true)');
    assert.equal(await js('ComposeModelPicker.value().modelName'), 'image::image-service::image-one');
    report.cases.push('Unavailable defaults require explicit choice; failed lookup preserves selection; image choice remains modality-qualified');

    await js("slow=true;ComposeModelPicker.refresh(true);window.readyDone=false;ComposeModelPicker.ready().then(()=>readyDone=true);void 0;");
    await delay(100); assert.equal(await js('readyDone'), false);
    await js("slow=false;adapter='opencode';ComposeModelPicker.refresh();void 0;");
    await until('readyDone');
    await js('finishCatalog();void 0;');
    assert.equal(await js('ComposeModelPicker.value().modelName'), 'short');
    await js("adapter='codex';ComposeModelPicker.refresh()");
    await click('#cpModelBtn');
    assert.equal(await js(`document.querySelectorAll('[data-native-model=""]').length`), 0);
    assert.equal(await js('ComposeModelPicker.value().modelName'), '', 'unknown account default must never become a managed model');
    await js("ComposeModelPicker.close();adapter='opencode';ComposeModelPicker.refresh()");
    await click('#cpModelBtn');
    report.cases.push('Send readiness waits for catalog; late previous-runtime response cannot overwrite current choice; native account isolation');
    assert.deepEqual(await js('errors'), []);
    report.ok = true;
  }
  app.whenReady().then(run).catch(error => { report.error = error.stack; }).finally(async () => {
    if (win && !win.isDestroyed()) {
      try { fs.writeFileSync(path.join(out, report.ok ? 'picker.png' : 'failure.png'), (await win.webContents.capturePage()).toPNG()); }
      catch (error) { report.captureError = error.message; }
      win.destroy();
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  });
}
