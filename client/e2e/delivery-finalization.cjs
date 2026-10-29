'use strict';
// Production message renderer and card/DOM patching; synthetic snapshots, no account or model calls.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 45000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), out = path.resolve(client, '../outputs/delivery-finalization-20261014');
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-delivery-final-')));
  const report = { ok: false, cases: [], errors: [] }; let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_r, cb) => cb({ cancel: true }));
    await win.loadURL('data:text/html;charset=utf-8,<main id="chat"><div id="nchatScroll"><div id="nchatList"></div></div></main>');
    const needed = new Set(['chat-dom-patch', 'chat-decorate-carry', 'panels-chat-tools', 'chat-plugin-draft-placement', 'chat-output-links', 'chat-deliveries', 'library-transfer', 'chat-context-meter', 'chat-scroll-follow', 'chat-markdown', 'chat-acceptance-results', 'chat-message-renderer']);
    const desktop = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
    const scripts = [...desktop.matchAll(/<script src="(components\/panels\/([^/]+)\.js)"><\/script>/g)]
      .filter(match => needed.has(match[2])).map(match => match[1]);
    assert.equal(scripts.length, needed.size);
    for (const file of scripts) {
      await js(fs.readFileSync(path.join(client, file), 'utf8') + '\nvoid 0;');
    }
    await js(`
      window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      window.SoduWorkAPI={taskStorageKey:()=> 'delivery-fixture'};
      window.ctx={esc:ChatTools.esc,_ref:'delivery-final',_snap:{status:'idle',execution:{},messages:[],tools:[]},
        _liveTextKey:'',_openThink:new Set(),_closedThink:new Set(),_openTool:new Set(),_hotToolBodies:new Set(),_openToolGroup:new Set(),
        _pending:'',_pendingSentAt:0,_pendingAttachmentNames:[],_pendingPlugins:[],_sessionOptions:{},_messageWindowSize:80,
        _outs:[],_collabTasks:new Map(),_collabStarts:new Set(),_retryDraft:null,_messageAttachments:null,
        _mount:()=>chat,_api:()=>({}),_collabEntries:()=>[],_turnMetricsHtml:()=>'',_thinkingStatusHtml:()=>'',
        _syncThinkingClock:()=>{},_renderQueue:()=>{},_renderTaskStartPrompt:()=>{},_syncSlowStatusTicker:()=>{},
        _setCollabEntryStatus:()=>{},_collabEntryStatus:()=>'',_answerUi:()=>{},_goalAction:()=>{},_removeGoal:()=>{}};
      window.renderer=ChatMessageRenderer.create(ctx);
      window.user=text=>({role:'user',text,sentAt:Date.now()});
      window.answer=(text,done=true)=>({role:'assistant',done,blocks:[{kind:'text',text,done}]});
      window.file=(id,name,version=1)=>({artifactId:id,name,relative:name,kind:'website',primary:true,changedInTurn:true,at:version,size:100+version});
      window.count=()=>nchatList.querySelectorAll('.ndelivery,.noutput-library').length;
      window.render=()=>{renderer._render();return count();};
      ctx._snap.messages=[user('先介绍一下'),answer('可以，描述一下要做的网页。')];render();
      ctx._snap.messages.push(user('制作网页'),answer('页面文件正在生成',false));ctx._snap.status='streaming';ctx._snap.execution={running:true};
      ctx._outs=[file('page','index.html')];void 0;
    `);
    for (const state of [
      { status: 'streaming', execution: { running: true } },
      { status: 'idle', execution: { running: true } },
      { status: 'idle', execution: { quality: { phase: 'reviewing' } } },
      { status: 'idle', execution: { quality: { phase: 'repairing' } } },
      { status: 'waiting-user', execution: {}, pendingUi: { title: '确认' } },
      { status: 'idle', execution: { stopped: true } },
      { status: 'error', execution: {} },
    ]) {
      await js('Object.assign(ctx._snap,' + JSON.stringify({ pendingUi: null, ...state }) + ');ctx._snap.messages[3]=answer("index.html 已写入，继续验证",true);void 0;');
      assert.equal(await js('render()'), 0, JSON.stringify(state));
    }
    report.cases.push('A written/mentioned HTML file never creates a card during streaming, between tools, verification, repair, permission wait, stop or failure');
    await js(`ctx._snap={status:'idle',execution:{},tools:[],messages:[user('先介绍一下'),answer('可以'),user('制作网页'),answer('index.html 已完成') ]};void 0;`);
    assert.equal(await js('render()'), 1);
    assert.equal(await js('document.querySelector(".ndelivery").closest("[data-chat-node]").dataset.chatNode.startsWith("delivery:")'), true);
    await js(`window.originalCard=document.querySelector('.ndelivery');window.originalOwner=originalCard.parentElement;
      window.removals=0;window.observer=new MutationObserver(rows=>{for(const row of rows)for(const n of row.removedNodes)if(n===originalCard||n.contains?.(originalCard))removals++;});observer.observe(nchatList,{childList:true,subtree:true});
      ctx._pending='再改一下';ctx._pendingSentAt=Date.now()+1000;void 0;`);
    assert.equal(await js('render()'), 1, 'optimistic follow-up must retain the completed card before user echo');
    assert.equal(await js('document.querySelector(".ndelivery")===originalCard'), true);
    await js(`ctx._pending='';ctx._snap.messages.push(user('再改一下'),answer('正在修改',false));ctx._snap.status='streaming';ctx._snap.execution={running:true};void 0;`);
    for (let i = 0; i < 15; i++) {
      await js(`ctx._outs=[file('page','index.html',${i + 2}),file('notes','notes.pdf',${i + 2})];ctx._snap.messages[5].blocks[0].text+=' 新进展';ctx._snap.tools=[{id:'tool-${i}',name:'write',state:'done',after:5,args:{path:'index.html'}}];void 0;`);
      assert.equal(await js('render()'), 1);
      assert.equal(await js('document.querySelector(".ndelivery")===originalCard && originalCard.parentElement===originalOwner'), true);
    }
    await js(`ctx._snap.status='idle';ctx._snap.execution={};ctx._snap.tools=[];ctx._snap.messages[5]=answer('修改完成：index.html 和 notes.pdf');void 0;`);
    assert.equal(await js('render()'), 2);
    assert.equal(await js('originalCard.isConnected && originalCard.parentElement===originalOwner'), true);
    await js('new Promise(r=>setTimeout(r,0))');
    assert.equal(await js('removals'), 0);
    assert.equal(await js('document.querySelectorAll(".ndelivery")[1].querySelector("[data-delivery-format]").textContent'), 'ZIP 成果包');
    assert.equal(await js('document.querySelectorAll("[data-delivery-download]").length'), 0);
    report.cases.push('Optimistic send, 15 file/tool updates and completed follow-up preserve the exact old DOM card; the new ZIP result appears only once after completion');
    await js(`ctx._snap.messages.push(user('这两个文件怎么用'),answer('打开 index.html，说明见 notes.pdf'));ctx._snap.deliverySync={currentTurn:false};void 0;`);
    assert.equal(await js('render()'), 2, 'a textual follow-up mentioning unchanged results must not duplicate cards');
    assert.equal(await js('originalCard.isConnected && originalCard.parentElement===originalOwner'), true);
    report.cases.push('A text-only follow-up keeps prior cards without duplicating the unchanged files');
    await js(`observer.disconnect();renderer.reset();nchatList.innerHTML='';ctx._ref='sliding-delivery';
      ctx._outs=[file('slide-html','index.html'),file('slide-report','report.md'),file('slide-notes','notes.md')];
      window.oldPrompt=user('旧任务：写网页与说明');window.oldReply=answer('旧任务完成');
      ctx._snap={status:'idle',execution:{},tools:[],history:{messageStart:100,messageIndices:[100,101,103,105]},
        messages:[oldPrompt,answer('正在编写'),answer('正在验证'),oldReply]};void 0;`);
    assert.equal(await js('render()'), 1);
    assert.equal(await js('nchatList.querySelector(".ndelivery [data-delivery-files-count]").textContent'), '3 个文件');
    assert.equal(await js('nchatList.querySelector(".ndelivery").parentElement.dataset.messageOwner'), '105');
    await js(`ctx._outs=ctx._outs.map(f=>({...f,changedInTurn:false}));
      ctx._snap={status:'streaming',execution:{running:true},tools:[{id:'skill-read',name:'read',state:'running',after:3,args:{path:'SKILL.md'}}],
        deliverySync:{currentTurn:false},history:{messageStart:100,messageIndices:[100,105,106,108]},
        messages:[oldPrompt,oldReply,user('新任务：读取技能后整理方案'),{role:'assistant',done:false,blocks:[{kind:'thinking',text:'先阅读技能，尚未生成成果',done:false}]}]};void 0;`);
    assert.equal(await js('render()'), 1);
    assert.equal(await js('nchatList.querySelector(".ndelivery").parentElement.dataset.chatNode'), 'message:1');
    assert.equal(await js('nchatList.querySelector(".ndelivery").parentElement.dataset.messageOwner'), '105');
    assert.equal(await js('nchatList.querySelectorAll("[data-delivery-current=true] .ndelivery").length'), 0);
    report.cases.push('Noncontiguous history shifts a three-file result from local reply 3 to 1; the new thinking/skill-reading reply reusing local 3 has no result card');
    await js(`ctx._snap.messages=ctx._snap.messages.slice(1);ctx._snap.history={messageStart:105,messageIndices:[105,106,108]};
      ctx._snap.tools[0].after=2;void 0;`);
    assert.equal(await js('render()'), 1);
    assert.equal(await js('nchatList.querySelector(".ndelivery").parentElement.dataset.chatNode'), 'message:0');
    assert.equal(await js('nchatList.querySelector(".ndelivery").parentElement.dataset.messageOwner'), '105');
    assert.equal(await js('nchatList.querySelectorAll(".nmsg.user .ndelivery").length'), 0);
    assert.equal(await js('nchatList.querySelector(".nmsg.user").dataset.messageOwner'), '106');
    assert.equal(await js('nchatList.querySelectorAll(".nmsg.user[data-delivery-final],.nmsg.user[data-delivery-current]").length'), 0);
    assert.equal(await js('nchatList.querySelectorAll("[data-delivery-current=true] .ndelivery").length'), 0);
    report.cases.push('A one-message shift keeps the user own absolute identity, clears assistant delivery flags and retains the collection on the true preceding assistant');
    await js(`ctx._snap.status='idle';ctx._snap.execution={};ctx._snap.tools=[];ctx._snap.messages[2]=answer('技能读取完成，方案说明。');void 0;`);
    assert.equal(await js('render()'), 1);
    assert.equal(await js('nchatList.querySelector(".ndelivery").parentElement.dataset.messageOwner'), '105');
    assert.equal(await js('nchatList.querySelectorAll("[data-delivery-current=true] .ndelivery").length'), 0);
    report.cases.push('Settled rerender retains the old collection on its absolute reply without attributing it to an unrelated new answer');
    await js(`ctx._snap={status:'streaming',execution:{running:true},tools:[],deliverySync:{currentTurn:false},
      history:{messageStart:110,messageIndices:[110,111,112,115]},messages:[user('之后的问题'),answer('之后的回答'),user('再读技能'),
        {role:'assistant',done:false,blocks:[{kind:'thinking',text:'阅读中',done:false}]}]};void 0;`);
    assert.equal(await js('render()'), 0, 'an evicted owner must not attach its card to another historical row');
    await js(`ctx._snap.history={messageStart:210,messageIndices:[210,215,220,225]};void 0;`);
    assert.equal(await js('render()'), 0);
    assert.equal(await js('nchatList.querySelector("[data-chat-node=\\"message:3\\"]").dataset.messageOwner'), '225', 'history identity alone invalidates the streaming fast path');
    await js(`ctx._snap.status='idle';ctx._snap.execution={};ctx._snap.messages[3]=answer('技能已读完');void 0;`);
    assert.equal(await js('render()'), 0);
    report.cases.push('Evicting the original reply removes its collection; history identity changes invalidate token-only updates and never revive the collection at settlement');
    await js(`observer.disconnect();renderer.reset();nchatList.innerHTML='';ctx._ref='cloud-final';
      ctx._snap={status:'streaming',execution:{running:true,cloud:true},tools:[],cloudHandoff:{taskId:'cloud-task'},messages:[user('远端做网页'),{...answer('index.html 正在生成',false),taskId:'cloud-task'}]};
      ctx._outs=[{...file('remote','index.html'),taskId:'cloud-task',role:'output'}];void 0;`);
    assert.equal(await js('render()'), 0);
    await js(`ctx._snap.status='idle';ctx._snap.execution.running=false;ctx._snap.deliveryPending=true;ctx._snap.messages[1]={...answer('远端已完成，文件回流中'),taskId:'cloud-task'};void 0;`);
    assert.equal(await js('render()'),0,'cloud results wait for the entire local materialization');
    await js('ctx._snap.deliveryPending=false;void 0;');
    await js(`ctx._snap.status='idle';ctx._snap.execution.running=false;ctx._snap.messages[1]={...answer('远端完成'),taskId:'cloud-task'};void 0;`);
    assert.equal(await js('render()'), 1);
    await js(`window.cloudCard=document.querySelector('.ndelivery');ctx._snap.messages.push(user('继续修改'),{...answer('正在修改',false),taskId:'cloud-task'});ctx._snap.status='streaming';ctx._snap.execution.running=true;void 0;`);
    assert.equal(await js('render()'), 1);
    assert.equal(await js('document.querySelector(".ndelivery")===cloudCard'), true);
    report.cases.push('Cloud attachment arrival is gated by turn completion and a follow-up preserves the previous cloud card');
    await js(`renderer.reset();nchatList.innerHTML='';ctx._ref='local-task';ctx._snap={status:'idle',execution:{},tools:[],messages:[user('本地需求'),{...answer('完成 index.html'),taskId:'local-task'}]};ctx._outs=[file('local-task-file','index.html')];void 0;`);
    assert.equal(await js('render()'), 1, 'local task binding must not be mistaken for a cloud output namespace');
    await js(`ctx._snap.deliveryPresentation='summary';ctx._snap.messages[1]=answer('工程已修改 README.md');ctx._outs=[file('source','README.md')];void 0;`);
    assert.equal(await js('render()'), 0, 'legacy library decorator must not revive code-summary cards');
    report.cases.push('Local task-associated outputs render normally; engineering summaries suppress both unified and legacy cards');
    await js(`ctx._snap.deliveryPresentation='';ctx._snap.messages[1]=answer('完成 index.html');ctx._outs=[file('scope','index.html')];render();ctx._snap.status='streaming';ctx._snap.execution={running:true};SoduWorkAPI.taskStorageKey=()=> 'different-account';void 0;`);
    assert.equal(await js('render()'), 0, 'never preserve prior-account result DOM after scope changes');
    report.cases.push('Changing account scope does not preserve another account\'s cards');
    await js(`
      renderer.reset();nchatList.innerHTML='<div class="nmsg user">写两份报告</div>';ctx._ref='library-revisions';
      SoduWorkAPI.taskStorageKey=()=> 'delivery-fixture';
      window.libraryFiles=[{artifactId:'md-a',name:'报告.md',kind:'document',at:1,size:10,changedInTurn:true},
        {artifactId:'md-b',name:'说明.md',kind:'document',at:1,size:20,changedInTurn:true}];
      window.libraryAnswer=()=>{const m=document.createElement('div');m.className='nmsg ai';
        m.dataset.deliveryFinal='true';m.dataset.deliveryCurrent='true';
        m.innerHTML='<div class="ntext"><button data-open-app="md-a">报告.md</button><button data-open-app="md-b">说明.md</button></div>';
        nchatList.appendChild(m);return m};
      window.decorateLibrary=()=>LibraryTransfer.decorateOutputs(nchatList,libraryFiles,ctx._ref,{status:'idle',execution:{}});
      libraryAnswer();decorateLibrary();void 0;
    `);
    for (let round = 2; round <= 5; round++) {
      await js(`libraryFiles=libraryFiles.map(f=>({...f,at:${round},size:f.size+1}));libraryAnswer();decorateLibrary();void 0;`);
      assert.equal(await js('nchatList.querySelectorAll(".noutput-library").length'), 1, 'self-review edits must update one group, round ' + round);
      assert.equal(await js('nchatList.querySelectorAll(".noutput-library-row").length'), 2);
    }
    assert.equal(await js('nchatList.lastElementChild.querySelector(".noutput-library")!==null'), true);
    await js('window.stableLibraryButton=nchatList.querySelector("[data-library-output]");decorateLibrary();void 0;');
    assert.equal(await js('nchatList.querySelector("[data-library-output]")===stableLibraryButton'), true, 'unchanged decoration must preserve the save button DOM');
    report.cases.push('Five automatic self-review edits update one two-file library card on the latest reply');
    await js(`nchatList.querySelectorAll('.nmsg.ai').forEach(m=>m.dataset.deliveryCurrent='false');
      nchatList.insertAdjacentHTML('beforeend','<div class="nmsg user">请修改报告</div>');
      libraryFiles=libraryFiles.map(f=>({...f,at:6,size:f.size+1}));libraryAnswer();decorateLibrary();void 0;`);
    assert.equal(await js('nchatList.querySelectorAll(".noutput-library").length'), 2);
    report.cases.push('A later user-requested revision creates a new version card and retains the previous turn');
    await js(`nchatList.querySelectorAll('.nmsg.ai').forEach(m=>m.dataset.deliveryCurrent='false');
      nchatList.insertAdjacentHTML('beforeend','<div class="nmsg user">解释这两个文件</div>');
      libraryFiles=libraryFiles.map(f=>({...f,changedInTurn:false}));libraryAnswer();decorateLibrary();decorateLibrary();void 0;`);
    assert.equal(await js('nchatList.querySelectorAll(".noutput-library").length'), 2);
    report.cases.push('Repeated decoration and a textual follow-up mentioning unchanged files do not append cards');
    await js(`nchatList.innerHTML='<div class="nmsg user">运行</div>';libraryAnswer();decorateLibrary();
      window.interim=nchatList.lastElementChild;interim.dataset.deliveryFinal='false';libraryAnswer();decorateLibrary();void 0;`);
    assert.equal(await js('interim.querySelector(".noutput-library")'), null);
    assert.equal(await js('nchatList.querySelectorAll(".noutput-library").length'), 1);
    await js('LibraryTransfer.decorateOutputs(nchatList,libraryFiles,ctx._ref,{status:"idle",execution:{running:true}});void 0;');
    assert.equal(await js('nchatList.querySelectorAll(".noutput-library").length'), 0);
    report.cases.push('Reclassified intermediate replies and idle-but-running snapshots cannot retain current-turn file cards');
    await js(`nchatList.innerHTML='<div class="nmsg user">展示新资料</div>';libraryAnswer();decorateLibrary();
      window.savedFiles=[];SoduWorkAPI.uploadLibraryOutput=async(ref,f)=>{savedFiles.push({ref,file:f});return{ok:true}};void 0;`);
    await js('LibraryTransfer.saveDecorated(nchatList.querySelector("[data-library-output]"))');
    assert.equal(await js('savedFiles[0].file.at'), 6);
    assert.equal(await js('nchatList.querySelectorAll(".noutput-library").length'), 1);
    report.cases.push('The reconciled card keeps its library save action and the newest file metadata');
    await js(`nchatList.innerHTML='<div class="nmsg user">执行两项需求</div>'+
      '<div data-task-stream="task-A" data-delivery-final="true"><div class="nmsg user">内部需求 A</div><div class="nmsg ai"><button data-open-app="task-file-A">报告.md</button></div></div>'+
      '<div data-task-stream="task-B" data-delivery-final="true"><div class="nmsg user">内部需求 B</div><div class="nmsg ai"><button data-open-app="task-file-B">报告.md</button></div></div>';
      libraryFiles=['A','B'].map(id=>({artifactId:'task-file-'+id,taskId:'task-'+id,name:'报告.md',at:1,size:10,changedInTurn:true}));
      decorateLibrary();libraryFiles=libraryFiles.map(f=>({...f,at:2}));decorateLibrary();void 0;`);
    assert.equal(await js('nchatList.querySelectorAll(".noutput-library").length'), 2);
    assert.equal(await js('nchatList.querySelectorAll("[data-task-stream]>.noutput-library").length'), 2);
    assert.equal(await js('nchatList.querySelector("[data-task-stream=task-A] [data-library-output]").dataset.libraryOutput'), 'task-file-A');
    assert.equal(await js('nchatList.querySelector("[data-task-stream=task-B] [data-library-output]").dataset.libraryOutput'), 'task-file-B');
    report.cases.push('Nested legacy task messages never split user turns or mix same-named outputs from different tasks');
    report.errors = await js('errors'); assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(error => { report.error = error.stack; }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    if (win) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
