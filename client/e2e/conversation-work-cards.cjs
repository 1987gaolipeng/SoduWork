'use strict';
// Use real Electron DOM, forms, and card coordination with isolated storage, model, and Hub doubles.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], {env, windowsHide:true, stdio:'inherit'});
  const timer = setTimeout(() => child.kill(), 90000);
  child.on('exit', code => {clearTimeout(timer); process.exitCode = code ?? 1;});
} else {
  const {app, BrowserWindow} = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-work-cards-'));
  const out = path.resolve(process.argv[2] || path.join(client, '../outputs/conversation-work-cards-20261016'));
  fs.mkdirSync(out, {recursive:true}); app.setPath('userData', path.join(tmp, 'profile'));
  const report = {ok:false, cases:[], errors:[], realModel:false, businessDatabase:false};
  let win;
  const js = source => win.webContents.executeJavaScript(source, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(source) {for (let i=0;i<150;i++) {if (await js(source)) return; await delay(20);} throw Error('等待超时：'+source);}
  const edit = (selector, value) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const scripts = ['task-priority','task-execution-client','plugin-ui-host','requirement-routing','panels-compose-submit','panels-compose-draft',
    'conversation-attachments','work-entry-sheet','schedule-timing','work-automation-bindings','work-automation-view','work-automation-card-state','work-automation-sheet',
    'panels-chat-work-actions','chat-work-cards'];
  async function boot(persisted = {}, persistedSelections = {}) {
    await js(`window.store=${JSON.stringify(persisted)}; window.calls={parse:0,create:0,schedule:0,reserve:0,uploads:0};window.tasks=[];window.authScope='alice';
      window.draftSelections=${JSON.stringify(persistedSelections)};
      window.toasts=[];window.petSay=t=>toasts.push(t);window.uid=()=>crypto.randomUUID();window.save=()=>{};
      window.Requirements={dateTimestamp:()=>null};window.Store={persistTask:async()=>{calls.create++;if(window.holdTask)await new Promise(r=>window.finishTask=r);return true;}};
      window._schmLoad=async()=>[{key:'plugin-report',name:'报告插件',version:'1.0',checksum:'a'.repeat(64),inputs:[{key:'format',label:'格式',type:'text'}]}];
      window.SoduWorkAPI={taskStorageKey:()=>authScope,listTeammates:async()=>({mates:[]}),
        parseTaskText:async text=>{calls.parse++;if(window.holdParse)await new Promise(r=>window.finishParse=r);return {title:'解析标题',note:text,checklist:['验收一'],kind:'bug'};},
        uploadAttachment:async(id,file)=>{calls.uploads++;return {id:'attachment-'+calls.uploads,filename:file.name,size:file.size};},
        taskExecutionOptions:async()=>({substrates:[{key:'local:pi',name:'Pi',cli:'pi',available:true}],repos:[{id:'repo-a',name:'示例工程'}]}),
        preflightSchedule:async()=>({state:'ready'}),createSchedule:async body=>{calls.schedule++;if(window.holdSchedule)await new Promise(r=>window.finishSchedule=r);return {...body,id:'schedule-'+calls.schedule};}};
      window.native={reserveWorkConversation:async({title,draftSelection})=>{calls.reserve++;const sessionId='session-'+calls.reserve;
          draftSelections[sessionId]={draftSelection:structuredClone(draftSelection),draftSelectionRevision:1};
          return {ok:true,sessionId,title,...structuredClone(draftSelections[sessionId]),snapshot:{status:'idle',messages:[],tools:[],workOnly:true}};},
        workCards:async id=>({ok:true,workOnly:true,cards:Object.values(store[id]||{}),presence:{title:'工作记录'},...structuredClone(draftSelections[id]||{})}),
        saveWorkDraftSelection:async(id,{selection,revision})=>{
          const previous=draftSelections[id];
          if(!previous)return {ok:false,reason:'会话不存在'};
          if(previous.draftSelectionRevision!==revision)return {ok:false,code:'STALE_DRAFT_SELECTION',reason:'选择版本已变化'};
          draftSelections[id]={draftSelection:structuredClone(selection),draftSelectionRevision:revision+1};
          return {ok:true,...structuredClone(draftSelections[id])};},
        saveWorkCard:async(id,card)=>{store[id]||={};const saved={...structuredClone(card),revision:(card.revision||0)+1};store[id][card.id]=saved;return {ok:true,card:saved};}};
      window.ctx={_viewEpoch:0,_sessionId:'',_ref:'',_draftKey:'new',_sessionOptions:{},_api:()=>native,_mount:()=>document.body,
        _render(){const list=document.getElementById('nchatList');
          const slots=(window.cards?.timeline(ctx._snap?.messages||[])||[]).map(card=>{
            const slot=[...list.children].find(node=>node.dataset.workCardSlot===card.id)||document.createElement('section');
            slot.dataset.chatNode='work-card:'+card.id;slot.dataset.workCardSlot=card.id;return slot;});
          list.replaceChildren(...slots);},refreshHistory(){},_workModel:()=>'',
        _chatDraftBridge:()=>({}),async _openWorkAction(command,options={}){const seed=await cards.prepare(command,options);return seed&&ChatWorkActions.open(command,seed,
          {mount:()=>document.body,dismissProposal(){},bridge:()=>({})});}};
      window.chatFiles=[];window.openCard=(id,text)=>ctx._openWorkAction({id,text},{bridge:{atts:()=>chatFiles}});
      window.leave=()=>{cards.detach();WorkEntrySheet.close(false,true);ctx._viewEpoch++;ctx._sessionId='';document.querySelector('.nchat-draft').replaceChildren();document.getElementById('nchatList').replaceChildren();};
      window.go=async id=>{leave();ctx._sessionId=id;await cards.restore(id);};void 0;`);
    for (const name of scripts) await js(fs.readFileSync(path.join(client,'components/panels',name+'.js'),'utf8')+'\nvoid 0;');
    await js(fs.readFileSync(path.join(client,'components/requirements/requirement-fields.js'),'utf8')+'\nwindow.cards=ChatWorkCards.create(ctx);void 0;');
  }
  app.whenReady().then(async()=>{
    const desk=fs.readFileSync(path.join(client,'desk.html'),'utf8');
    const styles=[...desk.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(m=>fs.readFileSync(path.join(client,m[1]),'utf8')).join('\n');
    const page=path.join(tmp,'fixture.html');
    fs.writeFileSync(page,'<!doctype html><meta charset="utf-8"><style>'+styles+'body{padding:24px}#nchatList,.nchat-draft{max-width:850px;margin:auto}</style><main id="nchatList"></main><section class="nchat-draft"></section><textarea id="nchatInput"></textarea>');
    win=new BrowserWindow({show:false,width:1100,height:1100,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_r,cb)=>cb({cancel:true}));
    win.webContents.on('console-message',event=>{if(event.level==='error') report.errors.push(event.message);});
    await win.loadFile(page); await boot();
    await js(`chatFiles=[new File(['完整原件尾部'],'原型.html',{type:'text/html'})];openCard('work.requirement.create','参考原型整理需求');void 0;`);
    await until('Boolean(document.querySelector("#cpTitle"))');
    const a=await js('ctx._sessionId'); assert.ok(a);
    await edit('#cpTitle','手动保留的标题'); await edit('#cpNote','详细说明与尾部约束'); await edit('#cpKind','improvement');
    await js('cards.capture();cards.flush()'); const parse=await js('calls.parse');
    await js(`go(${JSON.stringify(a)})`); await until('Boolean(document.querySelector("#cpTitle"))');
    assert.equal(await js('document.querySelector("#cpTitle").value'),'手动保留的标题');
    assert.equal(await js('document.querySelector("#cpKind").value'),'improvement');
    assert.equal(await js('WorkEntrySheet.capture().files[0].text()'),'完整原件尾部');
    assert.equal(await js('calls.parse'),parse); report.cases.push('需求草稿切换恢复手改字段和附件原件，不重新解析');
    await js('window.holdTask=true;document.querySelector("#cpCreate").click();void 0;'); await until('Boolean(window.finishTask)');
    await js(`go(${JSON.stringify(a)})`); await until('Boolean(document.querySelector("#cpCreate"))');
    assert.equal(await js('document.querySelector("#cpCreate").disabled'),true);
    await js('finishTask();void 0;'); await until('Boolean(document.querySelector(".cp-ok"))'); await js('cards.flush()');
    assert.equal(await js('calls.create'),1); assert.equal(await js('calls.uploads'),1);
    report.cases.push('需求提交中切换再回保持禁用，完成回执落原会话且不重复建单上传');
    await js(`go(${JSON.stringify(a)})`); await until('Boolean(document.querySelector(".cp-ok"))');
    assert.equal(await js('document.querySelectorAll("[data-wes-material]").length'),2);
    report.cases.push('需求结果卡恢复，相关材料仍可查看下载');
    await js(`window.openDetailEntry=id=>{window.detailTask=id;leave();};
      document.querySelector('#cpOpen').click();cards.flush();`);
    assert.ok(await js('detailTask'));
    await js(`go(${JSON.stringify(a)})`);
    await until('Boolean(document.querySelector(".cp-ok"))');
    assert.equal(await js('document.querySelectorAll("[data-wes-close],[data-cp-receipt-close],#cpCancel").length'),0);
    assert.equal(await js('WorkEntrySheet.capture().receipt.id===detailTask'),true);
    assert.equal(await js('calls.create'),1);
    report.cases.push('查看详情返回原会话恢复同一回执，无关闭按钮、不重复创建');
    await js(`chatFiles=[];openCard('work.automation.create','2030年10月20日中午12点生成报告');void 0;`);
    await until('Boolean(document.querySelector("#wazForm"))');
    await edit('[name="title"]','手改自动化'); await edit('[name="repoId"]','repo-a'); await edit('[name="personalPluginKey"]','plugin-report');
    await edit('[data-waz-method-input="format"]','CSV 尾部参数');
    await js('cards.capture();cards.flush()');
    const before=await js('WorkAutomationSheet.capture().proposal'); const count=await js('calls.parse');
    await js(`go(${JSON.stringify(a)})`); await until('Boolean(document.querySelector("#wazForm"))');
    const after=await js('WorkAutomationSheet.capture().proposal');
    for (const field of ['runAt','timeZone','repoId','personalPluginKey','pluginInputs']) assert.deepEqual(after[field],before[field],field);
    assert.equal(await js('calls.parse'),count); report.cases.push('自动化草稿恢复原时区日期、工程、插件参数，不重新推断预约');
    await js('window.holdSchedule=true;document.querySelector("[data-waz-save]").click();void 0;');await until('Boolean(window.finishSchedule)');
    await js(`go(${JSON.stringify(a)})`);await until('Boolean(document.querySelector("[data-waz-save]"))');
    assert.equal(await js('document.querySelector("[data-waz-save]").disabled'),true);
    await js('finishSchedule();void 0;');await until('Boolean(document.querySelector(".waz-saved"))');await js('cards.flush()');
    assert.equal(await js('calls.schedule'),1);report.cases.push('自动化保存中切换再回只创建一次，原卡接收结果');
    assert.equal(await js('document.querySelectorAll(".nchat-work-record").length'),1);report.cases.push('同一会话先后创建需求和自动化，两份结果共同留存');
    const persisted=await js('store'), persistedSelections=await js('draftSelections');
    await win.loadFile(page); await boot(persisted,persistedSelections); await js(`ctx._sessionId=${JSON.stringify(a)};cards.restore(ctx._sessionId)`);
    await until('Boolean(document.querySelector(".waz-saved"))'); assert.equal(await js('calls.parse'),0);assert.equal(await js('calls.schedule'),0);assert.equal(await js('calls.create'),0);
    report.cases.push('页面重载后从序列化记录恢复结果，无解析、创建或执行副作用');
    assert.ok(await js('document.querySelector(".waz-saved").getBoundingClientRect().height > 0'));
    await delay(250);
    fs.writeFileSync(path.join(out,'restored-cards.png'),(await win.webContents.capturePage()).toPNG());
    assert.deepEqual(report.errors,[]);report.ok=true;
  }).catch(async error=>{report.error=String(error.stack||error);
    report.failure=await js('({text:document.body.innerText,toasts,calls,sessionId:ctx._sessionId,store})').catch(()=>null);
  }).finally(()=>{
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));win?.destroy();app.exit(report.ok?0:1);
  });
}
