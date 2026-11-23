'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {create} = require('../e2e/fixtures/resumed-pi.cjs');
const gate = require('../main/pi-session/plugin-generation-gate.cjs');
const {resultState} = require('../main/pi-session/task-turn');

for (const mode of ['http403', 'cancel', 'pause']) {
  test('real Pi plugin repair preserves ' + mode + ' through the callback and logical receipt', {timeout:30000}, async t => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'plugin-repair-runtime-'));
    const f=await create(root);
    t.after(async()=>{await f.close();fs.rmSync(root,{recursive:true,force:true});});
    const callbacks=[],receipts=[];
    const begin=gate.begin;
    // Observe, but do not replace, the production callback, gate or runtime.
    t.mock.method(gate,'begin',options=>begin({...options,repair:async(...args)=>{
      const result=await options.repair(...args);callbacks.push(result);return result;
    }}));
    await f.open(mode==='pause'?{resumePath:undefined,intent:'goal',goal:'Create a reusable plugin'}:{});
    let entered;
    const repairing=new Promise(resolve=>{entered=resolve;});
    f.reply((body,count)=>{
      if(count===1)return {tool:'write',args:{path:'soduwork-plugin-draft.json',content:'{invalid'}};
      if(count===2)return {text:'Draft generated.'};
      assert.match(JSON.stringify(body.messages.at(-1)),/soduwork-internal-plugin-repair/);
      return {respond(response){
        entered();
        if(mode==='http403') {
          response.writeHead(403,{'content-type':'application/json'});
          response.end(JSON.stringify({error:{message:'Forbidden Bearer synthetic-secret https://fixture.invalid/private'}}));
        } else {
          response.writeHead(200,{'content-type':'text/event-stream'});
          response.flushHeaders();
        }
      }};
    });
    const item=f.handle.submit('Create the plugin draft',[],{goalMode:false,
      afterTurn:(state,result)=>receipts.push({state,result})});
    await repairing;
    if(mode==='cancel')await f.handle.cancel();
    if(mode==='pause')assert.equal(f.handle.pauseGoal().ok,true);
    const result=await item.completion;
    assert.equal(callbacks.length,1);assert.equal(receipts.length,1);
    assert.equal(f.requests.length,3,'one repair request, without side-effect replay');
    assert.equal(fs.readFileSync(path.join(f.cwd,'soduwork-plugin-draft.json'),'utf8'),'{invalid');
    assert.equal(f.handle.snapshot().tools.filter(row=>row.name==='write').length,1);
    assert.equal(f.handle.inFlight(),false);
    if(mode==='http403') {
      assert.equal(result.ok,false);assert.equal(result.failureKind,'plugin-repair');
      assert.equal(result.reason,'模型请求被拒绝（HTTP 403）');
      assert.equal(result.snapshot.completion.retryable,false);assert.equal(result.retrySafe,false);
      assert.equal(f.handle.snapshot().execution.turnQueue.failure.reason,result.reason);
      assert.equal(receipts[0].state,'failed');
      assert.doesNotMatch(JSON.stringify(result),/synthetic-secret|fixture.invalid|Bearer/);
    } else {
      assert.equal(callbacks[0].ok,true,'native control receipt is not a runtime failure');
      assert.equal(callbacks[0][mode==='cancel'?'cancelled':'paused'],true);
      assert.equal(result.ok,true);
      assert.equal(result[mode==='cancel'?'cancelled':'paused'],true);
      assert.equal(resultState(result),mode==='cancel'?'stopped':'waiting');
      assert.equal(receipts[0].state,mode==='cancel'?'stopped':'waiting');
    }
  });
}
test.after(()=>require('../main/app-resource-cache.cjs').close());
