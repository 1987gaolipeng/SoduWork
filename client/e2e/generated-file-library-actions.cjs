"use strict";
// Actual Electron DOM and shipped UI; isolated storage receipts, no user files or network.
const electron=require('electron');
if(typeof electron==='string'){
 const env={...process.env};for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS'])delete env[key];
 const child=require('node:child_process').spawn(electron,[__filename],{env,windowsHide:true,stdio:'inherit'});
 const timer=setTimeout(()=>child.kill(),60000);child.on('exit',code=>{clearTimeout(timer);process.exitCode=code??1;});
}else{
 const {app,BrowserWindow}=electron, fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
 const client=path.resolve(__dirname,'..'),out=path.resolve(client,'../outputs/generated-file-library-actions');fs.mkdirSync(out,{recursive:true});
 app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-file-library-')));
 const report={ok:false,cases:[],errors:[],network:[]};let win;
 const read=name=>fs.readFileSync(path.join(client,name),'utf8'),js=code=>win.webContents.executeJavaScript(code,true);
 const delay=ms=>new Promise(r=>setTimeout(r,ms));
 async function click(selector){
  const point=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});
  await delay(40);await js('window.pending');
 }
 async function shot(name){await fit();await delay(80);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
 async function fit(){assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);
  assert.equal(await js(`[...document.querySelectorAll('[data-delivery-retry],[data-library-output]')].every(e=>{
   const r=e.getBoundingClientRect(),label=e.querySelector('.ndelivery-action-label,.library-save-label'),svg=e.querySelector('svg');
   const textStyle=label&&getComputedStyle(label),textBox=label&&label.getBoundingClientRect();
   return Math.abs(r.width-r.height)<=1&&r.width>=28&&r.width<=32&&svg&&svg.getBoundingClientRect().width>0&&
    textStyle.position==='absolute'&&textStyle.clip!=='auto'&&textBox.width<=1&&textBox.height<=1&&
    e.title&&e.getAttribute('aria-label')===e.title;
  })`),true,'Save actions stay icon-only with accessible, state-aware tooltips');
  assert.equal(await js(`[...document.querySelectorAll('#messages button:not([hidden])')].every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&e.scrollWidth<=e.clientWidth+1})`),true);}
 app.whenReady().then(async()=>{
  win=new BrowserWindow({show:false,width:1100,height:760,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(r,cb)=>{report.network.push(r.url);cb({cancel:true});});
  await win.loadFile(path.join(__dirname,'fixtures/library.html'));
  await win.webContents.insertCSS(read('components/panels/chat-deliveries.css')+read('components/panels/library-transfer.css'));
  await win.webContents.insertCSS('body{padding:40px 24px;background:var(--bg-0)}#messages{max-width:560px;margin:60px auto}.nmsg{margin:20px 0}.ntext{font:15px/1.7 var(--font-ui);margin-bottom:18px}#fixtureRail{display:none}');
  const iconPath=path.join(app.getPath('userData'),'example.xlsx');fs.writeFileSync(iconPath,'isolated icon fixture');
  const fileIcon=(await app.getFileIcon(iconPath)).toDataURL();
  await js('window.soduWorkAPI={fileTypeIcon:async()=>({ok:true,dataUrl:'+JSON.stringify(fileIcon)+'})};void 0;');
  await js(`document.body.insertAdjacentHTML('beforeend','<main id="messages"></main>');window.fail=false;window.waitSave=false;window.saved=[];window.listCalls=[];window.routes=[];window.uploads=0;window.notices=[];window.previewCalls=0;window.scope='owner-a';window.remoteBackend='nfs';window.deliveryBackend='local';window.errors=[];
   addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));window.petSay=s=>notices.push(s);
   window.SoduWorkLibraryPreview={create:()=>({close(){},selectedId:()=>'',refreshSelection(){},open(){previewCalls++;}})};
   window.SoduWorkAPI={taskStorageKey:()=>scope,libraryOutputKey:(ref,file)=>file.artifactId,getLibraryOutputStatus:async key=>({ok:true,item:saved.find(item=>item.id==='local-'+key)||null}),getLibraryStorageStatus:async()=>({storage:{local:{available:true},remote:{backend:remoteBackend,available:true,connected:true,configured:true}}}),
    listLibrary:async f=>{listCalls.push(f);return{items:saved.filter(x=>(f.folderId==='server-history-root'?x.backend==='local'&&!x.id.startsWith('local-'):x.backend===f.storage)&&(!f.query||x.filename.includes(f.query))),folders:[],folder:f.folderId?{id:f.folderId,storageOrigin:'server-history'}:null};},
    saveLibraryDelivery:async payload=>{uploads++;if(fail)throw Error('保存失败：连接中断');if(waitSave)await new Promise(r=>window.releaseSave=r);const item={id:(deliveryBackend==='local'?'local-':'remote-')+payload.manifest.filename,backend:deliveryBackend,storage:deliveryBackend,title:payload.manifest.filename,filename:payload.manifest.filename,kind:'document',files:payload.manifest.files||[{path:payload.manifest.filename,size:30}],size:30};saved.push(item);return{ok:true,delivery:item};},
    uploadLibraryOutput:async(ref,file)=>{uploads++;if(fail)throw Error('保存失败：连接中断');const item={id:'local-'+file.artifactId,backend:'local',filename:file.name,title:file.name,kind:'document',size:30};saved.push(item);return{ok:true,item};}};
   window.api={inspectDelivery:async()=>({ok:true,manifest:{files:[{path:currentFile.name,size:30}]}}),prepareDelivery:async(ref,ids)=>({ok:true,manifest:{filename:currentFile.name},data:'fixture'})};void 0;`);
  for(const file of JSON.parse(read('core/locales/manifest.json')))await js(read('core/locales/'+file));
  for(const file of ['core/i18n-dom.js','core/i18n.js','components/panels/library-file-icons.js','components/panels/panels-library-dialogs.js','components/panels/library-transfer.js','components/panels/chat-dom-patch.js','components/panels/panels-chat-tools.js','components/panels/chat-deliveries.js','components/panels/panels-library.js'])await js(read(file)+'\nvoid 0;');
  await js(`SoduWorkI18n.setLocale('zh-CN',{persist:false,broadcast:false});
   WorkspaceHost={open:async(view,payload)=>{routes.push({view,...payload});return openLibraryPanel(payload);}};
   messages.addEventListener('click',e=>{const node=e.target.closest('button');if(!node)return;if(node.hasAttribute('data-library-output'))window.pending=LibraryTransfer.saveDecorated(node);else window.pending=ChatDeliveries.handle(node,api);});
   window.render=(ext,legacy=false)=>{closeLibraryPanel();window.currentFile={artifactId:'file-'+ext,name:'中学课程表.'+ext.split('-')[0],kind:ext==='png'?'image':'document',primary:true,changedInTurn:true,at:1,size:30};messages.innerHTML='<article class="nmsg ai"><div class="ntext">已生成文件，可打开查看或保存到资料库。</div></article>';
    if(legacy)LibraryTransfer.decorateOutputs(messages,[currentFile],'legacy-'+ext,{status:'idle'});
    else { ChatDeliveries.decorate(messages,[currentFile],'chat-'+ext,{status:'idle'}); ChatDeliveries.hydrate(messages,{api,ref:'chat-'+ext,snapshot:{status:'idle'}}); }};void 0;`);
  await js(`render('xlsx');`);await fit();await shot('excel-unsaved');
  assert.equal(await js(`document.querySelector('[data-delivery-retry]').innerText`),'保存到资料库');
  await js('fail=true;');await click('[data-delivery-retry]');
  assert.equal(await js(`document.querySelector('[data-delivery-retry]').innerText`),'重试保存');
  assert.match(await js(`document.querySelector('[data-delivery-status]').innerText`),/连接中断/);
  await js('fail=false;waitSave=true;');
  await js(`window.pending=ChatDeliveries.handle(document.querySelector('[data-delivery-retry]'),api);void 0;`);await delay(40);
  assert.equal(await js(`document.querySelector('[data-delivery-retry]').disabled`),true);
  assert.equal(await js(`document.querySelector('[data-delivery-retry]').innerText`),'正在保存到资料库…');await shot('excel-saving');
  await js('waitSave=false;releaseSave();');await js('pending');
  assert.equal(await js(`document.querySelector('[data-delivery-retry]').innerText`),'已保存到资料库');assert.equal(await js(`document.querySelector('[data-delivery-open]').hidden`),true);await shot('excel-saved');
  const before=await js('uploads');await click('[data-delivery-retry]');
  assert.equal(await js('uploads'),before);assert.equal(await js(`document.activeElement.querySelector('.library-card-copy b').textContent`),'中学课程表.xlsx');
  assert.equal(await js('listCalls.at(-1).storage'),'local');assert.equal(await js('previewCalls'),0);
  report.cases.push('Excel: icon-only save, failure retry, busy state, saved receipt, locate in the real library panel without duplicate upload or opening Office');
  await js('closeLibraryPanel();');
  for(const storage of ['local','nfs','minio']){
   await js(`deliveryBackend='${storage}';`);
   for(const ext of ['doc','docx','xls','xlsx','xlsm','ppt','pptx','zip','7z','html','md','txt','png','pdf']){
    const name=ext+'-'+storage,previewable=['html','md','txt','png','pdf'].includes(ext);
    await js(`render('${name}');`);
    assert.equal(await js(`document.querySelector('[data-delivery-open]').hidden`),true,'No preview before saving');
    await click('[data-delivery-retry]');
    assert.equal(await js(`document.querySelector('[data-delivery-retry]').innerText`),'已保存到资料库');
    assert.equal(await js(`document.querySelector('[data-delivery-open]').hidden`),!previewable,storage+': '+ext);
    await js(`render('${name}');`);
    assert.equal(await js(`document.querySelector('[data-delivery-open]').hidden`),!previewable,'Same policy after rerender');
    const previews=await js('previewCalls'),routeCount=await js('routes.length');
    if(!previewable){
     await js(`ChatDeliveries.handle(document.querySelector('[data-delivery-open]'),api);`);
     assert.equal(await js('previewCalls'),previews);assert.equal(await js('routes.length'),routeCount);
    }else if(storage==='local'){
     await click('[data-delivery-open]');
     for(let i=0;i<40&&await js('previewCalls')===previews;i++)await delay(25);
     assert.equal(await js('previewCalls'),previews+1,ext+' explicit preview');
    }
   }
   report.cases.push(storage+': Office/archive files never expose saved preview; HTML, Markdown, text, image and PDF retain it, including rerender');
  }
  await js(`deliveryBackend='local';render('md-bundle');
   const second={...currentFile,artifactId:'second-md',name:'second.md'};
   const bundle={filename:'documents.zip',files:[{path:currentFile.name,size:30},{path:second.name,size:30}]};
   api.inspectDelivery=async()=>({ok:true,manifest:bundle});
   api.prepareDelivery=async()=>({ok:true,manifest:bundle,data:'fixture'});
   messages.innerHTML='<article class="nmsg ai"><div class="ntext">Two generated files</div></article>';
   ChatDeliveries.decorate(messages,[currentFile,second],'bundle',{status:'idle'});`);
  await click('[data-delivery-retry]');
  assert.equal(await js(`document.querySelector('[data-delivery-open]').hidden`),true,'A ZIP package of previewable documents has no package preview icon');
  await shot('bundle-saved');
  report.cases.push('Multi-file ZIP result retains save/reveal actions without a preview icon');
  for(const locale of ['zh-CN','en-US','ja-JP','ko-KR']){
   await js(`SoduWorkI18n.setLocale('${locale}',{persist:false,broadcast:false});render('xlsx-${locale}');`);
   for(const width of [1100,390]){win.setContentSize(width,760);await delay(50);await fit();await shot('file-'+width+'-'+locale);}
  }
  report.cases.push('Four languages, 1100px and 390px: icon-only actions, accessible tooltips, no overflow');
  win.setContentSize(1100,760);await js(`SoduWorkI18n.setLocale('zh-CN',{persist:false,broadcast:false});render('xlsx',true);`);
  assert.equal(await js(`document.querySelector('[data-library-output]').innerText`),'保存到资料库');
  await click('[data-library-output]');assert.equal(await js(`document.querySelector('[data-library-output]').innerText`),'已保存到资料库');await shot('local-file-saved');
  await click('[data-library-output]');assert.equal(await js('listCalls.at(-1).storage'),'local');
  assert.equal(await js(`document.activeElement.querySelector('.library-card-copy b').textContent`),'中学课程表.xlsx');
  report.cases.push('Legacy file card saves to PC library and directly locates the saved item');
  await js(`closeLibraryPanel();remoteBackend='minio';saved.push({id:'minio-item',backend:'minio',filename:'对象存储.xlsx',title:'对象存储.xlsx',kind:'document'});LibraryTransfer.openSavedItem({id:'minio-item',storage:'minio',filename:'对象存储.xlsx'},{remote:true});`);
  assert.equal(await js('listCalls.at(-1).storage'),'minio');
  await js(`closeLibraryPanel();remoteBackend='nfs';window.wrongStoreError='';LibraryTransfer.openSavedItem({id:'minio-item',storage:'minio',filename:'对象存储.xlsx'},{remote:true}).catch(e=>wrongStoreError=e.message);`);
  assert.match(await js('wrongStoreError'),/远程存储暂时不可用/);
  report.cases.push('Saved provider is retained; configuration changes do not silently redirect MinIO items to NFS');
  await js(`closeLibraryPanel();saved.push({id:'old-server',backend:'local',filename:'历史成果.xlsx',title:'历史成果.xlsx',kind:'document'});LibraryTransfer.openSavedItem({id:'old-server',storage:'local',filename:'历史成果.xlsx'},{remote:true});`);
  assert.equal(await js('listCalls.at(-1).folderId'),'server-history-root');assert.equal(await js('listCalls.at(-1).storage'),'nfs');
  assert.equal(await js(`document.activeElement.querySelector('.library-card-copy b').textContent`),'历史成果.xlsx');
  report.cases.push('Historical Hub-local receipt uses server-history routing, never PC-local storage');
  await js(`closeLibraryPanel();render('scope.xlsx');scope='owner-b';dispatchEvent(new Event('soduwork-data-scope-changed'));void 0;`);
  const scoped=await js('uploads');await click('[data-delivery-retry]');assert.equal(await js('uploads'),scoped);
  report.cases.push('Account switch prevents stale card uploads');
  report.errors=await js('errors');assert.deepEqual(report.errors,[]);assert.deepEqual(report.network,[]);report.ok=true;
 }).catch(async e=>{report.error=String(e.stack);if(win)await shot('failure').catch(()=>{});}).finally(()=>{
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(win)win.destroy();app.exit(report.ok?0:1);
 });
}
