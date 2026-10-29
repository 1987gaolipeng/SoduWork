'use strict';
// Use real preview components and scrolling with fixture files, without business-directory or model access.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..');
  const out = path.resolve(process.env.SODUWORK_SCROLL_EVIDENCE || path.join(client, '../outputs/workbench-document-scroll-20261016'));
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-document-scroll-')));
  let win;
  const report = { ok: false, cases: [], metrics: [], errors: [] };
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const js = source => win.webContents.executeJavaScript(source, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(source) {
    for (let i = 0; i < 100; i++) { if (await js(source)) return; await delay(25); }
    throw Error('等待失败：' + source);
  }
  async function shot(name) {
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  async function click(selector) {
    const point = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('按钮不可用');const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    const zoom = win.webContents.getZoomFactor();
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(point.x * zoom), y: Math.round(point.y * zoom), button: 'left', clickCount: 1 });
    await delay(80);
  }
  async function bottom(name, selector, lastSelector, viewportSelector = selector) {
    await js('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
    await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollTop=el.scrollHeight;})()`);
    await delay(50);
    const metric = await js(`(()=>{const scroller=document.querySelector(${JSON.stringify(selector)}),body=document.querySelector('.ncw-body'),last=document.querySelector(${JSON.stringify(lastSelector)});const b=body.getBoundingClientRect(),s=document.querySelector(${JSON.stringify(viewportSelector)}).getBoundingClientRect();let l=last.getBoundingClientRect();if(last.matches('pre')&&last.firstChild?.nodeType===Node.TEXT_NODE){const n=last.firstChild,r=document.createRange();r.setStart(n,Math.max(0,n.length-30));r.setEnd(n,n.length);l=r.getBoundingClientRect();}return{bodyBottom:b.bottom,scrollBottom:s.bottom,lastBottom:l.bottom,lastTop:l.top,scrollTop:scroller.scrollTop,maxScroll:scroller.scrollHeight-scroller.clientHeight,windowHeight:innerHeight}})()`);
    report.metrics.push({ name, ...metric });
    await shot(name);
    assert.ok(Math.abs(metric.scrollTop - metric.maxScroll) <= 1, name + '：已到滚动底部');
    assert.ok(metric.scrollBottom <= metric.bodyBottom + 1, name + '：滚动区域越过承载区：' + JSON.stringify(metric));
    assert.ok(metric.lastBottom <= Math.min(metric.bodyBottom, metric.windowHeight) + 1 && metric.lastTop >= 0,
      name + '：最后一行仍被裁切：' + JSON.stringify(metric));
    report.cases.push(name);
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) report.errors.push(message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_r, cb) => cb({ cancel: true }));
    const fixture = path.join(out, 'fixture.html'), base = require('node:url').pathToFileURL(client + path.sep).href;
    const styles = ['theme/variables.css', 'components/panels/panels-chat.css', 'components/panels/code-workbench.css', 'vendor/codemirror/codemirror.css'];
    fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><base href="' + base + '">' + styles.map(file => '<link rel="stylesheet" href="' + file + '">').join('') + '<style>body{margin:0;font:14px var(--font-ui);background:var(--bg-0)}#chat{position:relative;height:100vh}.nchat-stage{height:100%;display:flex}.nchat-main{flex:1;min-width:0}</style><main id="chat" class="nchat"><div class="nchat-stage"><section class="nchat-main"></section></div></main>');
    await win.loadFile(fixture);
    await js(`window.fileText='# 项目交接快照\\n\\n'+Array.from({length:55},(_,i)=>'- 第 '+(i+1)+' 项：中文长行验证。检查文件预览滚动、工具栏和末尾内容均可见。').join('\\n\\n')+'\\n\\n**文档结束标记：最后一行完整可见。**';window.truncated=false;window.actions=[];
      window.soduWorkAPI={conversationSession:{artifactAction:async(ref,id,action)=>{actions.push({id,action});return{ok:true,text:fileText,tooBig:truncated};}}};void 0;`);
    for (const file of ['vendor/markdown/marked.umd.js', 'vendor/markdown/purify.min.js', 'vendor/markdown/diff.min.js', 'vendor/markdown/diff2html.min.js', 'vendor/codemirror/codemirror.js', 'vendor/codemirror/mode/markdown/markdown.js', 'components/panels/chat-output-links.js', 'components/panels/chat-dom-patch.js', 'components/panels/panels-chat-tools.js', 'components/panels/chat-workspace-info.js', 'components/panels/chat-workspace-split.js', 'components/panels/chat-workspace-controls.js', 'components/panels/panels-chat-workspace.js']) await js(read(file) + '\nvoid 0;');
    for (const file of ['vendor/markdown/d2h-theme.js', 'components/panels/chat-markdown.js']) await js(read(file) + '\nvoid 0;');
    await js(`ChatMarkdown.create({})._ensureHlCss();window.file={artifactId:'markdown',name:'项目交接快照.md',path:'C:/isolated/项目交接快照.md',kind:'document',primary:true,at:1};
      window.openDocument=(changed=false)=>{ChatWorkbench.reset();ChatWorkbench.bind(document.querySelector('#chat'),()=>({ref:'scroll-fixture'}));const value={...file,at:Date.now()};if(changed)value.change={action:'modified',before:{text:'旧内容'},after:{text:fileText}};ChatWorkbench.render(document.querySelector('#chat'),{messages:[]},[value]);ChatWorkbench.openOutput('markdown');};openDocument(true);void 0;`);
    await until('!!document.querySelector(".ncw-markdown p:last-child")');
    await bottom('markdown-with-modebar-wide', '.ncw-markdown', '.ncw-markdown > :last-child');
    win.setSize(760, 550); await delay(100);
    win.webContents.setZoomFactor(1.25); await delay(100);
    await bottom('markdown-with-modebar-narrow-zoom', '.ncw-markdown', '.ncw-markdown > :last-child');
    await js('truncated=true;openDocument(true);void 0;'); await until('!!document.querySelector(".ncw-truncated")');
    await bottom('markdown-with-modebar-and-truncation', '.ncw-markdown', '.ncw-markdown > :last-child');
    await click('[data-wb-code-view="code"]'); await until('!!document.querySelector(".CodeMirror")');
    await js(`(()=>{const editor=document.querySelector('.CodeMirror').CodeMirror;editor.scrollIntoView({line:editor.lastLine(),ch:0});editor.scrollTo(null,editor.getScrollInfo().height);})()`);
    await delay(100);
    // Measure clipping at the editor frame; CodeMirror's internal scroll layer uses negative margins.
    await bottom('source-with-modebar-and-truncation', '.CodeMirror-scroll', '.CodeMirror-code > :last-child', '.CodeMirror');
    await click('[data-wb-code-view="diff"]'); await until('!!document.querySelector(".ncw-diff-body tbody tr:last-child")');
    await bottom('diff-with-modebar-and-truncation', '.ncw-diff-body', '.ncw-diff-body tbody tr:last-child');
    win.webContents.setZoomFactor(1); win.setSize(1280, 800); await delay(100);
    await js('truncated=false;openDocument(false);void 0;'); await until('!!document.querySelector(".ncw-markdown")');
    await bottom('markdown-without-modebar', '.ncw-markdown', '.ncw-markdown > :last-child');
    await js('window.marked=null;openDocument(true);void 0;'); await until('!!document.querySelector(".ncw-code")');
    const raw = await js(`document.querySelector('.ncw-code').textContent`);
    assert.ok(raw.endsWith('**文档结束标记：最后一行完整可见。**'));
    // Measure the final plain-text line with a Range because the fallback has no child elements.
    await js(`(()=>{const e=document.querySelector('.ncw-code'),n=e.firstChild,r=document.createRange();r.setStart(n,n.length-30);r.setEnd(n,n.length);window.tailRange=r;})()`);
    await js(`document.querySelector('.ncw-code').scrollTop=document.querySelector('.ncw-code').scrollHeight;void 0;`);
    assert.ok(await js(`tailRange.getBoundingClientRect().bottom<=document.querySelector('.ncw-body').getBoundingClientRect().bottom+1`));
    await shot('markdown-plaintext-fallback'); report.cases.push('markdown-plaintext-fallback');
    assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(async error => { report.error = error.stack; if(win&&!win.isDestroyed())await shot('failure').catch(()=>{}); }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    if (win) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
