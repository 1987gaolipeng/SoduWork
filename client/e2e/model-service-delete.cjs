'use strict';

// Native pointer/keyboard interaction with the production page in a disposable profile.
const electron = require('electron');
if (typeof electron === 'string') {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-delete-ui-'));
  const env={...process.env,SODUWORK_DELETE_TEST_PROFILE:profile};
  for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS'])delete env[key];
  const child=require('node:child_process').spawn(electron,[__filename,...process.argv.slice(2)],{env,windowsHide:true,stdio:'inherit'});
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;child.kill();},90000);
  child.on('exit',code=>{clearTimeout(timer);process.exitCode=timedOut?1:code??1;fs.rmSync(profile,{recursive:true,force:true,maxRetries:4,retryDelay:100});});
} else {
  const {app,BrowserWindow}=electron,assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
  app.setPath('userData',process.env.SODUWORK_DELETE_TEST_PROFILE);app.disableHardwareAcceleration();
  let win;const js=code=>win.webContents.executeJavaScript(code,true),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function until(code){for(let i=0;i<150;i++){if(await js(code))return;await delay(25);}throw Error('Timeout: '+code);}
  async function click(selector){
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);await delay(25);
    const point=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(e.disabled)throw Error('Disabled target');return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});await delay(30);
  }
  async function key(keyCode){
    win.webContents.sendInputEvent({type:'keyDown',keyCode});
    if(keyCode==='Return')win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode});await delay(30);
  }
  async function shot(name){
    if(!process.argv[2])return;assert.ok(path.isAbsolute(process.argv[2]));fs.mkdirSync(process.argv[2],{recursive:true});
    fs.writeFileSync(path.join(process.argv[2],name+'.png'),(await win.webContents.capturePage()).toPNG());
    const region=await js(`(()=>{const r=document.querySelector('#mdDeleteDialog').getBoundingClientRect();return{x:Math.max(0,Math.floor(r.x)-12),y:Math.max(0,Math.floor(r.y)-12),width:Math.ceil(r.width)+24,height:Math.ceil(r.height)+24};})()`);
    fs.writeFileSync(path.join(process.argv[2],name+'-dialog.png'),(await win.webContents.capturePage(region)).toPNG());
  }
  async function open(){await click('[data-pdelete]');await until('document.querySelector("#mdDeleteDialog[open] [data-md-delete-confirm]")?.disabled===false');}
  async function run(){
    win=new BrowserWindow({show:false,width:1500,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
    await win.loadFile(path.join(__dirname,'fixtures/model-settings.html'));await until('_mdLoadState === "ready"');
    await js(`
      window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      fixture.revision='ui-1';fixture.providers=fixture.providers.filter(p=>['personal','company'].includes(p.id));
      fixture.providers.find(p=>p.id==='personal').personal=true;
      window.deleteWrites=[];window.failDelete=false;window.holdDelete=false;
      SoduWorkAPI.saveMyModels=async input=>{deleteWrites.push(structuredClone(input));if(holdDelete)await new Promise(resolve=>window.releaseDelete=resolve);
        if(failDelete)throw Object.assign(Error('synthetic write failure'),{detail:'模拟服务暂时不可用，请重试。'});
        assertOwnDeleteInput(input);fixture.providers=fixture.providers.filter(p=>p.personal!==true).concat(structuredClone(input.providers));fixture.myModels=structuredClone(input.models);fixture.revision='ui-'+(Number(fixture.revision.split('-')[1])+1);return{ok:true};};
      window.assertOwnDeleteInput=input=>{if(input.providers.some(p=>p.personal!==true)||input.models.some(m=>m.providerId==='company'))throw Error('Company data must not be included in a personal deletion');};
      _mdData=structuredClone(fixture);_mdMyModels=_mdData.myModels.slice();_mdOpen='personal';_mdRender();
      window.beforeView=document.querySelector('.cfg-detail-scroll');
    `);
    await open();
    assert.equal(await js('[...document.querySelectorAll("#mdDeleteDescription p")].filter(p=>!p.hidden&&p.textContent.trim()).length'),1);
    assert.ok(await js('document.querySelector("#mdDeleteDialog").getBoundingClientRect().height<220'));
    await shot('model-delete-clean');await key('Escape');await until('!document.querySelector("#mdDeleteDialog")');
    await js(`document.querySelector('[data-mdedit]').click();fill('[data-mdlabel]','Keep editor draft');fill('[data-pkey]','synthetic-unsaved-key');`);
    await js(`window.normalRead=SoduWorkAPI.myModels;SoduWorkAPI.myModels=async()=>{const r=await normalRead();await new Promise(resolve=>window.releaseRead=resolve);return r;};void 0;`);
    await click('[data-pdelete]');
    assert.equal(await js('document.querySelector("[data-md-delete-confirm]").disabled'),true);
    await key('Escape');await until('!document.querySelector("#mdDeleteDialog")');
    await js('SoduWorkAPI.myModels=normalRead;releaseRead()');
    assert.equal(await js('deleteWrites.length'),0);
    console.log('PASS loading confirmation can be cancelled without admitting a delete');
    await open();
    assert.equal(await js('document.activeElement.matches("[data-md-delete-cancel]")'),true);
    assert.ok(await js('document.querySelector("#mdDeleteDialog").textContent.includes("1 个模型")'));
    assert.ok(await js('document.querySelector("#mdDeleteDialog").textContent.includes("API Key")'));
    assert.ok(await js('document.querySelector("#mdDeleteDialog").textContent.includes("未保存")'));
    assert.equal(await js('document.querySelector("#mdDeleteTitle").textContent'),'删除“OpenAI 兼容（个人）”？');
    assert.equal(await js('[...document.querySelectorAll("#mdDeleteDescription p")].filter(p=>!p.hidden&&p.textContent.trim()).length'),2,
      'one scope sentence plus a draft warning only when needed');
    assert.ok(await js('document.querySelector("#mdDeleteDialog").getBoundingClientRect().width<=420'));
    assert.ok(await js('document.querySelector("#mdDeleteDialog").getBoundingClientRect().height<260'));
    const before=await js('beforeView.scrollTop');await shot('model-delete-confirm');
    for(const [locale,label] of [['en-US','Delete'],['ja-JP','削除'],['ko-KR','삭제']]){
      await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)},{persist:false,broadcast:false})`);
      assert.ok(await js(`document.querySelector('#mdDeleteTitle').textContent.includes(${JSON.stringify(label)})`));
      assert.ok(await js(`document.querySelector('#mdDeleteTitle').textContent.includes('OpenAI 兼容（个人）')`));
    }
    await js(`SoduWorkI18n.setLocale('zh-CN',{persist:false,broadcast:false})`);
    await key('Return');await until('!document.querySelector("#mdDeleteDialog")');
    assert.equal(await js('deleteWrites.length'),0);assert.equal(await js('beforeView.scrollTop'),before);
    assert.equal(await js('document.querySelector("[data-mdlabel]").value'),'Keep editor draft');
    await open();await key('Escape');await until('!document.querySelector("#mdDeleteDialog")');
    assert.equal(await js('deleteWrites.length'),0);
    console.log('PASS explicit scope, key/draft warnings, cancel-first focus, Enter and Escape cancellation, unchanged scroll and editor');

    await open();await js('failDelete=true;holdDelete=true');await click('[data-md-delete-confirm]');
    assert.equal(await js('document.querySelector("[data-md-delete-confirm]").disabled'),true);
    assert.equal(await js('_mdData.providers.some(p=>p.id==="personal")'),true);
    await js('document.querySelector("[data-md-delete-confirm]").click()');assert.equal(await js('deleteWrites.length'),1);
    await js('holdDelete=false;releaseDelete()');await until('!document.querySelector("#mdDeleteError").hidden');
    assert.equal(await js('_mdData.providers.some(p=>p.id==="personal")'),true);
    assert.equal(await js('_mdKeyEdits.personal'),'synthetic-unsaved-key');assert.equal(await js('_mdDrafts.has("personal")'),true);
    assert.ok(await js('document.querySelector("#mdDeleteError").textContent.includes("模拟服务暂时不可用")'));
    await shot('model-delete-error');
    await js('failDelete=false');await click('[data-md-delete-confirm]');await until('!document.querySelector("#mdDeleteDialog")');
    assert.equal(await js('_mdData.providers.some(p=>p.id==="personal")'),false);
    assert.equal(await js('_mdDrafts.has("personal")'),false);assert.equal(await js('_mdOpen'),'company');
    assert.equal(await js('deleteWrites.length'),2);
    assert.equal(await js('deleteWrites.at(-1).providers.some(p=>p.id==="company")'),false);
    assert.equal(await js('_mdData.providers.some(p=>p.id==="company")'),true);
    assert.equal(await js('_mdData.revision'),await js('fixture.revision'));
    assert.equal(await js('_mdManagedNeedsReload'),false);
    assert.equal(await js('document.querySelector("[data-pdelete]")'),null);
    console.log('PASS busy guard, failure retains service and input, retry commits once and retains the read-only company service with a usable revision');

    await js(`_mdAddService();_mdTouchProvider(_mdNew.id,{name:'Unsaved service'});_mdRender()`);
    await open();assert.equal(await js('document.querySelector("[data-md-delete-confirm]").textContent'),'丢弃服务');
    assert.equal(await js('document.querySelector("#mdDeleteSummary").textContent.includes("API Key")'),false);
    await click('[data-md-delete-confirm]');await until('!document.querySelector("#mdDeleteDialog")');
    assert.equal(await js('deleteWrites.length'),2);assert.equal(await js('_mdNew'),null);
    console.log('PASS unsaved service uses discard wording and performs no storage write');

    await js(`fixture.providers=[{id:'last',name:'A <service> & name',personal:true,baseUrl:'https://fixture.invalid/v1',myKeySet:false,modelNames:[]}];
      fixture.myModels=[];fixture.usable=[];_mdData=structuredClone(fixture);_mdMyModels=[];_mdOpen='last';_mdRender()`);
    win.setSize(800,850);await open();
    assert.ok(await js('document.querySelector("#mdDeleteDialog").textContent.includes("A <service> & name")'));
    assert.equal(await js('document.querySelector("#mdDeleteDialog service")'),null);
    assert.equal(await js('document.querySelector("#mdDeleteSummary").textContent.includes("API Key")'),false);
    assert.equal(await js('[...document.querySelectorAll("#mdDeleteDescription p")].filter(p=>!p.hidden&&p.textContent.trim()).length'),1);
    assert.equal(await js('/0 个模型/.test(document.querySelector("#mdDeleteSummary").textContent)'),false);
    assert.ok(await js('document.querySelector("#mdDeleteDialog").getBoundingClientRect().width < innerWidth'));
    await shot('model-delete-narrow');
    await click('[data-md-delete-confirm]');await until('!document.querySelector("#mdDeleteDialog")');
    assert.equal(await js('!!document.querySelector(".cfg-detail-empty")'),true);

    await js(`fixture.providers=[{id:'reopen',name:'Reopen test',personal:true,baseUrl:'https://fixture.invalid/v1',modelNames:[]}];
      _mdData=structuredClone(fixture);_mdOpen='reopen';_mdRender();holdDelete=true`);
    await open();await click('[data-md-delete-confirm]');
    await js('closeModelsPanel();openModelsPanel()');
    assert.equal(await js('!!document.querySelector("#mdDeleteDialog")'),false);
    assert.equal(await js('_mdLoadState'),'loading');
    await js('holdDelete=false;releaseDelete()');await until('_mdLoadState === "ready" && !_mdSaveFlight');
    assert.equal(await js('_mdData.providers.length'),0);
    console.log('PASS closing and reopening during deletion waits for its actual storage result');

    await js(`fixture.providers=['delete-target','keep-draft'].map(id=>({id,name:id,personal:true,baseUrl:'https://fixture.invalid/v1',modelNames:[]}));
      fixture.myModels=[];_mdData=structuredClone(fixture);_mdMyModels=[];_mdOpen='keep-draft';_mdRender()`);
    await click('.md-model-editor>summary');await click('.md-model-editor>summary');
    await click('[data-mdselect="delete-target"]');await open();
    assert.equal(await js('document.querySelector("#mdDeleteError").hidden'),true,'an untouched editor must not block deletion');
    await click('[data-md-delete-cancel]');
    await click('[data-mdselect="keep-draft"]');await click('.md-model-editor>summary');
    await js(`fill('[data-padd]','pending-other-model')`);
    await click('[data-mdselect="delete-target"]');await click('[data-pdelete]');
    await until('document.querySelector("#mdDeleteError")?.hidden === false');
    assert.ok(await js('document.querySelector("#mdDeleteError").textContent.includes("请先完成或取消其他服务的编辑")'));
    await click('[data-md-delete-cancel]');await click('[data-mdselect="keep-draft"]');
    await click('[data-mdcancel]');await click('[data-mdselect="delete-target"]');
    await open();await click('[data-md-delete-confirm]');await until('!document.querySelector("#mdDeleteDialog")');
    assert.equal(await js('_mdManagedNeedsReload'),false);
    assert.equal(await js('_mdData.providers[0].id'),'keep-draft');
    console.log('PASS untouched add editors do not block deletion and unapplied drafts have an explicit cancel path');
    assert.deepEqual(await js('errors'),[]);
    console.log('PASS zero models/no key, escaped user name, narrow dialog and last-service empty state');
  }
  app.whenReady().then(run).then(()=>{win.destroy();app.exit(0);}).catch(error=>{console.error(error);if(win)win.destroy();app.exit(1);});
}
