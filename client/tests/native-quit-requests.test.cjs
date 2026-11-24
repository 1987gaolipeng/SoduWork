'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'), syncFs=require('node:fs'), path=require('node:path'), os=require('node:os');
const {EventEmitter}=require('node:events'), {pathToFileURL}=require('node:url'), vm=require('node:vm');
const fileOpen=require('../main/file-open.cjs'), quitRelaunch=require('../main/quit-relaunch.cjs');
const main=syncFs.readFileSync(path.join(__dirname,'../main.js'),'utf8');

async function setup(t,{ready=true,platform='darwin',quitInitialized=true}={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'soduwork-native-quit-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const app=new EventEmitter(), handlers=new Map(), relaunches=[], calls=[];
  app.isReady=()=>ready; app.isPackaged=false; app.getPath=()=>root;
  app.relaunch=options=>relaunches.push(options);
  const createState=()=>quitRelaunch.create(app,{argv:['electron','app','--soduwork-open-file',path.join(root,'earlier.txt')]});
  const state=quitInitialized?createState():undefined;
  const mainFrame={}, sender={mainFrame,isDestroyed:()=>false,send(){},
    getURL:()=>pathToFileURL(path.resolve(__dirname,'../desk.html')).href};
  const hostWindow={isDestroyed:()=>false,webContents:sender};
  const start=main.indexOf('const _workWindows = new Map();'), end=main.indexOf('\nfunction revealWorkWindow(',start);
  assert.ok(start>=0 && end>start,'production file broker remains available');
  const context={app,ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},hostWindow,
    _quitRelaunch:state,_sessionIdentity:async()=> 'test-owner',
    revealWorkWindow:()=>calls.push('workspace'),openDeskWindow:()=>calls.push('workspace'),
    require(name){
      if(name==='./main/file-open.cjs')return fileOpen;
      if(name==='./main/quit-relaunch.cjs')return quitRelaunch;
      if(name==='./main/platform-connections/runtime.cjs')return {connectionScope:identity=>identity};
      throw Error('Unexpected broker dependency: '+name);
    },
  };
  const production=vm.runInNewContext(main.slice(start,end)+
    '\n_workWindows.set("workspace",hostWindow);\n({broker:_fileOpen,state:_quitRelaunch})',context);
  const activateStart=main.indexOf("    app.on('activate',"), activateEnd=main.indexOf('\n    });',activateStart);
  assert.ok(activateStart>=0 && activateEnd>activateStart,'production activation handler remains available');
  const activation={
    app,process:{platform},_quitRelaunch:production.state,_overlayFocusAt:0,Date:{now:()=>10000},
    BrowserWindow:{getAllWindows:()=>[]},_desktopOverlay:{createWindow:()=>calls.push('overlay')},
    openDeskWindow:()=>calls.push('workspace'),console,
  };
  vm.runInNewContext(main.slice(activateStart,activateEnd+'\n    });'.length),activation);
  const list=()=>handlers.get('file-open-list')({sender,senderFrame:mainFrame});
  let prevented=0;
  const open=file=>app.emit('open-file',{preventDefault:()=>prevented++},file);
  return {root,app,hostWindow,handlers,context,get state(){return production.state||context._quitRelaunch;},broker:production.broker,calls,relaunches,list,open,
    prevented:()=>prevented,ready:()=>{
      if(!production.state&&!context._quitRelaunch)context._quitRelaunch=createState();
      activation._quitRelaunch=production.state||context._quitRelaunch;
      ready=true;
    }};
}

test('a cold native file request remains queued until the desktop is ready',async t=>{
  const h=await setup(t,{ready:false,quitInitialized:false}), file=path.join(h.root,'cold.txt');
  h.open(file);
  assert.equal(h.prevented(),1); assert.deepEqual(h.calls,[]);
  assert.deepEqual((await h.list()).items.map(row=>row.name),['cold.txt']);
  h.ready(); h.broker.signal(); assert.deepEqual(h.calls,['workspace']);
  h.app.emit('will-quit'); assert.deepEqual(h.relaunches,[]);
});

function quitMenu(h) {
  let respond, notifyShown, attempts=0;
  const shown=new Promise(resolve=>{notifyShown=resolve;});
  h.app.getAppPath=()=>path.resolve(__dirname,'..');
  const sender=h.hostWindow.webContents;
  sender.mainFrame.url=sender.getURL();
  h.app.quit=()=>attempts++;
  const source=main.match(/function _quitSoduWork\(reason\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source,'production quit entry remains available');
  const context={app:h.app,_quitRelaunch:h.state,tray:null,
    BrowserWindow:{getAllWindows:()=>[]},_lifecycleDiagnostics:{setExitReason(){}}};
  const quit=vm.runInNewContext(source+'\n_quitSoduWork',context);
  require('../main/app-menu-info.cjs').install({app:h.app,
    ipcMain:{handle:(name,handler)=>h.handlers.set(name,handler)},
    BrowserWindow:{fromWebContents:contents=>contents===sender?h.hostWindow:null},
    dialog:{showMessageBox:()=>new Promise(resolve=>{respond=resolve;notifyShown();})},quit});
  return {request:()=>h.handlers.get('app-request-quit')({sender,senderFrame:sender.mainFrame}),
    respond:value=>respond({response:value}),attempts:()=>attempts,
    ready:()=>shown};
}

test('declining the production exit confirmation keeps native files and macOS activation in the running desktop',async t=>{
  const h=await setup(t),menu=quitMenu(h),a=path.join(h.root,'while-confirming.txt'),b=path.join(h.root,'after-cancel.txt');
  const pending=menu.request();await menu.ready();
  h.open(a);
  assert.equal(h.state.quitting,false);
  assert.equal(menu.attempts(),0);
  menu.respond(0);
  assert.deepEqual(await pending,{ok:true,canceled:true});
  h.open(b);h.app.emit('activate');
  assert.equal(h.state.quitting,false);
  assert.equal(menu.attempts(),0);
  assert.deepEqual((await h.list()).items.map(row=>row.name),['while-confirming.txt','after-cancel.txt']);
  assert.deepEqual(h.calls,['workspace','workspace','overlay','workspace']);
  h.app.emit('will-quit');assert.deepEqual(h.relaunches,[]);
});

test('confirming the production exit routes later native files and activation into one deferred fresh process',async t=>{
  const h=await setup(t),menu=quitMenu(h),file=path.join(h.root,'after-confirmation.txt');
  const pending=menu.request();await menu.ready();
  menu.respond(1);
  assert.deepEqual(await pending,{ok:true,canceled:false});
  assert.equal(menu.attempts(),1);
  assert.equal(h.state.quitting,true);
  h.app.emit('before-quit');h.open(file);h.app.emit('activate');h.open(file);
  h.app.emit('before-quit');
  assert.deepEqual(h.calls,[]);
  assert.deepEqual((await h.list()).items,[]);
  assert.deepEqual(h.relaunches,[]);
  h.app.emit('will-quit');h.app.emit('will-quit');
  assert.equal(h.relaunches.length,1);
  assert.deepEqual(fileOpen.commandFiles(['electron',...h.relaunches[0].args],h.root,false),[file]);
});

test('mixed native, command-line and activation requests retain twenty unique files without replaying the startup file',async t=>{
  const h=await setup(t),paths=Array.from({length:25},(_,index)=>path.join(h.root,'mixed-'+index+'.txt'));
  const start=main.indexOf("  app.on('second-instance'"),end=main.indexOf('  _fileOpen.fromCommand',start);
  assert.ok(start>=0&&end>start,'production second-instance handler remains available');
  vm.runInNewContext(main.slice(start,end),{app:h.app,_quitRelaunch:h.state,_fileOpenModule:fileOpen,_fileOpen:h.broker,
    _firstChatLinks:require('../main/first-chat-links.cjs'),
    _linuxStartup:{focusRecovery:()=>false},openDeskWindow:()=>h.calls.push('workspace'),console});
  h.state.markQuitting();
  for(const file of paths.slice(0,10))h.open(file);
  h.app.emit('second-instance',{},['electron','--unused-launch-switch'],h.root,
    {soduworkOpenFiles:{version:1,files:paths.slice(5)}});
  h.app.emit('activate');h.open(paths[0]);h.open(paths[24]);
  assert.deepEqual(h.calls,[]);
  assert.deepEqual((await h.list()).items,[]);
  h.app.emit('will-quit');
  assert.equal(h.relaunches.length,1);
  assert.deepEqual(fileOpen.commandFiles(['electron',...h.relaunches[0].args],h.root,false),paths.slice(0,20));
  assert.ok(!h.relaunches[0].args.includes('--unused-launch-switch'));
});

test('a native file request while running still queues normally and never schedules a restart',async t=>{
  const h=await setup(t), file=path.join(h.root,'running.txt');
  h.open(file);
  assert.equal(h.prevented(),1); assert.deepEqual(h.calls,['workspace']);
  assert.deepEqual((await h.list()).items.map(row=>row.name),['running.txt']);
  h.app.emit('will-quit'); assert.deepEqual(h.relaunches,[]);
});

test('native files received during confirmed quit are handed off once without queuing in the exiting desktop',async t=>{
  const h=await setup(t), a=path.join(h.root,'材料 & first.txt'), b=path.join(h.root,'second.txt');
  h.state.markQuitting(); h.open(a); h.open(b); h.open(a);
  assert.equal(h.prevented(),3);
  assert.deepEqual((await h.list()).items,[]); assert.deepEqual(h.calls,[]);
  assert.deepEqual(h.relaunches,[],'handoff waits until cleanup finishes');
  h.app.emit('will-quit'); h.app.emit('will-quit');
  assert.equal(h.relaunches.length,1);
  assert.deepEqual(fileOpen.commandFiles(['electron',...h.relaunches[0].args],h.root,false),[a,b]);
});

test('macOS activation during confirmed quit schedules one fresh launch and opens no exiting windows',async t=>{
  const h=await setup(t);
  h.state.markQuitting(); h.app.emit('activate'); h.app.emit('activate');
  assert.deepEqual(h.calls,[]); assert.deepEqual(h.relaunches,[]);
  h.app.emit('will-quit'); h.app.emit('will-quit');
  assert.equal(h.relaunches.length,1);
  assert.deepEqual(fileOpen.commandFiles(['electron',...h.relaunches[0].args],h.root,false),[]);
});

test('macOS activation while running retains normal overlay and workspace recovery',async t=>{
  const h=await setup(t);
  h.app.emit('activate'); assert.deepEqual(h.calls,['overlay','workspace']);
  h.app.emit('will-quit'); assert.deepEqual(h.relaunches,[]);
});

test('a native file followed by macOS activation keeps its file in the same deferred launch',async t=>{
  const h=await setup(t), file=path.join(h.root,'requested.txt');
  h.state.markQuitting(); h.open(file); h.app.emit('activate');
  assert.deepEqual(h.calls,[]); assert.deepEqual((await h.list()).items,[]);
  h.app.emit('will-quit'); assert.equal(h.relaunches.length,1);
  assert.deepEqual(fileOpen.commandFiles(['electron',...h.relaunches[0].args],h.root,false),[file]);
});

test('activation outside macOS retains the existing overlay fallback during confirmed quit',async t=>{
  for(const platform of ['linux','win32']){
    const h=await setup(t,{platform}); h.state.markQuitting(); h.app.emit('activate');
    assert.deepEqual(h.calls,['overlay']); h.app.emit('will-quit'); assert.deepEqual(h.relaunches,[]);
  }
});
