'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {performance} = require('node:perf_hooks');
const {identity} = require('./helpers/platform-session-fixture.cjs');
const replica = require('../main/conversation/replica-store.cjs');
const shared = require('../main/conversation/shared-history.cjs');
async function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-delete-storage-')));
  const app={getPath:()=>root}, who=identity();
  const store=replica.createWorker(path.join(root,'history.sqlite'));
  const session={findBySessionId:()=>null,historyEntry:async()=>({ok:false,notFound:true}),archivedConversation:async()=>null};
  const history=shared.create({app,store,identityOf:()=>who,session});
  t.after(async()=>{await history.close();fs.rmSync(root,{recursive:true,force:true});});
  const row=id=>({id,adapterId:'pi',at:1,count:1,deviceHistory:true,creator:{account:'one',hub:who.hub}});
  return {root,app,session,store,history,who,row};
}
test('single deletion stays admitted while real SQLite receives a large native discovery batch',async t=>{
  const f=await fixture(t), rows=Array.from({length:600},(_,index)=>f.row('native-'+index));
  await f.history.register(rows);
  let finished=false, completedBeforeDiscovery=false, singleGets=0;
  const get=f.store.get;
  f.store.get=(...args)=>{singleGets++;return get(...args);};
  const start=performance.now();
  const projecting=f.history.projectRows(rows).finally(()=>{finished=true;});
  const deleting=f.history.lifecycle('native-10','delete',f.who).then(value=>{
    completedBeforeDiscovery=!finished;
    t.diagnostic(JSON.stringify({inventory:rows.length,deleteMs:Math.round(performance.now()-start),singleGets}));
    return value;
  });
  const [projected,deleted]=await Promise.allSettled([projecting,deleting]);
  assert.equal(projected.status,'fulfilled',projected.reason?.message);
  assert.equal(deleted.status,'fulfilled',deleted.reason?.message);
  assert.equal(deleted.value.conversation.deleted,true);
  assert.equal(projected.value.length,rows.length-1);
  assert.equal(completedBeforeDiscovery,true,'background discovery must leave room for a foreground lifecycle write');
  assert.ok(singleGets<20,'native discovery must use bounded batch lookups instead of filling the 256-request worker queue');
  assert.equal((await f.store.get('native-10')).deleted,true);
});
test('local archive, restore and failed deletion preserve a private first send until permanent deletion succeeds', async t => {
  const f = await fixture(t), owner = require('../main/platform-connections/runtime.cjs').connectionScope(f.who);
  const journal = require('../main/conversation/first-send.cjs').create({ root: path.join(f.root, 'first-send-requests'),
    actor: async () => ({ owner }), assertCurrent() {}, notify() {}, received: async () => false,
    open: async (_actor, options) => ({ ok: true, sessionId: options.sessionTitle, ref: 'ref-' + options.sessionTitle }),
    send: async () => ({ ok: false, notSent: true, reason: 'offline' }) });
  const ids = ['chosen', 'other'];
  await f.history.register(ids.map(id => ({ ...f.row(id), adapterId: 'opencode' })));
  for (const id of ids) {
    const intentId = 'first-' + require('node:crypto').randomUUID();
    await journal.start(null, { intentId, open: { sessionTitle: id }, text: 'Saved private draft', attachments: [] });
    await journal.act(null, intentId, 'wait');
  }
  let canForget = false;
  f.session.forgetRunner = async () => canForget ? { ok: true } : { ok: false, reason: 'blocked' };
  const action = require('../main/pi-session/local-history-actions.cjs').create({ ...f, identityOf: () => f.who,
    retireFirstSends(captured, id) {
      const signed = require('../main/platform-connections/runtime.cjs').connectionScope(captured.identity);
      journal.forgetSession({ owner: signed }, id);
    } });
  assert.equal((await action('archive', 'chosen')).ok, true);
  assert.equal((await action('restore', 'chosen')).ok, true);
  assert.equal((await action('delete', 'chosen')).needsConfirm, true);
  await assert.rejects(action('delete', 'chosen', { confirmed: true }), /blocked/);
  assert.equal((await journal.list(null)).rows.length, 2);
  canForget = true;
  assert.equal((await action('delete', 'chosen', { confirmed: true })).ok, true);
  assert.deepEqual((await journal.list(null)).rows.map(row => row.sessionId), ['other']);
});
test('deleting a native source uses indexed recovery-copy lookups and preserves unrelated histories',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-delete-query-'));
  const file=path.join(root,'history.sqlite'),store=replica.create(file);
  const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(file);
  t.after(()=>{db.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  store.register([{id:'native',historyAliasIds:['native-segment']},
    {id:'recovery-one',sourceLocalId:'native'},{id:'recovery-two',sourceLocalId:'native-segment'},
    {id:'unrelated-copy',sourceLocalId:'other-native'}]);
  for(let offset=0;offset<600;offset+=200) store.register(Array.from({length:200},(_,index)=>({id:'unrelated-'+(offset+index)})));
  for(const id of ['recovery-one','recovery-two','unrelated-copy'])
    store.cache(id,[{role:'user',text:'Synthetic retained transcript'}],{expectedRevision:0,complete:true});
  const captured=[],prepare=DatabaseSync.prototype.prepare;
  const spy=t.mock.method(DatabaseSync.prototype,'prepare',function(sql){
    if (/SELECT.+FROM replicas.+sourceLocalId/.test(sql)) captured.push(sql);
    return prepare.call(this,sql);
  });
  store.lifecycle('native-segment','delete');spy.mock.restore();
  assert.equal(store.get('native').deleted,true);
  for(const id of ['recovery-one','recovery-two']) {
    assert.equal(store.get(id).deleted,true);
    assert.deepEqual(store.messages(id).items,[]);
  }
  assert.equal(store.get('unrelated-copy').deleted,false);
  assert.equal(store.messages('unrelated-copy').items[0].text,'Synthetic retained transcript');
  assert.equal(store.get('unrelated-599').deleted,false);
  assert.ok(captured.length>0,'Inspect the lookup actually executed by the lifecycle transaction');
  for(const sql of captured) {
    const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all('native').map(row=>row.detail).join('\n');
    assert.match(plan,/SEARCH replicas USING INDEX replica_migration_source \(<expr>=\?\)/,
      'A single deletion must seek by source alias instead of inspecting every active conversation');
    assert.doesNotMatch(plan,/SCAN replicas|replica_page/);
  }
});
test('renamed or unreadable native archives preserve deletion and SQLite visibility consistency',async t=>{
  for(const unavailable of [false,true]) await t.test(unavailable?'unreadable archive':'renamed archive',async t=>{
    const f=await fixture(t),folder=path.join(f.root,'pi-agent','sessions','fixture');
    fs.mkdirSync(folder,{recursive:true});
    const file=path.join(folder,'native.jsonl'),renamed=path.join(folder,'renamed.jsonl');
    const bytes=[{type:'session',id:'native'},{type:'message',message:{role:'user',content:'Retained native text'}}]
      .map(value=>JSON.stringify(value)).join('\n')+'\n';
    fs.writeFileSync(file,bytes);
    f.session.historyEntry=require('../main/pi-session/session').historyEntry;
    await f.history.register([{...f.row('native'),path:file}]);
    await f.store.saveDeviceHistory('native',{snapshot:{messages:[{role:'user',text:'Retained native text'}],tools:[]},
      coverage:{complete:true}},{expectedRevision:0});
    assert.equal((await f.session.historyEntry(f.app,'native',{strict:true})).entry.path,file);
    fs.renameSync(file,renamed);
    let deniedReads=0;
    if(unavailable) {
      const createReadStream=fs.createReadStream;
      t.mock.method(fs,'createReadStream',function(target,...args){
        if(path.resolve(String(target))===renamed) {
          deniedReads++;
          return new (require('node:stream').Readable)({
            read(){this.destroy(Object.assign(Error('Synthetic archive read denied'),{code:'EACCES'}));}
          });
        }
        return createReadStream.call(this,target,...args);
      });
    }
    const recycled=path.join(f.root,'recycled.jsonl'),trashed=[];
    const action=require('../main/pi-session/local-history-actions.cjs').create({...f,identityOf:()=>f.who,
      trash:async(_shell,target)=>{trashed.push(target);fs.renameSync(target,recycled);}});
    assert.equal((await action('delete','native')).needsConfirm,true);
    if(unavailable) {
      await assert.rejects(action('delete','native',{confirmed:true}),/read denied/);
      assert.ok(deniedReads>0,'The native reader must attempt to read the renamed archive');
      assert.deepEqual(trashed,[]);
      assert.equal(fs.readFileSync(renamed,'utf8'),bytes);
      const row=await f.store.get('native');assert.equal(row.deleted,false);assert.equal(row.archived,true);
      assert.equal((await f.history.list({archived:true})).items[0].id,'native');
      assert.equal((await f.store.deviceHistory('native')).snapshot.messages[0].text,'Retained native text');
    } else {
      assert.equal((await action('delete','native',{confirmed:true})).ok,true);
      assert.deepEqual(trashed,[renamed]);assert.equal(fs.readFileSync(recycled,'utf8'),bytes);
      assert.equal((await f.store.get('native')).deleted,true);
      assert.equal(await f.store.deviceHistory('native'),null);
      assert.deepEqual((await f.history.list()).items,[]);
      assert.deepEqual(await f.history.projectRows([{...f.row('native'),path:file}]),[]);
    }
  });
});
