const test=require('node:test'),assert=require('node:assert/strict');
const links=require('../components/panels/chat-output-links');
const files=[{artifactId:'local:report',name:'report.html',relative:'report.html'},
  {artifactId:'local:cn',name:'汇报 方案.pdf',relative:'交付/汇报 方案.pdf'}];

test('deleted verification images cannot reappear as inline previews from a stale mention',()=>{
  const shown = new Set();
  assert.equal(links._claimInlineMedia({artifactId:'deleted-shot',name:'verify-shot1.png',deleted:true},shown),false);
  assert.equal(shown.size,0);
  assert.equal(links._claimInlineMedia({artifactId:'live-image',name:'artwork.png'},shown),true);
});
test('known filenames beat hostnames; drive paths and file URLs resolve without raw paths',()=>{
  for(const href of ['report.html','./report.html','file:///C:/work/report.html','C:\\work\\report.html','sandbox:/mnt/data/report.html'])
    assert.equal(links.fileTarget(href,files)?.artifactId,'local:report',href);
  assert.equal(links.fileTarget('file:///C:/work/'+encodeURIComponent('汇报 方案.pdf'),files)?.artifactId,'local:cn');
});
test('untrusted protocols and explicit external links never become local files',()=>{
  for(const href of ['https://example.com/report.html','//example.com/report.html','javascript:report.html','data:report.html','#report.html'])
    assert.equal(links.fileTarget(href,files),null);
});
test('ambiguous basenames never open a different task or directory',()=>{
  const rows=[{artifactId:'a',relative:'one/report.html',name:'report.html'},{artifactId:'b',relative:'two/report.html',name:'report.html'}];
  assert.equal(links.fileTarget('report.html',rows),null);
  assert.equal(links.fileTarget('two/report.html',rows)?.artifactId,'b');
});
test('an explicit screenshot evidence path never falls back to an unrelated same-name asset',()=>{
  const shot={artifactId:'shot',name:'homepage.png',relative:'.soduwork/evidence/homepage.png'};
  const asset={artifactId:'asset',name:'homepage.png',relative:'assets/homepage.png'};
  for(const target of ['.soduwork/evidence/homepage.png','C:/work/.soduwork/evidence/homepage.png','file:///C:/work/.soduwork/evidence/homepage.png']) {
    assert.equal(links.fileTarget(target,[asset]),null,target);
    assert.equal(links.fileTarget(target,[shot,asset]),shot,target);
  }
  assert.equal(links.fileTarget('homepage.png',[asset]),asset,'bare legacy filenames retain their existing lookup');
});
test('Chinese filenames and word boundaries',()=>{
  assert.equal(links.mentions('生成 report.html 和 汇报 方案.pdf',files).length,2);
  assert.equal(links.mentions('other-report.html.bak',files).length,0);
});
test('settled and controlled completion refresh without a streaming transition',()=>{
  assert(links.shouldRefresh({kind:'settled',snapshot:{status:'idle'}},{status:'idle'}));
  assert(links.shouldRefresh({kind:'task-execution',snapshot:{execution:{taskExecutions:[{taskId:'t',runId:'r',status:'completed'}]}}},{status:'idle'}));
  assert(!links.shouldRefresh({kind:'snapshot',snapshot:{status:'idle'}},{status:'idle'}));
  const snapshot={execution:{taskExecutions:[{taskId:'t',runId:'r',status:'completed'}]}};
  assert(!links.shouldRefresh({kind:'task-execution',snapshot},snapshot));
});
test('task files merge with local files; inputs and tickets stay out of rendered metadata',async()=>{
  const hub={listAttachments:async taskId=>[
    {id:'out',taskId,filename:'report.html',role:'output',size:0,url:'/attachments/out?ticket=private'},
    {id:'in',filename:'input.pdf',role:'input',url:'/attachments/in?ticket=private'}]};
  const result=await links.load({outputs:async()=>({ok:true,artifacts:files,cloudOutputs:[{
    taskId:'t',attachmentId:'out',relative:'report.html',size:0,artifactId:'local:report'}]})},'ref',['t','t'],[],hub);
  // The cloud output has already been materialized into the trusted local
  // artifact index, so it is merged with the local row and never retains the
  // remote task/download identity.
  assert.equal(result.length,2);assert.equal(result[0].cloudTaskId,'t');
  assert.equal(result[0].remoteMaterialized,true);
  assert(!JSON.stringify(result).includes('private'));assert(!JSON.stringify(result).includes('input.pdf'));
});
test('remote validation screenshots stay evidence while declared output images remain deliverables',async()=>{
  const hub={listAttachments:async taskId=>[
    {id:'shot',taskId,filename:'homepage.png',role:'output',evidenceMeta:{kind:'deploy_screenshot',category:'evidence'}},
    {id:'image',taskId,filename:'final-chart.png',role:'output',evidenceMeta:{category:'primary'}},
    {id:'check',taskId,filename:'check.png',role:'verification',evidenceMeta:{kind:'deploy_screenshot'}}]};
  const rows=await links.load({outputs:async()=>({ok:true,artifacts:[]})},'ref',['t'],[],hub);
  const shot=rows.find(row=>row.attachmentId==='shot');
  const image=rows.find(row=>row.attachmentId==='image');
  const check=rows.find(row=>row.attachmentId==='check');
  assert.equal(shot.processEvidence,true);
  assert.equal(shot.primary,false);
  assert.equal(shot.category,'evidence');
  assert.equal(image.processEvidence,false);
  assert.equal(image.primary,true);
  assert.equal(check.processEvidence,true);
  assert.equal(check.primary,false);
});
test('legacy non-array output payloads are ignored without crashing the renderer',async()=>{
  const result=await links.load({outputs:async()=>({ok:true,artifacts:{length:1,files:[]},deliverables:{length:1}})},'r',[],[],null);
  assert.deepEqual(result,[]);
});
test('transient task index failure retains known outputs',async()=>{
  const row={taskId:'t',attachmentId:'a',name:'a.pdf'};
  assert.deepEqual(await links.load({outputs:async()=>({ok:true,artifacts:[]})},'r',['t'],[row],{listAttachments:async()=>{throw Error('offline')}}),[row]);
});
test('an empty trusted artifact index never revives a stale draft from the delivery fallback',async()=>{
  const draft={artifactId:'old-draft',name:'soduwork-plugin-draft.json'};
  const result=await links.load({outputs:async()=>({ok:true,artifacts:[],deliverables:[draft],files:[draft]})},'new-session',[],[],null);
  assert.deepEqual(result,[]);
  const legacy=await links.load({outputs:async()=>({ok:true,files:[draft]})},'legacy-session',[],[],null);
  assert.deepEqual(legacy,[draft]);
});
test('tool-written files stay work evidence: no primary promotion, build/telemetry noise hidden',()=>{
  const changed={cwd:'C:/work/ws',files:[
    {path:'index.html',action:'created',after:{mtimeMs:1}},
    {path:'1ei1jbii.0.cs',action:'created',after:{mtimeMs:2}},
    {path:'1ei1jbii.dll',action:'created',after:{mtimeMs:3}},
    {path:'1ei1jbii.cmdline',action:'created',after:{mtimeMs:4}},
    {path:'4zjze31d.err',action:'created',after:{mtimeMs:5}},
    {path:'cv_debug.log',action:'created',after:{mtimeMs:6}},
    {path:'bin/Debug/app.pdb',action:'created',after:{mtimeMs:7}},
    {path:'scripts/deploy.py',action:'created',after:{mtimeMs:8}},
  ]};
  const byName=Object.fromEntries(links.mergeFileChanges([],changed).map(f=>[f.relative,f]));
  // Workbench stays addressable, but nothing is auto-promoted to a deliverable.
  for(const rel of Object.keys(byName)){
    assert.equal(byName[rel].primary,false,rel);
    assert.equal(byName[rel].changedInTurn,true,rel);
  }
  assert.equal(byName['index.html'].processEvidence,false);
  assert.equal(byName['scripts/deploy.py'].processEvidence,false);
  for(const rel of ['1ei1jbii.0.cs','1ei1jbii.dll','1ei1jbii.cmdline','4zjze31d.err','cv_debug.log','bin/Debug/app.pdb'])
    assert.equal(byName[rel].processEvidence,true,rel);
  // Existing trusted rows are only refreshed, never re-promoted.
  const again=links.mergeFileChanges([{artifactId:'x',name:'keep.md',relative:'keep.md',primary:false}],{
    cwd:'C:/work/ws',files:[{path:'keep.md',action:'modified',after:{mtimeMs:9}}]});
  assert.equal(again[0].primary,false);
  assert.equal(again[0].changedInTurn,true);
});

test('task file clicks refresh tickets and save via the explicit download dialog',async()=>{
  const requests=[],saved=[],file={taskId:'t',attachmentId:'a'};
  const hub={listAttachments:async id=>{requests.push(id);return[{id:'a',role:'output',filename:'tool.zip',url:'/api/v1/attachments/a?ticket=fresh'}]},
    attachmentUrl:row=>'https://hub.test'+row.url};
  const bridge={downloadAttachment:async payload=>{saved.push(payload);return {ok:true};}};
  assert.equal(await links.openTaskFile(file,hub,bridge),true);
  assert.deepEqual(requests,['t']);
  assert.deepEqual(saved,[{url:'https://hub.test/api/v1/attachments/a?ticket=fresh',filename:'tool.zip'}]);
  await assert.rejects(links.openTaskFile({...file,attachmentId:'missing'},hub,bridge),/暂时不可用/);
  await assert.rejects(links.openTaskFile(file,{...hub,listAttachments:async()=>[{id:'a',role:'output',url:'javascript:alert(1)'}]},bridge),/地址无效/);
});

test('video outputs are recognized separately from images',()=>{
  assert.equal(links.isVideo({name:'demo.mp4'}),true);
  assert.equal(links.isVideo({name:'demo.webm'}),true);
  assert.equal(links.isVideo({name:'poster.png'}),false);
  assert.equal(links.isImage({name:'poster.png'}),true);
});
test('inline media is claimed once and process evidence remains compact',()=>{
  const shown=new Set();
  const result={artifactId:'result',name:'final-result.png'};
  assert.equal(links._claimInlineMedia(result,shown),true);
  assert.equal(links._claimInlineMedia(result,shown),false);
  assert.equal(links._claimInlineMedia({artifactId:'proof',name:'04-command-output.png',processEvidence:true},shown),false);
});
test('task videos refresh their signed stream URL for inline and side preview',async()=>{
  const previous=global.SoduWorkAPI;
  const requests=[];
  global.SoduWorkAPI={
    listAttachments:async taskId=>{requests.push(taskId);return[
      {id:'video',role:'output',filename:'demo.mp4',mimeType:'video/mp4',
       url:'/api/v1/attachments/video?ticket=fresh'}]},
    attachmentUrl:row=>'https://hub.test'+row.url,
  };
  try{
    const got=await links.readPreview(
      {taskId:'task-1',attachmentId:'video',name:'demo.mp4'},null,'ref','preview');
    assert.equal(got.ok,true);
    assert.equal(links.videoUrl(got),'https://hub.test/api/v1/attachments/video?ticket=fresh');
    assert.deepEqual(requests,['task-1']);
    assert.equal(links.videoUrl({ok:true,url:'javascript:alert(1)'}),'');
  }finally{global.SoduWorkAPI=previous;}
});
