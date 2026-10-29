'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'../components/panels',name+'.js'),'utf8');
function harness(){
  const calls={bound:[],opened:[],details:[],cleared:0};
  const nodes={cpInput:{value:'用户说明'},nchatInput:{focus(){}}};
  const window={document:{getElementById:id=>nodes[id]||null},setTimeout,clearTimeout,
    NativeChat:{hasSession:()=>true,bindTask:(...a)=>calls.bound.push(a),enter(){},openTask:(...a)=>calls.opened.push(a)},
    openDetailEntry:id=>calls.details.push(id)};
  window.window=window;
  vm.createContext(window);
  vm.runInContext(read('compose-surface'),window);
  window.ComposeSurface.create = () => ({_panel: () => null});
  vm.runInContext(read('panels-compose'),window);
  vm.runInContext(read('chat-work-intent'),window);
  vm.runInContext(read('panels-compose-submit'),window);
  const bridge=window.ChatWorkIntent.create({_taskAttachments:[],_bindCollaborationTask:(...a)=>calls.bound.push(a)})._chatDraftBridge();
  const buttons={};
  const box={innerHTML:'',querySelector:selector=>buttons[selector]||= {addEventListener:(event,fn)=>{buttons[selector].click=fn;}}};
  return {window,calls,bridge,box,buttons};
}
test('successful transfer receipt never binds or opens a sender execution session',()=>{
  const {window,calls,bridge,box,buttons}=harness();
  bridge.onPersisted('assigned','测试任务',{handedOff:true});
  window.ComposeDraftSubmit.done({box,id:'assigned',title:'测试任务',who:'同事甲',gone:true,variant:'chat',esc:String,...bridge});
  assert.deepEqual(calls.bound,[]);assert.deepEqual(calls.opened,[]);
  assert.match(box.innerHTML,/已交给 同事甲/);assert.doesNotMatch(box.innerHTML,/进入协作/);
  buttons['#cpOpen'].click();assert.deepEqual(calls.details,['assigned']);assert.deepEqual(calls.bound,[]);
});
test('self-owned creation and failed transfer keep the ordinary collaboration path',()=>{
  const {window,calls,bridge,box}=harness();
  bridge.onPersisted('own','自己的任务',{handedOff:false});
  window.ComposeDraftSubmit.done({box,id:'own',title:'自己的任务',gone:false,warn:'转交未成功',variant:'chat',esc:String,...bridge});
  assert.ok(calls.bound.some(a=>a[0]==='own'));
  assert.match(box.innerHTML,/进入协作/);assert.match(box.innerHTML,/转交未成功/);
});
test('sheet receipt closes the entry sheet before opening the detail (2026-10-15)',()=>{
  const {window,box,buttons}=harness();
  const sheet={closed:0,details:[]};
  window.openDetailEntry=id=>sheet.details.push(id);
  // saveOnly receipt: not handed off; the sheet must close before the detail opens.
  window.ComposeDraftSubmit.done({box,id:'sheet-task',title:'乡村音乐网页',who:'',warn:'',gone:false,variant:'sheet',esc:String,
    onOpen:id=>{sheet.closed++;window.openDetailEntry(id);},
    onOpenDetail:id=>{sheet.closed++;window.openDetailEntry(id);}});
  assert.match(box.innerHTML,/查看详情/);
  buttons['#cpOpen'].click();
  assert.equal(sheet.closed,1);
  assert.deepEqual(sheet.details,['sheet-task']);
  // A handed-off requirement receipt must also close the sheet before opening details.
  const given={closed:0,details:[]};
  window.openDetailEntry=id=>given.details.push(id);
  window.ComposeDraftSubmit.done({box,id:'given-task',title:'已交办需求',who:'同事甲',gone:true,variant:'sheet',esc:String,
    onOpenDetail:id=>{given.closed++;window.openDetailEntry(id);}});
  assert.match(box.innerHTML,/已交给 同事甲/);
  buttons['#cpOpen'].click();
  assert.equal(given.closed,1);
  assert.deepEqual(given.details,['given-task']);
});
test('task receipt forwards outcome to completion observers',()=>{
  const {window,box}=harness();let outcome;
  window.ComposeDraftSubmit.done({box,id:'t',title:'T',gone:true,esc:String,onCreated:(id,title,value)=>outcome=value});
  assert.equal(outcome?.handedOff,true);
});
test('read-only participant tasks cannot be added or started in the local queue',async()=>{
  const {window}=harness();
  window.SoduWorkAPI={};window.petSay=()=>{};
  vm.runInContext(read('chat-task-start'),window);
  vm.runInContext(read('chat-task-controller'),window);
  assert.equal(window.ChatTaskController.isPickableTask({id:'t',status:'todo',readOnly:true}),false);
  let sent=0;
  const controller=window.ChatTaskController.create({_collabTasks:new Map(),_collabStarts:new Set(),_send:()=>sent++});
  assert.equal(await controller._startTask({id:'t',status:'todo',readOnly:true}),false);
  assert.equal(sent,0);
});
test('standalone assigned-task navigation opens tracking details, never sender chat',()=>{
  const {window,calls}=harness();
  window.openTaskConversation=(...a)=>calls.opened.push(a);
  vm.runInContext(read('task-create-navigation'),window);
  window._openCreatedTaskInChat('assigned','任务',{readOnly:true});
  assert.deepEqual(calls.details,['assigned']);assert.deepEqual(calls.opened,[]);
  window._openCreatedTaskInChat('own','任务',{readOnly:false});
  assert.equal(calls.opened.length,1);
});
test('transferred queue entry is hidden from the send queue (2026-10-09)',async()=>{
  const {window,calls}=harness();
  vm.runInContext(read('chat-send-queue'),window);
  const entry={taskId:'assigned',task:{id:'assigned',title:'已转交的任务',readOnly:true},nativeTurn:true,queueState:'failed'};
  const host={innerHTML:'',dataset:{},classList:{add(){},toggle(){}}};
  const root={querySelector:()=>host};
  const controller=window.ChatSendQueue.create({_collabTasks:new Map([['assigned',entry]]),_localQueue:[],
    _snap:{execution:{}},_collabEntries:()=>[entry],_collabEntryStatus:e=>e.queueState,
    esc:String,_mount:()=>root});
  controller._renderQueue(root);
  assert.doesNotMatch(host.innerHTML,/已转交 · 查看进展/);
  assert.doesNotMatch(host.innerHTML,/data-queue-row="task:assigned"/);
});
