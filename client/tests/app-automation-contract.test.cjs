'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const contract=require('../main/soduwork-app-bridge-contract.cjs');
const normalize=params=>contract.normalizeRequest({id:'app-request',method:'automation.create',params});
test('direct schedule creation is an explicit separate app capability and carries bounded space context',()=>{
  assert.equal(contract.METHOD_CAPABILITY['automation.create'],'automation.create');
  assert.equal(contract.hasCapability(['conversation.send'],'automation.create'),false);
  const params={text:'每天9点采集资料',requestId:'task-1',context:{spaceId:'space-a',spaceName:'研发',page:'https://app.example/资料/index.html'},accessMode:'full',confirm:true,pluginId:'another'};
  const value=normalize(params);assert.equal(value.params.context.spaceId,'space-a');assert.equal(value.params.requestId,'task-1');
  assert.equal(value.params.accessMode,undefined);assert.equal(value.params.confirm,undefined);assert.equal(value.params.pluginId,undefined);
});
test('invalid context, blank/oversized text or operation ID are rejected without truncating the requirement',()=>{
  const base={text:'每周一9点采集资料',requestId:'one',context:{spaceId:'space-a'}};
  for(const patch of [{text:''},{text:'字'.repeat(8001)},{requestId:''},{requestId:'bad id'},{context:{spaceId:''}},{context:{spaceId:' space-a'}}])assert.throws(()=>normalize({...base,...patch}));
  assert.equal(normalize({...base,context:{}}).params.context.spaceId,'','hosted apps do not invent a business space; main process verifies installed declaration');
  assert.equal(normalize({...base,text:'字'.repeat(8000)}).params.text.length,8000);
});
