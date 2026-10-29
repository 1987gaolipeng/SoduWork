const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../components/panels/chat-collaboration.js'),'utf8');
function mount(state){
 const window={};const listeners=new Set();const doc={activeElement:null,addEventListener:(type,fn)=>listeners.add(fn),removeEventListener:(type,fn)=>listeners.delete(fn)};
 const host={ownerDocument:doc,innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[]};
 vm.runInNewContext(source,{window});
 const view=window.ChatCollaboration.create({host});view.render(state);view.setPin('dossier');return{host,view,listeners};
}

function eventTarget() {
 const listeners=[];
 const captureOf=options=>typeof options==='object'?Boolean(options?.capture):Boolean(options);
 return {
  addEventListener(type,handler,options){listeners.push({type,handler,capture:captureOf(options)})},
  removeEventListener(type,handler,options){
   const index=listeners.findIndex(row=>row.type===type&&row.handler===handler&&row.capture===captureOf(options));
   if(index>=0)listeners.splice(index,1);
  },
  dispatch(type,properties={}){
   const event={type,target:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true},stopPropagation(){},...properties};
   for(const row of listeners.filter(row=>row.type===type).sort((a,b)=>Number(b.capture)-Number(a.capture)))row.handler(event);
   return event;
  },
  listenerCount(){return listeners.length},
 };
}

function interactiveMount() {
 const window=eventTarget(),doc=Object.assign(eventTarget(),{
  defaultView:window,activeElement:null,querySelector:()=>null,querySelectorAll:()=>[],
 });
 const timers=new Map(),actions=[];let nextTimer=0,writes=0,html='',close=null,view;
 const host=Object.assign(eventTarget(),{
  ownerDocument:doc,
  contains(target){return Boolean(target)&&(target===host||target===close)},
  querySelector(selector){return selector==='[data-collab-picker-close]'?close:null},
  querySelectorAll(){return[]},
 });
 Object.defineProperty(host,'innerHTML',{
  get(){return html},
  set(value){
   html=value;writes++;
   close=html.includes('data-collab-picker-close')?eventTarget():null;
  },
 });
 vm.runInNewContext(source,{window,
  setTimeout(callback){const id=++nextTimer;timers.set(id,callback);return id},
  clearTimeout(id){timers.delete(id)},
 });
 view=window.ChatCollaboration.create({host,onAction(action){
  actions.push(action);
  if(action==='picker-close')view.render({...view.getState(),picker:{open:false,tasks:[]}});
 }});
 return {window,doc,host,view,actions,
  writes:()=>writes,close:()=>close,timerCount:()=>timers.size,
  flush(){const callbacks=Array.from(timers.values());timers.clear();callbacks.forEach(callback=>callback())},
  pointer(type,id=1){doc.dispatch(type,{target:close,pointerId:id})},
 };
}

function pickerState(title='') {
 return {sessionId:'conversation-a',ref:'ref-a',picker:{open:true,loading:!title,
  tasks:title?[{id:'requirement-a',title,status:'todo'}]:[]}};
}
test('task detail preserves long objectives and every acceptance criterion',()=>{
 const description='完整目标'.repeat(160),criteria=Array.from({length:8},(_,i)=>'验收要求'+i+'：'+('完整内容'.repeat(40)));
 const {host}=mount({taskId:'t',task:{id:'t',title:'测试任务',description,acceptanceCriteria:criteria}});
 assert.ok(host.innerHTML.includes(description));for(const criterion of criteria)assert.ok(host.innerHTML.includes(criterion));
 assert.doesNotMatch(host.innerHTML,/COLLABORATION DOSSIER|<span>0[1-6]<\/span>/);
});
test('explicit local execution is not mislabeled remote because a hostname exists',()=>{
 const {host}=mount({taskId:'t',task:{id:'t',title:'本机任务'},execution:{host:'DESKTOP-01',remote:false}});
 assert.match(host.innerHTML,/本机执行/);assert.doesNotMatch(host.innerHTML,/远程执行/);
});
test('task details escape titles and no longer render the obsolete pin rail',()=>{
 const {host}=mount({activeTaskId:'a',tasks:[{taskId:'a',status:'running',task:{title:'<script>alert(1)</script>'}},{taskId:'b',status:'done',task:{title:'第二项'}}]});
 assert.doesNotMatch(host.innerHTML,/ncollab-pin-trigger|ncollab-note-status/);
 assert.doesNotMatch(host.innerHTML,/<script>/);assert.match(host.innerHTML,/&lt;script&gt;/);
});
test('detail uses accessible non-modal tabs and releases dismissal listeners',()=>{
 const {host,view,listeners}=mount({taskId:'t',task:{id:'t',title:'测试'}});
 assert.match(host.innerHTML,/aria-modal="false"/);
 assert.equal((host.innerHTML.match(/role="tab"/g)||[]).length,3);
 assert.equal((host.innerHTML.match(/role="tabpanel"/g)||[]).length,3);
 assert.ok(listeners.size);view.destroy();assert.equal(listeners.size,0);assert.equal(host.innerHTML,'');
});
test('source typography enforces the readable floor and modal geometry stays stable',()=>{
 const css=fs.readFileSync(path.join(__dirname,'../components/panels/chat-collaboration.css'),'utf8');
 const declarations=[...css.matchAll(/font-size:\s*([^;}]+)/g)].map(([,value])=>value.trim());
 assert.ok(declarations.length>15);
 for(const value of declarations){
  const hasLowPx=[...value.matchAll(/(?:^|[,(]\s*)(\d*\.?\d+)px/g)].some(([,size])=>Number(size)<12);
  if(hasLowPx)assert.match(value,/max\(var\(--font-min-readable/);
 }
 assert.match(css,/height:min\(720px,calc\(100% - 28px\)\)/);
 assert.match(css,/prefers-reduced-motion:reduce/);
});
test('global Escape has no window close action behind task details or pickers',()=>{
 const boot=fs.readFileSync(path.join(__dirname,'../desk-boot.js'),'utf8');
 const index=boot.indexOf("if (e.key !== 'Escape') return;");
 const end=boot.indexOf('}, true);',index);
 assert.ok(index>=0&&end>index);
 assert.doesNotMatch(boot.slice(index,end),/closeWindow\(\)/);
});

test('stream state changes keep identical visible markup and its existing controls',()=>{
 const h=interactiveMount(),initial=pickerState('待办需求');
 h.view.render(initial);const close=h.close(),writes=h.writes();
 const latest={...initial,snapshot:{messages:[{role:'assistant',text:'新的流式内容'}]},execution:{phase:'execute'}};
 h.view.render(latest);
 assert.equal(h.writes(),writes);assert.equal(h.close(),close);
 assert.equal(h.view.getState().snapshot,latest.snapshot,'actions must still see the latest state');
 h.view.render(pickerState('已更新的需求名称'));
 assert.equal(h.writes(),writes+1);assert.notEqual(h.close(),close);
 assert.match(h.host.innerHTML,/已更新的需求名称/);h.view.destroy();
});

test('list responses preserve the pressed target through pointerup until the deferred paint',()=>{
 const h=interactiveMount();h.view.render(pickerState());
 const close=h.close(),writes=h.writes();h.pointer('pointerdown');
 h.view.render(pickerState('第一次列表结果'));
 assert.equal(h.close(),close);assert.equal(h.writes(),writes);
 assert.match(h.host.innerHTML,/正在读取待办需求/);
 h.pointer('pointerup');h.view.render(pickerState('最新列表结果'));
 assert.equal(h.close(),close);assert.equal(h.writes(),writes,'pointerup must leave the click target intact');
 h.flush();
 assert.equal(h.writes(),writes+1);assert.match(h.host.innerHTML,/最新列表结果/);
 assert.doesNotMatch(h.host.innerHTML,/第一次列表结果|正在读取待办需求/);h.view.destroy();
});

test('a second press keeps a previous release timer from interrupting its gesture',()=>{
 const h=interactiveMount();h.view.render(pickerState());
 const close=h.close(),writes=h.writes();
 h.pointer('pointerdown');h.view.render(pickerState('第一次结果'));h.pointer('pointerup');
 h.pointer('pointerdown');h.flush();
 assert.equal(h.close(),close);assert.equal(h.writes(),writes);
 h.view.render(pickerState('第二次结果'));h.pointer('pointerup');h.flush();
 assert.equal(h.writes(),writes+1);assert.match(h.host.innerHTML,/第二次结果/);h.view.destroy();
});

test('a response arriving only after pointerup still preserves the pending click target',()=>{
 const h=interactiveMount();h.view.render(pickerState());
 const close=h.close(),writes=h.writes();h.pointer('pointerdown');h.pointer('pointerup');
 h.view.render(pickerState('抬起后到达的结果'));
 assert.equal(h.close(),close);assert.equal(h.writes(),writes);
 h.flush();assert.equal(h.writes(),writes+1);assert.match(h.host.innerHTML,/抬起后到达的结果/);h.view.destroy();
});

test('pointer cancellation and window blur both release the latest pending view',()=>{
 for(const release of ['pointercancel','blur']){
  const h=interactiveMount();h.view.render(pickerState());
  const writes=h.writes();h.pointer('pointerdown');h.view.render(pickerState('恢复绘制的需求'));
  assert.equal(h.writes(),writes);
  if(release==='blur')h.window.dispatch('blur');else h.pointer(release);
  h.flush();assert.equal(h.writes(),writes+1,release);assert.match(h.host.innerHTML,/恢复绘制的需求/);
  h.view.render(pickerState('释放后更新'));assert.match(h.host.innerHTML,/释放后更新/);h.view.destroy();
 }
});

test('Escape, clicking close and external dismissal take effect before a deferred paint',()=>{
 for(const action of ['escape','click','external']){
  const h=interactiveMount();h.view.render(pickerState());
  h.pointer('pointerdown');h.view.render(pickerState('尚未绘制的需求'));
  if(action==='escape')h.doc.dispatch('keydown',{key:'Escape'});
  else{
   h.pointer('pointerup');assert.equal(h.timerCount(),1);
   if(action==='click')h.close().dispatch('click');
   else h.view.render({...h.view.getState(),picker:{open:false,tasks:[]}});
  }
  assert.equal(h.close(),null,action);assert.equal(h.host.innerHTML,'',action);
  assert.equal(h.timerCount(),0,action+' must cancel its pending paint');
  h.flush();assert.equal(h.host.innerHTML,'');
  h.view.render(pickerState('重新打开的需求'));assert.match(h.host.innerHTML,/重新打开的需求/);
  if(action!=='external')assert.deepEqual(h.actions,['picker-close']);
  h.view.destroy();
 }
});

test('switching conversations replaces the old view immediately and cancels its deferred work',()=>{
 const h=interactiveMount();h.view.render(pickerState());
 h.pointer('pointerdown');h.view.render(pickerState('旧会话结果'));h.pointer('pointerup');
 assert.equal(h.timerCount(),1);
 h.view.render({...pickerState('新会话需求'),sessionId:'conversation-b',ref:'ref-b'});
 assert.match(h.host.innerHTML,/新会话需求/);assert.doesNotMatch(h.host.innerHTML,/旧会话结果/);
 assert.equal(h.timerCount(),0);const writes=h.writes();h.flush();assert.equal(h.writes(),writes);
 h.view.render({...pickerState('新会话后续结果'),sessionId:'conversation-b',ref:'ref-b'});
 assert.match(h.host.innerHTML,/新会话后续结果/);h.view.destroy();
});

test('destroy removes document and window listeners and cancels pending paint',()=>{
 const h=interactiveMount();h.view.render(pickerState());
 h.pointer('pointerdown');h.view.render(pickerState('待清理的结果'));h.pointer('pointerup');
 assert.ok(h.doc.listenerCount());assert.ok(h.window.listenerCount());assert.equal(h.timerCount(),1);
 h.view.destroy();const writes=h.writes();
 assert.equal(h.doc.listenerCount(),0);assert.equal(h.window.listenerCount(),0);
 assert.equal(h.timerCount(),0);assert.equal(h.host.innerHTML,'');
 h.flush();h.pointer('pointerup');h.window.dispatch('blur');h.view.render(pickerState('不得恢复'));
 assert.equal(h.writes(),writes);assert.equal(h.host.innerHTML,'');assert.equal(h.timerCount(),0);
});

// Read duration and usage from individual Hub conversation records.
// For local tasks without conversations, fall back to actual task start and end times.
// Show unavailable usage explicitly when no authoritative source exists.
test('done task without hub sessions shows elapsed time from actualStart/actualEnd',()=>{
 const start=Date.parse('2026-10-20T10:00:00Z'),end=start+125000;
 const {host}=mount({taskId:'t',task:{id:'t',title:'本机需求',status:'done',actualStart:start,actualEnd:end},
  execution:{sessions:[]}});
 assert.match(host.innerHTML,/已用时<\/span><b>2 分 5 秒<\/b>/);
 assert.match(host.innerHTML,/Token<\/span><b>未提供<\/b>/);
});

test('execution metrics aggregate per-session usage and time range, ignoring ctx watermarks',()=>{
 const {host}=mount({taskId:'t',task:{id:'t',title:'云端需求',status:'done'},execution:{sessions:[
  {startedAt:'2026-10-20T10:00:00Z',finishedAt:'2026-10-20T10:01:00Z',usage:{totalTokens:300},tokens:{input:9999}},
  {startedAt:'2026-10-20T10:02:00Z',finishedAt:'2026-10-20T10:03:00Z',usage:{totalTokens:500}},
 ]}});
 assert.match(host.innerHTML,/已用时<\/span><b>3 分 0 秒<\/b>/);
 assert.match(host.innerHTML,/Token<\/span><b>800<\/b>/);
});

test('running task without finished time keeps live counting from actualStart',()=>{
 const start=Date.now()-90000;
 const {host}=mount({taskId:'t',task:{id:'t',title:'进行中',status:'doing',actualStart:start},execution:{sessions:[]}});
 assert.doesNotMatch(host.innerHTML,/已用时<\/span><b>未提供/);
 assert.match(host.innerHTML,/已用时<\/span><b>\d+ 分 \d+ 秒<\/b>/);
});
