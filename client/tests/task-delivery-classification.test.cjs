'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const deliveryContract = require('../main/conversation/delivery-contract');
const artifactRuntime = require('../main/conversation/artifact-runtime');
const outputs = require('../main/pi-session/outputs');
const { prepare } = require('../main/pi-session/task-input');

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-task-delivery-'));
}

test('测试方案文档会作为需求交付物保留', (t) => {
  const cwd = workspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, 'SoduWork测试方案.md');
  fs.writeFileSync(file, '# 测试方案\n');

  const scanned = outputs.scan(cwd, 0, 0);
  assert.equal(deliveryContract._isProcess(scanned.files[0]), false);
  assert.ok(scanned.delivery.items.some((item) => item.name === 'SoduWork测试方案.md'));

  const snapshot = artifactRuntime.snapshot({
    cwd,
    outputSnapshot: () => scanned,
  });
  const item = snapshot.items.find((row) => row.name === 'SoduWork测试方案.md');
  assert.ok(item, '交付物应出现在会话成果快照中');
  assert.equal(item.processEvidence, undefined);
});

test('测试报告仍作为过程证据排除', (t) => {
  const cwd = workspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, '测试报告.md');
  fs.writeFileSync(file, '# 测试报告\n');

  const scanned = outputs.scan(cwd, 0, 0);
  assert.equal(deliveryContract._isProcess(scanned.files[0]), true);
  assert.equal(scanned.delivery.items.some((item) => item.name === '测试报告.md'), false);
});

test('需求执行完成时会上传测试方案并绑定当前轮次', async (t) => {
  const cwd = workspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, 'SoduWork测试方案.md');
  fs.writeFileSync(file, '# 方案\n');
  t.mock.method(artifactRuntime, 'snapshotAsync', async () => ({
    items: [{ path: file, name: 'SoduWork测试方案.md', relative: 'SoduWork测试方案.md', changedInTurn:true }],
  }));
  const deliveries = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    const target = String(url);
    if (target.includes('/conversation-delivery')) {
      deliveries.push({
        path: options.body.get('paths'),
        file: options.body.get('files').name,
        outcome: options.body.get('outcome'),
        turnId: options.body.get('turnId'),
      });
      return Response.json({ ok: true, files: ['SoduWork测试方案.md'] });
    }
    if (target.includes('/conversation-turn')) return Response.json({ turn: { state: 'queued' }, task: { id: 't' } });
    return Response.json({ id: 't', title: '方案', description: '编写测试方案' });
  });
  const identity = { hub: 'http://fixture', clientId: 'd', secret: 'test-only' };
  const input = await prepare(identity, 't', 'chat', 'turn-delivery', '执行', {}, {
    handle: { sessionId: 'chat', cwd },
  });
  await input.beforeTurn();
  await input.afterTurn('completed');
  assert.deepEqual(deliveries, [{
    path: 'SoduWork测试方案.md',
    file: 'SoduWork测试方案.md',
    outcome: 'completed',
    turnId: 'turn-delivery',
  }]);
});

for (const declared of [false, true]) test('revised delivery excludes historical MD with ' + (declared ? 'an explicit manifest' : 'turn changes'), async t => {
  const cwd = workspace();
  t.after(() => fs.rmSync(cwd, {recursive:true,force:true}));
  const rows = ['report.md','report.html','appendix.pdf'].map((name,index)=>{
    const file = path.join(cwd,name); fs.writeFileSync(file,'content');
    return {path:file,name,relative:name,changedInTurn:index===1};
  });
  const unknown = {path:path.join(cwd,'unknown.md'),name:'unknown.md',relative:'unknown.md'};
  fs.writeFileSync(unknown.path,'Unscoped historical file');
  t.mock.method(artifactRuntime,'snapshotAsync',async()=>({items:[...rows,unknown],
    delivery:{source:declared?'manifest':'inferred',items:rows.slice(1)}}));
  let uploaded = [];
  t.mock.method(global,'fetch',async(url,options)=>{
    if (String(url).includes('/conversation-delivery')) {
      uploaded = options.body.getAll('files').map(file=>file.name);
      return Response.json({ok:true});
    }
    if (String(url).includes('/conversation-turn')) return Response.json({turn:{state:'queued'},task:{id:'t'}});
    return Response.json({id:'t',title:'Revise the report'});
  });
  const turn = await prepare({hub:'http://fixture',clientId:'d',secret:'test-only'},'t','chat','revision-2','Revise',{},
    {handle:{sessionId:'chat',cwd}});
  await turn.beforeTurn(); await turn.afterTurn('completed');
  assert.deepEqual(uploaded,declared?['report.html','appendix.pdf']:['report.html']);
});

test('browser capture provenance excludes final-named screenshots but respects explicit image delivery', t => {
  const cwd=workspace(); t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  for(const [name,data] of [['index.html','<html><body>Site</body></html>'],['final-hero.png','image']]) fs.writeFileSync(path.join(cwd,name),data);
  const handle={cwd,sessionId:'shots',snapshot:()=>({tools:[{name:'bash',state:'done',args:{command:"await page.screenshot({path: 'final-hero.png'})"}}]}),outputSnapshot:()=>outputs.scan(cwd,0,1)};
  let snap=artifactRuntime.snapshot(handle);
  assert.equal(snap.items.find(file=>file.name==='final-hero.png').processEvidence,true);
  assert.deepEqual(snap.delivery.items.map(file=>file.name),['index.html']);
   fs.mkdirSync(path.join(cwd,'.soduwork'));fs.writeFileSync(path.join(cwd,'.soduwork','delivery.json'),JSON.stringify({schemaVersion:1,deliverables:[{path:'final-hero.png'}]}));
  snap=artifactRuntime.snapshot(handle);
  assert.deepEqual(snap.delivery.items.map(file=>file.name),['final-hero.png']);
  assert.notEqual(snap.delivery.items[0].processEvidence,true);
});

test('requirement upload includes declared website dependencies and excludes unrelated screenshots',async t=>{
  const cwd=workspace();t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  fs.mkdirSync(path.join(cwd,'assets'));fs.writeFileSync(path.join(cwd,'index.html'),'<html><head><link rel="stylesheet" href="assets/style.css"></head><body>Site</body></html>');
  fs.writeFileSync(path.join(cwd,'assets/style.css'),'body{color:purple}');fs.writeFileSync(path.join(cwd,'final-hero.png'),'image');
  const handle={cwd,sessionId:'chat',snapshot:()=>({status:'idle',tools:[{name:'browser_screenshot',state:'done',args:{filename:'final-hero.png'}}]}),outputSnapshot:()=>outputs.scan(cwd,0,1)};
  let uploaded,categories;
  t.mock.method(global,'fetch',async(url,options)=>{
    if(String(url).includes('/conversation-delivery')){uploaded=options.body.getAll('paths');categories=options.body.getAll('categories');return Response.json({ok:true});}
    if(String(url).includes('/conversation-turn'))return Response.json({turn:{state:'queued'},task:{id:'t'}});
    return Response.json({id:'t',title:'Website'});
  });
  const turn=await prepare({hub:'http://fixture',clientId:'d',secret:'test-only'},'t','chat','turn','Build',{}, {handle});
  await turn.beforeTurn();await turn.afterTurn('completed');
  assert.deepEqual(uploaded,['assets/style.css','index.html']);assert.deepEqual(categories,['supporting','primary']);
});

test('declared multi-file deliveries retain every member and bundle beyond the upload envelope',async t=>{
  const cwd=workspace();t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const names=Array.from({length:61},(_,i)=>'result-'+String(i).padStart(2,'0')+'.txt');
  for(const name of names)fs.writeFileSync(path.join(cwd,name),'Final '+name);
   fs.mkdirSync(path.join(cwd,'.soduwork'));fs.writeFileSync(path.join(cwd,'.soduwork','delivery.json'),JSON.stringify({schemaVersion:1,deliverables:names.map(name=>({path:name}))}));
  const handle={cwd,sessionId:'chat',snapshot:()=>({status:'idle'}),outputSnapshot:()=>outputs.scan(cwd,0,1)};
  assert.equal(artifactRuntime.snapshot(handle).delivery.items.length,61);
  let uploaded;
  t.mock.method(global,'fetch',async(url,options)=>{
    if(String(url).includes('/conversation-delivery')){uploaded=options.body.getAll('files');return Response.json({ok:true});}
    if(String(url).includes('/conversation-turn'))return Response.json({turn:{state:'queued'},task:{id:'t'}});
    return Response.json({id:'t',title:'Many documents'});
  });
  const turn=await prepare({hub:'http://fixture',clientId:'d',secret:'test-only'},'t','chat','turn','Build',{}, {handle});
  await turn.beforeTurn();await turn.afterTurn('completed');
  assert.equal(uploaded.length,1);assert.match(uploaded[0].name,/\.zip$/);
  const bytes=Buffer.from(await uploaded[0].arrayBuffer());
  assert.equal(bytes.readUInt16LE(bytes.length-12),61,'ZIP central directory includes every declared file');
});
