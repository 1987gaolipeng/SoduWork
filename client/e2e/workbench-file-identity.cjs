'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), out = path.resolve(client, '../outputs/workbench-file-identity');
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-file-identity-')));
  const report = { ok: false, cases: [], metrics: [], errors: [], boundary: 'Isolated Electron, real workbench and CodeMirror, synthetic trusted journals/artifact index, preview I/O fixture. No live profile, external network, business process or model.' };
  let win;
  const js = source => win.webContents.executeJavaScript(source, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(source) {
    for (let i = 0; i < 80; i++) { if (await js(source)) return; await delay(25); }
    throw Error('Condition did not settle: ' + source);
  }
  async function shot(name) {
    await js('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
    fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  async function click(selector) {
    const point = await js(`(()=>{const node=document.querySelector(${JSON.stringify(selector)}),r=node.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(80);
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_r, cb) => cb({ cancel: true }));
    const base = require('node:url').pathToFileURL(client + path.sep).href;
    const fixture = path.join(out, 'fixture.html');
    const styles = ['theme/variables.css', 'components/panels/panels-chat.css', 'components/panels/code-workbench.css', 'components/panels/chat-deliveries.css', 'vendor/codemirror/codemirror.css'];
    fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><base href="' + base + '">' + styles.map(file => '<link rel="stylesheet" href="' + file + '">').join('') + '<style>body{margin:0;font:14px var(--font-ui);background:var(--bg-0)}#chat{position:relative;height:100vh}.nchat-stage{height:100%;display:flex}.nchat-main{flex:1;min-width:0;padding:24px}</style><div id="host"></div>');
    await win.loadFile(fixture);
    await js(`window.shows=[];window.writes=[];window.soduWorkAPI={conversationSession:{writeOutput:async(ref,target,text)=>{writes.push({ref,target,text});return{ok:true};}},workPreview:{onState:()=>()=>{},show:async payload=>{shows.push(payload);return{ok:true};},destroy:async()=>({}),hide:async()=>({})}};void 0;`);
    for (const file of ['vendor/markdown/marked.umd.js', 'vendor/markdown/purify.min.js', 'vendor/codemirror/codemirror.js', 'vendor/codemirror/mode/markdown/markdown.js', 'components/panels/chat-output-links.js', 'components/panels/library-delivery.js', 'components/panels/chat-dom-patch.js', 'components/panels/panels-chat-tools.js', 'components/panels/chat-workspace-info.js', 'components/panels/chat-workspace-split.js', 'components/panels/chat-workspace-controls.js', 'components/panels/panels-chat-workspace.js']) {
      await js(fs.readFileSync(path.join(client, file), 'utf8') + '\nvoid 0;');
    }
    await js(`window.fileText='# 项目交接说明\\n\\n'+Array.from({length:120},(_,i)=>'## 第 '+(i+1)+' 项\\n\\n这是一段用于检查工作台预览的内容。产物正式入库后，仍保留此处阅读位置。').join('\\n\\n');
      ChatOutputLinks.readPreview=async()=>({ok:true,text:fileText});
      window.openSession=id=>{ChatWorkbench.reset();document.querySelector('#host').innerHTML='<main id="chat" class="nchat"><div class="nchat-stage"><section class="nchat-main"><h1>产物预览</h1><p>同一文件保留一个标签，并延续编辑和阅读位置。</p></section></div></main>';ChatWorkbench.bind(document.querySelector('#chat'),()=>({ref:id,cwd:'C:/fixture'}));};
      window.snapshot=(name='report.md',at=1200)=>({messages:[{role:'user',at:1000,blocks:[{kind:'text',text:'Create '+name}]}],tools:[{name:'write',state:'done',after:0,args:{path:name}}],fileChanges:{cwd:'C:/fixture',capturedAt:at,files:[{path:name,action:'created',after:{exists:true,text:fileText,size:20000,mtimeMs:at}}]}});
      window.output=(name='report.md',at=1200)=>({artifactId:'published-'+name,relative:name,name,size:20000,at,primary:true,changedInTurn:true});
      window.render=(snap,files)=>ChatWorkbench.render(document.querySelector('#chat'),snap,files);
      window.tabIds=()=>Array.from(document.querySelectorAll('[role=tab]'),node=>node.dataset.wbTab);
      openSession('document-chat');render(snapshot(),[]);void 0;`);
    await until("!!document.querySelector('.ncw-markdown')");
    await js("document.querySelector('.ncw-markdown').scrollTop=520;void 0;");
    const documentBefore = await js("({tabs:tabIds(),scroll:document.querySelector('.ncw-markdown').scrollTop})");
    await js('render(snapshot(),[output()]);void 0;');
    const documentAfter = await js("({tabs:tabIds(),scroll:document.querySelector('.ncw-markdown').scrollTop})");
    assert.deepEqual(documentAfter, documentBefore); report.metrics.push({ documentBefore, documentAfter });
    report.cases.push('The local journal then indexed artifact keeps one tab and the real markdown scroll position.');
    await js("render(snapshot('second.md',1400),[output()]);render(snapshot('second.md',1400),[output(),output('second.md',1400)]);void 0;");
    await until("document.querySelectorAll('[role=tab]').length===2 && !!document.querySelector('.ncw-markdown')");
    await shot('two-files-two-tabs-wide'); report.cases.push('Two produced files across two turns create exactly two tabs.');
    win.setSize(760, 550); await delay(100); await shot('two-files-two-tabs-narrow');
    assert.equal(await js("document.querySelector('.ncw').getBoundingClientRect().right<=innerWidth+1"), true);
    report.cases.push('The two tabs and preview remain within the narrow window.');

    win.setSize(1280, 800);
    await js("openSession('editor-chat');render(snapshot(),[]);void 0;"); await until("!!document.querySelector('.ncw-markdown')");
    await click('[data-wb-code-view="code"]'); await until("!!document.querySelector('.CodeMirror')");
    await js("window.editor=document.querySelector('.CodeMirror').CodeMirror;editor.focus();editor.setCursor({line:20,ch:0});void 0;");
    win.webContents.focus();
    await win.webContents.insertText('未保存的修改 ');
    await until("editor.getValue().includes('未保存的修改')");
    await js("editor.setSelection({line:20,ch:2},{line:21,ch:4});editor.scrollTo(0,450);void 0;");
    const editorBefore = await js("({tabs:tabIds(),value:editor.getValue(),scroll:editor.getScrollInfo().top,selection:editor.listSelections(),history:editor.historySize(),save:document.querySelector('[data-wb-code-save]').disabled})");
    assert.match(editorBefore.value, /未保存的修改/); assert.equal(editorBefore.save, false);
    await js('render(snapshot(),[output()]);void 0;');
    await until("!!document.querySelector('.CodeMirror')");
    const editorAfter = await js("(()=>{const next=document.querySelector('.CodeMirror').CodeMirror;return{tabs:tabIds(),value:next.getValue(),scroll:next.getScrollInfo().top,selection:next.listSelections(),history:next.historySize(),save:document.querySelector('[data-wb-code-save]').disabled}})()");
    assert.deepEqual(editorAfter, editorBefore);
    report.metrics.push({ editorBefore: { ...editorBefore, value: '(omitted)' }, editorAfter: { ...editorAfter, value: '(omitted)' } });
    await shot('editor-draft-preserved'); report.cases.push('Real keyboard input, selected source view, undo history, selection, scroll and enabled save survive identity promotion.');
    await click('[data-wb-code-save]'); await until('writes.length===1');
    const saved = await js('writes[0]'); assert.equal(saved.ref, 'editor-chat'); assert.equal(saved.target, 'report.md'); assert.equal(saved.text, editorBefore.value);
    report.cases.push('Saving after promotion writes the preserved draft to the current chat workspace path.');

    await js("openSession('native-chat');render(snapshot('index.html'),[]);void 0;"); await until('shows.at(-1)?.kind==="file"');
    const nativeBefore = await js('shows.at(-1)');
    await js("render(snapshot('index.html'),[output('index.html')]);void 0;");
    await until('shows.at(-1)?.kind===undefined');
    const nativeAfter = await js('shows.at(-1)'); assert.equal(nativeAfter.tabId, nativeBefore.tabId); assert.equal(nativeAfter.reload, undefined);
    report.cases.push('Native preview receives only new bounds for the existing tab, without a second navigation or reload.');
    await js(`window.savedReads=0;window.SoduWorkAPI={taskStorageKey:()=> 'saved-owner',getDelivery:async id=>({delivery:{id,title:'已保存的花园',entryPath:'index.html',files:[{path:'index.html',contentType:'text/html',size:100}]}}),readDeliveryFile:async()=>{savedReads++;return new Blob(['<!doctype html><style>body{background:#e8f0e0}</style><h1>已保存的花园</h1>'],{type:'text/html'})}};
      ChatWorkbench.openSavedDelivery('saved-garden');void 0;`);
    await until("!!document.querySelector('.ncw .ldelivery-html-frame')");
    assert.equal(await js("document.querySelectorAll('dialog').length"), 0);
    const savedTabs = await js('tabIds()');
    await js("window.savedFrame=document.querySelector('.ldelivery-html-frame');ChatWorkbench.openSavedDelivery('saved-garden');void 0;");
    assert.deepEqual(await js('tabIds()'), savedTabs);
    assert.equal(await js("document.querySelector('.ldelivery-html-frame')===savedFrame&&savedReads===1"), true);
    await js("ChatWorkbench.openOutput('published-index.html');ChatWorkbench.openSavedDelivery('saved-garden');void 0;");
    assert.equal(await js("document.querySelector('.ldelivery-html-frame')===savedFrame&&savedReads===1"), true);
    await shot('saved-version-in-workbench');
    report.cases.push('Saved versions use the right pane, keep their iframe across repeat clicks and tab switches, and never create a modal.');
    await click('.ncw-tabwrap:has([data-wb-tab][aria-selected="true"]) [data-wb-tab-close]');
    assert.equal(await js("document.querySelectorAll('.ldelivery-embedded').length"), 0);
    await js(`window.releaseSaved=null;SoduWorkAPI.getDelivery=()=>new Promise(resolve=>releaseSaved=resolve);ChatWorkbench.openSavedDelivery('slow-saved');openSession('replacement-chat');releaseSaved({delivery:{files:[{path:'index.html',contentType:'text/html'}]}});void 0;`);
    await delay(60);
    assert.equal(await js("document.querySelectorAll('.ldelivery-embedded').length"), 0);
    assert.equal(await js('savedReads'), 1);
    report.cases.push('Closing the saved tab disposes it; switching conversations discards a late saved-version response before reading private bytes.');
    assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(error => { report.error = error.stack; }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    if (win) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
