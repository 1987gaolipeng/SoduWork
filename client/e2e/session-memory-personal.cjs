'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const result = require('node:child_process').spawnSync(electron, [__filename], { stdio: 'inherit', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined } });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
const path = require('node:path'), assert = require('node:assert/strict');
let win, item = null, revision = 0, listDelay = 0, failedUpdate = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code);
async function until(code) { for (let i=0;i<160;i++) { if (await js(code)) return; await sleep(20); } throw Error('timeout: '+code); }
function record(patch={}) { return { id:'personal-singleton', title:'个人记忆', content:'', relativePath:'personal.md', fileName:'personal.md', revision, scope:'personal', ...patch }; }
function handlers() {
  ipcMain.handle('memory-dimension-list', async () => { if (listDelay) await sleep(listDelay); return { ok:true, items:item?[(({content,...metadata})=>metadata)(item)]:[], hasMore:false }; });
  ipcMain.handle('memory-dimension-get', async (_e,q) => ({ ok:true, item }));
  ipcMain.handle('memory-dimension-create', async (_e,body) => { if (!item) { item=record({content:body.content,revision:++revision}); } return {ok:true,created:false,item}; });
  ipcMain.handle('memory-dimension-update', async (_e,q,body) => { if (failedUpdate) return {ok:false,reason:'模拟保存失败'}; item=record({id:q.id,content:body.content,revision:++revision}); return {ok:true,item}; });
  ipcMain.handle('memory-dimension-delete', async () => { item=null; return {ok:true}; });
  for (const name of ['memory-dimension-archive','memory-dimension-restore','memory-dimension-context']) ipcMain.handle(name, async () => ({ok:true,item}));
  for (const name of ['session-memory-preview','session-memory-cancel','session-memory-confirm','session-memory-list','session-memory-get','session-memory-options','session-memory-update','session-memory-archive','session-memory-restore','session-memory-delete']) ipcMain.handle(name, async () => ({ok:false,reason:'fixture'}));
}
async function run() {
  handlers();
  win = new BrowserWindow({show:false,width:920,height:720,webPreferences:{preload:path.join(__dirname,'../preload.js'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadFile(path.join(__dirname,'fixtures/session-memory.html'));
  await until('window.ready===true');
  await js('openSessionMemoryPanel()');
  await until("!!document.querySelector('[data-personal-form]')");
  assert.equal(await js("!!document.querySelector('[data-search]')"),false);
  assert.equal(await js("!!document.querySelector('[data-create]')"),false);
  assert.equal(await js("!!document.querySelector('[data-personal-form] textarea')"),true);
  await js("document.querySelector('[data-personal-content]').value='draft survives delayed list';document.querySelector('[data-personal-content]').dispatchEvent(new Event('input',{bubbles:true}))");
  listDelay=120; await js('openSessionMemoryPanel()'); await sleep(160);
  assert.equal(await js("document.querySelector('[data-personal-content]').value"),'draft survives delayed list');
  await js("document.querySelector('[data-personal-content]').value='first saved memory';document.querySelector('[data-personal-content]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-personal-form]').requestSubmit()");
  await until("document.querySelector('[data-message]').textContent.includes('personal.md')");
  assert.equal(revision,1); assert.equal(await js("document.querySelector('[data-personal-content]').value"),'first saved memory');
  await js("document.querySelector('[data-personal-content]').value='failed update stays visible';document.querySelector('[data-personal-content]').dispatchEvent(new Event('input',{bubbles:true}))");
  failedUpdate=true; await js("document.querySelector('[data-personal-form]').requestSubmit()"); await until("document.querySelector('[data-message]').classList.contains('is-error')");
  assert.equal(await js("document.querySelector('[data-personal-content]').value"),'failed update stays visible');
  failedUpdate=false; await js("document.querySelector('[data-personal-form]').requestSubmit()"); await until("!document.querySelector('[data-message]').classList.contains('is-error')");
  assert.equal(revision,2); assert.equal(item.content,'failed update stays visible');
  win.setSize(560,720); await sleep(100);
  const overflow=await js("[...document.querySelectorAll('.cmem-panel,.cmem-detail,.cmem-form')].map(n=>({w:n.clientWidth,s:n.scrollWidth}))");
  assert.ok(overflow.every(x=>x.s<=x.w+2),JSON.stringify(overflow));
  console.log(JSON.stringify({ok:true,cases:['single personal editor','draft survives delayed load','failed save keeps draft','retry persists singleton','narrow viewport no horizontal overflow'],revision}));
}
app.whenReady().then(run).catch(e=>{console.error(JSON.stringify({ok:false,error:e.stack}));process.exitCode=1}).finally(()=>{if(win&&!win.isDestroyed())win.destroy();app.exit(process.exitCode||0)});
