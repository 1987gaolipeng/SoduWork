'use strict';
// Real renderer and mouse events; isolated file/native-action boundaries, no user data.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), out = path.resolve(client, '../outputs/workbench-toolbar');
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-workbench-toolbar-')));
  let win; const report = { ok: false, cases: [], errors: [] };
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const js = source => win.webContents.executeJavaScript(source, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(source) { for (let i = 0; i < 100; i++) { if (await js(source)) return; await delay(35); } throw Error('Timed out: ' + source); }
  async function click(selector) {
    const point = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled||!el.checkVisibility())throw Error('Unavailable: '+${JSON.stringify(selector)});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(60);
  }
  async function shot(name) { await delay(150); await win.webContents.capturePage(); await delay(80); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 850, height: 650, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) report.errors.push(message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_r, cb) => cb({ cancel: true }));
    const fixture = path.join(out, 'fixture.html'), base = require('node:url').pathToFileURL(client + path.sep).href;
    fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><base href="' + base + '"><link rel="stylesheet" href="theme/variables.css"><link rel="stylesheet" href="components/panels/panels-chat.css"><link rel="stylesheet" href="components/panels/library-transfer.css"><style>body{margin:0;font:14px var(--font-ui);background:var(--bg-0)}#chat{position:relative;height:100vh}.nchat-stage{height:100%;display:flex}.nchat-main{flex:1;min-width:0}</style><main id="chat" class="nchat"><div class="nchat-stage"><section class="nchat-main"></section></div></main>');
    await win.loadFile(fixture);
    await js(`window.actions=[];window.references=[];window.fileText='# 保存\\n\\nNew chat\\n\\n取消';window.previewPng='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH0UAAAAASUVORK5CYII=';
      window.soduWorkAPI={conversationSession:{artifactAction:async(ref,id,action)=>{actions.push({id,action});return action==='read'?{ok:true,text:fileText}:{ok:true,mimeType:'image/png',data:previewPng};}},workPreview:{onState:cb=>{window.onNativeState=cb;return()=>{};},show:async p=>{window.nativeTab=p.tabId;return{ok:true,state:{tabId:p.tabId,url:p.url||'file:///fixture.html',canBack:true,canForward:true}};},hide:()=>{},destroy:()=>{},command:(id,action)=>actions.push({id,action}),inspect:async(id,enabled)=>{actions.push({action:'inspect',enabled});return{state:{tabId:id,inspectEnabled:enabled}};}}};
      window.ConversationAttachments={copyOutputImage:async file=>{actions.push({action:'copy-image',id:file.artifactId});return{ok:true};}};
      window.SoduWorkAPI={uploadLibraryOutput:(ref,file)=>new Promise(resolve=>{actions.push({action:'upload',id:file.artifactId});window.finishUpload=resolve;})};
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>actions.push({action:'copy-path',value})}});
      document.querySelector('#chat').addEventListener('soduwork-workbench-reference',e=>references.push(e.detail));void 0;`);
    for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
    for (const file of ['core/i18n-dom.js', 'core/i18n.js', 'vendor/markdown/marked.umd.js', 'vendor/markdown/purify.min.js', 'components/panels/library-transfer.js', 'components/panels/chat-output-links.js', 'components/panels/chat-dom-patch.js', 'components/panels/panels-chat-tools.js', 'components/panels/chat-workspace-info.js', 'components/panels/chat-workspace-split.js', 'components/panels/chat-workspace-controls.js', 'components/panels/panels-chat-workspace.js']) await js(read(file) + '\nvoid 0;');
    await js(`window.files=[{artifactId:'image',name:'保存',path:'C:/fixture/保存.png',kind:'image'},{artifactId:'markdown',name:'New chat.md',path:'C:/fixture/New chat.md',kind:'document'},{artifactId:'web',name:'测试.html',path:'C:/fixture/测试.html',kind:'website'}];ChatWorkbench.bind(document.querySelector('#chat'),()=>({ref:'toolbar-fixture'}));ChatWorkbench.render(document.querySelector('#chat'),{messages:[]},files);SoduWorkI18n.setLocale('en-US');ChatWorkbench.openOutput('image');void 0;`);
    await until('document.querySelector(".ncw-image img")?.naturalWidth>0');
    assert.equal(await js('document.querySelector("[data-wb-copy-location]").title'), 'Copy file path');
    assert.equal(await js('document.querySelector(".ncw-image img").alt'), '保存');
    await click('[data-wb-reference]'); await click('[data-wb-file-open]'); await click('[data-wb-image-copy]');
    assert.equal(await js('references[0].location'), 'C:/fixture/保存.png');
    assert.ok(await js('actions.some(a=>a.action==="open"&&a.id==="image") && actions.some(a=>a.action==="copy-image")'));
    report.cases.push('Image reference, native open and image-copy controls dispatch the original actions');
    await click('[data-wb-copy-location]'); await click('[data-wb-copy-location]');
    await js('SoduWorkI18n.setLocale("zh-CN");'); await delay(1400);
    assert.equal(await js('document.querySelector("[data-wb-copy-location]").title'), '复制文件位置');
    assert.equal(await js('document.querySelector("[data-wb-image-copy]").getAttribute("aria-label")'), '复制图片');
    await js('SoduWorkI18n.setLocale("en-US");'); await click('[data-wb-library-upload]');
    await js('SoduWorkI18n.setLocale("zh-CN");finishUpload({ok:true});void 0;'); await delay(100);
    assert.equal(await js('document.querySelector("[data-wb-library-upload]").title'), '已保存到资料库');
    assert.equal(await js('document.querySelector("[data-wb-library-upload]").getAttribute("aria-label")'), '已保存到资料库');
    report.cases.push('Repeated copy and pending upload recover source-language tooltips and accessible names after a locale switch');
    for (const width of [850, 360]) {
      win.setSize(width, 650); await delay(80);
      for (const locale of ['en-US', 'zh-CN']) {
        await js('SoduWorkI18n.setLocale(' + JSON.stringify(locale) + ');');
        for (const id of ['image', 'markdown', 'web']) {
          await js('ChatWorkbench.openOutput(' + JSON.stringify(id) + ');void 0;');
          await until('!document.querySelector(".ncw-loading")'); await delay(100);
          const metrics = await js(`(()=>{const bar=document.querySelector('.ncw-dochead,.ncw-browserbar'),r=bar.getBoundingClientRect();return{height:r.height,overflow:bar.scrollWidth>bar.clientWidth,controls:[...bar.querySelectorAll('button')].map(b=>{const s=b.querySelector('svg'),sr=s?.getBoundingClientRect(),cs=s&&getComputedStyle(s),br=b.getBoundingClientRect();return {named:!!b.getAttribute('aria-label'),drawn:!!sr&&sr.width>=15&&sr.height>=15&&cs.stroke!=='none',inside:br.left>=r.left&&br.right<=r.right,font:parseFloat(getComputedStyle(b).fontSize)}})}})()`);
          assert.equal(metrics.overflow, false, JSON.stringify({ width, locale, id, metrics }));
          assert.ok(metrics.height <= 44 && metrics.controls.every(c => c.named && c.drawn && c.inside && c.font >= 12), JSON.stringify({ width, locale, id, metrics }));
          if (id === 'markdown') assert.equal(await js('document.querySelector(".ncw-markdown").textContent.trim()'), '保存\nNew chat\n取消');
          if (locale === 'zh-CN') await shot(id + '-' + width);
        }
      }
    }
    report.cases.push('Image, Markdown and HTML toolbars fit 360/850px in both locales, with visible named icons and unchanged document text');
    await click('[data-wb-nav=reload]'); await click('[data-wb-inspect]');
    assert.ok(await js('actions.some(a=>a.action==="reload") && actions.some(a=>a.action==="inspect"&&a.enabled)'));
    await js('onNativeState({tabId:nativeTab,loading:true});void 0;'); await delay(50);
    assert.equal(await js('document.querySelector("[data-wb-nav=stop]").getAttribute("aria-label")'), '停止');
    await click('[data-wb-nav=stop]');
    assert.ok(await js('actions.some(a=>a.action==="stop")'));
    report.cases.push('Browser reload, annotation toggle and loading-to-stop controls retain their native action bindings');
    await js('SoduWorkI18n.setLocale("en-US");'); await click('[data-wb-files]');
    assert.equal(await js('document.querySelector(".ncw-file-row b").textContent'), '保存');
    report.cases.push('File names matching UI translations stay unchanged in the file list');

    await js(`window.typedReads=0;window.typedLocations=0;window.originalArtifactAction=soduWorkAPI.conversationSession.artifactAction;
      window.typedFiles=[{artifactId:'typed-doc',name:'任务报告.md',relative:'任务报告.md',kind:'document',at:1,size:20},
        {artifactId:'typed-image',name:'预览图片.png',relative:'预览图片.png',kind:'image',at:1,size:40}];
      soduWorkAPI.conversationSession.artifactAction=async(ref,id,action)=>{
        const file=typedFiles.find(file=>file.artifactId===id);if(!file)return originalArtifactAction(ref,id,action);
        if(action==='location')typedLocations++;else typedReads++;
        return{ok:true,path:'C:/fixture/交付目录/'+file.name,text:'# Authorized document',mimeType:'image/png',data:previewPng};};
      ChatWorkbench.render(document.querySelector('#chat'),{messages:[]},typedFiles);ChatWorkbench.openOutput('typed-doc');void 0;`);
    await until("document.querySelector('[data-wb-file-location]')?.title==='C:/fixture/交付目录/任务报告.md'");
    assert.equal(await js("document.querySelector('[data-wb-file-location]').textContent"), 'C:/fixture/交付目录/任务报告.md');
    await click('[data-wb-copy-location]');
    assert.equal(await js("actions.filter(a=>a.action==='copy-path').at(-1).value"), 'C:/fixture/交付目录/任务报告.md');
    await js("ChatWorkbench.openOutput('typed-image');void 0;");
    await until("document.querySelector('[data-wb-file-location]')?.title==='C:/fixture/交付目录/预览图片.png'");
    await until('document.querySelector(".ncw-image img")?.naturalWidth>0');
    await click('[data-wb-copy-location]');
    assert.equal(await js("actions.filter(a=>a.action==='copy-path').at(-1).value"), 'C:/fixture/交付目录/预览图片.png');
    await js("for(let i=0;i<100;i++)ChatWorkbench.render(document.querySelector('#chat'),{messages:[]},typedFiles);void 0;");
    assert.deepEqual(await js('[typedReads,typedLocations,typedFiles.some(file=>Object.hasOwn(file,"path"))]'), [2, 0, false]);
    assert.ok(await js("document.querySelector('.ncw-document-name svg').getBoundingClientRect().width>=16"));
    await shot('typed-image-location-360');
    report.cases.push('Image and document locations use authorized read results, remain single-line with visible type icons at 360px, copy exact absolute paths, and avoid extra filesystem lookups during 100 redraws.');

    await js(`window.originalReadPreview=ChatOutputLinks.readPreview;
      ChatOutputLinks.readPreview=(file,...args)=>file.taskId?Promise.resolve({ok:true,text:'# Remote report',path:'C:/different-machine/remote.md'}):originalReadPreview(file,...args);
      window.remoteDoc={artifactId:'remote-doc',name:'remote.md',relative:'remote.md',kind:'document',taskId:'remote-task',attachmentId:'attachment'};
      ChatWorkbench.render(document.querySelector('#chat'),{messages:[]},[remoteDoc]);ChatWorkbench.openOutput('remote-doc');void 0;`);
    await until("document.querySelector('.ncw-markdown')?.textContent.includes('Remote report')");
    assert.equal(await js("document.querySelector('[data-wb-file-location]').title"), 'remote.md');
    const copiesBefore = await js("actions.filter(a=>a.action==='copy-path').length");
    await click('[data-wb-copy-location]');
    assert.equal(await js("actions.filter(a=>a.action==='copy-path').length"), copiesBefore);
    report.cases.push('An unmaterialized remote document keeps its filename and does not display or copy a path from another machine.');
    assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(error => { report.error = error.stack; }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    if (win) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
