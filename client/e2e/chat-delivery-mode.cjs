'use strict';

// Local and cloud sessions share the same final-file delivery contract.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const assert = require('node:assert/strict');

  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-chat-delivery-mode-')));
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 900, height: 600,
      webPreferences: { contextIsolation: false, nodeIntegration: false } });
    await win.loadURL('data:text/html;charset=utf-8,<main id="messages"></main>');
    await win.webContents.insertCSS(fs.readFileSync(path.join(__dirname,'../components/panels/chat-deliveries.css'),'utf8'));
    const js = code => win.webContents.executeJavaScript(code, true);
    const source = fs.readFileSync(path.join(__dirname, '../components/panels/chat-deliveries.js'), 'utf8');
    await js(`window.SoduWorkAPI={taskStorageKey:()=> 'e2e'};window.SoduWorkLibraryFileIcons={markup:()=>'<span>file</span>',hydrate:()=>{}};${source}`);
    const localFiles = [{ artifactId: 'local-file', name: 'report.md', relative: 'report.md',
      contentType: 'text/markdown', changedInTurn: true }];
    await js(`messages.innerHTML='<article class="nmsg ai"><button data-open-app="local-file">report.md</button></article>';` +
      `ChatDeliveries.decorate(messages,${JSON.stringify(localFiles)},'local-session',{});void 0;`);
    assert.equal(await js('document.querySelectorAll(".ndelivery").length'), 1);
    assert.equal(await js('document.querySelectorAll("[data-open-app]").length'), 3);
    assert.equal(await js('document.querySelectorAll("[data-delivery-download]").length'), 0);
    assert.equal(await js('document.querySelectorAll("[data-delivery-reveal]").length'), 1);
    const structure=await js('Array.from(document.querySelector(".ndelivery").querySelectorAll("*")).map(e=>e.tagName+":"+e.className)');
    await js(`messages.innerHTML='<article class="nmsg ai"><button data-open-app="source">README.md</button></article>';ChatDeliveries.decorate(messages,[{artifactId:"source",name:"README.md",primary:false,changedInTurn:true}],"code-session",{});void 0;`);
    assert.equal(await js('document.querySelectorAll(".ndelivery").length'), 0);

    const cloudFiles = [{ artifactId: 'cloud-file', taskId: 'cloud-task', role: 'output',
      name: 'report.md', relative: 'report.md', contentType: 'text/markdown', changedInTurn: true }];
    await js(`messages.innerHTML='<article class="nmsg ai" data-output-task="cloud-task"><p>完成。</p></article>';` +
      `ChatDeliveries.decorate(messages,${JSON.stringify(cloudFiles)},'cloud-session',{cloudHandoff:{taskId:'cloud-task'}});void 0;`);
    assert.equal(await js('document.querySelectorAll(".ndelivery").length'), 1);
    assert.equal(await js('document.querySelectorAll("[data-delivery-download]").length'), 0);
    assert.deepEqual(await js('Array.from(document.querySelector(".ndelivery").querySelectorAll("*")).map(e=>e.tagName+":"+e.className)'),structure);
    win.setContentSize(390,760);
    await js('new Promise(r=>requestAnimationFrame(r))');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);
    await js(`window.calls=0;window.savedIds=[];
      const files=[{artifactId:'remote-a',taskId:'cloud-task',attachmentId:'a',cloudPending:true,name:'a.md',role:'output'},
                   {artifactId:'remote-b',taskId:'cloud-task',attachmentId:'b',cloudPending:true,name:'b.md',role:'output'}];
      messages.innerHTML='<article class="nmsg ai" data-output-task="cloud-task">完成</article>';
      ChatDeliveries.decorate(messages,files,'batch-session',{cloudHandoff:{taskId:'cloud-task'}});
      window.batchApi={cloud:{materialize:async()=>{calls++;return{ok:true,artifacts:['a','b'].map(id=>({artifactId:'local-'+id,remoteAttachmentId:id,cloudTaskId:'cloud-task',name:id+'.md'}))};}},openLocalDelivery:async(ref,ids)=>{savedIds=ids;return{ok:true}}};
      ChatDeliveries.handle(document.querySelector('[data-delivery-reveal]'),batchApi);`);
    assert.equal(await js('calls'),1);
    await js(`messages.innerHTML='<article class="nmsg ai" data-output-task="cloud-assets">完成</article>';ChatDeliveries.decorate(messages,['index.html','style.css','app.js'].map((name,i)=>({artifactId:'asset-'+i,cloudTaskId:'cloud-assets',remoteMaterialized:true,role:'output',primary:i===0,name,relative:name})),'asset-session',{cloudHandoff:{taskId:'cloud-assets'}});void 0;`);
    assert.equal(await js('document.querySelectorAll(".ndelivery-files li").length'),3);
    assert.equal(await js('document.querySelector(".ndelivery-files").hidden'),false);
    assert.equal(await js('document.querySelector("[data-delivery-archive]").hidden'),false);
    await js(`batchApi.openDeliveryArchive=async(ref,ids)=>{window.archiveIds=ids;return{ok:true}};ChatDeliveries.handle(document.querySelector('[data-delivery-archive]'),batchApi);`);
    assert.equal(await js('archiveIds.length'),3);
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);
    assert.deepEqual(await js('savedIds'),['local-a','local-b']);
    await js(`window.localOpened=null;window.WorkspaceHost={open:async(_,options)=>{localOpened=options;return true}};batchApi.continueLocalDelivery=async(ref,ids)=>({ok:true,cwd:'isolated-copy',file:{path:'isolated-copy/a.md'},preview:true});ChatDeliveries.handle(document.querySelector('[data-delivery-local]'),batchApi);`);
    assert.equal(await js('localOpened.newSession'),true);
    assert.equal(await js('localOpened.fileOpen.cwd'),'isolated-copy');
    assert.equal(await js('calls'),1);
    await js(`messages.innerHTML='<article class="nmsg ai">代码已提交。</article>';ChatDeliveries.decorate(messages,[{artifactId:'old-report',taskId:'git-task',name:'README.md',role:'output',primary:true}],'git-session',{deliveryMode:'git',cloudHandoff:{taskId:'git-task'},artifactUrl:'https://git.example.test/team/repo.git'});void 0;`);
    assert.equal(await js('document.querySelectorAll(".ndelivery").length'),0);
    await win.destroy();
    await app.quit();
    console.log(JSON.stringify({ ok: true, cases: [
      'PC local results have location and library actions, no download; engineering source has no card',
      'PC cloud results share local controls without download and can continue locally',
      'local/cloud cards use identical structure and fit a 390px viewport',
      'a multi-file cloud result materializes once for location and local continuation',
      'Git delivery returns a summary without reviving old attachments or a repository preview card',
    ] }));
  }).catch(error => { console.error(error.stack || error); app.exit(1); });
}
