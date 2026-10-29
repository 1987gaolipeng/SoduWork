'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const window={SoduWorkPluginPlatforms:require('../core/plugin-platforms')};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components/panels/plugin-mcp-gate.js'),'utf8'),{window});
const item={personal:true,key:'sales-report',name:'销售报告',capabilities:{mcpServers:['crm']}};
function options(catalog){
 const calls=[];
 return {calls,value:{api:{myMcpServers:async()=>catalog},say:value=>calls.push(['say',value]),
  errorText:error=>error.message,setCatalog:value=>calls.push(['catalog',value]),
  openPanel:async()=>calls.push(['panel']),openEditor:(a,b,value)=>calls.push(['editor',a,b,value]),
  resume:()=>calls.push(['resume'])}};
}
test('missing generic MCP opens a prefilled connection and waits before trial',async()=>{
 const fixture=options({company:[],personal:[],enabledCompany:[]});
 assert.equal(await window.SoduWorkPluginMcpGate.ensure(item,fixture.value),false);
 assert.deepEqual(fixture.calls.map(row=>row[0]),['catalog','panel','say','editor']);
 const config=fixture.calls.at(-1)[3];assert.equal(config.name,'crm');config.onSaved();
 assert.equal(fixture.calls.at(-1)[0],'resume');
});
test('enabled personal and selected company MCP satisfy the declared dependency',async()=>{
 for(const catalog of [
  {company:[],personal:[{name:'crm',enabled:true}],enabledCompany:[]},
  {company:[{name:'crm'}],personal:[],enabledCompany:['crm']},
 ]){
  const fixture=options(catalog);assert.equal(await window.SoduWorkPluginMcpGate.ensure(item,fixture.value),true);
  assert.deepEqual(fixture.calls.map(row=>row[0]),['catalog']);
 }
});
test('platform-owned Feishu MCP waits on the platform account gate, not generic setup',async()=>{
 const fixture=options({company:[],personal:[],enabledCompany:[]});
 const platform={personal:true,key:'brief',capabilities:{platforms:['feishu'],mcpServers:['feishu']}};
 assert.equal(await window.SoduWorkPluginMcpGate.ensure(platform,fixture.value),true);
 assert.deepEqual(fixture.calls,[]);
});
test('SoduWork-owned virtual MCP is available without a user connection',async()=>{
 const fixture=options({company:[],personal:[],enabledCompany:[]});
 const item={personal:true,key:'video-maker',name:'视频制作',capabilities:{mcpServers:['soduwork-media']}};
 assert.equal(await window.SoduWorkPluginMcpGate.ensure(item,fixture.value),true);
 assert.deepEqual(fixture.calls,[]);
});
test('catalog failure is actionable and does not open an unverified editor',async()=>{
 const fixture=options(null);fixture.value.api.myMcpServers=async()=>{throw Error('后台断开')};
 assert.equal(await window.SoduWorkPluginMcpGate.ensure(item,fixture.value),false);
 assert.deepEqual(fixture.calls,[['say','后台断开']]);
});
