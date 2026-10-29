'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../components/panels/panels-capability-mcp.js'),'utf8');
const {File}=require('node:buffer');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const file=()=>new File(['{"mcpServers":{"fixture":{"url":"https://fixture.invalid/mcp","headers":{"Authorization":""},"enabled":false}}}'],'fixture.mcp.json');
const preview={summary:{importable:1,total:1},servers:[{name:'fixture',target:'https://fixture.invalid/mcp',importable:true,credentialKeys:['Authorization']}]};
function fixture(){
 const window={};vm.runInNewContext(source,{window});
 const elements=new Map(),calls=[];let revision=0,owner='alice';
 const node=()=>({classList:{add(){}},textContent:'',innerHTML:'',hidden:false,disabled:false,checked:false});
 const layer={isConnected:true,hidden:false,querySelector:key=>{if(!elements.has(key))elements.set(key,node());return elements.get(key)}};
 const ctx={api:{taskStorageKey:()=>owner,previewMyMcpImport:async f=>{calls.push(['preview',await f.text()]);return preview},
  importMyMcp:async f=>{calls.push(['import',await f.text()]);return {importedRows:[{id:'created',name:'fixture',enabled:false,headers:{Authorization:''},url:'https://fixture.invalid/mcp'}]}}},
  h:s=>String(s??''),say:s=>calls.push(['say',s]),errorText:e=>e.message,
  viewRevision:()=>revision,openModal:(_title,_subtitle,body)=>{revision++;layer.hidden=false;calls.push(['modal',body]);return layer},closeModal:()=>{revision++;layer.hidden=true},
  load:async()=>{},openMcpEditor:(...args)=>calls.push(['editor',...args])};
 return {window,layer,elements,calls,ctx,switchOwner:()=>{owner='bob'},leaveView:()=>{revision++;layer.hidden=true},open:options=>window.SoduWorkMcpManagement.openImport(ctx,options),
  confirm:()=>{const consent=layer.querySelector('[data-mcp-import-consent]');consent.checked=true;consent.onchange();return layer.querySelector('[data-mcp-import-do]').onclick()}};
}
test('template preview requires explicit confirmation then opens the masked disabled row',async()=>{
 const f=fixture();f.open({file:file()});await flush();
 assert.equal(f.calls.filter(x=>x[0]==='import').length,0);
 assert.doesNotMatch(f.calls.find(x=>x[0]==='modal')[1],/data-mcp-file/);
 assert.equal(f.layer.querySelector('[data-mcp-import-do]').disabled,true);
 await f.confirm();
 const row=f.calls.find(x=>x[0]==='editor')[1];
 assert.equal(row.enabled,false);assert.equal(row.url,'https://fixture.invalid/mcp');assert.equal(row.headers.Authorization,'');
 assert.equal(f.calls.filter(x=>x[0]==='import').length,1);
});
test('stale template guard errors prevent imports and remain actionable without losing preview',async()=>{
 const f=fixture();f.open({file:file(),beforeImport:async()=>{throw Error('插件版本已变化')}});await flush();await f.confirm();
 assert.equal(f.calls.some(x=>x[0]==='import'),false);
 assert.equal(f.layer.querySelector('[data-mcp-feedback]').textContent,'插件版本已变化');
 assert.equal(f.layer.querySelector('[data-mcp-import-do]').disabled,false);
});
test('closing or replacing the shared modal during import cannot reopen an editor',async()=>{
 for(const replace of [false,true]){
  const f=fixture();let complete;f.ctx.api.importMyMcp=()=>new Promise(resolve=>{complete=resolve});
  f.open({file:file()});await flush();const pending=f.confirm();await flush();
  if(replace)f.elements.set('[data-mcp-import-do]',{});else f.layer.hidden=true;
  complete({importedRows:[{id:'late',enabled:false}]});await pending;
  assert.equal(f.calls.some(x=>x[0]==='editor'),false);
 }
});
test('late preview cannot mutate a replaced modal',async()=>{
 const f=fixture();let complete;f.ctx.api.previewMyMcpImport=()=>new Promise(resolve=>{complete=resolve});
 f.open({file:file()});const old=f.layer.querySelector('[data-mcp-preview]');f.elements.set('[data-mcp-import-do]',{});
 complete(preview);await flush();assert.equal(old.innerHTML,'');
});
test('existing manual import still accepts file selection and failed import can retry',async()=>{
 const f=fixture();f.open();
 await f.layer.querySelector('[data-mcp-file]').onchange({target:{files:[file()]}});
 const normal=f.ctx.api.importMyMcp;f.ctx.api.importMyMcp=async()=>{throw Error('后台暂时不可用')};
 await f.confirm();assert.equal(f.layer.querySelector('[data-mcp-feedback]').textContent,'后台暂时不可用');
 f.ctx.api.importMyMcp=normal;await f.confirm();assert.equal(f.calls.filter(x=>x[0]==='editor').length,1);
});

test('navigation during post-import refresh cannot reopen the editor; a new import remains usable',async()=>{
 const f=fixture();let complete;f.ctx.load=()=>new Promise(resolve=>{complete=resolve});
 f.open({file:file()});await flush();const pending=f.confirm();await flush();
 assert.equal(f.layer.hidden,true);assert.equal(typeof complete,'function');
 f.leaveView();complete();await pending;
 assert.equal(f.calls.some(x=>x[0]==='editor'),false);
 f.ctx.load=async()=>{};f.open({file:file()});await flush();await f.confirm();
 assert.equal(f.calls.filter(x=>x[0]==='editor').length,1);
});
test('switching views while a preview is pending prevents late rendering',async()=>{
 const f=fixture();let complete;f.ctx.api.previewMyMcpImport=()=>new Promise(resolve=>{complete=resolve});
 f.open({file:file()});const old=f.layer.querySelector('[data-mcp-preview]');
 f.leaveView();f.layer.hidden=false;complete(preview);await flush();
 assert.equal(old.innerHTML,'');assert.equal(f.calls.some(x=>x[0]==='import'),false);
});

for(const stage of ['preview','import'])test('account switch discards delayed '+stage+' without opening another account editor',async()=>{
 const f=fixture();let complete;
 if(stage==='preview')f.ctx.api.previewMyMcpImport=()=>new Promise(resolve=>complete=resolve);
 else f.ctx.api.importMyMcp=()=>new Promise(resolve=>complete=resolve);
 f.open({file:file()});await flush();const pending=stage==='import'?f.confirm():null;await flush();
 f.switchOwner();complete(stage==='preview'?preview:{importedRows:[{id:'foreign'}]});await pending;await flush();
 assert.equal(f.calls.some(x=>x[0]==='editor'),false);assert.equal(f.calls.some(x=>x[0]==='say'),false);
 if(stage==='preview')assert.equal(f.layer.querySelector('[data-mcp-preview]').innerHTML,'');
});
test('changing confirmation during import cannot start duplicate import requests',async()=>{
 const f=fixture();let complete,count=0;
 f.ctx.api.importMyMcp=()=>{count++;return new Promise(resolve=>complete=resolve)};
 f.open({file:file()});await flush();const one=f.confirm();await flush();await f.confirm();
 assert.equal(count,1);complete({importedRows:[]});await one;
});
