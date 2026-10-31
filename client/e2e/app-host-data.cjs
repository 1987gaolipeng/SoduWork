'use strict';
const electron=require('electron'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
if(typeof electron==='string'){
 const env={...process.env};for(const k of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_TEST_CONTEXT','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE'])delete env[k];
 const r=require('node:child_process').spawnSync(electron,[__filename],{env,windowsHide:true,stdio:'inherit',timeout:60000});process.exit(r.status??1);
}
const {app,BrowserWindow,WebContentsView,ipcMain}=electron,folder=fs.mkdtempSync(path.join(os.tmpdir(),'app-host-data-e2e-'));
app.setPath('userData',path.join(folder,'profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
const wins=[];let host, modelServer;const inference=[];const deadline=setTimeout(()=>{console.error('Host data E2E timed out');app.exit(1);},50000);
app.whenReady().then(async()=>{
 modelServer=require('node:http').createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);inference.push({url:req.url,body:JSON.parse(Buffer.concat(chunks).toString())});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'Spark, Orbit, Echo, Drift, Bloom'},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}}));});
 await new Promise(resolve=>modelServer.listen(0,'127.0.0.1',resolve));
 const identity={hub:'https://fixture.invalid',clientId:'device',session:require('../tests/helpers/platform-session-fixture.cjs').sessions().renewed};

 require('../main/app-settings-store.cjs').configure({app,safeStorage:electron.safeStorage,ownerOf:()=>'isolated/sdk-test'});
 require('../main/work-preview').install({app,ipcMain,authenticatedIdentityOf:async()=>identity,authorizeAI:async()=>{},resolveModel:async()=>({ok:true,model:{id:'isolated-fast-model',baseUrl:'http://127.0.0.1:'+modelServer.address().port+'/v1',key:'fixture-only'}}),BrowserWindow:Object.assign(function(opts){const w=new BrowserWindow({...opts,show:false});w.show=()=>{};wins.push(w);return w;},{fromWebContents:wc=>BrowserWindow.fromWebContents(wc)}),WebContentsView,shell:{openExternal:async()=>{throw Error('No external navigation');}}});
 const url=p=>require('node:url').pathToFileURL(path.resolve(__dirname,'..',p)).href;
 fs.writeFileSync(path.join(folder,'host.html'),`<!doctype html><title>SDK host</title><script>
 window.PluginUIHost={assertUse:async()=>{}};window.SoduWorkAPI={taskStorageKey:()=> 'fixture-account',clientAuthMe:async()=>({user:{id:'me',displayName:'Current user',token:'private-secret'}}),mateMessages:async()=>({items:[{id:'n',text:'Full notice'}],nextCursor:''}),listLibrary:async p=>({items:[{id:'document',title:p.storage,path:'private-path'}],folders:[]}),readLibraryContent:async()=>({content:'Full document',preview:{truncated:false}}),readLibraryBinary:async()=>({blob:new Blob(['abc'])})};
 </script><script src="${url('components/panels/app-host-data.js')}"></script><script src="${url('components/panels/soduwork-app-bridge-host.js')}"></script>`);
 host=new BrowserWindow({show:false,webPreferences:{preload:path.resolve(__dirname,'../preload.js'),contextIsolation:true,sandbox:true}});await host.loadFile(path.join(folder,'host.html'));
 const personal=require('../main/personal-plugins'),base={template:'app',name:'Host data SDK fixture',key:'host-data-fixture',version:'1.0.0',description:'Isolated SDK verification',instructions:'Read only',ui:{contributions:[{id:'main',title:'SDK',slot:'workspace.navigation',source:{type:'package',entry:'ui/index.html',bridge:{version:1,capabilities:['ai.generate','context.read','messages.read','library.read']}}}]},resources:[{path:'ui/index.html',kind:'ui',encoding:'utf8',content:'<!doctype html><p>SDK fixture</p><script src="soduwork-app.js"></script>'},{path:'ui/soduwork-app.js',kind:'ui',encoding:'base64',content:fs.readFileSync(path.resolve(__dirname,'../sdk/soduwork-app.js')).toString('base64')}]};
 async function open(body){const plugin=personal.create(app,body).plugin;let view;
  const opened=await host.webContents.executeJavaScript(`soduWorkAPI.workPreview.showDetached(${JSON.stringify({tabId:body.key,label:body.name,package:{pluginId:plugin.pluginId,contributionId:'main'}})})`);assert.equal(opened.ok,true);
  for(let n=0;n<100;n++){view=require('electron').webContents.getAllWebContents().find(wc=>wc.getURL().startsWith(require('../core/plugin-package-page.cjs').origin(plugin.pluginId)));if(view&&await view.executeJavaScript('typeof soduWorkApp!=="undefined"').catch(()=>false))return view;await new Promise(r=>setTimeout(r,30));}throw Error('SDK page did not load');
 }
 const page=await open(base),invoke=expr=>page.executeJavaScript(expr);
 const args={input:'brainstorm',instructions:'Return five creative words.',requestId:'native-once'};
 const generated=await invoke('soduWorkApp.ai.generate('+JSON.stringify(args)+')');assert.equal(generated.ok,true);assert.equal(generated.text.split(', ').length,5);
 const repeated=await invoke('soduWorkApp.ai.generate('+JSON.stringify(args)+')');assert.deepEqual(repeated,generated);assert.equal(inference.length,1);
 assert.deepEqual(inference[0],{url:'/v1/chat/completions',body:{model:'isolated-fast-model',stream:false,max_tokens:256,messages:[{role:'system',content:args.instructions},{role:'user',content:args.input}]}});
 assert.equal(fs.existsSync(path.join(app.getPath('userData'),'pi-agent')),false,'stateless API must not create agent state');

 const user=await invoke('soduWorkApp.user.getCurrent()');assert.equal(user.user.id,'me');assert.doesNotMatch(JSON.stringify(user),/private-secret/);
 assert.equal((await invoke('soduWorkApp.notifications.list()')).items[0].text,'Full notice');
 for(const storage of ['local','minio','nfs']){const r=await invoke(`soduWorkApp.library.list({storage:${JSON.stringify(storage)}})`);assert.equal(r.items[0].title,storage);assert.doesNotMatch(JSON.stringify(r),/private-path/);}
 assert.equal((await invoke('soduWorkApp.library.read({id:"document"})')).content,'Full document');assert.equal((await invoke('soduWorkApp.library.read({id:"document",format:"base64"})')).data,'YWJj');
 await invoke('window.__topic="";window.__off=soduWorkApp.events.onDataChanged(e=>window.__topic=e.topic);true');
 const changed=await host.webContents.executeJavaScript('soduWorkAPI.workPreviewAppHost.notifyDataChanged("library")');assert.equal(changed.ok,true);assert.equal(changed.delivered,1);
 for(let i=0;i<50 && await invoke('window.__topic')!=='library';i++)await new Promise(r=>setTimeout(r,20));assert.equal(await invoke('window.__topic'),'library');
 await invoke('window.__off()');await host.webContents.executeJavaScript('soduWorkAPI.workPreviewAppHost.notifyDataChanged("identity")');await new Promise(r=>setTimeout(r,30));assert.equal(await invoke('window.__topic'),'library');
 const noAuth=await invoke('soduWorkApp.conversations.list()');assert.equal(noAuth.ok,false);assert.equal(noAuth.code,'APP_HISTORY_READ_FAILED','real history route must fail closed without an account');
 const denied=structuredClone(base);denied.key='denied-data-fixture';denied.ui.contributions[0].source.bridge.capabilities=[];const untrusted=await open(denied);assert.equal((await untrusted.executeJavaScript('soduWorkApp.user.getCurrent()')).code,'APP_CAPABILITY_DENIED');
 console.log(JSON.stringify({ok:true,evidence:folder,cases:['stateless AI through native bridge and HTTP proxy','native data-change delivery and unsubscribe','actual public SDK and native IPC','current user whitelist','full notification content','local/minio/nfs library routing','text and binary content','history route rejects missing identity','undeclared capability denied'],liveBusiness:false}));
}).then(()=>{clearTimeout(deadline);for(const w of wins)if(!w.isDestroyed())w.destroy();host?.destroy();modelServer?.closeAllConnections();modelServer?.close();app.exit(0);}).catch(error=>{console.error(error.stack);clearTimeout(deadline);modelServer?.closeAllConnections();modelServer?.close();app.exit(1);});
