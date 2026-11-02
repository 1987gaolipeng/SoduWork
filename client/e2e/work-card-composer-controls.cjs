'use strict';
// Use real Electron controls and draft state with stub execution and model services; do not start an agent.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron,[__filename,...process.argv.slice(2)],{env,windowsHide:true,stdio:'inherit'});
  const timer=setTimeout(()=>child.kill(),60000);
  child.on('exit',code=>{clearTimeout(timer);process.exitCode=code??1;});
} else {
  const {app,BrowserWindow}=electron, fs=require('node:fs'), path=require('node:path'), os=require('node:os'), assert=require('node:assert/strict');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-work-controls-')), client=path.resolve(__dirname,'..');
  const out=path.resolve(process.argv[2]||path.join(client,'../outputs/work-conversation-20261016/controls'));
  fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(root,'profile'));
  const report={ok:false,cases:[],errors:[],realModel:false};let win;
  const js=code=>win.webContents.executeJavaScript(code,true);
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function until(code){for(let i=0;i<120;i++){if(await js(code))return;await delay(20);}throw Error('等待超时：'+code);}
  const click=selector=>js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('控件不可用：'+${JSON.stringify(selector)});e.click();})()`);
  app.whenReady().then(async()=>{
    const page=path.join(root,'fixture.html');
    fs.writeFileSync(page,'<!doctype html><meta charset="utf-8"><div id="host"><div id="nchatQueue"></div><div id="nchatModel"><button><span>模型</span></button><div class="nmodel-pop" hidden></div></div><button id="nchatMode"><span id="nchatModeName"></span></button><button id="nchatRuntime"><span id="nchatRuntimeIcon"></span><span id="nchatRuntimeName"></span></button></div>');
    win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_r,cb)=>cb({cancel:true}));
    win.webContents.on('console-message',event=>{if(event.level==='error')report.errors.push(event.message);});
    await win.loadFile(page);
    await js(`window.calls=[];window.messages=[];window.support={supported:true,schema:'soduwork.access-policy/v1',modes:['standard','readonly','full'],canChangeDuringSession:true};
      window.runtimes=[{id:'pi',displayName:'Pi',modelMode:'managed',accessControl:support},{id:'qwen',displayName:'Qwen',modelMode:'managed',accessControl:support}];
      window.petSay=x=>messages.push(x);window.soduWorkAPI={accessPreferences:{get:async()=>({ok:true,mode:'readonly'}),onChange:()=>()=>{}},conversationSession:{
        runtimes:async()=>({ok:true,runtimes,availableRuntimes:runtimes,missing:[]}),confirmNewChatAccess:async()=>{calls.push('confirm');return {ok:true,consentId:'native-grant'};},revokeNewChatAccess:async()=>({ok:true}),
        conversationRuntimes:async()=>{calls.push('live-list');return {ok:true,runtimes,availableRuntimes:runtimes,missing:[]};},
        selectAgent:async(ref,id)=>{calls.push('live-agent:'+ref);return {ok:true,adapterId:id,snapshot:{adapterId:id,accessPolicy:{mode:'readonly'},accessControl:support}};},
        selectModel:async(ref,name)=>{calls.push('live-model:'+ref);return {ok:true,selection:{name,model:{id:name}}};},
        setAccessMode:async(ref,mode)=>{calls.push('live-access:'+ref);return {ok:true,accessPolicy:{mode},accessControl:support};}}};
      window.SoduWorkAPI={myModels:async()=>({usable:[{name:'chosen',label:'已选模型'}]})};
      window.ctx={_sessionId:'',_ref:'',_viewEpoch:1,_sessionOptions:{},_snap:{},_api:()=>soduWorkAPI.conversationSession,
        _paintBar(){window.controls?.render();},_render(){window.controls?.render();}};void 0;`);
    for(const file of ['work-composer','compose-surface','chat-composer-bindings','chat-session-controls','chat-runtime-picker','chat-composer-controls'])
      await js(fs.readFileSync(path.join(client,'components/panels',file+'.js'),'utf8')+'\nvoid 0;');
    await js(`window.draft=ChatComposerBindings.createDraftControls(ctx);window.controls=ChatComposerControls.create(document.querySelector('#host'),{
      draft,state:()=>({ref:ctx._ref,adapterId:ctx._snap.adapterId||ctx._sessionOptions.adapterId||'pi',selection:ctx._snap.modelSelection,
        accessPolicy:ctx._snap.accessPolicy,accessControl:ctx._snap.accessControl,...draft.state()}),say:petSay,renderQueue(){},updateQueue(){},
      runtimeSelected:r=>{ctx._snap=r.snapshot;ctx._sessionOptions.adapterId=r.adapterId;ctx._sessionOptions.modelName='';controls.render();},
      modelSelected:s=>{ctx._snap.modelSelection=s;ctx._sessionOptions.modelName=s.name;controls.render();},
      accessChanged:r=>{ctx._snap={...ctx._snap,...r};controls.render();}});controls.render();void 0;`);
    assert.equal(await js('document.querySelector("#nchatRuntime").disabled'),false);
    await click('#nchatRuntime');await until('Boolean(document.querySelector("[data-session-agent=qwen]"))');await click('[data-session-agent=qwen]');
    await until('ctx._sessionOptions.adapterId==="qwen"');
    await click('#nchatModel>button');await until('Boolean(document.querySelector("[data-model-name=chosen]"))');await click('[data-model-name=chosen]');
    await until('ctx._sessionOptions.modelName==="chosen"');
    assert.deepEqual(await js('({sessionId:ctx._sessionId,ref:ctx._ref,calls})'),{sessionId:'',ref:'',calls:[]});
    report.cases.push('空白草稿可先选择 Agent 和模型，仅更新本地发送选项，不创建会话或调用运行态 API');
    await js(`ctx._viewEpoch++;ctx._sessionId='work-session';ctx._snap={workOnly:true};controls.render();void 0;`);
    await until('document.querySelector("#nchatModeName").textContent.includes("只读")');
    assert.equal(await js('document.querySelector("#nchatRuntime").disabled'),false);
    assert.equal(await js('document.querySelector("#nchatModel>button").disabled'),false);
    await click('#nchatMode');assert.equal(await js('document.querySelectorAll("[data-access-mode]:disabled").length'),0);
    report.cases.push('空白 DOM 先绑定，再进入表单历史，复用控件仍能选择执行选项');
    report.cases.push('仅表单会话的 Agent、模型和权限均可用，权限显示系统只读设置');
    await click('#nchatRuntime');await until('Boolean(document.querySelector("[data-session-agent=qwen]"))');await click('[data-session-agent=qwen]');
    await until('ctx._sessionOptions.adapterId==="qwen"');assert.equal(await js('ctx._sessionId'),'work-session');
    await click('#nchatModel>button');await until('Boolean(document.querySelector("[data-model-name=chosen]"))');await click('[data-model-name=chosen]');
    await until('ctx._sessionOptions.modelName==="chosen"');assert.deepEqual(await js('calls'),[]);
    report.cases.push('切 Agent 与模型只更新发送选项，保持 sessionId 且未调用运行态 API');
    await click('#nchatMode');await click('[data-access-mode=full]');await until('ctx._sessionOptions.accessConsentId==="native-grant"');
    assert.equal(await js('ctx._sessionOptions.accessMode'),'full');assert.deepEqual(await js('calls'),['confirm']);
    await click('#nchatMode');await click('[data-access-mode=readonly]');await until('ctx._sessionOptions.accessMode==="readonly"');
    assert.equal(await js('ctx._sessionOptions.accessConsentId'),undefined);
    report.cases.push('完全访问复用新会话原生确认；降级清除授权，不调用运行态权限接口');
    await js(`window.catalogOriginal=soduWorkAPI.conversationSession.runtimes;soduWorkAPI.conversationSession.runtimes=()=>new Promise(resolve=>window.finishCatalog=resolve);void 0;`);
    await click('#nchatRuntime');await until('typeof finishCatalog==="function"');
    await js(`ctx._viewEpoch++;ctx._sessionId='work-b';controls.render();finishCatalog({ok:true,runtimes});soduWorkAPI.conversationSession.runtimes=catalogOriginal;void 0;`);
    await delay(40);assert.equal(await js('document.querySelector(".nchat-runtime-pop").hidden'),true);
    report.cases.push('两个表单的 ref 同为空，旧 Agent 列表迟到仍会按会话身份隔离');
    await js(`SoduWorkAPI.myModels=()=>new Promise(resolve=>window.finishModels=resolve);void 0;`);
    await click('#nchatModel>button');await until('typeof finishModels==="function"');
    await js(`ctx._viewEpoch++;ctx._sessionId='work-c';controls.render();finishModels({usable:[{name:'stale',label:'旧模型'}]});
      SoduWorkAPI.myModels=async()=>({usable:[{name:'chosen',label:'已选模型'}]});void 0;`);
    await delay(40);assert.equal(await js('document.querySelector(".nmodel-pop").hidden'),true);
    report.cases.push('两个表单的 ref 同为空，旧模型列表不会重新显示或污染新选择');
    await js(`ctx._ref='live-ref';ctx._snap={adapterId:'qwen',accessPolicy:{mode:'readonly'},accessControl:support};controls.render();void 0;`);
    await click('#nchatRuntime');await until('Boolean(document.querySelector("[data-session-agent=pi]"))');await click('[data-session-agent=pi]');await until('calls.includes("live-agent:live-ref")');
    await click('#nchatModel>button');await until('Boolean(document.querySelector("[data-model-name=chosen]"))');await click('[data-model-name=chosen]');await until('calls.includes("live-model:live-ref")');
    report.cases.push('已有 ref 会话继续走原运行态 Agent/模型接口');
    assert.deepEqual(report.errors,[]);report.ok=true;
  }).catch(error=>{report.error=String(error.stack||error);}).finally(()=>{
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));win?.destroy();app.exit(report.ok?0:1);
  });
}
