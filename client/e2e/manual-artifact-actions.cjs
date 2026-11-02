"use strict";
// Actual Electron DOM and production file cards/workbench; isolated action spies, no user files or network.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 45000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), out = path.resolve(client, '../outputs/manual-artifact-actions');
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-manual-artifacts-')));
  const report = { ok: false, cases: [], errors: [], network: [] }; let win;
  const read = name => fs.readFileSync(path.join(client, name), 'utf8');
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const shot = async name => { await delay(80); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(70); await js('pending');
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1200, height: 780,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*'] }, (request, cb) => { report.network.push(request.url); cb({ cancel: true }); });
    await win.loadURL('data:text/html;charset=utf-8,<main id="chat" class="nchat"></main>');
    for (const file of ['theme/variables.css','components/panels/panels-chat.css','components/panels/code-workbench.css','components/panels/chat-deliveries.css'])
      await win.webContents.insertCSS(read(file));
    await win.webContents.insertCSS('*{box-sizing:border-box}body{margin:0;background:var(--bg-0);color:var(--ink);font:15px system-ui}#chat{height:100vh}.nchat-stage{display:flex;height:100vh}.nchat-main{flex:1;min-width:0;padding:72px 48px}.nmsg{max-width:720px;margin:24px auto}.nmsg.user{text-align:right}.ntext{line-height:1.8;margin-bottom:24px}.ncw{height:100%}');
    await js(`window.actions=[];window.pending=null;window.notices=[];window.errors=[];
      addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      window.petSay=text=>notices.push(text);window.SoduWorkAPI={taskStorageKey:()=>'fixture-owner',saveLibraryDelivery:async payload=>{actions.push('save');return{ok:true,delivery:{id:'saved',files:payload.manifest.files}};}};
      window.api={artifactAction:async(ref,id,mode)=>{actions.push(mode);return{ok:true,text:'# 预览内容'};},
        inspectDelivery:async()=>({ok:true,manifest:{files:[{path:currentFile.name,size:20}]}}),
        prepareDelivery:async()=>({ok:true,manifest:{files:[{path:currentFile.name,size:20}]}}),
        openLocalDelivery:async()=>{actions.push('open');return{ok:true};}};
      window.soduWorkAPI={conversationSession:api};window.fixtureContext={ref:'fixture',cwd:'/project',intent:{}};void 0;`);
    const iconFile = path.join(app.getPath('userData'), 'example.xlsx'); fs.writeFileSync(iconFile, 'fixture');
    const icon = (await app.getFileIcon(iconFile)).toDataURL();
    await js('soduWorkAPI.fileTypeIcon=async()=>({ok:true,dataUrl:'+JSON.stringify(icon)+'});void 0;');
    for (const name of ['library-file-icons','chat-dom-patch','panels-chat-tools','chat-output-links','chat-workspace-info','chat-workspace-split',
      'chat-workspace-controls','panels-chat-workspace','chat-deliveries']) await js(read('components/panels/' + name + '.js') + '\nvoid 0;');
    await js(`window.render=ext=>{
      ChatWorkbench.reset();fixtureContext.ref='fixture-'+ext;actions.length=0;
      chat.innerHTML='<div class="nchat-stage"><section class="nchat-main"><div id="messages"><article class="nmsg user">请生成工作文件</article><article class="nmsg ai"><div class="ntext">文件已生成，可按需打开或保存到资料库。</div></article></div></section></div>';
      window.currentFile={artifactId:ext,relative:'工作文件.'+ext,name:'工作文件.'+ext,path:'/project/工作文件.'+ext,size:20,at:1200,primary:true,changedInTurn:true};
      window.snapshot={status:'idle',messages:[{role:'user',at:1000,blocks:[{kind:'text',text:'请生成工作文件'}]},{role:'assistant',at:1200,blocks:[{kind:'text',text:'已完成'}]}],tools:[],deliverySync:{currentTurn:true,artifactVersions:[{id:ext,at:1200,size:20}]}};
      ChatWorkbench.bind(chat,()=>fixtureContext);ChatWorkbench.render(chat,snapshot,[currentFile]);
      ChatDeliveries.decorate(messages,[currentFile],fixtureContext.ref,snapshot);ChatDeliveries.hydrate(messages,{api,ref:fixtureContext.ref,snapshot});
      messages.addEventListener('click',e=>{const node=e.target.closest('button');if(node)pending=ChatDeliveries.handle(node,api);});
    };void 0;`);
    for (const ext of ['xlsx','docx','pptx','zip','bin']) {
      await js(`render('${ext}');`); await delay(150);
      assert.deepEqual(await js('actions'), [], ext + ' must not open or download on render or hydration');
      assert.equal(await js('ChatWorkbench.state().open'), false);
      assert.equal(await js('messages.querySelectorAll(".ndelivery").length'), 1);
      assert.equal(await js('messages.querySelector(".ndelivery").closest("article").classList.contains("ai")'), true);
      assert.equal(await js('messages.querySelector("[data-delivery-retry]").innerText'), '保存到资料库');
      assert.equal(await js('messages.querySelector("[data-delivery-reveal]").disabled'), false);
      if (ext === 'xlsx') await shot('excel-card-passive');
      await click('[data-delivery-reveal]'); assert.deepEqual(await js('actions'), ['open']);
      await click('[data-delivery-retry]'); assert.deepEqual(await js('actions'), ['open','save']);
      assert.equal(await js('messages.querySelector("[data-delivery-retry]").innerText'), '已保存到资料库');
      report.cases.push(ext + ': card remains below the reply; no automatic actions; real clicks open and save');
    }
    await js("render('md');"); await delay(150);
    assert.equal(await js('ChatWorkbench.state().open'), true);
    assert.equal(await js('actions.includes("open")||actions.includes("save")'), false);
    report.cases.push('Markdown still opens inside the right pane without launching another application');
    await js("render('xlsx-narrow');"); win.setContentSize(760,780); await delay(100);
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true); await shot('narrow-file-card');
    report.cases.push('Narrow window keeps the file card and its manual actions visible');
    assert.deepEqual(await js('errors'), []); assert.deepEqual(report.errors, []); assert.deepEqual(report.network, []);
    report.ok = true;
  }).catch(async error => { report.error = String(error.stack); if (win) await shot('failure').catch(() => {}); }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
