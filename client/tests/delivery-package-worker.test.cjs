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
test('turn completion leaves real files local; explicit preparation still packages supporting resources', async t => {
  const f = await fixture(t, true), now = Math.floor(Date.now() / 1000);
  const identity = { hub: 'http://localhost:9999', clientId: 'desktop', session: Buffer.from(JSON.stringify({ typ: 'device', cid: 'desktop', uid: 'alice', iat: now, exp: now + 3600 })).toString('base64url') + '.' + 'a'.repeat(64) };
  let packages = 0;
  const manager = require('../main/conversation/local-delivery-sync').create({ prepare: () => packages++ });
  manager.bind(f.session, identity); await f.session.captureDelivery();
  assert.equal(packages, 0); assert.equal(f.session.deliverySync.state, 'local');
  assert.equal(await fs.readFile(path.join(f.cwd, 'report.md'), 'utf8'), '# Original');
  const revision = f.session.deliverySync.revision, file = path.join(f.cwd, 'report.md'), before = await fs.stat(file);
  await fs.writeFile(file, '# Modified'); await fs.utimes(file, before.atime, before.mtime);
  await f.session.captureDelivery();
  assert.notEqual(f.session.deliverySync.revision, revision, 'same-size edits with preserved mtime must invalidate saved state');
  await fs.writeFile(file, '# Original');
  const original = await prepare(f.session, f.ids);
  await fs.writeFile(path.join(f.cwd, 'data.bin'), 'changed supporting data');
  const revised = await prepare(f.session, f.ids);
  assert.notEqual(revised.manifest.revision, original.manifest.revision);
  assert.equal(entries(revised.bytes).get('data.bin').toString(), 'changed supporting data');
  await fs.unlink(path.join(f.cwd, 'data.bin'));
  await assert.rejects(prepare(f.session, f.ids), /data.bin/);
});
