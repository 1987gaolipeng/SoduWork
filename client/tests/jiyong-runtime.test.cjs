'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const store = require('../main/app-settings-store.cjs');
const data = require('../main/jiyong-data.cjs');
const personal = require('../main/personal-plugins');
const contract = require('../core/jiyong-contract.cjs');
const schema = {version:1,parameters:[
  {key:'theme',type:'string',display:'select',options:['light','dark'],default:'light'},
  {key:'serviceKey',type:'string',display:'hidden',secret:true},
  {key:'currentCollection',type:'string',display:'hidden',default:'notes'},
],collections:[{key:'notes',indexes:['status']}],mcp:{server:'soduwork-jiyong',bindings:[]}};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-jiyong-')), key = crypto.randomBytes(32);
  let owner = 'test/account-a';
  const app = {getPath:() => root};
  const safeStorage = {isEncryptionAvailable:() => true,
    encryptString(value) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm',key,iv); const bytes=Buffer.concat([cipher.update(value),cipher.final()]); return Buffer.concat([iv,cipher.getAuthTag(),bytes]); },
    decryptString(bytes) { const cipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12)); cipher.setAuthTag(bytes.subarray(12,28)); return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString(); }};
  store.configure({app,safeStorage,ownerOf:() => owner});
  const body = {template:'app',key:'jiyong-notes',name:'即用便签',version:'0.1.0',description:'Test notes',instructions:'Read and update real notes through declared MCP tools.',
    entrypoints:{automation:true},jiyong:schema,mcpServers:['soduwork-jiyong'],
    ui:{contributions:[{id:'main',title:'Notes',slot:'workspace.navigation',source:{type:'package',entry:'ui/index.html',bridge:{version:1,capabilities:['data.read','data.write','settings.read','settings.write','mcp.connect','automation.create']}}}]},
    // Installation now opens an isolated first screen. Keep this fixture a
    // complete app, while preserving every initialization/account assertion.
    resources:[{path:'ui/index.html',kind:'ui',encoding:'base64',content:Buffer.from('<!doctype html><title>Notes</title><body><p>Notes</p><script src="soduwork-app.js"></script>').toString('base64')},
      {path:'ui/soduwork-app.js',kind:'ui',encoding:'base64',content:fs.readFileSync(path.resolve(__dirname,'../sdk/soduwork-app.js')).toString('base64')}]};
  const installed = personal.create(app,body).plugin;
  const binding = {pluginId:installed.pluginId,origin:require('../core/plugin-package-page.cjs').origin(installed.pluginId)};
  t.after(async () => { await data.close(); fs.rmSync(root,{recursive:true,force:true}); });
  return {app,root,body,installed,binding,setOwner:v => {owner=v;},run:(method,params) => data.execute(app,binding,schema,method,params)};
}
test('declarations survive installation/export; malformed types, secret defaults and undescribed MCP fail closed', async t => {
  const f = fixture(t);
  assert.equal(f.installed.entrypoints.automation,true);
  assert.deepEqual(f.installed.dependencyReadiness.requiredMcp,[]);
  assert.deepEqual(f.installed.jiyong,contract.normalize(schema));
  const file = path.join(f.root,'portable.soduwork-plugin');
  await personal.exportToFile(f.app,{showSaveDialog:async()=>({filePath:file})},f.installed.pluginId);
  const imported = require('../main/plugin-package-reader.cjs').readPersonalArchive(fs.readFileSync(file));
  assert.deepEqual(personal.preflight(imported).manifest.jiyong,contract.normalize(schema));
  const bad = structuredClone(schema); bad.parameters[1].default='example';
  assert.throws(() => contract.normalize(bad),/默认值/);
  for (const value of [{...schema,version:2},{...schema,parameters:[{key:'x',type:'object',display:'text'}]}, {...schema,collections:[{key:'bad.name'}]}, {...schema,mcp:{server:'soduwork-jiyong',bindings:[{tool:'data_get',argument:'id',parameter:'serviceKey'}]}}]) assert.throws(()=>contract.normalize(value));
  assert.throws(()=>personal.preflight({...f.body,mcpServers:[]}),/同时声明/);
  assert.throws(()=>personal.preflight({...f.body,jiyong:{...schema,ignored:'value'}}),/不支持/);
  assert.throws(()=>contract.json(JSON.parse('{"__proto__":{}}')),/字段/);
});
test('parameter types/defaults/hidden secrets share secure bridge storage, CAS and explicit reads', t => {
  const f = fixture(t), runtime = require('../main/jiyong-runtime.cjs');
  const first = runtime.parameters(f.binding,f.installed,'get',{});
  assert.equal(first.values.theme,'light'); assert.equal(first.values.serviceKey,undefined);
  const next = runtime.parameters(f.binding,f.installed,'update',{values:{theme:'dark',serviceKey:'fixture-private-value'},expectedRevision:0});
  assert.equal(next.values.theme,'dark'); assert.equal(next.values.serviceKey,undefined);
  assert.ok(next.secretKeys.includes('serviceKey'));
  assert.equal(fs.readFileSync(path.join(f.root,'app-settings.secure.json'),'utf8').includes('fixture-private-value'),false);
  assert.equal(runtime.parameters(f.binding,f.installed,'get',{keys:['serviceKey'],includeSecrets:true}).values.serviceKey,'fixture-private-value');
  assert.throws(()=>runtime.parameters(f.binding,f.installed,'update',{values:{theme:'blue'}}),/选项/);
  assert.throws(()=>runtime.parameters(f.binding,f.installed,'update',{values:{foreign:'x'}}),/未声明/);
  assert.throws(()=>runtime.parameters(f.binding,f.installed,'update',{values:{theme:'light'},expectedRevision:0}),/变化/);
  runtime.parameters(f.binding,f.installed,'update',{remove:['theme'],expectedRevision:next.revision});
  assert.equal(runtime.parameters(f.binding,f.installed,'get',{}).values.theme,'light');
});
test('SQLite pagination/indexes, atomic conflicts, backup, restart and account/app isolation in an empty cwd', async t => {
  const f = fixture(t);
  await f.run('data.batch',{collection:'notes',operations:[{id:'note_a',expectedRevision:0,value:{status:'open',title:'A'}},{id:'note_b',expectedRevision:0,value:{status:'open',title:'B'}}]});
  const page = await f.run('data.list',{collection:'notes',limit:1,filter:{status:'open'}});
  assert.deepEqual(page.items.map(r=>r.id),['note_a']); assert.equal(page.next,'note_a');
  const second = await f.run('data.list',{collection:'notes',limit:1,after:page.next});
  assert.equal(second.items[0].value.title,'B'); assert.equal(second.next,null);
  await assert.rejects(f.run('data.batch',{collection:'notes',operations:[{id:'note_a',expectedRevision:1,value:{status:'closed'}},{id:'note_b',expectedRevision:0,delete:true}]}),/已更新/);
  assert.equal((await f.run('data.get',{collection:'notes',id:'note_a'})).item.value.status,'open');
  await assert.rejects(f.run('data.list',{collection:'notes',filter:{title:'A'}}),/索引/);
  await f.run('backup',{});
  await data.close();
  const scope = store.scope(f.binding), file = path.join(f.root,'jiyong-data',scope,'data.sqlite');
  assert.ok(fs.existsSync(file+'.backup'));
  const {DatabaseSync} = require('node:sqlite'), backup = new DatabaseSync(file+'.backup',{readOnly:true});
  assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM records').get().n,2); backup.close();
  assert.equal((await f.run('data.get',{collection:'notes',id:'note_a'})).item.revision,1);
  f.setOwner('test/account-b'); assert.equal((await f.run('data.get',{collection:'notes',id:'note_a'})).item,null);
  f.setOwner('test/account-a');
  assert.equal((await data.execute(f.app,{...f.binding,pluginId:'local:other'},schema,'data.get',{collection:'notes',id:'note_a'})).item,null);
  assert.equal((await f.run('data.get',{collection:'notes',id:'note_a'})).item.value.title,'A');
  assert.equal(fs.readdirSync(f.root).includes('notes.json'),false);
  const deleted = await f.run('data.batch',{collection:'notes',operations:[{id:'note_a',expectedRevision:1,delete:true}]});
  assert.equal(deleted.items[0].revision,2);
  const tombstone = await f.run('data.get',{collection:'notes',id:'note_a'});
  assert.equal(tombstone.item,null); assert.equal(tombstone.revision,2);
  await f.run('data.batch',{collection:'notes',operations:[{id:'note_a',expectedRevision:2,value:{status:'new'}}]});
  await assert.rejects(f.run('data.batch',{collection:'notes',operations:[{id:'note_a',expectedRevision:1,value:{status:'stale'}}]}),/已更新/);
});
test('first-page cursors accept omitted/null/empty; invalid cursors do not weaken record IDs', async t => {
  const f = fixture(t);
  await f.run('data.batch',{collection:'notes',operations:[
    {id:'note_a',expectedRevision:0,value:{status:'open'}},
    {id:'note_b',expectedRevision:0,value:{status:'open'}}]});
  for (const cursor of [{},{after:null},{after:''}]) {
    const page = await f.run('data.list',{collection:'notes',limit:1,...cursor});
    assert.deepEqual(page.items.map(row=>row.id),['note_a']);
    const next = await f.run('data.list',{collection:'notes',limit:1,after:page.next});
    assert.deepEqual(next.items.map(row=>row.id),['note_b']);
    assert.equal(next.next,null);
  }
  for (const after of [' ',42,{},'constructor','bad/id']) {
    await assert.rejects(f.run('data.list',{collection:'notes',after}),/data\.list\.after/);
  }
  assert.throws(()=>contract.dataRequest('data.get',{collection:'notes',id:''},schema),/标识无效/);
  assert.throws(()=>contract.dataRequest('data.batch',{collection:'notes',operations:[{id:'',expectedRevision:0,value:{}}]},schema),/标识无效/);
});

test('material assets are stored on disk, bounded, verified, isolated and survive worker restart', async t => {
  const f = fixture(t), bytes = new Uint8Array([1,2,3,4]);
  const result = await f.run('data.assetPut',{name:'icon.png',type:'image/png',data:bytes});
  assert.match(result.asset.id,/^asset_/); assert.equal(result.asset.size,4);
  await data.close();
  const read = await f.run('data.assetGet',{id:result.asset.id}); assert.deepEqual(read.data,bytes);
  f.setOwner('test/account-b'); assert.equal((await f.run('data.assetGet',{id:result.asset.id})).asset,null);
  await assert.rejects(f.run('data.assetGet',{id:'../../outside'}),/标识/);
  await assert.rejects(f.run('data.assetPut',{name:'../escape.png',type:'image/png',data:bytes}),/格式/);
});
test('headless app conversation MCP uses the same data and revokes on settings, version and owner changes', async t => {
  const f = fixture(t), guard = require('../main/pi-session/app-mcp-grant.cjs');
  const session = {snapshot:()=>({activePlugins:[]})};
  guard.bind(session,undefined,'',f.app);
  const turn = {pluginIds:[f.installed.pluginId]}; guard.guardSend(session,turn); await turn.beforeTurn();
  const context = guard.forSession(session), connection = context.connection;
  const proxy = await require('../main/pi-session/app-mcp-proxy.cjs').create(connection); t.after(()=>proxy.cleanup());
  async function rpc(method,params) {
    const response = await fetch(proxy.url,{method:'POST',headers:{Authorization:'Bearer '+proxy.token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    return {status:response.status,body:await response.json()};
  }
  const tools = (await rpc('tools/list')).body.result.tools; assert.deepEqual(tools.map(t=>t.name),['data_apps','data_get','data_list','data_batch']);
  const saved = await rpc('tools/call',{name:'data_batch',arguments:{collection:'notes',operations:[{id:'background_result',expectedRevision:0,value:{status:'done'}}]}});
  assert.equal(saved.body.result.isError,undefined);
  assert.equal((await f.run('data.get',{collection:'notes',id:'background_result'})).item.value.status,'done');
  const listed=await rpc('tools/call',{name:'data_list',arguments:{collection:'notes',after:''}});
  assert.equal(listed.body.result.isError,undefined);
  assert.equal(JSON.parse(listed.body.result.content[0].text).items[0].id,'background_result');
  assert.equal(JSON.stringify(tools).includes(f.root),false);
  const unknown = await rpc('tools/call',{name:'execute_sql',arguments:{}}); assert.equal(unknown.body.result.isError,true);
  store.update(f.binding,{values:{theme:'dark'}}); assert.equal((await rpc('tools/list')).status,401);
  const refreshed = require('../main/jiyong-hosted-connection.cjs').context(f.app,f.installed.pluginId).connection;
  personal.create(f.app,{...f.body,version:'0.2.0'}); assert.throws(()=>refreshed.readCurrent(),/安装已变化/);
  f.setOwner('test/account-b'); assert.throws(()=>connection.readCurrent(),/账号/);
});
test('MCP explicit parameter bindings override model input, hide bound schema and redact server echoes', async t => {
  const binding = require('../main/jiyong-mcp-bindings.cjs');
  const params=[{tool:'test',argument:'sk',parameter:'serviceKey',value:'fixture-private'}];
  const transformed = binding.input({method:'tools/call',params:{name:'test',arguments:{sk:'attacker',x:1}}},params);
  assert.equal(transformed.params.arguments.sk,'fixture-private'); assert.equal(transformed.params.arguments.x,1);
  const reply=binding.output({result:{tools:[{name:'test',inputSchema:{properties:{sk:{type:'string'},x:{type:'number'}},required:['sk','x']}}],echo:'fixture-private'}},params,['fixture-private']);
  assert.equal(reply.result.tools[0].inputSchema.properties.sk,undefined);
  assert.deepEqual(reply.result.tools[0].inputSchema.required,['x']); assert.equal(reply.result.echo,'[已隐藏凭据]');
});
test('same-account apps discover, read and update each other without a sharing ACL; account and credentials remain isolated',async t => {
  const f=fixture(t), access=require('../main/jiyong-data-access.cjs');
  const other=personal.create(f.app,{...f.body,key:'shared-notes',name:'另一即用'}).plugin;
  const call=(method,input)=>access.request({app:f.app},f.binding,f.installed,method,input);
  const apps=await call('data.apps',{});
  assert.equal(apps.apps.length,2); assert.equal(JSON.stringify(apps).includes('serviceKey'),false);
  await call('data.batch',{appId:other.pluginId,collection:'notes',operations:[{id:'shared_one',expectedRevision:0,value:{title:'协作结果'}}]});
  const value=await call('data.get',{appId:other.pluginId,collection:'notes',id:'shared_one'});
  assert.equal(value.item.value.title,'协作结果');
  assert.equal((await f.run('data.get',{collection:'notes',id:'shared_one'})).item,null,'physical databases remain separate');
  f.setOwner('test/account-b');
  assert.equal((await call('data.get',{appId:other.pluginId,collection:'notes',id:'shared_one'})).item,null);
  await assert.rejects(call('data.get',{appId:other.pluginId,collection:'notes',id:'shared_one',account:'test/account-a'}),/不支持/);
  await assert.rejects(call('data.get',{appId:'../../escape',collection:'notes',id:'shared_one'}),/标识/);
});

test('editing copies every resource beyond the old prompt limit, bumps the candidate version and preserves installed bytes',async t => {
  const f=fixture(t),edit=require('../main/jiyong-edit-source.cjs');
  const bytes=crypto.randomBytes(32000);
  const installed=personal.create(f.app,{...f.body,version:'0.1.1',resources:[...f.body.resources,{path:'assets/material.bin',kind:'asset',encoding:'base64',content:bytes.toString('base64')}]}).plugin;
  const candidate=await edit.prepare({app:f.app,pluginId:installed.pluginId,cwd:f.root});
  const body=JSON.parse(fs.readFileSync(candidate.draft,'utf8'));
  assert.equal(body.version,'0.1.2');assert.equal(body.key,installed.key);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(candidate.draft),'assets/material.bin')),bytes);
  assert.equal(personal.get(f.app,installed.pluginId).checksum,installed.checksum);
  assert.ok(candidate.guide.length<2000,'binary payloads are never expanded or truncated in the prompt');
  const collected=require('../main/plugin-resources').collect(body,candidate.draft,f.root);
  const next=personal.create(f.app,collected).plugin;
  assert.equal(next.pluginId,installed.pluginId);assert.equal(next.version,'0.1.2');
  await assert.rejects(edit.prepare({app:f.app,pluginId:installed.pluginId,cwd:f.root,readOnly:true}),/只读/);
  assert.throws(()=>personal.create(f.app,{...collected,description:'changed without bump'}),/提升版本号/);
});

test('busy independent databases share a bounded worker pool and keep committed data after eviction',async t=>{
  const f=fixture(t);let maximum=0;
  const all=Array.from({length:16},(_,n)=>({pluginId:'local:pool-'+n,origin:f.binding.origin}));
  await Promise.all(all.map(async binding=>{const pending=data.execute(f.app,binding,schema,'data.batch',{collection:'notes',operations:[{id:'saved',expectedRevision:0,value:{status:null}}]});maximum=Math.max(maximum,data.diagnostics().activeWorkers);await pending;}));
  assert.ok(maximum<=8);assert.equal(data.diagnostics().pendingRequests,0);
  for(const binding of all){const page=await data.execute(f.app,binding,schema,'data.list',{collection:'notes',filter:{status:null}});assert.equal(page.items.length,1);}
});

test('bound external MCP proxy injects credentials on HTTP calls and redacts the actual service response',async t=>{
  const http=require('node:http');let received;
  const server=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;received={authorization:req.headers.authorization,body:JSON.parse(text)};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:received.body.params.arguments.sk}]}}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const current={token:'fixture-bearer',revision:1};
  const lease=await require('../main/pi-session/app-mcp-proxy.cjs').create({server:'fixture',url:'http://127.0.0.1:'+server.address().port+'/mcp',...current,readCurrent:()=>current,bindings:[{tool:'echo',argument:'sk',parameter:'serviceKey',value:'fixture-private-value'}],redactions:['fixture-private-value']});
  t.after(()=>{lease.cleanup();server.closeAllConnections();return new Promise(r=>server.close(r));});
  const response=await fetch(lease.url,{method:'POST',headers:{Authorization:'Bearer '+lease.token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'echo',arguments:{sk:'wrong'}}})});
  assert.equal(response.status,200);assert.equal(received.authorization,'Bearer fixture-bearer');assert.equal(received.body.params.arguments.sk,'fixture-private-value');assert.equal(JSON.stringify(await response.json()).includes('fixture-private-value'),false);
});


test('developer changes create a portable version preserving identity and every resource, with stale edits rejected',async t=>{
 const f=fixture(t),meta=require('../main/personal-plugin-metadata.cjs');
 const options={author:'即用实验室',appCategory:'game',expectedChecksum:f.installed.checksum};
 const changed=await meta.update({app:f.app,pluginId:f.installed.pluginId,options});
 assert.equal(changed.plugin.pluginId,f.installed.pluginId);assert.equal(changed.plugin.authorName,'即用实验室');assert.equal(changed.plugin.version,'0.1.1');
 assert.deepEqual(changed.plugin.localDraft.resources,f.installed.localDraft.resources);
 await assert.rejects(meta.update({app:f.app,pluginId:f.installed.pluginId,options}),/版本已变化/);
 const file=path.join(f.root,'developer.soduwork-plugin');await personal.exportToFile(f.app,{showSaveDialog:async()=>({filePath:file})},f.installed.pluginId);
 const imported=require('../main/plugin-package-reader.cjs').readPersonalArchive(fs.readFileSync(file));assert.equal(imported.author,'即用实验室');assert.equal(imported.appCategory,'game');
 const next=await meta.update({app:f.app,pluginId:f.installed.pluginId,options:{appCategory:'robot',expectedChecksum:changed.plugin.checksum}});
 assert.equal(next.plugin.version,'0.1.2');assert.equal(next.plugin.authorName,'即用实验室');assert.equal(next.plugin.appCategory,'robot');
 const repeat=await meta.update({app:f.app,pluginId:f.installed.pluginId,options:{appCategory:'robot',expectedChecksum:next.plugin.checksum}});assert.equal(repeat.plugin.version,'0.1.2');
 await assert.rejects(meta.update({app:f.app,pluginId:f.installed.pluginId,options:{appCategory:'invalid',expectedChecksum:next.plugin.checksum}}),/分类/);
 assert.equal(f.installed.appCategory,'other');
});


test('native app automation goes to its own composer, pins host identity, rejects foreign receipts and rechecks scope',async t=>{
 const f=fixture(t),automate=require('../main/work-preview-app-automation.cjs');let envelope,expanded=0;
 const composer={id:202,isDestroyed:()=>false,send:(channel,value)=>{assert.equal(channel,'app-composer-automation');envelope=value;}};
 const owner={sender:{id:101,isDestroyed:()=>false,send:()=>assert.fail('must use own composer')}};
 const item={id:'app',appBridge:{appId:'plugin:'+f.installed.pluginId,contributionId:'main',origin:f.binding.origin},composer:{view:{webContents:composer}}};
 require('../main/work-preview-app-owner.cjs').capture(item, { app: f.app });
 const request={params:{text:'每天9点运行',requestId:'once',context:{characterName:'阿奇',appName:'forged',page:f.binding.origin+'/ui/index.html'}}};
 const response=automate.submit({owner,item,request,deps:{app:f.app,expandComposer:()=>expanded++}});
 while(!envelope)await new Promise(r=>setImmediate(r));
 assert.equal(expanded,1);assert.equal(envelope.params.context.sourceApp.name,f.installed.name);assert.equal(envelope.params.context.sourceApp.characterName,'阿奇');
 assert.equal(automate.finish({id:202},{id:envelope.id,result:{ok:true}}).ok,false);
 assert.equal((await automate.authorize(composer,envelope.id)).ok,true);
 f.setOwner('test/account-b');await assert.rejects(automate.authorize(composer,envelope.id),{code:'APP_ACCOUNT_CHANGED'});
 automate.finish(composer,{id:envelope.id,result:{ok:true,schedule:{id:'created'}}});
 assert.equal((await response).uncertain,true);
});


function initializedBody(f,script,version='0.1.1'){
 return {...f.body,version,jiyong:{...schema,initialization:{script:'assets/data-init.json'}},resources:[...f.body.resources,{path:'assets/data-init.json',kind:'asset',encoding:'utf8',content:JSON.stringify(script)}]};
}
const seed=(id,title)=>({collection:'notes',id,value:{title,status:'active'}});
test('first installation initializes data before opening a window; repeat/reopen/upgrade and accounts preserve user records',async t=>{
 const f=fixture(t),init=require('../main/jiyong-initialization.cjs'),access=require('../main/jiyong-data-access.cjs');
 const script={schemaVersion:1,migrations:[{version:1,seed:[seed('welcome','Initial')]}]};
 const handlers={};personal.install({app:f.app,ipcMain:{handle:(name,fn)=>handlers[name]=fn},safeStorage:undefined});
 const installed=await handlers['personal-plugin-create']({},initializedBody(f,script));
 assert.equal(installed.ok,true,JSON.stringify(installed));assert.equal(installed.initialization.state,'ready');
 assert.ok(fs.existsSync(path.join(f.root,'jiyong-data',store.scope(f.binding),'data.sqlite')));
 const call=(method,params)=>access.request({app:f.app},f.binding,personal.get(f.app,f.installed.pluginId),method,params);
 assert.equal((await call('data.get',{collection:'notes',id:'welcome'})).item.value.title,'Initial');
 await call('data.batch',{collection:'notes',operations:[{id:'welcome',expectedRevision:1,value:{title:'My work',status:'active'}}]});
 await data.close();await init.initialize({app:f.app},f.installed.pluginId);
 assert.equal((await call('data.get',{collection:'notes',id:'welcome'})).item.value.title,'My work');
 await call('data.batch',{collection:'notes',operations:[{id:'welcome',expectedRevision:2,delete:true}]});
 script.migrations.push({version:2,seed:[seed('welcome','New default'),seed('next','New seed')]});
 personal.create(f.app,initializedBody(f,script,'0.1.2'));assert.equal((await init.initialize({app:f.app},f.installed.pluginId)).migrationVersion,2);
 assert.equal((await call('data.get',{collection:'notes',id:'welcome'})).item,null,'deleted seed is never resurrected');
 assert.equal((await call('data.get',{collection:'notes',id:'next'})).revision,1);
 f.setOwner('test/account-b');await init.initialize({app:f.app},f.installed.pluginId);
 assert.equal((await call('data.get',{collection:'notes',id:'welcome'})).item.value.title,'Initial','another account initializes its own DB');
 f.setOwner('test/account-a');assert.equal((await call('data.get',{collection:'notes',id:'welcome'})).item,null);
 script.migrations[0].seed[0].value.title='Rewritten history';personal.create(f.app,initializedBody(f,script,'0.1.3'));
 await assert.rejects(init.initialize({app:f.app},f.installed.pluginId),/已执行.*修改/);
});
test('initialization seeds and ledger roll back atomically on SQLite failure and the same installed package can retry',async t=>{
 const f=fixture(t),init=require('../main/jiyong-initialization.cjs');await f.run('data.list',{collection:'notes'});await data.close();
 const file=path.join(f.root,'jiyong-data',store.scope(f.binding),'data.sqlite'),{DatabaseSync}=require('node:sqlite');
 let db=new DatabaseSync(file);db.exec("CREATE TRIGGER deny_seed BEFORE INSERT ON records WHEN NEW.id='fail' BEGIN SELECT RAISE(ABORT,'fixture seed failure');END");db.close();
 const script={schemaVersion:1,migrations:[{version:1,seed:[seed('first','First'),seed('fail','Fail')]}]};personal.create(f.app,initializedBody(f,script));
 await assert.rejects(init.initialize({app:f.app},f.installed.pluginId),/fixture seed failure/);await data.close();
 db=new DatabaseSync(file);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM records').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jiyong_migrations').get().n,0);db.exec('DROP TRIGGER deny_seed');db.close();
 assert.equal((await init.initialize({app:f.app},f.installed.pluginId)).migrationVersion,1);
});
test('preflight rejects missing/nondeclarative initialization resources and package roundtrips preserve the complete script',async t=>{
 const f=fixture(t),script={schemaVersion:1,migrations:[{version:1,seed:[seed('welcome','Initial')]}]},body=initializedBody(f,script);
 assert.throws(()=>personal.preflight({...body,resources:f.body.resources}),/未随包/);
 for(const content of ['console.log("install")',JSON.stringify({schemaVersion:1,migrations:[{version:3,seed:[]}]}),JSON.stringify({schemaVersion:1,migrations:[{version:1,seed:[{...seed('a','A'),collection:'not_declared'}]}]})])assert.throws(()=>personal.preflight({...body,resources:[...f.body.resources,{path:'assets/data-init.json',kind:'asset',encoding:'utf8',content}]}));
 const installed=personal.create(f.app,body).plugin,file=path.join(f.root,'initialization.soduwork-plugin');await personal.exportToFile(f.app,{showSaveDialog:async()=>({filePath:file})},installed.pluginId);
 const exported=require('../main/plugin-package-reader.cjs').readPersonalArchive(fs.readFileSync(file));assert.deepEqual(require('../core/jiyong-initialization.cjs').parse(exported.jiyong,exported.resources),script);
});
