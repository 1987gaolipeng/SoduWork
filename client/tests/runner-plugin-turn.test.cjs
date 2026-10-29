'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRunnerRuntimeAdapter, getRunnerSessionDetails, _uuidV5} = require('../main/agent-runtime/runner-adapter');
const catalog = require('../main/agent-runtime/runtime-catalog');
const pluginTurn = require('../main/pi-session/plugin-turn');
const grant = require('../main/pi-session/plugin-grant');
const personal = require('../main/personal-plugins');
const NS = '9af442c8-cd1d-4b91-a668-22da2b2635bf';
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for(let i=0;i<300;i++){if(fn())return;await delay(10);}throw Error('timeout'); }
function plugin(id='p', capabilities={}) {
  return {pluginId:id, name:'测试插件', version:'1.0.0', context:'Only the plugin knows PLUGIN-SECRET-MARKER', capabilities};
}
function harness(t, opts={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-runner-plugin-'));
  const app={getPath:()=>root};
  const spec=opts.spec || catalog.runtime('opencode'), ref=String(opts.ref || 'chat-plugin-test');
  const id=_uuidV5(NS,'chat:'+ref+':'+spec.id);
  const calls=[], events=[];
  let hold=null, released=false, count=0;
  const runtime={async rpc(op,payload){
    calls.push({op,payload});
    if(op==='job.dispatch'||op==='job.comment'){
      if(opts.failDispatch)return {ok:false,error:'test-ticket dispatch failed'};
      const first=op==='job.dispatch';
      events.push({seq:events.length+1,kind:'user',
        text:first?payload.ctx.conversationUserText:payload.text,
        plugins:first?payload.ctx.conversationPlugins:payload.plugins});
      count++;
      return {ok:true,data:{ref:id,ok:true}};
    }
    if(op==='job.session'){
      if(opts.hold && !released) await new Promise(r=>{hold=r;});
      if(events.at(-1)?.kind==='user')events.push({seq:events.length+1,kind:'say',text:opts.reply||'completed '+count});
      return {ok:true,data:{ok:true,status:'done',items:events.filter(e=>e.seq>payload.since)}};
    }
    if(op==='job.stop')return {ok:true,data:{ok:true}};
    if(op==='runtime.detect')return {ok:true,data:{accessControl:{schema:'soduwork.access-policy/v1',supported:true,modes:['standard','readonly','full']}}};
    throw Error(op);
  }};
  const adapter=createRunnerRuntimeAdapter({app, runtimeSpec:spec, runnerRuntime:runtime,
    modelConfig:{fetchModel:async()=>({ok:true,model:{id:'fixture',baseUrl:'http://model.invalid',key:'model-ticket'}}),...opts.modelConfig}});
  let sessions=[];
  t.after(async()=>{released=true;hold?.();for(const s of sessions)await s.dispose();fs.rmSync(root,{recursive:true,force:true});});
  async function open(extra={}){
    const session=await adapter.createSession({identity:{},native:{runner:{openOptions:{
      app,ref,cwd:root,identity:{},capabilityIds:[],...opts.open,...extra}}}});
    sessions.push(session);return session;
  }
  return {root,app,open,calls,events,id,
    release(){released=true;hold?.();}, get held(){return !!hold;}};
}
for (const adapterId of ['harness2', 'opencode']) {
  test(adapterId + ' sends the shared Pi conversation contract before plugins and final language', async t => {
    const contract = require('../main/conversation/agent-contract');
    const locale = require('../main/native-locale.cjs');
    const h = harness(t, { spec: catalog.runtime(adapterId), open: {
      resolvePlugins: async ids => ({ items: ids.map(id => plugin(id)), grant: { servers: [], guide: 'PLUGIN-GUIDE' } }),
    } });
    const session = await h.open();
    await session.send({ text: 'create a report' }).completion;
    await session.send({ text: 'revise the report', options: { pluginIds: ['p1'] } }).completion;
    const prompts = h.calls.filter(row => ['job.dispatch', 'job.comment'].includes(row.op))
      .map(row => row.op === 'job.dispatch' ? row.payload.task.note : row.payload.promptText);
    assert.equal(prompts.length, 2);
    for (const prompt of prompts) {
      assert.ok(prompt.includes(contract.BASE), 'ordinary Runner work receives the same execution and delivery rules as Pi');
      assert.equal(prompt.endsWith(contract.outputLanguage(locale.getLocale())), true);
      assert.equal(prompt.split(contract.outputLanguage(locale.getLocale())).length, 2, 'language contract appears once at the end');
    }
    assert.ok(prompts[1].indexOf(contract.BASE) < prompts[1].indexOf('PLUGIN-GUIDE'));
  });
}

test('Runner plugin preprocessing preserves the full original request for dispatch and continuation', async t => {
  const h = harness(t, { open: { resolvePlugins: async ids => ({ items: ids.map(id => plugin(id)), grant: { servers: [] } }) } });
  const session = await h.open();
  const raw = '  /需求 #1\r\n' + '完整原文'.repeat(400) + '\n  ';
  for (const text of [raw, raw + '继续']) assert.equal((await session.send({ text, options: { pluginIds: ['p1'] } }).completion).ok, true);
  const dispatch = h.calls.find(row => row.op === 'job.dispatch').payload;
  const comment = h.calls.find(row => row.op === 'job.comment').payload;
  assert.equal(dispatch.ctx.conversationUserText, raw);
  assert.ok(dispatch.task.note.includes('【用户原话】\n' + raw));
  assert.equal(comment.text, raw + '继续');
  assert.ok(comment.promptText.includes('【用户原话】\n' + raw + '继续'));
});

test('Runner rejects over-limit requests before dispatch instead of silently cutting the request', async t => {
  const h = harness(t), session = await h.open();
  const result = session.send({ text: 'A'.repeat(50000) + 'MUST_NOT_DISAPPEAR' });
  assert.equal(result.accepted, false);
  assert.match(result.result.reason, /50000|50,000/);
  assert.equal(h.calls.filter(row => ['job.dispatch', 'job.comment'].includes(row.op)).length, 0);
});
for(const spec of catalog.runnerRuntimes()){
  test(spec.displayName+' resolves trusted plugins for first, queued, follow-up and restored turns',async t=>{
    const resolutions=[],cleanups=[];
    const h=harness(t,{spec,hold:true,open:{resolvePlugins:async(ids,projectId)=>{
      resolutions.push({ids,projectId});
      return {items:ids.map(id=>plugin(id)),grant:{servers:[],guide:'RUNTIME-GUIDE-'+resolutions.length,
        cleanup:()=>cleanups.push(ids[0]),redact:s=>s.replaceAll('test-ticket','[hidden]')}};
    }}});
    const s=await h.open(), handle=getRunnerSessionDetails(s).handle;
    const first=s.send({text:'first',options:{pluginIds:['p1'],projectId:'project'}});
    await until(()=>h.held);
    const second=s.send({text:'queued',options:{pluginIds:['p2']}});
    assert.equal(second.queued,true);assert.equal(resolutions.length,1);
    assert.deepEqual(s.snapshot().activePlugins,['p1'], 'queued selection cannot change the executing turn');
    const payload=h.calls.find(c=>c.op==='job.dispatch').payload;
    assert.match(payload.task.note,/PLUGIN-SECRET-MARKER/);
    assert.match(payload.task.note,/RUNTIME-GUIDE/);
    assert.equal(payload.ctx.conversationUserText,'first');
    assert.equal(payload.ctx.conversationPlugins[0].pluginId,'p1');
    assert.deepEqual(cleanups,[]);
    h.release();
    assert.equal((await first.completion).ok,true);
    assert.equal((await second.completion).ok,true);
    await until(()=>!handle.inFlight());
    const comment=h.calls.find(c=>c.op==='job.comment').payload;
    assert.deepEqual(comment.cfg.skillSelection, payload.ctx.skills,
      'follow-up turns must carry the current selection so Runner can replace the read scope');
    assert.equal(comment.text,'queued');assert.match(comment.promptText,/PLUGIN-SECRET-MARKER/);
    assert.equal(comment.plugins[0].pluginId,'p2');
    assert.deepEqual(resolutions,[{ids:['p1'],projectId:'project'},{ids:['p2'],projectId:''}]);
    assert.deepEqual(cleanups,['p1','p2']);
    assert.equal((await handle.send('follow-up',[],{pluginIds:['p3']})).ok,true);
    await until(()=>!handle.inFlight());
    assert.equal((await handle.send('follow-up without selecting plugin',[])).ok,true);
    await until(()=>!handle.inFlight());
    const inherited=h.calls.filter(c=>c.op==='job.comment').at(-1).payload;
    assert.match(inherited.promptText,/PLUGIN-SECRET-MARKER/);
    assert.match(inherited.promptText,/RUNTIME-GUIDE-4/);
    assert.doesNotMatch(inherited.promptText,/RUNTIME-GUIDE-3/);
    assert.deepEqual(resolutions.at(-1).ids,['p3']);
    assert.equal((await handle.send('ordinary without plugin',[],{clearPluginSelection:true,pluginIds:['stale-plugin']})).ok,true);
    assert.equal(resolutions.length,4);
    assert.deepEqual(cleanups,['p1','p2','p3','p3']);
    assert.doesNotMatch(h.calls.filter(c=>c.op==='job.comment').at(-1).payload.promptText,/soduwork-conversation-plugins/);
    assert.doesNotMatch(JSON.stringify(s.snapshot()),/PLUGIN-SECRET-MARKER|RUNTIME-GUIDE|test-ticket/);
    assert.deepEqual(s.snapshot().messages.filter(m=>m.role==='user').map(m=>m.plugins.map(p=>p.pluginId)),
      [['p1'],['p2'],['p3'],['p3'],[]]);
    const restored=await h.open({resumePath:h.id});
    await until(()=>restored.snapshot().messages.length===10);
    assert.deepEqual(restored.snapshot().messages.filter(m=>m.role==='user').map(m=>m.plugins.map(p=>p.pluginId)),
      [['p1'],['p2'],['p3'],['p3'],[]]);
    assert.deepEqual(restored.snapshot().activePlugins,[], 'restoring cannot undo an explicit clear');
    assert.equal((await restored.send({text:'after restored clear'}).completion).ok,true);
    assert.equal(resolutions.length,4);
  });

  test(spec.displayName+' restores conversation plugins for follow-ups while isolating new sessions',async t=>{
    const resolutions=[];
    const h=harness(t,{spec,ref:'chat-plugin-restore',open:{resolvePlugins:async ids=>{
      resolutions.push(ids.slice());
      return {items:ids.map(id=>plugin(id)),grant:{cleanup(){}}};
    }}});
    const s=await h.open();
    assert.equal((await s.send({text:'first with Tencent Meeting',options:{pluginIds:['tencent-meeting']}}).completion).ok,true);
    await until(()=>!getRunnerSessionDetails(s).handle.inFlight());
    assert.deepEqual(s.snapshot().activePlugins,['tencent-meeting']);

    const restored=await h.open({resumePath:h.id});
    const queued=restored.send({text:'second without selecting the plugin',options:{}});
    assert.equal(queued.queued,true, 'follow-up must wait for the archive selection to be restored');
    const followUp=await queued.completion;
    assert.equal(followUp.ok,true);
    await until(()=>!getRunnerSessionDetails(restored).handle.inFlight());
    assert.deepEqual(resolutions,[['tencent-meeting'],['tencent-meeting']]);
    assert.deepEqual(restored.snapshot().messages.filter(m=>m.role==='user').map(m=>m.plugins.map(p=>p.pluginId)),
      [['tencent-meeting'],['tencent-meeting']]);

    const freshHarness=harness(t,{spec,ref:'chat-plugin-fresh',open:{resolvePlugins:async ids=>{
      resolutions.push(ids.slice());
      return {items:ids.map(id=>plugin(id)),grant:{cleanup(){}}};
    }}});
    const fresh=await freshHarness.open();
    assert.deepEqual(fresh.snapshot().activePlugins,[]);
    const freshResult=await fresh.send({text:'new session without plugin',options:{}}).completion;
    assert.equal(freshResult.ok,true);
    await until(()=>!getRunnerSessionDetails(fresh).handle.inFlight());
    assert.deepEqual(resolutions,[['tencent-meeting'],['tencent-meeting']]);
  });
}
test('Runner queued turns inherit the selection at execution; cancelling a queued change leaves it intact',async t=>{
  const resolutions=[],cleanups=[];
  const h=harness(t,{hold:true,open:{resolvePlugins:async ids=>{
    resolutions.push(ids.slice());
    return {items:ids.map(id=>plugin(id)),grant:{cleanup:()=>cleanups.push(ids[0])}};
  }}});
  const session=await h.open(), handle=getRunnerSessionDetails(session).handle;
  const first=session.send({text:'first',options:{pluginIds:['p1']}});
  await until(()=>h.held);
  const inherited=session.send({text:'keep current'});
  const changed=session.send({text:'change selection',options:{pluginIds:['p2']}});
  const cancelled=session.send({text:'cancel this change',options:{pluginIds:['cancelled']}});
  const afterChange=session.send({text:'inherit changed selection'});
  assert.equal(handle.cancelQueued(cancelled.queueId).ok,true);
  assert.deepEqual(session.snapshot().activePlugins,['p1']);
  assert.deepEqual(resolutions,[['p1']]);
  h.release();
  for (const item of [first,inherited,changed,afterChange]) assert.equal((await item.completion).ok,true);
  assert.equal((await cancelled.completion).cancelled,true);
  assert.deepEqual(resolutions,[['p1'],['p1'],['p2'],['p2']]);
  assert.deepEqual(cleanups,['p1','p1','p2','p2']);
  assert.deepEqual(session.snapshot().messages.filter(m=>m.role==='user').map(m=>m.plugins.map(p=>p.pluginId)),
    [['p1'],['p1'],['p2'],['p2']]);
});
test('Runner rechecks permission for inherited plugins and refuses a revoked grant before dispatch',async t=>{
  let resolutions=0,cleanups=0;
  const h=harness(t,{open:{resolvePlugins:async ids=>{
    if (++resolutions>1) throw Error('Plugin permission revoked');
    return {items:ids.map(id=>plugin(id)),grant:{cleanup:()=>cleanups++}};
  }}});
  const session=await h.open(),handle=getRunnerSessionDetails(session).handle;
  assert.equal((await session.send({text:'authorized',options:{pluginIds:['p1']}}).completion).ok,true);
  await until(()=>!handle.inFlight());
  const result=await session.send({text:'permission changed'}).completion;
  assert.equal(result.ok,false);assert.equal(result.failureKind,'plugin-grant');
  assert.match(result.reason,/permission revoked/);
  assert.equal(resolutions,2);assert.equal(cleanups,1);
  assert.equal(h.calls.filter(c=>c.op==='job.comment').length,0);
});
for (const adapterId of ['harness2', 'opencode']) {
  test(adapterId + ': denied plugin selection does not contaminate the next ordinary message', async t => {
    const resolutions = [];
    const h = harness(t, { spec: catalog.runtime(adapterId), open: { resolvePlugins: async ids => {
      resolutions.push(ids.slice()); throw Error('Requested plugin lacks browser capability');
    } } });
    const session = await h.open(), handle = getRunnerSessionDetails(session).handle;
    const denied = await session.send({ text: 'request with unavailable plugin', options: { pluginIds: ['denied'] } }).completion;
    assert.equal(denied.ok, false); assert.equal(denied.failureKind, 'plugin-grant');
    assert.deepEqual(session.snapshot().activePlugins, [], 'rejected selection was never activated');
    assert.equal(session.snapshot().execution.turnQueue.paused, true);
    const ordinary = session.send({ text: 'ordinary follow-up without plugins' });
    assert.equal(ordinary.queued, false);
    assert.equal((await ordinary.completion).ok, true);
    await until(() => !handle.inFlight());
    assert.deepEqual(resolutions, [['denied']]);
    assert.deepEqual(session.snapshot().messages.filter(row => row.role === 'user').map(row => row.text), ['ordinary follow-up without plugins']);
    assert.equal(h.calls.filter(row => row.op === 'job.dispatch').length, 1);
  });
  test(adapterId + ': a rejected replacement preserves the last authorized plugin and pending queue', async t => {
    const resolutions = [];
    const h = harness(t, { spec: catalog.runtime(adapterId), open: { resolvePlugins: async ids => {
      resolutions.push(ids.slice());
      if (ids.includes('denied')) throw Error('Requested replacement is unavailable');
      return { items: ids.map(id => plugin(id)), grant: { cleanup() {} } };
    } } });
    const session = await h.open(), handle = getRunnerSessionDetails(session).handle;
    assert.equal((await session.send({ text: 'authorized first request', options: { pluginIds: ['allowed'] } }).completion).ok, true);
    await until(() => !handle.inFlight());
    const denied = session.send({ text: 'replace with denied plugin', options: { pluginIds: ['denied'] } });
    const later = session.send({ text: 'already queued follow-up' });
    assert.equal((await denied.completion).ok, false);
    assert.deepEqual(session.snapshot().activePlugins, ['allowed']);
    assert.equal(session.snapshot().execution.turnQueue.paused, true);
    assert.deepEqual(session.snapshot().execution.queue.map(row => row.id), [later.queueId]);
    const newest = session.send({ text: 'new message preserves pending work' });
    assert.equal(newest.queued, true);
    assert.equal(h.calls.filter(row => row.op === 'job.comment').length, 0, 'pending queue requires explicit continuation');
    assert.equal(handle.updateQueue('', 'resume').ok, true);
    assert.equal((await later.completion).ok, true); assert.equal((await newest.completion).ok, true);
    assert.deepEqual(resolutions, [['allowed'], ['denied'], ['allowed'], ['allowed']]);
    assert.deepEqual(h.calls.filter(row => row.op === 'job.comment').map(row => row.payload.text), ['already queued follow-up', 'new message preserves pending work']);
    assert.equal((await session.send({ text: 'explicitly clear all plugins', options: { clearPluginSelection: true, pluginIds: ['denied'] } }).completion).ok, true);
    assert.deepEqual(session.snapshot().activePlugins, []);
    assert.equal(resolutions.length, 4, 'explicit clear retains priority over a supplied selection');
  });
}
test('ordinary model preflight failure releases only its idle automatic pause on fresh input', async t => {
  let unavailable = false;
  const h = harness(t, { modelConfig: { fetchModel: async (_identity, name) => unavailable
    ? { ok: false } : { ok: true, model: { id: name || 'fixture', baseUrl: 'http://model.invalid', key: 'synthetic' } } } });
  const session = await h.open(), handle = getRunnerSessionDetails(session).handle;
  assert.equal((await session.send({ text: 'first ordinary request' }).completion).ok, true);
  await until(() => !handle.inFlight());
  assert.equal((await handle.selectModel('replacement')).ok, true); unavailable = true;
  const failed = await session.send({ text: 'model fails before dispatch' }).completion;
  assert.equal(failed.ok, false); assert.match(failed.reason, /模型不可用/);
  assert.equal(session.snapshot().execution.turnQueue.paused, true);
  assert.equal(h.calls.filter(row => row.op === 'job.comment').length, 0);
  unavailable = false;
  const fresh = session.send({ text: 'ordinary request after model recovery' });
  assert.equal(fresh.queued, false); assert.equal((await fresh.completion).ok, true);
  assert.equal(session.snapshot().execution.turnQueue.paused, false);
  assert.deepEqual(h.calls.filter(row => row.op === 'job.comment').map(row => row.payload.text), ['ordinary request after model recovery']);
});
test('fresh ordinary input preserves an explicit admission pause until the queue is resumed', async t => {
  const options = { failDispatch: true }, h = harness(t, options);
  const session = await h.open(), handle = getRunnerSessionDetails(session).handle;
  assert.equal((await session.send({ text: 'explicitly refused admission' }).completion).ok, false);
  options.failDispatch = false;
  const fresh = session.send({ text: 'new ordinary input' });
  assert.equal(fresh.queued, true); assert.equal(session.snapshot().execution.turnQueue.paused, true);
  assert.equal(h.calls.filter(row => row.op === 'job.dispatch').length, 1);
  assert.equal(handle.updateQueue('', 'resume').ok, true);
  assert.equal((await fresh.completion).ok, true);
  assert.deepEqual(h.calls.filter(row => row.op === 'job.dispatch').map(row => row.payload.ctx.conversationUserText), ['explicitly refused admission', 'new ordinary input']);
});
test('authorization errors never dispatch or append a pretend success; queued input stays intact',async t=>{
  let cleaned=0;
  const h=harness(t,{open:{resolvePlugins:async()=>({items:[plugin('p',{runtime:['computer']})],
    grant:{cleanup:()=>cleaned++}})}});
  const s=await h.open();
  const a=s.send({text:'needs desktop',options:{pluginIds:['p']}});
  const b=s.send({text:'keep this later'});
  const result=await a.completion;
  assert.equal(result.ok,false);assert.equal(result.failureKind,'plugin-grant');assert.equal(result.retrySafe,true);
  assert.match(result.reason,/操作电脑/);assert.equal(cleaned,1);assert.equal(h.calls.filter(c=>c.op.startsWith('job.')).length,0);
  assert.equal(s.snapshot().messages.length,0);
  assert.equal(s.snapshot().queue[0].id,b.queueId);
});
test('cancel and close while authorization is pending release grants and do not dispatch',async t=>{
  for(const action of ['cancel','close']){
    let release,cleaned=0;
    const h=harness(t,{open:{resolvePlugins:()=>new Promise(r=>release=r)}});
    const s=await h.open(), handle=getRunnerSessionDetails(s).handle;
    const sent=s.send({text:'cancel while preparing',options:{pluginIds:['p']}});
    await until(()=>!!release);handle[action]();
    release({items:[plugin()],grant:{cleanup:()=>cleaned++}});
    assert.equal((await sent.completion).cancelled,true);
    assert.equal(cleaned,1);assert.equal(h.calls.filter(c=>c.op.startsWith('job.')).length,0);
  }
});
test('per-turn grant redacts Runner output and is removed after completion',async t=>{
  let cleaned=0;
  const h=harness(t,{reply:'test-ticket',open:{resolvePlugins:async()=>({items:[plugin()],
    grant:{redact:s=>s.replaceAll('test-ticket','[hidden]'),cleanup:()=>cleaned++}})}});
  const s=await h.open();assert.equal((await s.send({text:'redact',options:{pluginIds:['p']}}).completion).ok,true);
  assert.equal(cleaned,1);assert.doesNotMatch(JSON.stringify(s.snapshot()),/test-ticket/);
  assert.match(JSON.stringify(s.snapshot()),/\[hidden\]/);
});
test('local installed resource plugin uses real resolver/materialization without Hub',async t=>{
  const h=harness(t);
  const installed=personal.create(h.app,{template:'method',key:'runner-local-resource',name:'本机资源',
    version:'1.0.0',description:'测试本机资源',instructions:'Read references/receipt.txt',
    resources:[{path:'references/receipt.txt',kind:'reference',encoding:'utf8',content:'LOCAL-RESOURCE-CONTENT'}]});
  assert.equal(installed.ok,true,JSON.stringify(installed));
  const id=personal.catalog(h.app,true).find(p=>p.key==='runner-local-resource').pluginId;
  const s=await h.open({resolvePlugins:(pluginIds,projectId)=>grant.resolve({
    app:h.app,cwd:h.root,pluginIds,projectId,identityOf:()=>{throw Error('Unexpected Hub call');}})});
  assert.equal((await s.send({text:'read it',options:{pluginIds:[id]}}).completion).ok,true);
  const note=h.calls.find(c=>c.op==='job.dispatch').payload.task.note;
  assert.match(note,/receipt\.txt/);assert.match(note,/Read references/);
  const bundles=h.calls.find(c=>c.op==='job.dispatch').payload.cfg.pluginResourceBundles;
  assert.equal(bundles.length,1);assert.equal(bundles[0].pluginId,id);
  assert.equal(require('../main/plugin-resources').digest(bundles[0].resources),bundles[0].digest);
  assert.equal(Buffer.from(bundles[0].resources[0].content,'base64').toString(),'LOCAL-RESOURCE-CONTENT');
  assert.doesNotMatch(JSON.stringify(s.snapshot()),/LOCAL-RESOURCE-CONTENT/);
  await until(()=>!getRunnerSessionDetails(s).handle.inFlight());
  await s.send({text:'read again',options:{pluginIds:[id]}}).completion;
  assert.equal(h.calls.filter(c=>c.op==='job.comment').at(-1).payload.cfg.pluginResourceBundles.length,1);
  await until(()=>!getRunnerSessionDetails(s).handle.inFlight());
  await s.send({text:'ordinary',options:{clearPluginSelection:true,pluginResourceBundles:bundles,readRoots:[h.root]}}).completion;
  assert.deepEqual(h.calls.filter(c=>c.op==='job.comment').at(-1).payload.cfg.pluginResourceBundles,[],
    'renderer data cannot grant resources; an unselected plugin expires on the next turn');
});
test('missing resolver, empty grant, read-only and unbound MCP all fail closed',async()=>{
  for(const opts of [
    {},
    {resolvePlugins:async()=>({items:[]})},
    {readOnly:true,resolvePlugins:async()=>({items:[plugin('p',{runtime:['files']})]})},
    {resolvePlugins:async()=>({items:[plugin('p',{mcpServers:['unbound']})]})}
  ]){
    const result=await pluginTurn.prepare(opts,{pluginIds:['p']});
    assert.equal(result.ok,false);assert.equal(result.failureKind,'plugin-grant');
  }
});
test('multiple long plugin contexts arrive intact, renderer-supplied instructions are ignored',async t=>{
  const h=harness(t,{open:{resolvePlugins:async ids=>({items:ids.map(id=>({
    ...plugin(id),context:'x'.repeat(9900)+'TAIL-'+id}))})}});
  const s=await h.open();
  const result=await s.send({text:'original',options:{plugins:[
    {pluginId:'p1',context:'untrusted injection'},{pluginId:'p2'},{pluginId:'p3'}]}}).completion;
  assert.equal(result.ok,true);
  const prompt=h.calls.find(c=>c.op==='job.dispatch').payload.task.note;
  for(const id of ['p1','p2','p3'])assert.match(prompt,new RegExp('TAIL-'+id));
  assert.doesNotMatch(prompt,/untrusted injection/);
});
test('real MCP grant config lives only for the active Runner turn, including cancellation',async t=>{
  for(const cancel of [false,true]){
    let configFile='',resolutions=0;
    const h=harness(t,{hold:true,open:{resolvePlugins:async pluginIds=>{
      resolutions++;
      const resolved=await grant.resolve({app:h.app,ref:'mcp-test',pluginIds,
        identityOf:async()=>({hub:'https://fixture.invalid',clientId:'fixture',secret:'fixture'}),
        fetchImpl:async()=>({ok:true,json:async()=>({ok:true,items:[plugin('mcp',{mcpServers:['crm']})],
          mcpGrant:{ticket:'isolated-mcp-ticket',servers:['crm']}})})});
      configFile=resolved.grant.configFile;return resolved;
    }}});
    const s=await h.open(),handle=getRunnerSessionDetails(s).handle;
    const sent=s.send({text:'MCP test',options:{pluginIds:['mcp']}});
    await until(()=>h.held);
    assert.equal(resolutions,1);assert.ok(fs.existsSync(configFile));
    const note=h.calls.find(c=>c.op==='job.dispatch').payload.task.note;
    assert.match(note,/--config/);assert.doesNotMatch(note,/isolated-mcp-ticket/);
    assert.doesNotMatch(JSON.stringify(s.snapshot()),/isolated-mcp-ticket|--config/);
    if(cancel)handle.cancel();else h.release();
    const result=await sent.completion;
    assert.equal(result.ok,true);assert.equal(Boolean(result.cancelled),cancel);
    assert.equal(fs.existsSync(configFile),false);
    h.release();
  }
});
test('Runner dispatch failure redacts its error and releases the plugin grant',async t=>{
  let cleaned=0;
  const h=harness(t,{failDispatch:true,open:{resolvePlugins:async()=>({items:[plugin()],
    grant:{redact:s=>s.replaceAll('test-ticket','[hidden]'),cleanup:()=>cleaned++}})}});
  const s=await h.open();
  const result=await s.send({text:'fail dispatch',options:{pluginIds:['p']}}).completion;
  assert.equal(result.ok,false);assert.doesNotMatch(result.reason,/test-ticket/);
  assert.equal(cleaned,1);assert.doesNotMatch(JSON.stringify(s.snapshot()),/test-ticket/);
});

for (const spec of catalog.runnerRuntimes()) {
  test(spec.displayName + ' ordinary conversation connectors refresh per turn without plugin badges', async t => {
    let turns = 0, cleaned = 0;
    const h = harness(t, { spec, reply: 'connector-private-ticket', open: {
      resolveConnectors: async () => ({ guide: 'CONNECTOR-GUIDE-' + (++turns), servers: ['fixture'],
        cleanup() { cleaned++; }, redact: text => text.replaceAll('connector-private-ticket', '[hidden]') }) } });
    const s = await h.open(), handle = getRunnerSessionDetails(s).handle;
    assert.equal((await s.send({ text: 'ordinary first' }).completion).ok, true);
    await until(() => !handle.inFlight());
    assert.equal((await s.send({ text: 'ordinary followup' }).completion).ok, true);
    assert.equal(turns, 2); assert.equal(cleaned, 2);
    assert.match(h.calls.find(row => row.op === 'job.dispatch').payload.task.note, /CONNECTOR-GUIDE-1/);
    assert.match(h.calls.find(row => row.op === 'job.comment').payload.promptText, /CONNECTOR-GUIDE-2/);
    assert.deepEqual(s.snapshot().activePlugins, []);
    assert.doesNotMatch(JSON.stringify(s.snapshot()), /CONNECTOR-GUIDE|connector-private-ticket/);
    assert.ok(s.snapshot().messages.filter(row => row.role === 'user').every(row => !row.plugins.length));
  });
}
test('ordinary Runner connector cancellation cleans a late grant and never dispatches', async t => {
  for (const action of ['cancel', 'close']) {
    let release, cleaned = 0;
    const h = harness(t, { open: { resolveConnectors: () => new Promise(resolve => { release = resolve; }) } });
    const s = await h.open(), handle = getRunnerSessionDetails(s).handle;
    const sent = s.send({ text: 'ordinary cancelled' });
    await until(() => release); handle[action]();
    release({ guide: 'LATE-CONNECTOR', cleanup() { cleaned++; } });
    assert.equal((await sent.completion).cancelled, true);
    assert.equal(cleaned, 1);
    assert.equal(h.calls.filter(row => row.op === 'job.dispatch').length, 0);
  }
});
test('Runner optional connector errors still complete a normal turn and release dispatch failures', async t => {
  const h = harness(t, { open: { resolveConnectors: async () => { throw Error('private-provider-error'); } } });
  const s = await h.open();
  assert.equal((await s.send({ text: 'normal chat' }).completion).ok, true);
  assert.doesNotMatch(h.calls.find(row => row.op === 'job.dispatch').payload.task.note, /private-provider-error/);
  let cleaned = 0;
  const failing = harness(t, { failDispatch: true, open: { resolveConnectors: async () => ({
    guide: 'fixture guide', servers: ['fixture'], cleanup() { cleaned++; }, redact: text => text.replaceAll('test-ticket', '[hidden]') }) } });
  const failed = await failing.open();
  const result = await failed.send({ text: 'failing runtime' }).completion;
  assert.equal(result.ok, false); assert.equal(cleaned, 1); assert.doesNotMatch(result.reason, /test-ticket/);
});

test('Runner uses its effective readonly policy instead of an old readOnly=false snapshot for connectors', async t => {
  const h = harness(t); let observed;
  const s = await h.open({ readOnly: false, accessPolicy: require('../main/access-control/policy').create('readonly', h.root),
    resolveConnectors: async options => { observed = options.readOnly; return { guide: 'READONLY-NO-CONNECTORS', servers: [] }; } });
  assert.equal((await s.send({ text: 'read-only ordinary turn' }).completion).ok, true);
  assert.equal(observed, true);
});
