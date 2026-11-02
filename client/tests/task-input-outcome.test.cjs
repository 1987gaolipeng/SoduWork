const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const artifactRuntime = require('../main/conversation/artifact-runtime');
const { prepare } = require('../main/pi-session/task-input');

const identity = { hub: 'http://fixture', clientId: 'd', secret: 'test-only' };
const runtime = { handle: { sessionId: 'chat' }, app: { getPath: () => os.tmpdir() } };

/*
 * Pass turn outcome to artifact collection: failed, waiting, and stopped remain
 * evidence-only incomplete outputs; completed turns may enter candidate review.
 */
test('afterTurn forwards the turn outcome to the delivery endpoint', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-outcome-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'scene.js'), 'const ok = 1;\n');
  t.mock.method(artifactRuntime, 'snapshotAsync', () => ({
    items: [{ path: path.join(dir, 'scene.js'), name: 'scene.js', relative: 'scene.js', changedInTurn:true }],
  }));
  const deliveries = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    const target = String(url);
    if (target.includes('/conversation-delivery')) {
      deliveries.push({
        outcome: options.body.get('outcome'),
        turnId: options.body.get('turnId'),
        conversationId: options.body.get('conversationId'),
      });
      return Response.json({ ok: true, files: ['scene.js'] });
    }
    if (target.endsWith('/tasks/t/attachments')) return Response.json([]);
    if (target.includes('/conversation-turn')) return Response.json({ turn: { state: 'queued' }, task: { id: 't' } });
    return Response.json({ id: 't', title: 'T', description: '需求正文' });
  });
  const base = [identity, 't', 'chat'];

  const failed = await prepare(...base, 'outcome-failed', '做个游戏', {}, runtime);
  await failed.beforeTurn();
  await failed.afterTurn('failed');
  assert.deepEqual(deliveries[deliveries.length - 1], {
    outcome: 'incomplete', turnId: 'outcome-failed', conversationId: 'chat',
  });

  const waiting = await prepare(...base, 'outcome-waiting', '做个游戏', {}, runtime);
  await waiting.beforeTurn();
  await waiting.afterTurn('waiting');
  assert.equal(deliveries[deliveries.length - 1].outcome, 'incomplete');

  const done = await prepare(...base, 'outcome-done', '做个游戏', {}, runtime);
  await done.beforeTurn();
  await done.afterTurn('completed');
  assert.deepEqual(deliveries[deliveries.length - 1], {
    outcome: 'completed', turnId: 'outcome-done', conversationId: 'chat',
  });
});

test('restored native receipt uploads completed files before completing the original turn', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-resumed-delivery-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'game.html');fs.writeFileSync(file,'<html>game</html>');
 t.mock.method(artifactRuntime,'snapshotAsync',()=>({items:[{path:file,name:'game.html',relative:'game.html',changedInTurn:true}]}));
 const turn={state:'running',executor:'native',conversationId:'chat',turnId:'old-turn'}, events=[];
 t.mock.method(global,'fetch',async(url,options)=>{
  if(String(url).includes('/conversation-delivery')){
   assert.equal(options.body.get('turnId'),'old-turn');
   assert.equal(options.body.get('conversationId'),'chat');
   assert.equal(options.body.get('outcome'),'completed');
   assert.equal(await options.body.get('files').text(),'<html>game</html>');
   events.push('deliver');return Response.json({ok:true});
  }
  if(options?.body){const body=JSON.parse(options.body);events.push(body.action);assert.equal(body.turnId,'old-turn');return Response.json({turn});}
  return Response.json({id:'t',status:'doing',ownerClientId:'d',workRouting:{conversationTurn:turn}});
 });
 const session=Buffer.from(JSON.stringify({typ:'device',uid:'u',cid:'d',iat:1,exp:9e9})).toString('base64url')+'.'+'0'.repeat(64);
 const input=await prepare({...identity,session},'t','chat','new-turn','继续',{reuseConversation:true,followUp:true},
  {app:{getPath:()=>dir},handle:{sessionId:'chat',cwd:dir,adapterId:'pi',taskIds:['t'],claimInterruptedTask:async()=>'claim-token',releaseInterruptedTask:async()=>true}});
 await input.beforeTurn();await input.afterTurn('completed');
 assert.deepEqual(events,['deliver','complete']);
});
