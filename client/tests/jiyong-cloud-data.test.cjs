'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const personal=require('../main/personal-plugins'),store=require('../main/app-settings-store.cjs');
const cloud=require('../main/jiyong-cloud-data.cjs'),access=require('../main/jiyong-data-access.cjs');
const {scaffold}=require('../../skills/app-developer/scripts/scaffold.cjs');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-cloud-test-')),app={getPath:()=>root};
  let owner='org/account-a';
  store.configure({app,ownerOf:()=>owner,safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
  const out=path.join(root,'source');scaffold({out,key:'cloud-notes',name:'云端便签',storage:'cloud'});
  const file=path.join(out,'soduwork-plugin-draft.json');
  const body=require('../main/plugin-resources').collect(JSON.parse(fs.readFileSync(file,'utf8')),file,out);
  const installed=personal.create(app,body).plugin;
  const bound={pluginId:installed.pluginId,origin:require('../core/plugin-package-page.cjs').origin(installed.pluginId)};
  const identity={hub:'https://hub.example',clientId:'device-a',session:Buffer.from(JSON.stringify({typ:'device',cid:'device-a',uid:'user-a'})).toString('base64url')+'.signature'};
  const calls=[];
  const deps={app,identityOf:async()=>identity,fetchImpl:async(url,options)=>{
    calls.push({url,options,body:options.body&&JSON.parse(options.body)});
    return Response.json({ok:true,item:null,revision:0});
  }};
  t.after(()=>{require('../main/jiyong-hosted-connection.cjs').configure(undefined);fs.rmSync(root,{recursive:true,force:true});});
  return {root,app,body,installed,bound,identity,calls,deps,setOwner:v=>{owner=v;}};
}
test('cloud scaffold and portable packages keep exact storage, initialization and runtime validators',async t=>{
  const f=fixture(t),preview=personal.preflight(f.body);
  assert.equal(preview.manifest.jiyong.storage.location,'cloud');
  assert.ok(preview.checks.some(row=>row.key==='storage-location'&&row.label.includes('云端')));
  const archive=path.join(f.root,'cloud.soduwork-plugin');
  await personal.exportToFile(f.app,{showSaveDialog:async()=>({filePath:archive})},f.installed.pluginId);
  const imported=require('../main/plugin-package-reader.cjs').readPersonalArchive(fs.readFileSync(archive));
  assert.equal(personal.preflight(imported).manifest.jiyong.storage.location,'cloud');
  const bad=structuredClone(imported);delete bad.jiyong.initialization;
  assert.throws(()=>personal.preflight(bad),/初始化/);
  const unknown=structuredClone(imported);unknown.jiyong.storage.databaseUrl='postgresql://fixture';
  assert.throws(()=>personal.preflight(unknown),/不支持/);
  const missing=structuredClone(imported);missing.resources=missing.resources.filter(row=>row.path!=='assets/data-init.json');
  assert.throws(()=>personal.preflight(missing),/初始化脚本未随包提供/);
  for(const name of ['cloud-data.md','jiyong-data.schema.json','data-initialization.schema.json']){
    assert.ok(require('../main/app-developer-plugin.cjs').body(f.app).resources.some(row=>row.path==='references/developer/references/'+name));
  }
});
test('data access routes cloud requests with host-owned identity and never creates SQLite',async t=>{
  const f=fixture(t);
  await access.request(f.deps,f.bound,f.installed,'data.get',{collection:'notes',id:'welcome'});
  const sent=f.calls[0];
  assert.equal(sent.url,'https://hub.example/api/v1/jiyong/data');
  assert.equal(sent.options.headers.Authorization,'Device '+f.identity.session);
  assert.equal(sent.body.appId,f.installed.pluginId);assert.equal(sent.body.checksum,f.installed.checksum);
  assert.equal(sent.body.packageKey,f.body.key,'portable cloud identity comes from the package key, not the random installation UUID');
  assert.equal(sent.body.declaration.storage.location,'cloud');assert.equal(sent.body.initialization.schemaVersion,1);
  assert.equal(sent.body.ownerId,undefined);assert.equal(sent.body.databaseUrl,undefined);
  assert.equal(fs.existsSync(path.join(f.root,'jiyong-data')),false);
  await assert.rejects(require('../main/jiyong-data.cjs').execute(f.app,f.bound,f.installed.jiyong,'data.get',{collection:'notes',id:'x'}),/不能写入本机/);
});
test('initialization automatically provisions cloud through same data transport',async t=>{
  const f=fixture(t);
  f.deps.fetchImpl=async(_url,options)=>{f.calls.push(JSON.parse(options.body));return Response.json({ok:true,state:'ready',location:'cloud'});};
  const result=await require('../main/jiyong-initialization.cjs').initialize(f.deps,f.installed.pluginId,f.installed);
  assert.equal(result.state,'ready');assert.equal(f.calls[0].method,'initialize');
  assert.equal(fs.existsSync(path.join(f.root,'jiyong-data')),false);
});
test('cloud failures and account changes never fall back to local persistence',async t=>{
  const f=fixture(t);
  f.deps.fetchImpl=async()=>Response.json({detail:{code:'JIYONG_CONFLICT',message:'数据已更新'}},{status:409});
  await assert.rejects(access.request(f.deps,f.bound,f.installed,'data.get',{collection:'notes',id:'x'}),e=>e.code==='JIYONG_CONFLICT');
  f.deps.fetchImpl=async()=>{f.setOwner('org/other');return Response.json({ok:true,item:{id:'private'}});};
  await assert.rejects(access.request(f.deps,f.bound,f.installed,'data.get',{collection:'notes',id:'x'}),/账号已变化/);
  assert.equal(fs.existsSync(path.join(f.root,'jiyong-data')),false);
});
test('readiness preflight is GET only and unavailable cloud blocks native install checks',async t=>{
  const f=fixture(t);
  assert.equal((await cloud.preflight(f.deps,f.body)).ok,true);
  assert.equal(f.calls[0].options.method,'GET');assert.equal(f.calls[0].body,undefined);
  f.deps.fetchImpl=async()=>Response.json({detail:{code:'JIYONG_CLOUD_UNAVAILABLE',message:'未配置'}},{status:503});
  const preview=await personal.preflightCandidate(f.app,f.body,f.deps);
  assert.equal(preview.ok,false);assert.ok(preview.checks.some(row=>row.key==='cloud-readiness'&&row.ok===false));
  assert.equal(preview.runtime,undefined);assert.equal(fs.existsSync(path.join(f.root,'jiyong-data')),false);
});
test('headless skill MCP uses the same cloud account and installed package',async t=>{
  const f=fixture(t);require('../main/jiyong-hosted-connection.cjs').configure(f.deps);
  const connection=require('../main/jiyong-hosted-connection.cjs').context(f.app,f.installed.pluginId).connection;
  const result=await connection.invoke({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'data_get',arguments:{collection:'notes',id:'welcome'}}});
  assert.equal(JSON.parse(result.result.content[0].text).ok,true);
  assert.equal(f.calls[0].body.appId,f.installed.pluginId);
});
test('market cloud MCP restores its package identity and loads verified initialization after the page closes',async t=>{
  const f=fixture(t),remote={...f.installed,pluginId:'market-id',versionId:'accepted-v1',installed:true,enabled:true,permissions:{canUse:true}};
  const bound={pluginId:remote.pluginId,origin:require('../core/plugin-package-page.cjs').origin(remote.pluginId)};
  // saveHosted intentionally caches only runtime metadata, not the catalog row.
  store.saveHosted(bound,remote);
  f.deps.fetchImpl=async(url,options)=>{
    f.calls.push({url,options,body:options.body&&JSON.parse(options.body)});
    if(url.endsWith('/plugins/catalog'))return Response.json({items:[remote]});
    if(url.endsWith('/ui-package'))return Response.json({versionId:remote.versionId,jiyong:remote.jiyong,resources:f.body.resources});
    return Response.json({ok:true,item:null,revision:0});
  };
  require('../main/jiyong-hosted-connection.cjs').configure(f.deps);
  const connection=require('../main/jiyong-hosted-connection.cjs').context(f.app,remote.pluginId).connection;
  const reply=await connection.invoke({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'data_get',arguments:{collection:'notes',id:'welcome'}}});
  assert.equal(reply.result.isError,undefined,JSON.stringify(reply));
  const sent=f.calls.find(row=>row.url.endsWith('/jiyong/data')).body;
  assert.equal(sent.appId,'market-id');assert.equal(sent.versionId,'accepted-v1');
  assert.equal(sent.declaration,undefined,'market declarations must come from the server accepted version');
  assert.ok(f.calls.some(row=>row.url.endsWith('/ui-package')));
});
test('storage choice is preserved as mandatory declaration guidance in development prompts',()=>{
  const vm=require('node:vm'),window={};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components/panels/panels-plugin-builder-entry.js'),'utf8'),{window});
  for(const location of ['local','cloud']){
    const payload=window.PluginBuilderEntry.buildPayload('客户管理',{appCategory:'office',storageLocation:location,attachmentNames:['参考图.png']},true,'lite');
    assert.match(payload.contextPrompts.join('\n'),new RegExp('"location":"'+location+'"'));
    assert.ok(payload.contextPrompts.some(row=>row.includes('jiyong.storage')));
    const actual=require('../main/pi-session/environment-ipc').entryContextPrompts(payload.contextPrompts);
    assert.match(actual.join('\n'),new RegExp('"location":"'+location+'"'),'required mode survives the real four-prompt bridge limit');
    assert.equal(payload.autoSend,undefined);
  }
});
