'use strict';
// Explicit live test: one real cover and a retained acceptance series; no Runner.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const option = key => { const index=process.argv.indexOf(key); return index<0?undefined:process.argv[index+1]; };
if (!process.argv.includes('--live') || !process.argv.includes('--keep-series') || !process.argv.includes('--cloud-root')) throw Error('--live --keep-series --cloud-root required: uses current account, one paid image and retains the named acceptance series');
const electron = require('electron');
if (typeof electron === 'string') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-series-live-'));
  const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' };
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  try {
    const result = spawnSync(electron, [__filename, ...process.argv.slice(2), '--test-root', root, '--disable-gpu'], {env,windowsHide:true,stdio:'inherit',timeout:900000});
    process.exitCode = result.status ?? 1;
  } finally {
    const resolved=fs.realpathSync(root), base=fs.realpathSync(os.tmpdir());
    if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('soduwork-series-live-') || fs.lstatSync(root).isSymbolicLink()) throw Error('Unexpected test cleanup root');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
} else {
  const {app,BrowserWindow,WebContentsView,ipcMain,safeStorage}=electron;
  const http=require('node:http'), assert=require('node:assert/strict');
  const client=path.resolve(__dirname,'..'), cloud=path.resolve(option('--cloud-root')), root=option('--test-root');
  const output=path.resolve(option('--output')||path.join(client,'../outputs/app-series-live-20261022'));fs.mkdirSync(output,{recursive:true});
  const sourceProfile=option('--profile')||path.join(app.getPath('appData'),'SoduWork');
  fs.mkdirSync(path.join(root,'profile'));fs.copyFileSync(path.join(sourceProfile,'Local State'),path.join(root,'profile/Local State'));
  app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
  const space=option('--space')||'team-c', windows=[], report={ok:false,cases:[],boundary:'Production H5/SDK/native app lease and Agent Runtime; current authorized text/image models and remote MCP. At most one paid cover; the named acceptance series is retained for user review. Existing series and original application are untouched.'};
  let server,host,application,composer,runtime,session,key='',remote='',seriesId=option('--resume-series')||'',generated=0,finished=false,failed=null,allowTextRewrite=false;
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  async function until(check,label,ms=20000){const end=Date.now()+ms;while(Date.now()<end){const value=await check();if(value)return value;await delay(250)}throw Error('Timed out: '+label)}
  const page=code=>application.webContents.executeJavaScript(code);
  async function tool(name,args={}) {
    const response=await fetch(remote+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}),signal:AbortSignal.timeout(30000)});
    const value=await response.json();if(!response.ok||value.error||value.result?.isError)throw Error('MCP '+name+' failed');
    return value.result.structuredContent||JSON.parse(value.result.content[0].text);
  }
  app.whenReady().then(async()=>{
    const source={isPackaged:false,getAppPath:()=>client,getVersion:()=>require('../package.json').version,getPath:k=>k==='userData'?sourceProfile:app.getPath(k)};
    require('../main/hub-endpoint.cjs').initialize(source);
    const auth=require('../main/device-auth');auth.install({app:source,safeStorage,ipcMain:{handle(){}}});
    const identity=await auth.authenticatedIdentity(source);assert(identity,'Current SoduWork account unavailable');
    const personal=require('../main/personal-plugins'), installed=personal.catalog(source).find(x=>x.key==='ops-cloud-console');assert(installed,'Installed application missing');
    const existing=personal.get(source,installed.pluginId);remote=new URL(existing.ui.contributions[0].source.url).origin;
    const store=require('../main/app-settings-store.cjs');store.configure({app:source,safeStorage,ownerOf:()=>identity.hub+':'+auth.localOwner(source)});
    key=store.read({pluginId:installed.pluginId,origin:remote}).values.ukey;assert(key,'Application ukey unavailable');
    const models=await tool('list_models',{space_id:space});assert(models.models.some(x=>x.kind==='image'&&x.available),'Image model unavailable');
    report.imageModel=models.models.find(x=>x.kind==='image').effective_model;
    const login=await fetch(remote+'/api/auth/login-ukey',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ukey:key}),signal:AbortSignal.timeout(15000)}).then(r=>r.json());assert(login.token,'Application login failed');
    const body=JSON.parse(fs.readFileSync(path.join(cloud,'plugin/soduwork-plugin-draft.json')));report.pluginVersion=body.version;
    server=http.createServer(async(req,res)=>{
      try {
        const url=new URL(req.url,'http://test');
        if(url.pathname==='/__bootstrap')return res.end('<!doctype html><script>localStorage.setItem("mediaops.languagePreference","zh");localStorage.setItem("soduworkToken",'+JSON.stringify(login.token)+');sessionStorage.setItem("soduworkSpaceId",'+JSON.stringify(space)+');location.replace("/home.html?space='+encodeURIComponent(space)+'");</script>');
        if(url.pathname.startsWith('/api/')||url.pathname==='/mcp'){
          const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks);let rpc;
          try{rpc=JSON.parse(raw)}catch{}
          const name=url.pathname==='/mcp'?rpc?.params?.name:url.pathname.split('/').pop(), args=url.pathname==='/mcp'?rpc?.params?.arguments:rpc;
          if(process.argv.includes('--verify-only')&&(name?.startsWith('generate_')||['put_series','put_settings','put_topic','put_scripts','put_assets','create_record','update_record','delete_record'].includes(name))){
            assert(allowTextRewrite&&name==='put_settings'&&Object.keys(args.settings||{}).join(',')==='doc','Verification is read-only');
          }
          if(name==='create_record'&&args?.table==='series'){assert(!seriesId||seriesId===args.id);assert.equal(args.space_id,space);seriesId=args.id;}
          if(['put_series','put_settings','update_record','delete_record','put_topic','put_scripts','put_assets'].includes(name)){
            assert.equal(args?.space_id,space);assert(['put_settings','update_record'].includes(name),'Unexpected test write');
            assert.equal(args.series_id||args.id,seriesId,'Unexpected record write');if(name==='update_record')assert.equal(args.table,'series');
          }
          if(name==='generate_image'){assert.equal(args?.space_id,space);assert.equal(generated,0,'Only one image submission authorized');generated++;}
          if(name==='generate_video')throw Error('Video generation not authorized');
          const headers={};for(const h of ['authorization','content-type','accept','mcp-session-id','mcp-protocol-version'])if(req.headers[h])headers[h]=req.headers[h];
          const response=await fetch(remote+req.url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:raw}:{}),redirect:'error',signal:AbortSignal.timeout(180000)});
          res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')||'application/json','Cache-Control':'no-store'});return res.end(Buffer.from(await response.arrayBuffer()));
        }
        const file=path.resolve(cloud,'web/public','.'+decodeURIComponent(url.pathname));assert(file.startsWith(path.join(cloud,'web/public')+path.sep));
        res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript; charset=utf-8':file.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(fs.readFileSync(file));
      }catch{res.writeHead(400,{'Content-Type':'application/json'});res.end('{"detail":"Live test request rejected"}')}
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
    store.configure({app,safeStorage,ownerOf:()=>'live-fixture-owner'});
    body.key='ops-series-live-'+Date.now();body.ui.contributions[0].source.url=origin+'/__bootstrap';const plugin=personal.create(app,body).plugin;
    fs.writeFileSync(path.join(root,'host.html'),'<!doctype html><title>Series live verification</title>');
    fs.writeFileSync(path.join(root,'composer.html'),'<script>soduWorkAPI.workPreview.onComposerSubmit(p=>soduWorkAPI.workPreview.composerSubmitResult({id:p.id,ok:true,liveText:p.text}));</script>');
    const installedIpc={handle(name,handler){ipcMain.handle(name,async(event,payload,...rest)=>{
      const result=await handler(event,payload,...rest);
      if(name==='work-preview-composer-submit-result'&&event.sender===composer?.webContents&&payload?.liveText)setImmediate(()=>execute(payload.liveText).catch(e=>{failed=e;finished=true}));
      return result;
    })}};
    require('../main/work-preview').install({app,ipcMain:installedIpc,
      BrowserWindow:Object.assign(function(options){const win=new BrowserWindow(options);windows.push(win);return win},{fromWebContents:wc=>BrowserWindow.fromWebContents(wc)}),
      WebContentsView:function(options){const view=new WebContentsView(options),load=view.webContents.loadFile.bind(view.webContents);view.webContents.loadFile=(file,options)=>load(path.basename(file)==='desk.html'?path.join(root,'composer.html'):file,options);return view},shell:{openExternal:async()=>{throw Error('No external browser')}}});
    runtime=require('../main/agent-runtime/process-session').createProcessSession({identityOf:()=>auth.authenticatedIdentity(source)});
    async function execute(text){
      report.sentText=text;assert(text.length<600,'Automatic task too long');
      console.log(JSON.stringify({stage:'Running real SoduWork text model; MCP settings and one cover',promptLength:text.length}));
      const cwd=path.join(root,'work');fs.mkdirSync(cwd,{recursive:true});
      const opened=await runtime.open({app,identity,cwd,ref:'series-live-'+Date.now(),modelName:option('--model')||'',pluginIds:[plugin.pluginId],
        accessPolicy:require('../main/access-control/policy').create('full',cwd),capabilityIds:['browser'],skillDirs:[path.resolve(client,'../skills/mcp-tools')],noExtensions:true,
        resolvePlugins:async(ids,projectId)=>require('../main/pi-session/plugin-grant').resolve({app,identityOf:async()=>identity,appContext:require('../main/work-preview').appContextFor(composer.webContents),ref:'series-live',pluginIds:ids,projectId,cwd})});
      assert(opened.ok,opened.reason);session=opened.session;
      const result=await session.send(text,[],{pluginIds:[plugin.pluginId]});if(result?.ok===false)throw Error(result.reason||'Runtime failed');
      const snapshot=await session.snapshotAsync();report.model=snapshot.modelSelection?.name||snapshot.model?.id;
      report.tools=(snapshot.tools||[]).map(t=>({name:t.name,isError:!!t.isError,bridge:t.name==='bash'&&String(t.args?.command).includes('mcp.mjs')}));
      assert(!report.tools.some(t=>t.isError),'Model tool error; inspect isolated runtime transcript');
      await composer.webContents.executeJavaScript('soduWorkAPI.workPreview.composerTurnSettled()');finished=true;
    }
    host=new BrowserWindow({show:false,webPreferences:{preload:path.join(client,'preload.js'),contextIsolation:true,sandbox:true}});await host.loadFile(path.join(root,'host.html'));
    const opened=await host.webContents.executeJavaScript('soduWorkAPI.workPreview.showDetached('+JSON.stringify({tabId:'series-live',url:origin+'/__bootstrap',appBridge:{appId:'plugin:'+plugin.pluginId,contributionId:'ops-cloud-console',origin,version:1,capabilities:body.ui.contributions[0].source.bridge.capabilities}})+')');assert(opened.ok);
    [,application,composer]=windows[0].contentView.children;
    await until(()=>page('!!window.MediaOpsSeries && !!window.MediaOpsSkills'),'application ready');await page('MediaOpsAppSettingsReady');
    let name='验收·系列设定与封面·'+new Date().toISOString().replace(/\D/g,'').slice(0,14);
    if(process.argv.includes('--verify-only')){
      assert(seriesId,'Verification requires --resume-series');const prior=await tool('get_record',{space_id:space,table:'series',id:seriesId});
      assert(prior.name.startsWith('验收·系列设定与封面·')&&prior.doc&&prior.cover_attachment_id,'Only verify the completed acceptance series');
      name=prior.name;report.mode='read-only verification of the existing live result';
      if(process.argv.includes('--exercise-text-helper')){
        const connection=await until(()=>require('../main/work-preview').appContextFor(composer.webContents)?.connection,'text helper app lease');
        const grant=await require('../main/pi-session/app-mcp-grant.cjs').extend({app,connection});
        try{
          allowTextRewrite=true;
          const saved=await new Promise((resolve,reject)=>{const child=require('node:child_process').spawn(process.execPath,[path.resolve(client,'../skills/mcp-tools/scripts/app-settings-text.mjs'),'--config',grant.configFile,'--server','media-ops-cloud','--space',space,'--series',seriesId],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';child.stdin.end(prior.doc);child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('close',code=>resolve({code,out,err}))});
          assert.equal(saved.code,0,'Markdown helper failed');const reread=await tool('get_record',{space_id:space,table:'series',id:seriesId});
          assert.equal(reread.doc,prior.doc);assert.equal(reread.cover_attachment_id,prior.cover_attachment_id);report.rawMarkdownHelperVerified=true;
        }finally{allowTextRewrite=false;grant.cleanup()}
      }
      if(process.argv.includes('--model-verify')){
        await page('MediaOpsSkills.launch("data-fix",'+JSON.stringify('只读验收：通过MCP查询当前系列的设定、风格、比例、封面附件，并用check_data核对。现有图片任务：'+(option('--job-id')||'')+'。确认结果并给链接；禁止写入、再次生成或打开浏览器。')+',{context:'+JSON.stringify({spaceId:space,seriesId,topicId:''})+'})');
      }else finished=true;
    }else if(seriesId){
      const prior=await tool('get_record',{space_id:space,table:'series',id:seriesId});assert(prior.name.startsWith('验收·系列设定与封面·')&&!prior.cover_attachment_id,'Only resume this unfinished acceptance series');name=prior.name;
      const task=['媒体比例：'+prior.media_ratio,'视觉风格：'+prior.visual_style,'系列设定：\n'+prior.initial_brief,'请完善当前系列设定，并生成系列封面；完成后通过 MCP 查询确认结果。'].join('\n');
      report.resumedSeries=true;await page('MediaOpsSkills.launch("series-gen",'+JSON.stringify(task)+',{context:'+JSON.stringify({spaceId:space,seriesId,seriesName:name,topicId:''})+'})');
    }else{
      await page('opsNewSeries.click()');await until(()=>page('!opsSeriesProduct.disabled'),'series form ready');
      await page('opsSeriesName.value='+JSON.stringify(name)+';opsSeriesBrief.value="面向小团队的会议纪要实践，每周两期。正文约400字，写清定位、栏目、节奏和风格。封面一张，无文字，温暖办公桌与笔记本意象。不做外部调研，不创建话题或视频。";opsSeriesRatio.value="3:4";opsSeriesStyle.value="水彩手绘";opsSeriesCreate.click()');
    }
    await until(()=>finished||failed,'real series runtime completion',720000);if(failed)throw failed;
    const row=await tool('get_record',{space_id:space,table:'series',id:seriesId});assert(row.doc?.length>100);assert.equal(row.visual_style,'水彩手绘');assert.equal(row.media_ratio,'3:4');assert(row.cover_attachment_id,'Cover not linked');assert.equal(generated,process.argv.includes('--verify-only')?0:1);
    if(option('--job-id')){const job=await tool('get_generation',{space_id:space,job_id:option('--job-id')});assert.equal(job.status,'succeeded');assert.equal(job.media_status,'ready');assert(job.attachments.some(x=>x.id===row.cover_attachment_id));report.generation={jobId:job.job_id,status:job.status,mediaStatus:job.media_status,attachment:job.attachments.map(x=>({id:x.id,width:x.width,height:x.height,thumbnailWidth:x.thumbnail_width,thumbnailHeight:x.thumbnail_height}))};}
    const checked=await tool('check_data',{space_id:space});assert.deepEqual(checked.errors,[]);
    report.seriesId=seriesId;report.coverAttachmentId=row.cover_attachment_id;report.docLength=row.doc.length;report.imageSubmissions=generated;report.checkData={errors:checked.errors,warnings:checked.warnings};
    await application.webContents.loadURL(origin+'/settings.html?space='+space+'&series='+seriesId);await until(()=>page('document.getElementById("doc")?.innerText.length>100'),'settings render');
    const connection=await until(()=>require('../main/work-preview').appContextFor(composer.webContents)?.connection,'settings app lease');const shot=await connection.inspect('shot');fs.writeFileSync(path.join(output,'settings-current-app.png'),Buffer.from(shot.png,'base64'));
    await application.webContents.loadURL(origin+'/home.html?space='+space);await until(()=>page('document.querySelectorAll("#thumbs img").length>0'),'cover home render');
    await until(()=>page('(()=>{const card=[...document.querySelectorAll("#thumbs .thumb")].find(x=>x.textContent.includes('+JSON.stringify(name)+'));const img=card?.querySelector("img");return !!(img&&img.complete&&img.naturalWidth>0)})()'),'generated cover displayed',30000);
    await page('document.querySelector('+JSON.stringify('#thumbs .thumb[data-id="'+seriesId+'"]')+').dispatchEvent(new MouseEvent("mouseenter"))');
    await until(()=>page('document.querySelector("#stageMain h2")?.textContent.includes('+JSON.stringify(name)+') && !!document.querySelector("#stageMain img")?.naturalWidth'),'acceptance cover preview');
    const homeConnection=await until(()=>require('../main/work-preview').appContextFor(composer.webContents)?.connection,'home app lease');const cover=await homeConnection.inspect('shot');fs.writeFileSync(path.join(output,'cover-current-app.png'),Buffer.from(cover.png,'base64'));
    report.cases.push(process.argv.includes('--verify-only')?'Existing real model result → MCP doc/style/ratio/cover readback → ready generation metadata → current authenticated app renders settings and cover; no additional generation':
      'Production create-series form → short native message → real Agent Runtime → authenticated MCP doc and fields → one real image → ready attachment → cover association → MCP readback → current app renders settings and cover');report.ok=true;
  }).catch(error=>{report.error=String(error.stack||error).split(key||'__NO_KEY__').join('[redacted]')}).finally(async()=>{
    try{await session?.close();await runtime?.dispose()}catch{report.runtimeCleanup=false}
    host?.destroy();windows.forEach(w=>{if(!w.isDestroyed())w.destroy()});
    if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}
    if(seriesId){report.seriesId=seriesId;report.seriesRetained=true;report.url=remote+'/settings.html?space='+space+'&series='+seriesId;}
    report.imageSubmissions=generated;fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.exit(report.ok?0:1);
  });
}
