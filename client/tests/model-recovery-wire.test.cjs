'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {pathToFileURL}=require('node:url');
const config=require('../main/pi-session/model-config');
async function until(check,timeout=12000){
  const end=Date.now()+timeout;
  while(Date.now()<end){const value=check();if(value)return value;await new Promise(r=>setTimeout(r,20));}
  throw Error('Timed out waiting for native session state');
}
for (const initialStatus of [500, 504, 'truncated', 'summary', 'summary-local', 'summary-tool-call', 'denied-policy', 'denied-legacy']) test('real Pi recovery (' + initialStatus + ') retains completed tools and consumes the recovery action once', {timeout:60000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-recovery-wire-'));
  const cwd=path.join(root,'work'),agentDir=path.join(root,'agent');fs.mkdirSync(cwd);fs.mkdirSync(agentDir);
  // Fast but otherwise real SDK retry policy, isolated from user configuration.
  const retries=initialStatus===500?2:6;
  fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({retry:{enabled:true,baseDelayMs:10,
    delayScheduleMs:[10,20,40,80,160,320],
    ...(initialStatus===500?{maxRetries:2}:{})}})); // HTTP504 uses the shipped six-retry default.
  const summaryCase = String(initialStatus).startsWith('summary');
  const deniedCase = String(initialStatus).startsWith('denied');
  const local = initialStatus === 'summary-local';
  const replacement = local ? 'local:model-' + 'a'.repeat(32) : 'replacement';
  const wireModel = local ? 'local-wire-test' : replacement;
  let summaryAuth, releaseDenial;
  const denialPending = new Promise(resolve => { releaseDenial = resolve; });
  const captured=[],receipts=[];let healthy=false,toolOffered=false,failureStatus=summaryCase ? 403 : initialStatus;
  const gatewayBody='<html><body><h1>504 Gateway Time-out</h1>The server did not respond in time. '+
    'http://192.0.2.40:8181/private?token=fixture-secret</body></html>';
  const output=path.join(cwd,'saved-once.txt');
  const server=http.createServer((req,res)=>{
    let raw='';req.on('data',part=>raw+=part);req.on('end',async()=>{
      const body=JSON.parse(raw);captured.push(body);
      if (body.model === wireModel) summaryAuth = req.headers.authorization;
      if(toolOffered&&!healthy){
        if (summaryCase) await denialPending;
        if(failureStatus===0){req.socket.destroy();return;}
        if(failureStatus==='truncated'||failureStatus==='truncated-once'){
          if(failureStatus==='truncated-once')healthy=true;
          res.writeHead(200,{'Content-Type':'text/event-stream'});
          res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',
            choices:[{index:0,delta:{role:'assistant',content:'Partial reply'},finish_reason:null}]})+'\n\n');return;
        }
        if (summaryCase || deniedCase) {
          const category = initialStatus === 'denied-policy' ? 'restricted' : 'generic';
          const trace = 'a'.repeat(32);
          const categoryFields = initialStatus === 'denied-legacy' ? {} : {refusalCategory: category};
          const marker = categoryFields.refusalCategory ? ' [soduwork-refusal:' + category + ']' : '';
          const data = JSON.stringify({ error: { status: 403, code: 403, type: 'soduwork_proxy_error',
            ...categoryFields, diagnosticId: trace, message: 'HTTP 403：模型请求被拒绝' + marker + ' [soduwork-trace:' + trace + ']' } });
          if (local) {
            res.writeHead(403, {'Content-Type':'application/json'}); res.end(data);
          } else {
            res.writeHead(200, {'Content-Type':'text/event-stream'}); res.end('data: ' + data + '\n\n');
          }
          return;
        }
        res.writeHead(failureStatus,{'Connection':'close','Content-Type':'text/html'});
        res.end(failureStatus===504?gatewayBody:'');return;
      }
      const unexpected = initialStatus === 'summary-tool-call' && body.model === 'replacement';
      const tool=!toolOffered || unexpected;toolOffered=true;
      const delta=tool ? {role:'assistant',content:'Saving the file once.',tool_calls:[{index:0,id:'save_once',type:'function',function:{name:'write',arguments:JSON.stringify({path:unexpected ? output + '.unexpected' : output,content:'saved exactly once'})}}]}
        : {role:'assistant',content:'Finished safely.'};
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
      res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}})+'\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const sdk=await import(pathToFileURL(path.join(__dirname,'../node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  const sessions=require('../main/pi-session/session');
  const model={id:'fixture',quotaProvider:'fixture-service',configRevision:'a'.repeat(64),label:'Fixture',contextWindow:32000,input:['text'],key:'fixture',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1'};
  config.noProxyFor(model.baseUrl);
  const modelPath=config.writeModels(agentDir,model),prepare=config.prepare,create=sdk.ModelRuntime.create;
  const env=process.env.SODUWORK_PROXY_KEY;process.env.SODUWORK_PROXY_KEY='fixture';
  config.prepare=async()=>({ok:true,provider:'soduwork',agentDir,model});
  sdk.ModelRuntime.create=()=>create.call(sdk.ModelRuntime,{modelsPath:modelPath,authPath:path.join(agentDir,'auth.json'),modelsStorePath:path.join(agentDir,'models.db')});
  const fetchSelection = config.fetchSelection;
  if (summaryCase) config.fetchSelection = async (_, name) => ({
    ok: true, model: { ...model, id: name || model.id,
      ...(name === replacement ? { key: 'replacement-key', quotaProvider: 'replacement-provider',
        quotaVersion: 2, quotaUsageToken: 'fixture-usage' } : {}),
      ...(local && name === replacement ? { localOnly: true, modelRef: replacement, wireModelId: wireModel } : {}) },
  });
  let session;
  t.after(async()=>{
    if(session)await session.close();config.fetchSelection=fetchSelection;config.prepare=prepare;sdk.ModelRuntime.create=create;
    if(env===undefined)delete process.env.SODUWORK_PROXY_KEY;else process.env.SODUWORK_PROXY_KEY=env;
    server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});
  });
  const opened=await sessions.open({app:{isPackaged:false,getPath:()=>root},identity:{},cwd,ephemeral:true});
  assert.equal(opened.ok,true,opened.reason);session=opened.session;
  const first=session.submit('TASK_A: write saved-once.txt and report completion.',[],{taskId:'a',taskTitle:'A', goalMode: initialStatus === 'summary-tool-call',
    beforeTurn:async()=>receipts.push('a:start'),beforeRetry:async()=>receipts.push('a:recovery'),afterTurn:async status=>receipts.push('a:'+status)});
  const second=session.submit('TASK_B: reply with Finished safely.',[],{taskId:'b',taskTitle:'B',beforeTurn:async()=>receipts.push('b:start'),afterTurn:async status=>receipts.push('b:'+status)});
  if (summaryCase) {
    await until(() => captured.length === 2);
    // Change the composer's future selection before the active request receives its denial.
    const selected = await session.selectModel(replacement);
    releaseDenial();
    assert.equal(selected.ok, true);
  }
  const firstResult=await first.completion;
  if (deniedCase) {
    const denied = session.snapshot();
    assert.equal(captured.length, 2);
    assert.equal(denied.completion.modelFailure.phase, 'tool-result');
    assert.equal(denied.completion.retryable, false);
    assert.equal(denied.execution.modelRecovery, null);
    assert.equal(denied.execution.turnQueue.paused, true);
    assert.equal(fs.readFileSync(output, 'utf8'), 'saved exactly once');
    return;
  }
  let failed;
  try { failed=await until(()=>{const s=session.snapshot();return s.execution.modelRecovery&&s;}); }
  catch(error){throw Error(error.message+' '+JSON.stringify({result:firstResult.reason,completion:firstResult.snapshot?.completion,
    status:session.snapshot().status,recovery:session.snapshot().execution.modelRecovery,queue:session.snapshot().execution.turnQueue,receipts,requests:captured.length}));}
  assert.equal(fs.readFileSync(output,'utf8'),'saved exactly once');
  const mtime=fs.statSync(output).mtimeMs;
  assert.equal(failed.execution.running,false);assert.equal(failed.execution.turnQueue.activeTaskId,'');
  assert.equal(failed.execution.turnQueue.tasks.find(x=>x.taskId==='a').status,'failed');
  assert.equal(failed.execution.queue[0].taskId,'b');assert.ok(!receipts.includes('b:start'));
  assert.equal(failed.status,'unreachable');assert.equal(failed.completion.reason,'error');
  if (summaryCase) {
    const token = failed.execution.modelRecovery;
    assert.equal(token.mode, 'text-summary');
    assert.equal(token.failedModelName, 'fixture');
    assert.equal(failed.completion.retryable, false);
    assert.equal(failed.completion.modelFailure.model, 'fixture');
    assert.equal(failed.completion.modelFailure.provider, 'fixture-service');
    assert.equal(failed.completion.modelFailure.phase, 'tool-result');
    assert.equal(failed.completion.modelFailure.status, 403);
    assert.equal(captured.length, 2);
    assert.equal(failed.modelSelection.name, replacement);
    assert.equal((await session.selectModel('')).ok, true);
    assert.equal(session.updateQueue(token.id,'retry-model').ok, false, 'default cannot recover');
    assert.equal((await session.selectModel('fixture')).ok, true);
    assert.equal(session.updateQueue(token.id,'retry-model').ok, false, 'same model cannot recover');
    assert.equal((await session.selectModel(replacement)).ok, true);
    healthy = true;
    assert.equal(session.updateQueue(token.id,'retry-model').ok, true);
    assert.equal(session.updateQueue(token.id,'retry-model').ok, false);
    const finished = await until(() => {
      const snap = session.snapshot();
      return captured.length > 2 && !snap.execution.turnQueue.activeQueueId && snap;
    });
    assert.equal(captured.length, 3);
    assert.equal(captured[2].model, wireModel);
    assert.equal(summaryAuth, 'Bearer replacement-key');
    assert.ok(!captured[2].tools?.length);
    assert.match(JSON.stringify(captured[2].messages), /saved-once/);
    assert.match(JSON.stringify(captured[2].messages), /总结已确认的成果/);
    assert.equal(finished.execution.modelRecovery, null);
    assert.equal(finished.execution.turnQueue.tasks.find(x => x.taskId === 'a').status, 'failed');
    assert.deepEqual(receipts, ['a:start', 'a:failed']);
    assert.equal(finished.execution.turnQueue.paused, true);
    assert.equal(finished.execution.queue[0].taskId, 'b');
    assert.equal(finished.tools.filter(x => x.name === 'write').length, 1);
    assert.equal(fs.statSync(output).mtimeMs, mtime);
    assert.equal(fs.existsSync(output + '.unexpected'), false);
    assert.equal(finished.completion.reason, initialStatus === 'summary-tool-call' ? 'error' : 'stop');
    if (initialStatus !== 'summary-tool-call') {
      assert.match(JSON.stringify(finished.messages.at(-1)), /Finished safely/);
      const usage = finished.usageReceipts.at(-1);
      assert.equal(usage.model, replacement);
      assert.equal(usage.provider, 'replacement-provider');
      assert.equal(usage.quotaUsageToken, 'fixture-usage');
      assert.equal(usage.localOnly === true, local);
      assert.doesNotMatch(JSON.stringify(finished), /local-wire-test|replacement-key/);
    }
    return;
  }
  assert.equal(failed.completion.retryable,true);
  assert.equal(failed.completion.error,'模型服务暂时不可用'+(initialStatus==='truncated'?'':'（HTTP '+initialStatus+'）'));
  assert.doesNotMatch(JSON.stringify(failed),/html|fixture-secret|192\.0\.2\.40/i);
  assert.equal(failed.modelRetry?.attempt,retries,'SDK exhausts configured retries before surfacing interruption');
  assert.equal(captured.length,retries+2,'one tool response, the failed request, then bounded agent retries only');
  for(const request of captured.slice(1)) {
    assert.equal(request.messages.filter(m=>m.role==='user'&&JSON.stringify(m.content).includes('TASK_A:')).length,1);
    assert.equal(request.messages.filter(m=>m.role==='tool'&&m.tool_call_id==='save_once').length,1,
      'each automatic retry continues after the saved tool result, without replaying its invocation');
  }
  assert.equal(failed.tools.filter(x=>x.name==='write').length,1);
  assert.equal(session.updateQueue('','resume').ok,false);
  const recoveryId=failed.execution.modelRecovery.id;
  healthy=true;const retry=session.updateQueue(recoveryId,'retry-model');
  assert.equal(retry.ok,true,retry.reason);assert.equal(session.updateQueue(recoveryId,'retry-model').ok,false);
  await second.completion;await until(()=>!session.snapshot().execution.running&&!session.snapshot().execution.turnQueue.activeTaskId);
  assert.deepEqual(receipts,['a:start','a:failed','a:recovery','a:start','a:completed','b:start','b:completed']);
  const continuation=captured.find(x=>JSON.stringify(x.messages).includes('<soduwork-internal-output-continue>'));
  assert.ok(continuation,'recovery sends a continuation, not the task original prompt');
  assert.equal(continuation.messages.filter(m=>m.role==='user'&&JSON.stringify(m.content).includes('TASK_A:')).length,1);
  assert.ok(continuation.messages.some(m=>m.role==='tool'&&m.tool_call_id==='save_once'),'completed tool result stays in model context');
  assert.equal(fs.statSync(output).mtimeMs,mtime,'recovery does not re-execute successful write');
  const final=session.snapshot();assert.equal(final.execution.modelRecovery,null);assert.equal(final.modelRetry,null,'new turn clears old retry counts');
  assert.equal(final.execution.turnQueue.tasks.filter(x=>x.status==='completed').length,2);
  assert.equal(final.tools.filter(x=>x.name==='write').length,1);
  if(initialStatus==='truncated'){
    healthy=false;failureStatus='truncated-once';const beforeTransient=captured.length;
    await session.submit('Complete the summary after one transient stream interruption',[]).completion;
    assert.equal(captured.length,beforeTransient+2,'one SDK retry resumes the interrupted model response');
    assert.equal(session.snapshot().completion.reason,'stop');
    assert.equal(session.snapshot().execution.modelRecovery,null);
    assert.equal(fs.statSync(output).mtimeMs,mtime,'automatic recovery also retains the successful write');
  }
  healthy=false;failureStatus=0;
  const disconnected=session.submit('Continue after a connection interruption',[]);
  const trailing=session.submit('Wait behind the interrupted ordinary message',[]);
  await disconnected.completion;
  const network=await until(()=>{const s=session.snapshot();return s.execution.modelRecovery&&s;});
  assert.equal(network.completion.retryable,true);
  assert.equal(network.execution.modelRecovery.taskId,'','ordinary recovery does not inherit a historical task binding');
  assert.match(network.completion.error,/模型服务暂时不可用/);
  healthy=true;assert.equal(session.updateQueue(network.execution.modelRecovery.id,'retry-model').ok,true);
  await trailing.completion;await until(()=>!session.snapshot().execution.running);
  healthy=false;failureStatus=403;const beforeDenied=captured.length;
  const denied=session.submit('Check credentials',[]);session.submit('Must wait behind denied request',[]);
  await denied.completion;await until(()=>!session.snapshot().execution.turnQueue.activeTaskId);
  assert.equal(captured.length,beforeDenied+1,'permission errors must not be retried');
  assert.equal(session.snapshot().execution.modelRecovery,null,'no automatic recovery token for denied credentials');
  assert.equal(session.snapshot().execution.turnQueue.paused,true,'denied request still blocks later queued work');
});
