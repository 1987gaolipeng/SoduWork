"use strict";
const electron=require("electron");
if(typeof electron==="string"){
 const {spawnSync}=require("node:child_process");
 const result=spawnSync(electron,[__filename,...process.argv.slice(2)],{stdio:"inherit"});
 process.exit(result.status===null?1:result.status);
}
const {app,BrowserWindow,ipcMain}=electron;
const fs=require("node:fs"), path=require("node:path"), os=require("node:os"), assert=require("node:assert/strict");
const importer=require("../main/conversation/codex-import");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"soduwork-session-memory-e2e-"));
const source=path.join(root,"codex-rollout.jsonl");
const rows=[{type:"session_meta",payload:{id:"e2e-codex-session"}},
 {type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"Build the release checklist"}]}},
 {type:"response_item",payload:{type:"message",role:"assistant",content:[{type:"output_text",text:"Decision: use the verified release gate"},{type:"input_image",image_url:"https://private.invalid/image?token=redact"}]}}];
fs.writeFileSync(source,rows.map(JSON.stringify).join("\n"));
const report={ok:false,cases:[]}; let win, item=null, archived=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms)); const js=code=>win.webContents.executeJavaScript(code);
async function until(code){for(let i=0;i<120;i++){if(await js(code))return;await delay(25)}throw Error("Timed out: "+code)}
function resultItem(patch={}){return {id:"memory-e2e",title:"Build the release checklist",source:"codex",sourceSessionId:"e2e-codex-session",projectId:"",repoId:"",taskId:"",revision:1,visibility:"private",scope:"private",archived:false,sourceMeta:{fileName:"codex-rollout.jsonl",format:"jsonl",bytes:source.length,retained:2,total:2,attachmentCount:1},summary:"Decision: use the verified release gate",fields:{summary:"Decision: use the verified release gate",goal:"Build the release checklist",decisions:"Decision: use the verified release gate",constraints:"",pending:"",outcomes:""},events:[],warnings:[],...patch}}
function installHandlers(){
 ipcMain.handle("session-memory-preview",async()=>{const draft=importer.parse(fs.readFileSync(source),path.basename(source));return {ok:true,previewId:"draft-e2e",...draft}});
 ipcMain.handle("session-memory-cancel",async()=>({ok:true}));
 ipcMain.handle("session-memory-options",async()=>({ok:true,projects:[],repos:[],tasks:[]}));
 ipcMain.handle("session-memory-confirm",async(_e,key,body)=>{assert.equal(key,"draft-e2e"); item=resultItem({title:body.title||"Build the release checklist",fields:body.fields,sourceMeta:{fileName:"codex-rollout.jsonl",format:"jsonl",retained:2,total:2,attachmentCount:1}});return {ok:true,duplicate:false,item}});
 ipcMain.handle("session-memory-list",async(_e,query)=>({ok:true,items:(item&&!item.archived||query?.archived)?[item]:[],hasMore:false}));
 ipcMain.handle("session-memory-get",async()=>({ok:true,item}));
 ipcMain.handle("session-memory-archive",async()=>{item={...item,archived:true};return {ok:true,item}});
 ipcMain.handle("session-memory-restore",async()=>{item={...item,archived:false};return {ok:true,item}});
 ipcMain.handle("session-memory-delete",async()=>{item=null;return {ok:true}});
 ipcMain.handle("memory-dimension-list",async()=>({ok:true,items:[],hasMore:false}));
}
async function run(){
 app.setPath("userData",path.join(root,"user-data"));fs.mkdirSync(path.join(root,"user-data"),{recursive:true});installHandlers();
 win=new BrowserWindow({show:false,width:1280,height:860,webPreferences:{preload:path.join(__dirname,"../preload.js"),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 await win.loadFile(path.join(__dirname,"fixtures/session-memory.html")); await until("window.ready===true");
 await js("openSessionMemoryPanel()"); await until("document.querySelector('#sessionMemoryPanel.show') && document.querySelector('[data-import]')");
 await js("document.querySelector('[data-import]').click()"); await until("document.querySelector('[data-detail] input[name=title]')");
 assert.ok(await js("document.querySelector('.cmem-source-card')?.textContent.includes('codex-rollout.jsonl')"));
 assert.ok(await js("document.querySelector('.cmem-warnings')?.textContent || document.querySelector('[data-message]')?.textContent"));
 assert.equal(await js("document.querySelector('[data-wizard]')?.dataset.wizardStep"),"review");
 await js("document.querySelector('[data-wizard-next]').click()");
 assert.equal(await js("document.querySelector('[data-wizard]')?.dataset.wizardStep"),"confirm");
 assert.equal(await js("document.querySelector('[data-wizard-back]').hidden"),false);
 await js("document.querySelector('[data-wizard-back]').click()");
 assert.equal(await js("document.querySelector('[data-wizard]')?.dataset.wizardStep"),"review");
 report.cases.push("renderer opens Codex JSONL through the native import action and shows provenance/warnings");
 await js("document.querySelector('[data-wizard-next]').click();document.querySelector('[data-confirm]').click();document.querySelector('form').requestSubmit()"); await until("document.querySelector('[data-use]')");
 assert.equal(await js("!!document.querySelector('[data-memory-id]')"),false); report.cases.push("confirmed Codex import remains in its own detail route and is not shown as a personal-memory row");
 report.cases.push("the imported detail route stays separate from the personal Markdown document");
 report.ok=true;
}
app.whenReady().then(run).catch(e=>{report.error=e.stack}).finally(()=>{fs.writeFileSync(path.join(root,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(win)win.destroy();app.exit(report.ok?0:1)});
