'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), zlib = require('node:zlib');
const { capture, prepare } = require('../main/conversation/delivery-package-worker');
const artifacts = require('../main/conversation/artifact-runtime'), outputs = require('../main/pi-session/outputs');
async function fixture(t, large = false) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-delivery-worker-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.writeFile(path.join(cwd,'report.md'),'# Original');
  if (large) {
    await fs.writeFile(path.join(cwd,'data.bin'),require('node:crypto').randomBytes(8*1024*1024));
    await fs.mkdir(path.join(cwd,'.soduwork'));
    await fs.writeFile(path.join(cwd,'.soduwork/delivery.json'),JSON.stringify({schemaVersion:1,deliverables:[{path:'report.md',files:['data.bin']}]}));
  }
  const session = {cwd,sessionId:'worker-test',snapshot:()=>({status:'idle'}),outputSnapshot:()=>outputs.scan(cwd,0,1)};
  const ids=artifacts.snapshot(session).items.filter(f=>f.primary!==false).map(f=>f.artifactId);
  return {cwd,session,ids};
}
function entries(bytes) {
  const result = new Map();let at=0;
  while(bytes.readUInt32LE(at)===0x04034b50) {
    const size=bytes.readUInt32LE(at+18),n=bytes.readUInt16LE(at+26),extra=bytes.readUInt16LE(at+28);
    const name=bytes.subarray(at+30,at+30+n).toString(),start=at+30+n+extra;
    const data=bytes.subarray(start,start+size);
    result.set(name,bytes.readUInt16LE(at+8)===8?zlib.inflateRawSync(data):data);at=start+size;
  }
  return result;
}
test('background worker preserves original single-file bytes and declared revision', async t => {
  const f=await fixture(t),result=await prepare(f.session,f.ids);
  assert.equal(result.bytes.toString(),'# Original');assert.equal(result.manifest.files.length,1);
  assert.equal(result.manifest.files[0].sha256,require('node:crypto').createHash('sha256').update(result.bytes).digest('hex'));
});
test('capture releases before encoding and retains old bytes when the next turn overwrites the source', async t => {
  const f=await fixture(t,true),job=await capture(f.session,f.ids,{completedTurn:true});
  let packed=false;job.payload.then(()=>packed=true);
  assert.equal(packed,false);assert(job.byteLength>8*1024*1024);
  await fs.writeFile(path.join(f.cwd,'report.md'),'# Next turn');
  const result=await job.payload,files=entries(result.bytes);
  assert.equal(files.get('report.md').toString(),'# Original');assert.equal(files.get('data.bin').length,8*1024*1024);
});
test('task and session titles reach the worker thread for the bundle title', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cwd, 'page.html'), '<link href="app.css">');
  await fs.writeFile(path.join(f.cwd, 'app.css'), 'body{}');
  f.session.taskTitle = '赛车游戏';
  const result = await prepare(f.session, artifacts.snapshot(f.session).items.filter(x => x.primary !== false).map(x => x.artifactId));
  assert.equal(result.manifest.title, '赛车游戏 · 会话成果');
  assert.equal(result.filename, '赛车游戏 · 会话成果.zip');
});

test('unchanged files release the worker without scheduling an archive', async t => {
  const f=await fixture(t),job=await capture(f.session,f.ids,{completedTurn:true,turnSince:Date.now()+1000});
  assert.equal(job.changedInTurn,false);assert.equal((await job.payload).bytes,undefined);
});

test('a declaration-only change captures older supporting files without needing an entry-file edit', async t => {
  const f=await fixture(t),old=new Date(Date.now()-10000);
  await fs.writeFile(path.join(f.cwd,'instructions.txt'),'Existing instructions');
  for(const name of ['report.md','instructions.txt'])await fs.utimes(path.join(f.cwd,name),old,old);
  await fs.mkdir(path.join(f.cwd,'.soduwork'));
  const since=Date.now()-500;
  await fs.writeFile(path.join(f.cwd,'.soduwork/delivery.json'),JSON.stringify({schemaVersion:1,deliverables:[{path:'report.md',files:['instructions.txt']}]}));
  const result=await prepare(f.session,f.ids,{completedTurn:true,turnSince:since});
  assert.equal(result.changedInTurn,true);assert.equal(entries(result.bytes).get('instructions.txt').toString(),'Existing instructions');
});
test('worker validates running state, resource errors and cancellation without losing original files', async t => {
  const f=await fixture(t,true);f.session.inFlight=()=>true;
  await assert.rejects(prepare(f.session,f.ids),/仍在生成/);
  const job=await capture(f.session,f.ids,{completedTurn:true});job.cancel();
  await assert.rejects(job.payload,/取消/);assert.equal(await fs.readFile(path.join(f.cwd,'report.md'),'utf8'),'# Original');
  f.session.inFlight=()=>false;
  await fs.rm(f.cwd,{recursive:true,force:true});
  await assert.rejects(prepare(f.session,f.ids),error=>error.code==='ENOENT');
});
test('background packing finishes under the original account before authorization is rechecked', async () => {
  const { create }=require('../main/conversation/local-delivery-sync');
  const now=Math.floor(Date.now()/1000),identity=user=>({hub:'http://localhost:9999',clientId:'desktop',session:Buffer.from(JSON.stringify({typ:'device',cid:'desktop',uid:user,iat:now,exp:now+3600})).toString('base64url')+'.'+'a'.repeat(64)});
  let account=identity('alice'),finish,uploads=0,checks=0;
  const payload=new Promise(resolve=>finish=resolve),handle={snapshot:()=>({status:'idle'})};
  const manager=create({app:{},identityOf:async()=>{checks++;return account},snapshotFiles:()=>({items:[{artifactId:'report',primary:true,changedInTurn:true}]}),
    prepare:async()=>({manifest:{revision:'v1'},byteLength:1,payload}),upload:async()=>{uploads++;return{id:'saved'}}});
  manager.bind(handle,account);await handle.captureDelivery();
  for(let i=0;i<50&&!checks;i++)await new Promise(resolve=>setImmediate(resolve));
  account=identity('bob');finish({manifest:{revision:'v1'},bytes:Buffer.from('a')});
  for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(uploads,0);assert.equal(checks,2);
});

test('unchanged follow-ups skip recapture while changed support files and missing resources are detected', async t => {
  const f=await fixture(t,true),now=Math.floor(Date.now()/1000);
  const identity={hub:'http://localhost:9999',clientId:'desktop',session:Buffer.from(JSON.stringify({typ:'device',cid:'desktop',uid:'alice',iat:now,exp:now+3600})).toString('base64url')+'.'+'a'.repeat(64)};
  let captures=0,uploads=0;
  const manager=require('../main/conversation/local-delivery-sync').create({app:{},identityOf:async()=>identity,
    prepare:async(...args)=>{captures++;return capture(...args)},upload:async()=>({id:'stored-'+(++uploads)})});
  manager.bind(f.session,identity);
  f.session.deliveryCaptureAtTurnBoundary=true;
  const nextTurn=()=>{
    manager.observe(f.session,{kind:'update'},{status:'streaming'});
    manager.observe(f.session,{kind:'turn-finished'},{status:'idle'});
  };
  const synced=async()=>{for(let i=0;i<300&&f.session.deliverySync.state!=='synced';i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.session.deliverySync.state,'synced',f.session.deliverySync.error)};
  await f.session.captureDelivery();await synced();
  nextTurn();await f.session.captureDelivery();assert.equal(captures,1);assert.equal(uploads,1);
  assert.equal(f.session.deliverySync.state,'synced');assert.equal(f.session.deliverySync.delivery.id,'stored-1');
  assert.equal(f.session.deliverySync.currentTurn,false);
  await fs.writeFile(path.join(f.cwd,'data.bin'),'changed supporting data');
  await f.session.captureDelivery();await synced();assert.equal(captures,2);assert.equal(uploads,2);
  await fs.unlink(path.join(f.cwd,'data.bin'));
  await f.session.captureDelivery();assert.equal(captures,3);assert.equal(f.session.deliverySync.state,'failed');assert.equal(uploads,2);
});

test('unchanged follow-up keeps an in-flight receipt and receives its eventual completion', async t => {
  const f=await fixture(t),now=Math.floor(Date.now()/1000);
  const identity={hub:'http://localhost:9999',clientId:'desktop',session:Buffer.from(JSON.stringify({typ:'device',cid:'desktop',uid:'alice',iat:now,exp:now+3600})).toString('base64url')+'.'+'a'.repeat(64)};
  let finish,uploads=0;
  const manager=require('../main/conversation/local-delivery-sync').create({app:{},identityOf:async()=>identity,
    upload:async()=>{uploads++;await new Promise(resolve=>finish=resolve);return{id:'saved-original'}}});
  manager.bind(f.session,identity);f.session.deliveryCaptureAtTurnBoundary=true;
  await f.session.captureDelivery();
  for(let i=0;i<100&&!finish;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(uploads,1);
  manager.observe(f.session,{}, {status:'streaming'});manager.observe(f.session,{}, {status:'idle'});
  await f.session.captureDelivery();assert.equal(f.session.deliverySync.state,'saving');
  finish();
  for(let i=0;i<100&&f.session.deliverySync.state!=='synced';i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(uploads,1);assert.equal(f.session.deliverySync.delivery.id,'saved-original');
  assert.equal(f.session.deliverySync.currentTurn,false);
});
