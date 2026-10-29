const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../components/panels/panels-schedules-methods.js'),'utf8');
const plugin=(key,extra={})=>({key,name:key,version:'1.0.0',enabled:true,entrypoints:{automation:true},ui:{contributions:[]},...extra});
function fixture(list){const context={window:{soduWorkAPI:{personalPlugins:{list}}}};vm.createContext(context);vm.runInContext(source,context);return context;}
test('returning to automation shows a plugin created after the first empty catalog',async()=>{
 let items=[];const c=fixture(async()=>({ok:true,items}));
 assert.equal((await c._schmLoad()).length,0);
 items=[plugin('new-method')];
 assert.deepEqual(Array.from(await c._schmLoad(),x=>x.key),['new-method']);
 assert.equal(c._schmFind('new-method').version,'1.0.0');
});
test('reopening automation reflects plugin updates, disablement and deletion',async()=>{
 let items=[plugin('method')];const c=fixture(async()=>({ok:true,items}));await c._schmLoad();
 items=[plugin('method',{version:'1.0.1'})];await c._schmLoad();assert.equal(c._schmFind('method').version,'1.0.1');
 items=[plugin('method',{enabled:false})];await c._schmLoad();assert.equal(c._schmFind('method'),null);
 items=[];assert.equal((await c._schmLoad()).length,0);
});
test('concurrent views share one in-flight IPC and retain automation eligibility',async()=>{
 let resolve,calls=0;const c=fixture(()=>{calls++;return new Promise(r=>{resolve=r;});});
 const a=c._schmLoad(),b=c._schmLoad();assert.equal(calls,1);
 resolve({ok:true,items:[plugin('usable'),plugin('disabled',{enabled:false}),plugin('conversation',{entrypoints:{automation:false}}),plugin('interactive',{ui:{contributions:[{slot:'conversation.panel'}]}})]});
 assert.deepEqual(Array.from(await a,x=>x.key),['usable']);assert.deepEqual(Array.from(await b,x=>x.key),['usable']);
});
