'use strict';
// Production composer controls in Chromium; API responses are deterministic fixtures.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron, fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  app.disableHardwareAcceleration();
  const assert = require('node:assert/strict'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-agent-picker-'));
  app.setPath('userData', root); let win;
  const js = s => win.webContents.executeJavaScript(s, true), sleep = ms => new Promise(r => setTimeout(r, ms));
  async function until(s) { for(let i=0;i<100;i++){if(await js('Boolean('+s+')'))return;await sleep(25);}throw Error('Timed out: '+s); }
  async function click(selector) {
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'});void 0`);
    const point = await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({ type, button:'left',clickCount:1,...point });
    await sleep(60);
  }
  async function assertRuntimeRow(expectedVersion = 'v0.4.40') {
    const row = await js(`(()=>{
      const el=document.querySelector('[data-runtime=dsh]');el.scrollIntoView({block:'nearest'});
      const name=el.querySelector('.cp-runtime-head b'),version=el.querySelector('.cp-runtime-version'),state=el.querySelector('.cp-runtime-state');
      const bounds=node=>{const r=node.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}};
      return{name:name.textContent,title:name.title,version:version.textContent,versionTitle:version.title,status:state.textContent,
        nameBounds:bounds(name),versionBounds:bounds(version),copyBounds:bounds(el.querySelector('.cp-runtime-copy')),
        metaBounds:bounds(el.querySelector('.cp-runtime-meta')),rowBounds:bounds(el),nameClipped:name.scrollWidth>name.clientWidth,
        overflow:[...el.querySelectorAll('.cp-runtime-head>*')].some(n=>bounds(n).right>bounds(el.querySelector('.cp-runtime-copy')).right+1)};
    })()`);
    assert.equal(row.name,'DeepSeek Harness');assert.equal(row.title,row.name);
    assert.equal(row.version,expectedVersion);assert.equal(row.versionTitle,expectedVersion);assert.doesNotMatch(row.status,/0\.4\.40|@openma/);
    assert.equal(row.nameClipped,false,JSON.stringify(row));assert.equal(row.overflow,false,JSON.stringify(row));
    assert.ok(row.versionBounds.top>=row.nameBounds.bottom-1,JSON.stringify(row));
    assert.ok(row.copyBounds.right<=row.metaBounds.left&&row.metaBounds.right<=row.rowBounds.right,JSON.stringify(row));
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show:false,width:1000,height:760,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true} });
    await win.loadFile(path.join(__dirname,'fixtures/conversation-runtime-picker.html'));await until('window.fixtureReady');
    await js('document.querySelector("#nchatInput").value="Keep my draft";document.querySelector("#nchatInput").dispatchEvent(new Event("input"));void 0');
    for(const agent of ['opencode','qwen','dsh','harness2','pi']) {
      await click('#nchatRuntime'); await until('document.querySelector("[data-runtime=qwen]")');
      await click('[data-runtime='+agent+']'); await until('state.adapterId==='+JSON.stringify(agent));
      assert.equal(await js('state.ref'),'same-conversation');assert.equal(await js('document.querySelector("#nchatInput").value'),'Keep my draft');
    }
    await click('#nchatModel>button');await until('document.querySelector("[data-model-name=b]")');await click('[data-model-name=b]');
    await until('state.selection.name==="b"');
    await js('state.busy=true;controls.render();void 0');await click('#nchatRuntime');
    assert.match(await js('notices.at(-1)'),/等待/);await js('state.busy=false;fail=true;controls.render();void 0');
    await click('#nchatRuntime');await click('[data-runtime=qwen]');await until('document.querySelector(".nchat-runtime-pop [role=status]")?.textContent.includes("暂不可用")');
    assert.equal(await js('state.adapterId'),'pi');
    await js('fail=false;controls.reset();window.modelGate=new Promise(r=>window.releaseModels=r);void 0');
    await click('#nchatModel>button');await click('#nchatRuntime');await click('[data-runtime=opencode]');await until('state.adapterId==="opencode"');
    await js('releaseModels();modelGate=null;void 0');await sleep(80);assert.equal(await js('document.querySelector(".nmodel-pop").hidden'),true);
    await js('window.switchGate=new Promise(r=>window.releaseSwitch=r);void 0');await click('#nchatRuntime');await click('[data-runtime=qwen]');
    assert.equal(await js('document.querySelector("#nchatRuntime").disabled'),true);
    await js('releaseSwitch();switchGate=null;void 0');await until('state.adapterId==="qwen"');
    assert.equal(await js('document.querySelector("#nchatRuntimeAvailability").checkVisibility()'),false, 'missing runtimes stay out of the composer toolbar');
    await click('#nchatRuntime');
    await until('!document.querySelector("#nchatRuntimeAvailability").hidden');
    assert.equal(await js('document.querySelector(".nchat-runtime-pop").contains(document.querySelector("#nchatRuntimeAvailability"))'),true);
    assert.equal(await js('document.querySelector("#nchatRuntimeAvailability").checkVisibility()'),true);
    assert.equal(await js('document.querySelectorAll("#nchatRuntimeMissing [data-runtime-missing]").length'),1);
    assert.equal(await js('document.querySelector("#nchatRuntimeMore").hidden'),false);
    await click('#nchatRuntimeMore');
    assert.equal(await js('agentManagementOpened'),1);
    for(const [width,locale] of [[320,'zh-CN'],[390,'en-US'],[1000,'zh-CN']]) {
      win.setSize(width,760);await js('locale='+JSON.stringify(locale));await sleep(80);await click('#nchatRuntime');
      const bounds=await js('(()=>{const r=document.querySelector(".nchat-runtime-pop").getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,width:innerWidth}})()');
      assert.ok(bounds.left>=11&&bounds.right<=bounds.width-11&&bounds.top>=0,JSON.stringify(bounds));
      await assertRuntimeRow();
      assert.equal(await js('document.querySelector("[data-runtime=dsh] .cp-runtime-state").textContent'),await js('SoduWorkI18n.translateText("可用")'));
      const output=path.resolve(__dirname,'../outputs/deepseek-picker');fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'agent-picker-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
      await js('controls.reset();void 0');
    }
    await js('runtimes.find(row=>row.id==="dsh").version="@openma/deepseek-harness-acp 0.5.0-beta.2+very.long.build.identifier";void 0');
    win.setSize(320,760);await click('#nchatRuntime');
    await assertRuntimeRow('v0.5.0-beta.2+very.long.build.identifier');
    assert.equal(await js('runtimes.find(row=>row.id==="dsh").version'),'@openma/deepseek-harness-acp 0.5.0-beta.2+very.long.build.identifier');
    assert.deepEqual(await js('errors'),[]);
    win.setSize(1000,760);
    await win.loadFile(path.join(__dirname,'fixtures/cloud-start-compose.html'));
    await until('document.querySelector("[data-runtime=dsh]")');await click('#cpRuntime');
    await until('document.querySelector("[data-runtime=dsh] .cp-runtime-version").textContent==="v0.4.40"');
    await assertRuntimeRow();
    console.log('PASS: Chromium Agent/model controls; DeepSeek version in both pickers; preserved draft/ref, busy/failure/concurrency, stale model response, Chinese/English and narrow layout');
    app.exit(0);
  }).catch(e=>{console.error(e);app.exit(1)});
}
