const test=require('node:test'),assert=require('node:assert/strict');
const errors=require('../main/pi-session/model-errors'),recovery=require('../main/pi-session/model-recovery');
const {createTurnQueue}=require('../main/pi-session/turn-queue'),stream=require('../main/pi-session/event-stream');
const failure=(text='500 status code (no body)')=>({ok:true,snapshot:{status:'unreachable',completion:{reason:'error',error:text}}});
test('bare 500 and structured transient errors classify; credentials/quota never retry',()=>{
 for(const value of ['500 status code (no body)','HTTP 502','503: {"type":"soduwork_work_proxy_error","code":503}',{status:504,message:'No body'},{statusCode:500,code:'upstream_error',message:'No body'},'Connection error.','fetch failed','ECONNRESET','socket hang up'])assert.equal(errors.describe(value).retryable,true);
 for(const value of ['401 status code (no body)','403 status code (no body)','404: missing','429: insufficient_quota','500: billing limit exceeded'])assert.equal(errors.describe(value).retryable,false);
 // access-layer LB cuts long idle requests and answers with its own HTML page (no "HTTP" prefix)
 const lb504='504 <html><body><h1>504 Gateway Time-out</h1> The server didn'+String.fromCharCode(39)+'t respond in time. </body></html>';
 const lbInfo=errors.describe(lb504);
 assert.equal(lbInfo.status,504);assert.equal(lbInfo.transient,true);assert.equal(lbInfo.retryable,true);
 assert.equal(errors.forDisplay(lb504),'模型服务暂时不可用（HTTP 504）');
 for(const v of ['502 <html><body><h1>502 Bad Gateway</h1></body></html>','<html><body><h1>503 Service Unavailable</h1></body></html>'])assert.equal(errors.describe(v).retryable,true);
 assert.equal(errors.describe('500 status code (no body)').status,500);
 assert.doesNotMatch(errors.forDisplay('500 status code (no body)'),/no body/);
});
test('recovery consumes one token, precedes pending tasks and preserves task/plugin identity without re-sending input',async()=>{
 const q=createTurnQueue(),r=recovery.create();let claims=0,starts=0;
 q.add({text:'原始任务及附件',attachments:[{name:'a.png'}],options:{taskId:'t',pluginIds:['plugin'],beforeTurn:async()=>starts++,beforeRetry:async()=>claims++}});
 q.add({text:'下一项'});const first=q.take();await q.run(first,async()=>failure());r.remember(first,failure());
 const token=r.view();assert.ok(q.blocked());assert.equal(r.take('stale'),null);
 const retry=r.take(token.id);assert.equal(r.take(token.id),null);assert.equal(retry.options.taskId,'t');
 assert.deepEqual(retry.options.pluginIds,['plugin']);assert.deepEqual(retry.attachments,[]);
 assert.ok(retry.text.includes('已成功的写入'));assert.ok(!retry.text.includes('原始任务及附件'));
 q.add(retry);const second=q.take();assert.equal(second.options.modelRecovery,true);
 await q.run(second,async()=>failure());r.remember(second,failure());q.add(r.take(r.view().id));
 await q.run(q.take(),async()=>({ok:true}));assert.equal(starts,3);assert.equal(claims,2,'one receipt refresh per recovery, not nested');
 assert.equal(q.view()[0].text,'下一项');assert.equal(q.state().tasks[0].status,'completed');
});
test('ordinary message recovery also goes before queued messages; controlled workflows and cancellation are excluded',()=>{
 const q=createTurnQueue(),r=recovery.create(),a=q.add({text:'original'});q.take();q.add({text:'later'});r.remember(a,failure());q.add(r.take(a.id));
 assert.equal(q.take().options.modelRecovery,true);assert.equal(q.view()[0].text,'later');
 for(const result of [{...failure(),cancelled:true},{...failure(),recovering:true},failure('401: forbidden')]){r.remember(a,result);assert.equal(r.view(),null);}
 r.remember({...a,options:{controlled:{}}},failure());assert.equal(r.view(),null);
});
test('recovery uses structured retryability, not localized text, and respects permanent failures',()=>{
 const q=createTurnQueue(),r=recovery.create(),a=q.add({text:'original'});
 r.remember(a,{snapshot:{completion:{reason:'error',error:'模型服务暂时不可用',retryable:true}}});assert.ok(r.view());
 r.remember(a,{snapshot:{completion:{reason:'error',error:'500: Connection error',retryable:false}}});assert.equal(r.view(),null);
});
test('SDK retry progress is truthful and exhaustion keeps transcript/tool results',()=>{
 const acc=stream.create();acc.push({type:'agent_start'});
 acc.push({type:'tool_execution_start',toolCallId:'save-once',toolName:'write'});
 acc.push({type:'tool_execution_end',toolCallId:'save-once',toolName:'write',result:{content:[{type:'text',text:'saved'}]}});
 acc.push({type:'auto_retry_start',attempt:2,maxAttempts:3,errorMessage:'500 status code (no body)'});
 assert.deepEqual(acc.snapshot().modelRetry,{active:true,attempt:2,max:3});
 acc.push({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'500 status code (no body)'}});
 acc.push({type:'auto_retry_end',success:false,attempt:2});acc.push({type:'agent_settled'});
 assert.match(acc.snapshot().statusText,/已自动重试 2 次/);assert.equal(acc.snapshot().tools.length,1);
 assert.equal(acc.snapshot().modelRetry.active,false);assert.equal(acc.status(),'unreachable');
});
