'use strict';
// Reproduce an empty creation card after opening details or collaboration from an inline requirement receipt.
// Use real Electron DOM and production card coordination with isolated storage and model doubles.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], {env, windowsHide:true, stdio:'inherit'});
  const timer = setTimeout(() => child.kill(), 120000);
  child.on('exit', code => {clearTimeout(timer); process.exitCode = code ?? 1;});
} else {
  const {app, BrowserWindow} = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const client = path.resolve(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-empty-req-'));
  const out = path.resolve(process.argv[2] || path.join(client, '../outputs/repro-empty-req'));
  fs.mkdirSync(out, {recursive:true}); app.setPath('userData', path.join(tmp, 'profile'));
  const report = {ok:false, steps:[], errors:[]};
  let win;
  const js = source => win.webContents.executeJavaScript(source, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(source) {for (let i=0;i<200;i++) {if (await js(source)) return; await delay(20);} throw Error('等待超时：'+source);}
  async function snap(label) {
    const state = await js(`(()=>{
      const host=document.querySelector('.nchat-draft');
      const box=document.getElementById('wesTaskDraft');
      return {
        surfaceCount: host?host.querySelectorAll('.pui-surface').length:0,
        surfaceClasses: host?[...host.querySelectorAll('.pui-surface')].map(n=>n.className):[],
        boxConnected: Boolean(box&&box.isConnected),
        boxHtml: box?box.innerHTML:'', boxLength: box?box.innerHTML.length:0,
        hostHtmlLength: host?host.innerHTML.length:0,
        revisionBars: document.querySelectorAll('.pui-revision-bar').length,
        cards: Object.values(window.store[window.ctx._sessionId]||{}).map(c=>({id:c.id,phase:c.state&&c.state.phase,receipt:Boolean(c.state&&c.state.receipt),closed:c.closed}))
      };})()`);
    report.steps.push({label, ...state});
    fs.writeFileSync(path.join(out, label.replace(/[^\w-]+/g,'_')+'.png'), (await win.webContents.capturePage()).toPNG());
    return state;
  }
  const edit = (selector, value) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const scripts = ['task-priority','task-execution-client','plugin-ui-host','requirement-routing','panels-compose-submit','panels-compose-draft',
    'conversation-attachments','work-entry-sheet','schedule-timing','work-automation-bindings','work-automation-view','work-automation-card-state','work-automation-sheet',
    'panels-chat-work-actions','chat-work-cards'];
  async function boot(persisted = {}) {
    await js(`window.store=${JSON.stringify(persisted)}; window.calls={parse:0,create:0,reserve:0,uploads:0};
      window.tasks=[];window.authScope='alice';window.toasts=[];window.petSay=t=>toasts.push(t);
      window.uid=()=>crypto.randomUUID();window.save=()=>{};
      window.Requirements={dateTimestamp:()=>null};
      window.Store={persistTask:async()=>{calls.create++;if(window.holdTask)await new Promise(r=>window.finishTask=r);return true;}};
      window._schmLoad=async()=>[];
      window.SoduWorkAPI={taskStorageKey:()=>authScope,listTeammates:async()=>({mates:[]}),
        parseTaskText:async text=>{calls.parse++;return {title:'开发找茬小游戏',note:text,checklist:['能玩一局'],kind:'requirement'};},
        uploadAttachment:async(id,file)=>({id:'att-'+calls.uploads++,filename:file.name,size:file.size}),
        taskExecutionOptions:async()=>({substrates:[{key:'local:pi',name:'Pi',cli:'pi',available:true}],repos:[{id:'repo-a',name:'示例工程'}]}),
        preflightSchedule:async()=>({state:'ready'}),createSchedule:async body=>({...body,id:'schedule-x'})};
      window.native={reserveWorkConversation:async({title})=>{calls.reserve++;return {ok:true,sessionId:'session-'+calls.reserve,title};},
        workCards:async id=>({ok:true,workOnly:true,cards:Object.values(store[id]||{}),presence:{title:'工作记录'}}),
        saveWorkDraftSelection:async(id,payload)=>({ok:true,draftSelection:payload.selection,draftSelectionRevision:(payload.revision||0)+1}),
        saveWorkCard:async(id,card)=>{store[id]||={};const saved={...structuredClone(card),revision:(card.revision||0)+1};store[id][card.id]=saved;return {ok:true,card:saved};}};
      window.collabBound=[];window.renders=0;
      window.ctx={_viewEpoch:0,_sessionId:'',_ref:'',_draftKey:'new',_sessionOptions:{},_taskAttachments:[],_api:()=>native,
        _mount:()=>document.body,_render(){renders++;document.getElementById('nchatList').textContent='消息 '+renders;},refreshHistory(){},
        _workModel:()=>'',_bindCollaborationTask(id,title){collabBound.push([id,title]);ctx._render();return true;},
        async _send(text,options){return true;},
        async _openWorkAction(command,options={}){const seed=await cards.prepare(command,options);return seed&&ChatWorkActions.open(command,seed,
          {mount:()=>document.body,dismissProposal(){},bridge:()=>(typeof window.composeDraftBridge==='function'?window.composeDraftBridge():{}),model:()=>''});}};
      window.chatFiles=[];window.openCard=(id,text,opts={})=>{if(opts.failAttach){window.ConversationAttachments.create=(o)=>{throw new Error('failAttach');};}return ctx._openWorkAction({id,text},{bridge:{atts:()=>chatFiles}});};
      window.leave=()=>{cards.detach();WorkEntrySheet.close(false,true);ctx._viewEpoch++;ctx._sessionId='';document.querySelector('.nchat-draft').replaceChildren();document.getElementById('nchatList').textContent='';};
      window.go=async id=>{leave();ctx._sessionId=id;try{await cards.restore(id);}catch(e){window.goError=String(e&&e.stack||e);}};void 0;`);
    for (const name of scripts) await js(fs.readFileSync(path.join(client,'components/panels',name+'.js'),'utf8')+'\nvoid 0;');
    await js(fs.readFileSync(path.join(client,'components/requirements/requirement-fields.js'),'utf8')+'\nwindow.cards=ChatWorkCards.create(ctx);void 0;');
  }
  app.whenReady().then(async()=>{
    const desk=fs.readFileSync(path.join(client,'desk.html'),'utf8');
    const styles=[...desk.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(m=>fs.readFileSync(path.join(client,m[1]),'utf8')).join('\n');
    const page=path.join(tmp,'fixture.html');
    fs.writeFileSync(page,'<!doctype html><meta charset="utf-8"><style>'+styles+'body{padding:24px}.nchat-draft{max-width:850px;margin:auto}#nchatList{padding:8px}</style>'+
      '<main class="nchat-draft"></main><div id="nchatList"></div><textarea id="nchatInput"></textarea>');
    win=new BrowserWindow({show:false,width:1100,height:1100,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_r,cb)=>cb({cancel:true}));
    win.webContents.on('console-message',event=>{if(event.level==='error') report.errors.push(event.message);});
    await win.loadFile(page); await boot();

    // Open an inline requirement form from a task-creation request.
    await js(`openCard('work.requirement.create','帮我创建一个找茬小游戏');void 0;`);
    await until('Boolean(document.querySelector("#cpTitle"))');
    await snap('1-draft-open');
    const sid = await js('ctx._sessionId');

    // Create the requirement and inspect its receipt.
    await edit('#cpTitle','开发找茬小游戏');
    await js('document.querySelector("#cpCreate").click();void 0;');
    await until('Boolean(document.querySelector(".cp-ok"))');
    await snap('2-receipt');

    // Open collaboration from the receipt for an unassigned self-created requirement.
    const openLabel = await js('document.querySelector("#cpOpen")?.textContent||""');
    await js('(()=>{const btnEl=document.querySelector("#cpOpen");if(btnEl)btnEl.click();})();void 0;');
    await delay(120);
    await snap('3-after-open-click');
    report.collabBoundAfterClick = await js('window.collabBound');

    // Navigate away and return before opening details from the conversation.
    await js(`go(${JSON.stringify(sid)})`);
    report.goError = await js('window.goError||null');
    await delay(400);
    const backState = await snap('4-back-in-session');

    // If the restored form is empty, retry the receipt action when present.
    report.backBoxEmpty = backState.boxLength === 0;
    if (backState.boxLength === 0) {
      await js('(()=>{const btnEl=document.querySelector("#cpOpen");if(btnEl)btnEl.click();})();void 0;');
      await delay(120);
      await snap('5-empty-then-click');
    }

    // Open details through the close-then-openDetails entry flow.
    await js('window.detailCalls=[];window.openDetailEntry=id=>window.detailCalls.push(id);void 0;');
    await js('(()=>{const btnEl=document.querySelector("#cpOpen");if(btnEl)btnEl.click();})();void 0;');
    await delay(150);
    await snap('5-after-view-detail');
    report.detailCalls = await js('window.detailCalls');

    // Navigate away and return to verify card activation and content.
    await js(`go(${JSON.stringify(sid)})`);
    await delay(400);
    const finalState = await snap('6-reenter-after-detail');
    report.finalBoxEmpty = finalState.boxLength === 0;

    // Inspect paint state before selecting history when an empty form appears.
    // Inject a synchronous attachment-construction error after mount and before render.
    // Attachment failure should show feedback while the form still renders.
    await js(`openCard('work.requirement.create','帮我创建一个跳一跳小游戏',{failAttach:true});void 0;`);
    await delay(400);
    const s12 = await snap('12-throw-before-render');
    report.throwRepro = { boxLength: s12.boxLength, surfaceCount: s12.surfaceCount,
      empty: s12.boxLength === 0 && s12.surfaceCount > 0,
      healed: s12.boxLength > 200 };

    // Verify that clearing the initial content is repaired by repaint within 150ms.
    await js('(()=>{const b=document.getElementById("wesTaskDraft");if(b)b.innerHTML="";})();void 0;');
    await delay(350);
    const s13 = await snap('13-selfheal-after-wipe');
    report.selfHeal = { boxLength: s13.boxLength, healed: s13.boxLength > 200,
      surfaceCount: s13.surfaceCount };
    report.toasts = await js('window.toasts');
    report.ok = Boolean(report.throwRepro.healed && report.selfHeal.healed);
  }).catch(error=>{report.error=String(error.stack||error);}).finally(()=>{
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2)); win?.destroy(); app.exit(report.ok?0:1);
  });
}
