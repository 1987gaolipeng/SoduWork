'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), out = path.resolve(client, '../outputs/workbench-session-races-20261020');
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-preview-races-')));
  const report = { ok: false, cases: [], errors: [], boundary: 'Hidden isolated Electron renderer with production workbench, CodeMirror and real DOM. Preview I/O, native state delivery and animation timing are controlled fixtures. No business data, accounts, paid models or external network.' };
  let win;
  const js = source => win.webContents.executeJavaScript(source, true);
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) report.errors.push(message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_r, cb) => cb({ cancel: true }));
    const base = require('node:url').pathToFileURL(client + path.sep).href, fixture = path.join(out, 'fixture.html');
    const styles = ['theme/variables.css', 'components/panels/panels-chat.css', 'components/panels/code-workbench.css', 'vendor/codemirror/codemirror.css'];
    fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><base href="' + base + '">' + styles.map(file => '<link rel="stylesheet" href="' + file + '">').join('') + '<style>body{margin:0;font:14px var(--font-ui);background:var(--bg-0)}#chat{height:100vh}.nchat-stage{height:100%;display:flex}.nchat-main{flex:1;min-width:0;padding:24px}</style><div id="host"></div>');
    await win.loadFile(fixture);
    await js(`window.previewStates=[];window.shows=[];window.reads=[];window.ownerScope='account-a';window.ref='session-a';window.frames=new Map();window.frameSequence=0;window.nativeFrame=requestAnimationFrame.bind(window);
      window.requestAnimationFrame=fn=>{frames.set(++frameSequence,fn);return frameSequence;};window.cancelAnimationFrame=id=>frames.delete(id);
      window.SoduWorkAPI={taskStorageKey:()=>ownerScope};window.soduWorkAPI={conversationSession:{},workPreview:{onState:fn=>{previewStates.push(fn);return()=>{};},show:async payload=>{shows.push(payload);return{ok:true};},destroy:async()=>({}),hide:async()=>({})}};
      window.flushFrames=async()=>{while(frames.size){const batch=[...frames.values()];frames.clear();for(const fn of batch)await fn();}};void 0;`);
    for (const file of ['vendor/codemirror/codemirror.js', 'components/panels/chat-output-links.js', 'components/panels/chat-dom-patch.js', 'components/panels/panels-chat-tools.js', 'components/panels/chat-workspace-info.js', 'components/panels/chat-workspace-split.js', 'components/panels/chat-workspace-controls.js', 'components/panels/panels-chat-workspace.js']) {
      await js(fs.readFileSync(path.join(client, file), 'utf8') + '\nvoid 0;');
    }
    await js(`window.openSession=id=>{ChatWorkbench.reset();ref=id;document.querySelector('#host').innerHTML='<main id="chat" class="nchat"><div class="nchat-stage"><section class="nchat-main"><h1>'+id+'</h1></section></div></main>';ChatWorkbench.bind(document.querySelector('#chat'),()=>({ref}));};
      ChatOutputLinks.materializeTask=file=>new Promise(resolve=>reads.push({file,resolve}));
      window.openTask=()=>{const file={artifactId:'remote',taskId:'task',attachmentId:'attachment',name:'报告.html',kind:'website'};ChatWorkbench.render(document.querySelector('#chat'),{messages:[]},[file]);ChatWorkbench.openOutput('remote');};openSession('session-a');void 0;`);
    await js(`ChatWorkbench.openPath('旧稿.js',{readSnapshot:{id:'old',text:'PRIVATE OLD CONTENT'}});window.oldFrames=[...frames.values()];openSession('session-b');ChatWorkbench.openPath('新稿.js',{readSnapshot:{id:'new',text:'CURRENT SESSION CONTENT'}});flushFrames();`);
    await js('Promise.all(oldFrames.map(fn=>fn())).then(()=>undefined)');
    assert.equal(await js("document.querySelector('.CodeMirror').CodeMirror.getValue()"), 'CURRENT SESSION CONTENT');
    assert.equal(await js("document.querySelectorAll('.CodeMirror').length"), 1);
    report.cases.push('Delayed editor mounting from the old session cannot inject its private text into the new session.');

    await js("openSession('session-a');ChatWorkbench.openLink('https://old.example.test');flushFrames();");
    const oldId = await js('shows.at(-1).tabId');
    await js("openSession('session-b');ChatWorkbench.openLink('https://new.example.test');flushFrames();");
    await js('previewStates.at(-1)(' + JSON.stringify({ tabId: oldId, title: 'PRIVATE OLD TITLE', url: 'https://old.example.test/private' }) + ');ChatWorkbench.toggle();ChatWorkbench.toggle();void 0;');
    assert.doesNotMatch(await js("document.querySelector('.ncw-tabs').textContent"), /PRIVATE OLD TITLE/);
    assert.match(await js("document.querySelector('[data-wb-address]').value"), /new.example.test/);
    report.cases.push('Queued native title/URL state cannot overwrite the next conversation tab.');

    await js("openSession('session-a');openTask();ChatWorkbench.openLink('https://chosen.example.test');document.querySelector('[data-wb-close]').click();reads.at(-1).resolve({artifactId:'ready',name:'报告.html',path:'C:/fixture/report.html'});void 0;");
    await js('flushFrames();');
    assert.equal(await js('ChatWorkbench.state().open'), false);
    report.cases.push('An awaited remote file respects manual preview closure.');

    await js("openSession('session-a');openTask();window.oldRead=reads.at(-1);openSession('session-b');openTask();window.newRead=reads.at(-1);oldRead.resolve({artifactId:'old',name:'old.html',path:'C:/old/report.html'});void 0;");
    await js('flushFrames();');
    assert.equal(await js('ChatWorkbench.state().has'), false);
    assert.equal(await js('oldRead===newRead'), false);
    await js("newRead.resolve({artifactId:'new',name:'new.html',path:'C:/new/report.html'});void 0;");
    await js('flushFrames();');
    assert.match(await js("document.querySelector('.ncw-tabs').textContent"), /new.html/);
    report.cases.push('A pending attachment does not lock the next session; its old response remains isolated and the current response opens.');

    await js("ownerScope='account-b';dispatchEvent(new Event('soduwork-data-scope-changed'));void 0;");
    assert.equal(await js('ChatWorkbench.state().has'), false);
    assert.equal(await js("document.querySelector('.ncw-body').textContent"), '');
    assert.equal(await js("document.querySelector('.ncw').getAttribute('aria-hidden')"), 'true');
    report.cases.push('Account changes invalidate all prior preview state.');

    await js(`window.copiedLocations=[];window.locationReads=[];
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>copiedLocations.push(value)}});
      soduWorkAPI.conversationSession.artifactAction=async(ref,id,action)=>action==='location'
        ? new Promise(resolve=>locationReads.push({ref,id,resolve})) : {ok:true,text:'# Local report'};
      window.openLocalReport=()=>{const file={artifactId:'report',name:'report.md',relative:'report.md',kind:'document'};
        ChatWorkbench.render(document.querySelector('#chat'),{messages:[]},[file]);ChatWorkbench.openOutput('report');};
      openSession('location-session-a');openLocalReport();void 0;`);
    await js('flushFrames();');
    await js(`document.querySelector('[data-wb-copy-location]').click();
      locationReads.at(-1).resolve({ok:true,path:'C:/fixture/report.md'});void 0;`);
    assert.deepEqual(await js('copiedLocations'), ['C:/fixture/report.md']);
    await js(`document.querySelector('[data-wb-copy-location]').click();window.oldLocation=locationReads.at(-1);
      openSession('location-session-b');ChatWorkbench.openLink('https://current.example.test');
      oldLocation.resolve({ok:true,path:'C:/fixture/old-report.md'});void 0;`);
    assert.deepEqual(await js('copiedLocations'), ['C:/fixture/report.md']);
    await js(`openSession('location-session-b');openLocalReport();void 0;`);
    await js('flushFrames();');
    await js(`document.querySelector('[data-wb-copy-location]').click();ownerScope='account-c';
      locationReads.at(-1).resolve({ok:true,path:'C:/fixture/private-report.md'});void 0;`);
    assert.deepEqual(await js('copiedLocations'), ['C:/fixture/report.md']);
    report.cases.push('Public artifacts copy resolved absolute paths; delayed location responses from another conversation or account cannot overwrite the clipboard.');

    await js("openSession('验收完成：当前会话');ChatWorkbench.openPath('当前会话.js'," + JSON.stringify({ readSnapshot: { id: 'current', text: '// 此预览仅属于当前会话。\nconst isolation = true;' } }) + ");flushFrames();");
    await js('document.fonts.ready.then(()=>new Promise(resolve=>nativeFrame(()=>nativeFrame(resolve))))');
    await js("new Promise((resolve,reject)=>{const deadline=performance.now()+2000;const check=()=>Number(getComputedStyle(document.querySelector('.ncw')).opacity)>.99?resolve():performance.now()>deadline?reject(Error('Preview transition did not settle')):nativeFrame(check);check();})");
    fs.writeFileSync(path.join(out, 'current-session.png'), (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(error => { report.error = error.stack; }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    if (win) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
