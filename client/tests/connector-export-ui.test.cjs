'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../components/panels/connector-export.js'),'utf8');
function fixture(){
 let resolve,calls=0,downloads=0,owner='a',version=0,body='',args;
 const waiting=new Promise(r=>resolve=r),save={},feedback={},choices=[{checked:true,dataset:{exportId:'one'}},{checked:true,dataset:{exportId:'two'}}];
 const layer={isConnected:true,hidden:false,querySelector:s=>s==='[data-export-save]'?save:feedback,querySelectorAll:()=>choices};
 const ctx={api:{taskStorageKey:()=>owner,exportMyMcp:ids=>{calls++;args=ids;return waiting;}},h:x=>String(x).replace(/</g,'&lt;'),mcp:{personal:[{id:'one',name:'<unsafe>'},{id:'two',name:'two'}]},viewRevision:()=>version,errorText:e=>e.message,openModal:(_t,_s,b)=>{body=b;version++;return layer;}};
 const window={};vm.runInNewContext(source,{window,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},Blob:class{},setTimeout(){},document:{body:{append(){}},createElement:()=>({click(){downloads++;},remove(){}})}});
 window.SoduWorkConnectorExport.open(ctx);return{save,feedback,choices,layer,resolve,get calls(){return calls;},get downloads(){return downloads;},get body(){return body;},get args(){return args;},switchOwner(){owner='b';},leave(){version++;}};
}
const result={filename:'safe.json',content:JSON.stringify({mcpServers:{one:{url:'https://example.test/mcp'}}}),warnings:['需要重新授权']};
test('export uses selected IDs, preserves the page and sends once on rapid clicks',async()=>{const f=fixture();f.choices[1].checked=false;const a=f.save.onclick(),b=f.save.onclick();f.resolve(result);await Promise.all([a,b]);assert.equal(f.calls,1);assert.equal(f.downloads,1);assert.equal(f.args.join(','),'one');assert.match(f.feedback.textContent,/重新授权/);assert.equal(f.layer.hidden,false);assert.match(f.body,/&lt;unsafe>/);});
test('empty selection cannot export',async()=>{const f=fixture();f.choices.forEach(x=>x.checked=false);f.choices[0].onchange();await f.save.onclick();assert.equal(f.calls,0);assert.equal(f.save.disabled,true);});
for(const state of ['owner','closed','left'])test('late export does not download after '+state,async()=>{const f=fixture();const request=f.save.onclick();if(state==='owner')f.switchOwner();else if(state==='closed')f.layer.hidden=true;else f.leave();f.resolve(result);await request;assert.equal(f.downloads,0);});
test('invalid payload stays in dialog and permits retry',async()=>{const f=fixture();const request=f.save.onclick();f.resolve({content:'not json'});await request;assert.equal(f.downloads,0);assert.equal(f.save.disabled,false);assert.ok(f.feedback.textContent);});
