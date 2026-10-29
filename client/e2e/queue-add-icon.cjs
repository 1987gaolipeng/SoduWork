'use strict';
// Exercise production queue and task picker with synthetic data, in a fresh profile.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw Error('Absolute evidence directory required');
fs.mkdirSync(root, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-add-icon-')));
const report = { ok: false, checks: [] }; let win;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code, true);
const add = '[data-queue-action="add"]';
async function until(code) {
  for (let i = 0; i < 100; i++) { if (await js(code)) return; await delay(40); }
  throw Error('Timeout: ' + code);
}
async function click(selector) {
  await delay(220);
  const point = await js('(()=>{const e=document.querySelector(' + JSON.stringify(selector) + ');e.scrollIntoView({block:"nearest"});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await delay(80);
}
async function shot(name) {
  await delay(160);
  fs.writeFileSync(path.join(root, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
async function assertDocked() {
  const geometry = await js(`(()=>{
    const q=s=>document.querySelector(s),rect=s=>q(s).getBoundingClientRect();
    const curve=rect('.nqueue-add-curve'),input=rect('.nbox'),button=rect('[data-queue-action="add"]');
    const rows=q('.nqueue-items'),goal=q('.nqueue-goal-slot > .wi-rail.show');
    const surface=goal?goal.getBoundingClientRect():rows.children.length?rows.getBoundingClientRect():input;
    const dock=rect('.nchat-entry-dock'),stream=rect('#transcript');
    const blank=document.elementFromPoint(input.left+8,surface.top-15);
    return {gap:surface.top-button.bottom,seam:curve.bottom-surface.top,inside:curve.left>=input.left&&curve.right<=input.right,
      curveWidth:curve.width,curveHeight:curve.height,coarse:matchMedia('(pointer:coarse)').matches,
      spanRiseRatio:(q('.nqueue-curve-edge').getBBox().width/2)/q('.nqueue-curve-edge').getBBox().height,
      controlsClear:[...q('.nqueue-stack').querySelectorAll('.nqueue-row button,.nqueue-row summary,.wi-rail-toggle,.wi-rail-action')].filter(e=>e.checkVisibility()&&(!e.closest('details:not([open])')||e.tagName==='SUMMARY')).every(e=>{const r=e.getBoundingClientRect();
        if(rows.scrollTop>0&&e.closest('.nqueue-items')){const clip=rows.getBoundingClientRect(),top=Math.max(r.top,clip.top),bottom=Math.min(r.bottom,clip.bottom);
          if(bottom<=top)return true;return e.contains(document.elementFromPoint(r.x+r.width/2,(top+bottom)/2));}
        return r.left>=button.right||r.right<=button.left||r.top>=button.bottom||r.bottom<=button.top;}),
      inputClear:button.bottom<=input.top+parseFloat(getComputedStyle(q('#nchatInput')).paddingTop),
      safe:stream.bottom-parseFloat(getComputedStyle(q('#transcript')).paddingBottom)<=dock.top+1,stableShoulder:!!blank?.closest('.nchat-entry-dock'),
      overflow:document.documentElement.scrollWidth>innerWidth+1,
      center:button.x+button.width/2-input.x-input.width/2,
      right:input.right-button.right};
  })()`);
  assert.ok(Math.abs(geometry.gap+(geometry.coarse?8:4))<1, JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.spanRiseRatio-1.618)<.02, 'Golden-ratio reference for the half-span and rise: '+JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.seam-2)<1, JSON.stringify(geometry));
  assert.ok(geometry.curveWidth<=108 && geometry.curveHeight<=40, 'Keep the cap low and compact: '+JSON.stringify(geometry));
  assert.ok(geometry.controlsClear && geometry.inputClear, 'Inset button must not cover text or queue controls: '+JSON.stringify(geometry));
  assert.ok(geometry.inside && geometry.safe && geometry.stableShoulder && !geometry.overflow, JSON.stringify(geometry));
  return geometry;
}
async function assertTransparentShoulders() {
  const probe = await js(`(()=>{
    const stream=document.querySelector('#transcript'),line=stream.querySelectorAll('p')[40];
    line.innerHTML='<a href="#body-link" id="body-link">正文链接仍可阅读和点击，不应被灰色背景遮挡。</a>';
    const link=line.firstElementChild;link.onclick=e=>{e.preventDefault();window.bodyLinkClicks=(window.bodyLinkClicks||0)+1;};
    const toolbar=document.querySelector('.nqueue-toolbar').getBoundingClientRect();
    stream.scrollTop+=link.getBoundingClientRect().top-(toolbar.top+5);
    const r=link.getBoundingClientRect(),x=Math.ceil(r.left+5),y=Math.ceil(r.top+7);
    const layers=['.nchat-foot','.nchat-footin','.nchat-entry-dock','.nchat-queue','.nqueue-stack','.nqueue-toolbar'];
    const hit=document.elementFromPoint(x,y);
    return {x,y,stableHit:!!hit?.closest('.nchat-entry-dock'),cursor:getComputedStyle(hit).cursor,
      backgrounds:layers.map(s=>{const c=getComputedStyle(document.querySelector(s));return [c.backgroundColor,c.backgroundImage,c.backdropFilter];}),
      crop:{x:Math.ceil(r.left),y:Math.ceil(r.top),width:120,height:16}};
  })()`);
  // The committed cursor-flicker fix keeps the transparent dock as a stable hit region.
  assert.ok(probe.stableHit, 'The transparent shoulder must retain its stable dock target: '+JSON.stringify(probe));
  assert.equal(probe.cursor, 'default');
  for(const layer of probe.backgrounds) assert.deepEqual(layer,['rgba(0, 0, 0, 0)','none','none']);
  // Compare the transparent layers without the intentional composer shadow,
  // which otherwise disappears together with the hidden footer in the baseline.
  const shadow=await js('(()=>{const e=document.querySelector(".nbox"),value=e.style.boxShadow;e.style.boxShadow="none";return value})()');
  await delay(120);
  const visible=(await win.webContents.capturePage(probe.crop)).toBitmap();
  await js('document.querySelector(".nchat-foot").style.visibility="hidden"');
  await delay(120);
  const uncovered=(await win.webContents.capturePage(probe.crop)).toBitmap();
  await js('document.querySelector(".nchat-foot").style.visibility=""');
  await js('document.querySelector(".nbox").style.boxShadow='+JSON.stringify(shadow));
  assert.deepEqual(visible,uncovered,'Floating shoulder must not tint or blur the text pixels');
  const before=await js('window.bodyLinkClicks||0');
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:probe.x,y:probe.y});
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:probe.x,y:probe.y});
  await delay(80);
  assert.equal(await js('window.bodyLinkClicks||0'), before, 'The stable dock must not activate content behind it');
  const exposed=await js(`(()=>{
    const stream=document.querySelector('#transcript'),link=document.querySelector('#body-link');
    const dock=document.querySelector('.nchat-entry-dock').getBoundingClientRect();
    stream.scrollTop+=link.getBoundingClientRect().bottom-(dock.top-8);
    const r=link.getBoundingClientRect(),x=Math.ceil(r.left+5),y=Math.ceil(r.top+7);
    return {x,y,hit:document.elementFromPoint(x,y)===link};
  })()`);
  assert.ok(exposed.hit, 'Scrolling the transcript link above the dock must restore normal interaction');
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:exposed.x,y:exposed.y});
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:exposed.x,y:exposed.y});
  await until('window.bodyLinkClicks==='+String(before+1));
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1160, height: 720, webPreferences: {
    offscreen: true, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false
  } });
  await win.loadFile(path.join(__dirname, 'fixtures/task-queue-removal.html'));
  await until('window.fixtureReady===true');
  const button = await js('(()=>{const e=document.querySelector(\'' + add + '\'),r=e.getBoundingClientRect(),t=e.closest(".nqueue-toolbar").getBoundingClientRect();return {text:e.textContent.trim(),label:e.getAttribute("aria-label"),title:e.title,width:r.width,height:r.height,offset:r.x+r.width/2-t.x-t.width/2}})()');
  assert.equal(button.text, ''); assert.equal(button.label, '添加需求'); assert.equal(button.title, '添加需求');
  assert.equal(button.width, 28); assert.equal(button.height, 28); assert.ok(Math.abs(button.offset) < 1);
  await shot('empty'); report.checks.push('icon-only 28px button sits in a low compact cap, with tooltip and accessible name');
  const crop=await js('(()=>{const r=document.querySelector(".nchat-entry-dock").getBoundingClientRect();return {x:Math.floor(r.x-12),y:Math.floor(r.y-12),width:Math.ceil(r.width+24),height:Math.ceil(r.height+24)}})()');
  fs.writeFileSync(path.join(root,'composer-detail.png'),(await win.webContents.capturePage(crop)).toPNG());
  const colors = [], backgrounds = [];
  for (const theme of ['azure', 'warm', 'minimal', 'steady']) {
    await js('document.documentElement.dataset.theme=' + JSON.stringify(theme));
    await delay(200);
    colors.push(await js('getComputedStyle(document.querySelector(\'' + add + '\')).color'));
    const circle=await js('(()=>{const e=document.querySelector(\''+add+'\'),s=getComputedStyle(e);return {background:s.backgroundColor,radius:parseFloat(s.borderRadius),width:e.getBoundingClientRect().width,fill:getComputedStyle(document.querySelector(".nqueue-curve-fill")).fill,surface:getComputedStyle(document.querySelector(".nbox")).backgroundColor}})()');
    assert.notEqual(circle.background, 'rgba(0, 0, 0, 0)');
    assert.notEqual(circle.background, circle.fill);
    assert.equal(circle.fill, circle.surface, 'the cap follows its composer surface in every theme');
    assert.ok(circle.radius>=circle.width/2);
    backgrounds.push(circle.background);
  }
  // Composer actions share the neutral palette introduced in 6d0977206.
  assert.deepEqual(colors, Array(4).fill('rgb(59, 61, 66)'));
  assert.deepEqual(backgrounds, Array(4).fill('rgb(241, 242, 244)'));
  report.checks.push('the neutral icon and visible circular background stay consistent across four themes; the cap matches each composer surface');
  await js('document.documentElement.dataset.theme="azure"');
  await click(add); await until('!!document.querySelector("[data-collab-picker-close]")');
  assert.equal(await js('document.querySelectorAll("[data-collab-task-select]").length'), 2);
  await shot('picker'); await click('[data-collab-picker-close]');
  report.checks.push('real mouse click opens the task picker and close works');
  await js('fixtureContext._snap.execution.queue=[{id:"message-one",text:"整理当前进展"},{id:"task-one",taskId:"one",taskTitle:"整理开源项目",text:"完整说明"}];fixtureContext._render()');
  assert.equal(await js('document.querySelectorAll(".nqueue-row").length'), 2);
  assert.ok(await js('(()=>{const e=document.querySelector(\'' + add + '\'),r=e.getBoundingClientRect(),t=e.closest(".nqueue-toolbar").getBoundingClientRect();return r.x>t.x+t.width/2})()'));
  await shot('queued');
  await js('document.querySelector(\'' + add + '\').focus()');
  assert.equal(await js('document.activeElement?.getAttribute("data-queue-action")'), 'add');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' });
  win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' });
  await until('!!document.querySelector("[data-collab-picker-close]")');
  await click('[data-collab-picker-close]');
  assert.equal(await js('document.querySelectorAll(".nqueue-row").length'), 2);
  assert.equal(await js('sent.length'), 0);
  assert.deepEqual(await js('fixtureErrors'), []);
  report.checks.push('mixed queue keeps right-aligned icon; Enter opens picker without sending or modifying queued work');
  await assertDocked();
  await js('document.querySelector("#transcript").innerHTML=Array.from({length:80},(_,i)=>"<p>可滚动的正文段落 "+i+" · 查看完整工作进展。</p>").join("")');
  for (const theme of ['azure','warm','minimal','steady']) {
    await js('document.documentElement.dataset.theme='+JSON.stringify(theme));
    await assertTransparentShoulders();
  }
  await js('document.documentElement.dataset.theme="azure"');
  await shot('transparent-queued-shoulders');
  report.checks.push('all four themes: body-link pixels remain unchanged behind the stable dock; scrolling above it restores link clicks');
  for (const width of [1160, 760, 390]) {
    win.setSize(width, 780); await delay(120);
    const before = await assertDocked();
    await js('document.querySelector("#transcript").scrollTop=100000');
    const after = await assertDocked();
    assert.equal(after.right, before.right);
    await js('document.querySelector("#nchatInput").style.height="180px"');
    await assertDocked();
    await js('fixtureContext._snap.execution.queue=[];fixtureContext._render()');
    assert.ok(Math.abs((await assertDocked()).center)<1);
    await assertTransparentShoulders();
    if (width===1160) await shot('transparent-empty-shoulders');
    await js('document.querySelector("#transcript").scrollTop=100000');
    assert.ok(await js('document.querySelector("#transcript p:last-child").getBoundingClientRect().bottom<=document.querySelector(".nchat-entry-dock").getBoundingClientRect().top'));
    if (width===390) await shot('narrow');
    await js('fixtureContext._snap.execution.queue=[{id:"message-one",text:"整理当前进展"}];fixtureContext._render()');
  }
  report.checks.push('1160px / 760px / 390px: curve remains joined, scrolling and taller input do not drift; final paragraph stays visible and transparent shoulder retains a stable hit target');
  await js('fixtureContext._collabEntries=()=>[{taskId:"done",nativeTurn:true,task:{title:"已交付的阶段结果"},fixtureState:"completed"}];fixtureContext._collabEntryStatus=entry=>entry.fixtureState;fixtureContext._snap.execution.queue=[{id:"running-one",taskId:"active",taskTitle:"示例企业产业链每日分析",status:"streaming"},{id:"waiting-one",taskId:"pending",taskTitle:"水泥原材料及产品价格盘点"}];fixtureContext._render()');
  await js('fixtureContext._snap.execution.running=true;fixtureContext._snap.execution.turnQueue={activeTaskId:"active",tasks:[]};fixtureContext._render()');
  assert.equal(await js('document.querySelector(".nqueue-state").textContent'),'执行中');
  assert.ok(await js('document.querySelector(".nqueue-state .nqueue-progress")'));
  assert.ok(await js('[...document.querySelectorAll(".nqueue-row")].every(e=>e.getBoundingClientRect().height<=34)'));
  for (const width of [1160,760,390]) {
    win.setSize(width,780);await delay(100);
    await js('document.querySelector("#transcript").scrollTop=100000');
    await assertDocked();
    assert.ok(await js('(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();return r("[data-queue-action=history]").top>=r(".nqueue-toolbar").top&&r("#transcript p:last-child").bottom<=r("[data-queue-action=history]").top&&r(".nqueue-items").bottom<=r(".nbox").top+1})()'));
    await click('[data-queue-action="history"]');
    await js('document.querySelector("#transcript").scrollTop=100000');
    assert.ok(await js('document.querySelector("#transcript p:last-child").getBoundingClientRect().bottom<=document.querySelector(".nchat-foot").getBoundingClientRect().top'));
    await shot('completed-running-'+width);
    await click('[data-queue-action="history"]');
  }
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await js('getComputedStyle(document.querySelector(".nqueue-progress")).animationName'),'none');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});win.webContents.debugger.detach();
  report.checks.push('34px compact rows; streaming state has a trailing progress ring; completed history occupies layout at all three widths; reduced-motion stops animation');
  win.setSize(1160, 780); await delay(120);
  await js(`document.querySelector('.nchat-entry-dock').insertAdjacentHTML('afterbegin',WorkIntent.rail('nchat'));
    window.goalClicks={resume:0,pause:0,clear:0};
    window.paintGoal=state=>WorkIntent.showGoal(document.querySelector('main'),{mode:'goal',goal:'完成产品介绍网站',acceptance:'页面可打开；通过检查'},'nchat',{
      phases:[{key:'understand',state:'completed'},{key:'plan',state:'completed'},{key:'execute',state:'blocked'}],
      ...state,onResume(){goalClicks.resume++;paintGoal({busy:true})},onPause(){goalClicks.pause++;paintGoal({paused:true,canContinue:true})},
      onClear(){goalClicks.clear++;WorkIntent.showGoal(document.querySelector('main'),{mode:'chat'},'nchat')}
    });paintGoal({failed:true,canContinue:true});fixtureContext._render();`);
  for (const [width,height] of [[1366,768],[1093,614],[760,720],[390,667]]) {
    win.setSize(width,height);await delay(120);await assertDocked();
    const layout=await js(`(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();
      const rail=r('.wi-rail'),rows=r('.nqueue-items');
      const sizes=[...document.querySelectorAll('.wi-rail *,.nqueue-row *')].filter(e=>e.checkVisibility()&&[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())).map(e=>parseFloat(getComputedStyle(e).fontSize));
      return {width:innerWidth,height:innerHeight,railHeight:rail.height,rowHeight:r('.nqueue-row').height,
        joined:Math.abs(rail.bottom-rows.top)<1,aligned:rail.left===rows.left&&rail.width===rows.width,minFont:Math.min(...sizes)};
    })()`);
    assert.equal(layout.railHeight,34);assert.equal(layout.rowHeight,34);assert.ok(layout.joined&&layout.aligned&&layout.minFont>=12,JSON.stringify(layout));
    report.checks.push(layout);await shot('goal-and-tasks-'+width);
  }
  win.setSize(1160,780);await delay(100);
  await click('#nchatIntentToggle');
  await js(`window.originalRail=document.querySelector('.wi-rail');document.querySelector('#nchatIntentResume').focus();
    fixtureContext._snap.execution.queue.push({id:'after-goal',text:'补充排队的消息'});fixtureContext._render();`);
  assert.ok(await js(`document.querySelector('.wi-rail')===originalRail&&originalRail.classList.contains('open')&&
    document.activeElement.id==='nchatIntentResume'&&!document.querySelector('#nchatIntentPanel').hidden`));
  await shot('goal-expanded');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'ESC'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'ESC'});
  assert.ok(await js(`document.querySelector('#nchatIntentPanel').hidden&&document.activeElement.id==='nchatIntentToggle'`));
  await click('#nchatIntentResume');assert.equal(await js('goalClicks.resume'),1);
  await click('#nchatIntentPause');assert.equal(await js('goalClicks.pause'),1);
  await js('fixtureContext._snap.execution.queue=[];fixtureContext._collabEntries=()=>[];fixtureContext._render()');
  await assertDocked();await shot('goal-only');
  const goalCrop=await js('(()=>{const r=document.querySelector(".nchat-entry-dock").getBoundingClientRect();return {x:Math.floor(r.x-8),y:Math.floor(r.y-8),width:Math.ceil(r.width+16),height:Math.ceil(r.height+16)}})()');
  fs.writeFileSync(path.join(root,'goal-composer-detail.png'),(await win.webContents.capturePage(goalCrop)).toPNG());
  await js(`fixtureContext._snap.execution.queue=Array.from({length:20},(_,i)=>({id:'many-'+i,text:'排队任务 '+i}));fixtureContext._render();
    document.querySelector('.nqueue-items').scrollTop=99999;`);
  assert.ok(await js(`document.querySelector('.nqueue-items').scrollTop>0&&document.querySelector('.wi-rail').getBoundingClientRect().height===34`));
  await click('#nchatIntentClear');assert.equal(await js('goalClicks.clear'),1);
  assert.ok(await js('!document.querySelector(".nqueue-goal-slot").checkVisibility()'));
  await assertDocked();
  await js('fixtureContext._snap.execution.queue=[];fixtureContext._render()');
  assert.ok(Math.abs((await assertDocked()).center)<1);
  report.checks.push('goals share the cap with compact tasks at four sizes; node identity, expanded state and focus survive queue updates; Escape, resume, pause and clear work; 20 rows scroll separately; clearing restores empty cap');
  await js(`fixtureContext._snap={status:'idle',execution:{running:false,queue:[],turnQueue:{activeTaskId:'',tasks:[]}}};
    fixtureContext._collabEntries=()=>[1,2,3,4].map(n=>({taskId:'task-'+n,nativeTurn:true,task:{title:'业务处理中 · '+n,status:'doing'},fixtureState:'running'}));
    fixtureContext._collabTasks=new Map(fixtureContext._collabEntries().map(e=>[e.taskId,e]));fixtureContext._render()`);
  assert.equal(await js('document.querySelectorAll(".nqueue-progress").length'),0);
  assert.equal(await js('document.querySelectorAll(".nqueue-row").length'),0, 'Stale business status must not create pending queue rows');
  await shot('idle-business-tasks');
  await js(`fixtureContext._snap.status='streaming';fixtureContext._snap.execution.running=true;
    fixtureContext._snap.execution.turnQueue.activeTaskId='task-1';
    fixtureContext._snap.execution.queue=[2,3,4].map(n=>({id:'queued-'+n,taskId:'task-'+n,taskTitle:'待执行的下一项 · '+n,text:'完整任务说明',status:'running'}));fixtureContext._render()`);
  assert.equal(await js('document.querySelectorAll(".nqueue-progress").length'),1);
  assert.equal(await js('document.querySelectorAll("[data-queue-state=queued]").length'),3);
  await shot('one-active-three-queued');
  await js(`fixtureContext._snap.status='waiting-user';fixtureContext._snap.pendingUi={method:'confirm'};fixtureContext._render()`);
  assert.equal(await js('document.querySelectorAll(".nqueue-progress").length'),0);
  await js(`fixtureContext._snap.status='unreachable';fixtureContext._snap.pendingUi=null;
    Object.assign(fixtureContext._snap.execution,{running:false,modelRecovery:{id:'recover-one',taskId:'task-1',available:true},
      turnQueue:{activeTaskId:'',paused:true,tasks:[{taskId:'task-1',status:'failed'}]}});fixtureContext._render();
    window.recoveryClicks=[];fixtureContext._api=()=>({updateQueue:async(ref,id,action)=>{recoveryClicks.push({ref,id,action});return {ok:true};}});void 0`);
  assert.equal(await js('document.querySelectorAll(".nqueue-progress").length'),0);
  assert.equal(await js('document.querySelectorAll("[data-queue-action=resume]").length'),0);
  await shot('failed-model-pauses-queue');
  await click('[data-queue-action="retry-model"]');
  assert.deepEqual(await js('recoveryClicks'),[{ref:'chat-a',id:'recover-one',action:'retry-model'}]);
  await js('fixtureContext._api=()=>({updateQueue:async()=>{throw Error("连接中断，请重试")}});void 0');
  await click('[data-queue-action="retry-model"]');
  await until('notices.at(-1)==="连接中断，请重试"');
  assert.deepEqual(await js('fixtureErrors'),[]);
  report.checks.push('four stale business tasks never spin together: one active / three queued, approval stops spinner, HTTP failure pauses queue and recovery click uses same-turn action with visible connection errors');
  await win.loadFile(path.join(__dirname, '../tests/new-conversation.html'));
  await until('document.querySelector("#out")?.textContent.includes("new conversation smoke:")');
  report.nativeConversation = await js('document.querySelector("#out").textContent');
  assert.match(report.nativeConversation, /new conversation smoke: \d+ passed, 0 failed/);
  report.checks.push('native conversation mounting, new/history navigation and goal flow pass with real queue/composer hierarchy');
  await js(`window.modelResumeClicks=[];window.soduWorkAPI.conversationSession.updateQueue=async(ref,id,action)=>{modelResumeClicks.push({ref,id,action});return {ok:true,snapshot:{...snap(),status:'streaming',execution:{running:true,queue:[]}}}};
    openComposePanel({chatId:'model-recovery-fixture'});`);
  await until('NativeChat.sessionInfo().ref==="history:model-recovery-fixture"&&!!eventSink');
  await js(`eventSink({ref:NativeChat.sessionInfo().ref,kind:'queue-changed',snapshot:{...snap(),status:'unreachable',
    statusText:'模型服务暂时不可用（HTTP 500）。已有内容和工具结果已保留，可恢复这一轮继续。',
    messages:[{role:'assistant',text:'文件已保存，正在整理交付说明。',blocks:[{kind:'text',text:'文件已保存，正在整理交付说明。',done:true}]}],
    execution:{running:false,queue:[],turnQueue:{activeTaskId:'',paused:true,tasks:[]},modelRecovery:{id:'actual-model-retry',taskId:'',available:true}}}});`);
  await until('!!document.querySelector("[data-model-retry]")?.getClientRects().length');
  await click('[data-model-retry]');
  await until('modelResumeClicks.length===1');
  assert.deepEqual(await js('modelResumeClicks'),[{ref:'history:model-recovery-fixture',id:'actual-model-retry',action:'retry-model'}]);
  await until('!document.querySelector("[data-model-retry]")');
  report.checks.push('ordinary chat runtime-error button invokes same-turn recovery once through production renderer and delegated click handler; accepted recovery removes error button');
  report.ok = true;
}).catch(async error => {
  report.error = error.stack;
  if (win) {
    report.errors = await js('window.fixtureErrors').catch(() => []);
    report.controlHits=await js(`[...document.querySelectorAll('.nqueue-row button,.nqueue-row summary')].filter(e=>e.checkVisibility()&&(!e.closest('details:not([open])')||e.tagName==='SUMMARY')).map(e=>{
      const r=e.getBoundingClientRect(),c=document.querySelector('.nqueue-items').getBoundingClientRect(),top=Math.max(r.top,c.top),bottom=Math.min(r.bottom,c.bottom),hit=document.elementFromPoint(r.x+r.width/2,(top+bottom)/2);
      return {action:e.dataset.queueAction||e.className,top,bottom,hit:hit?.className,ok:bottom<=top||e.contains(hit)};
    }).filter(r=>!r.ok)`).catch(()=>[]);
    await shot('failure').catch(() => {});
  }
}).finally(() => {
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  if (win) win.destroy(); app.exit(report.ok ? 0 : 1);
});
