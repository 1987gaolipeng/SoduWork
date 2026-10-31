'use strict';
// Production library panel/viewer in an isolated Electron renderer. Synthetic
// files exercise UI contracts; no account, model, business data or OS launch.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 120000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-library-pane-'));
  const output = path.resolve(client, '../outputs/library-preview-pane');
  fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  const report = { ok: false, boundary: 'Production library renderer/modules and real Electron layout/iframe, isolated synthetic API responses and files. No live account, server or actual system application launch.', cases: [], screenshots: [], errors: [] };
  const textSource = '首行：保存原始内容\r\nconst value = "<b>literal</b>";\n';
  const htmlSource = '<!doctype html><html><head><meta charset="utf-8"><style>body{background:rgb(24,34,52);color:white;margin:24px}h1{font:30px sans-serif}</style></head><body><h1>Website preview</h1><button id="action">Start</button><script>window.fixtureLoaded=true;document.querySelector("#action").onclick=()=>document.querySelector("#action").textContent="Clicked";try{parent.document.body.dataset.previewLeak="yes"}catch(e){window.parentBlocked=true}</script></body></html>\n';
  const markdownSource = '# 月度摘要\n\n- 已完成资料预览\n- 保留原始文件\n\n<script>window.markdownLeak=true</script>\n';
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKk0AAAAASUVORK5CYII=';
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('UTF16 中文\r\n', 'utf16le')]).toString('base64');
  const gb18030 = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]).toString('base64');
  const wav = Buffer.alloc(8044, 128);
  wav.write('RIFF', 0); wav.writeUInt32LE(8036, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(8000, 40);
  const pdfStream = 'BT /F1 20 Tf 48 720 Td (Library PDF preview) Tj ET';
  const pdfObjects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length ' + pdfStream.length + ' >>\nstream\n' + pdfStream + '\nendstream'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  pdfObjects.forEach((source, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += (index + 1) + ' 0 obj\n' + source + '\nendobj\n'; });
  const xref = Buffer.byteLength(pdf); pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  const definitions = [
    ['text', '说明.txt', 'text/plain', textSource], ['html', '网页.html', 'text/html', htmlSource],
    ['markdown', '月度摘要.md', 'text/markdown', markdownSource], ['image', '示意图.png', 'image/png', pixel, true],
    ['office', '业务说明.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Office original bytes'],
    ['unknown', '原始数据.bin', 'application/octet-stream', 'binary'], ['large', '大文件.txt', 'text/plain', 'large'],
    ['slow', '旧请求.txt', 'text/plain', 'Old private data'], ['retry', '可重试.txt', 'text/plain', 'Recovered content'],
    ['binaryText', '不应当作文本.txt', 'text/plain', '\u0000\u0001\u0002'],
    ['bundle', '网站成果.zip', 'application/zip', 'bundle'],
    ['singleDelivery', '单文件成果.zip', 'application/zip', 'single member'],
    ['rawTextDelivery', '会话原文.txt', 'text/plain', 'Packaged notes 原始文件'],
    ['rawHtmlDelivery', '会话网页.html', 'text/html', htmlSource],
    ['failedDelivery', '暂时不可读的原文.txt', 'text/plain', 'Packaged notes 原始文件'],
    ['audio', '录音.wav', 'audio/wav', wav.toString('base64'), true], ['pdf', '说明.pdf', 'application/pdf', Buffer.from(pdf).toString('base64'), true],
    ['gb', '旧编码.txt', 'text/plain', '正确解码：中文旧文件'], ['truncated', '节选.txt', 'text/plain', 'File excerpt'],
    ['textMislabel', '原文.txt', 'text/html', textSource], ['markdownMislabel', '渲染.md', 'text/html', markdownSource],
    ['code', 'example.js', 'text/html', 'const text = "<h1>Keep literal</h1>";\n'],
    ['unreadable-html', '编码异常.html', 'text/html', '', false, 'nfs'],
    ['unreadable-markdown', '编码异常.md', 'text/markdown', '', false, 'minio'],
  ];
  for (const backend of ['nfs', 'minio']) for (const kind of ['html', 'markdown', 'text', 'office']) {
    const original = definitions.find(row => row[0] === kind);
    definitions.push([backend + '-' + kind, original[1], original[2], original[3], original[4], backend]);
  }
  const items = definitions.map(([id, filename, contentType, content, _encoded, backend = 'local']) => ({ id, title: filename.replace(/\.[^.]+$/, ''), filename, contentType, size: id === 'large' ? 9 * 1024 * 1024 : content.length, kind: id === 'image' ? 'image' : 'document', backend, storage: backend, updatedAt: '2026-10-13T08:00:00Z', extra: ['bundle', 'singleDelivery', 'rawTextDelivery', 'rawHtmlDelivery', 'failedDelivery'].includes(id) ? { soduWorkDelivery: { schemaVersion: 1, source: 'local', sessionId: 'fixture-session' } } : {}, sourceType: id === 'bundle' ? 'conversation' : 'upload', conversationTitle: id === 'bundle' ? '网站演示' : '', sessionId: id === 'bundle' ? 'fixture-session' : '' }));
  let win;
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code, message = code) { for (let i = 0; i < 180; i++) { if (await js(code)) return; await delay(35); } throw Error('Timed out: ' + message); }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),target=e&&getComputedStyle(e).display==='contents'?e.querySelector('.library-card-name')||e.firstElementChild:e;if(!e||e.disabled||!target?.checkVisibility())throw Error('Unavailable '+${JSON.stringify(selector)});target.scrollIntoView({block:'nearest'});const r=target.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
    await delay(65);
    if (selector === '[data-preview-close]') await until('!document.querySelector(".library-preview-pane")', 'Animated dismissal releases the modal');
  }
  async function shot(name) {
    // A hidden Electron window can retain the previous compositor frame until
    // the first capture wakes it. Discard that frame before recording evidence.
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await delay(150);
    const file = path.join(output, name + '.png'); fs.writeFileSync(file, (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); report.screenshots.push(file);
  }
  async function open(id, settled = true) {
    await js(`void fixturePreview.open(fixtureItems.find(i=>i.id===${JSON.stringify(id)}))`);
    await until(`fixturePreview.selectedId()===${JSON.stringify(id)}&&!!document.querySelector('[data-preview-body]')`);
    if (settled) await js(`Promise.all(document.querySelector('.library-preview-pane').getAnimations()
      .filter(a=>a.animationName==='library-preview-enter').map(a=>a.finished.catch(()=>{})))`);
  }
  async function selectFile(path) {
    await click('[data-archive-root]');
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) await click('[data-archive-folder=' + JSON.stringify(parts.slice(0, index).join('/')) + ']');
    await click('[data-archive-file=' + JSON.stringify(path) + ']');
  }
  async function assertNoTabs(label) {
    assert.equal(await js('document.querySelectorAll(".library-preview-pane [role=tablist],.library-preview-pane [data-preview-tab]").length'), 0, label + ' must not retain preview/source tabs');
  }
  async function assertLocalActions(visible, label) {
    const actions = await js(`Object.fromEntries(['download','system','reveal','download-archive'].map(action=>[action,Boolean(document.querySelector('[data-preview-'+action+']')?.checkVisibility())]))`);
    assert.deepEqual(actions, { download: true, system: visible, reveal: visible, 'download-archive': false }, label);
  }
  async function assertIconToolbar() {
    const state = await js(`(()=>{const pane=document.querySelector('.library-preview-pane'),head=pane.querySelector('.library-preview-head');return{titles:pane.querySelectorAll('.library-preview-heading,[data-preview-title],.library-preview-file-mark,.library-preview-provenance,[data-preview-source]').length,controls:['download','system','reveal','close'].map(action=>{const button=pane.querySelector('[data-preview-'+action+']'),rect=button.getBoundingClientRect();return{action,inside:head.contains(button),text:button.textContent.trim(),title:button.title,aria:button.getAttribute('aria-label'),icon:!!button.querySelector('svg'),top:rect.top,right:rect.right,visible:button.checkVisibility()}})}})()`);
    assert.equal(state.titles, 0, 'Preview must omit the entire filename/conversation title block');
    for (const control of state.controls) {
      assert.equal(control.inside, true, control.action + ' belongs in the single toolbar');
      assert.equal(control.text, '', control.action + ' must be icon-only');
      assert.ok(control.title && control.aria && control.icon && control.visible, control.action + ' keeps a tooltip, accessible label and visible icon');
      assert.ok(Math.abs(control.top - state.controls[0].top) <= 1, control.action + ' must stay on the same row');
    }
    assert.ok(state.controls.at(-1).right > state.controls.at(-2).right, 'Close follows the file actions');
    await assertNoTabs('Icon-only preview');
  }
  async function key(code) { for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: code }); await delay(45); }
  const bodyText = () => js('document.querySelector("[data-preview-body]").textContent');
  async function findWebsiteFrame() {
    for (let i = 0; i < 180; i++) {
      for (const frame of win.webContents.mainFrame.frames) if (!frame.isDestroyed() && await frame.executeJavaScript('Boolean(window.fixtureLoaded)').catch(() => false)) return frame;
      await delay(35);
    }
    throw Error('HTML did not execute within isolated preview frame');
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1440, height: 900,
      titleBarStyle: 'hidden', titleBarOverlay: {color:'#ffffff',symbolColor:'#52525b',height:34},
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }));
    await win.loadFile(path.join(__dirname, 'fixtures/library.html'));
    // Match the shipping cascade, including desk-window and workspace headings
    // that load after component CSS. Appending preview CSS last masks conflicts.
    const stylesheets = [...read('desk.html').matchAll(/<link\s+rel=["']stylesheet["']\s+href=["']([^"']+)["']/g)].map(match => require('node:url').pathToFileURL(path.join(client, match[1])).href);
    await js(`(async()=>{document.querySelectorAll('link[rel=stylesheet]').forEach(link=>link.remove());await Promise.all(${JSON.stringify(stylesheets)}.map(href=>new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.onload=resolve;link.onerror=()=>reject(Error('Stylesheet failed: '+href));document.head.append(link)})));})()`);
    await js(`window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));window.fixtureItems=${JSON.stringify(items)};window.fixtureDefinitions=${JSON.stringify(definitions)};window.fixtureScope='first-user';window.fixtureCalls=[];window.fixtureActions=[];window.fixtureRelease=null;window.fixtureRetryFailed=true;window.notices=[];window.petSay=m=>notices.push(m);window.WorkspaceHost={open:(...args)=>fixtureActions.push({action:'source',args})};window.SoduWorkAPI={
      taskStorageKey:()=>fixtureScope,
      listLibrary:async()=>({items:window.fixtureListing||fixtureItems.slice(0,7),folders:[],breadcrumbs:[],trashCount:0}),
      getLibraryStorageStatus:async()=>({local:{available:true,configured:true,connected:true},minio:{available:false,configured:false,connected:false}}),
      readLibraryContent:async id=>{fixtureCalls.push({method:'content',id});if(id==='slow')return new Promise(resolve=>{fixtureRelease=()=>resolve({content:'Old private data'});});if(id==='retry'&&fixtureRetryFailed)throw Error('Temporary isolated failure');if(id.startsWith('unreadable-'))throw Error('无法识别文件的文本编码，请下载原文件');const row=fixtureDefinitions.find(r=>r[0]===id);return{content:row[3],preview:{format:'text',encoding:id==='gb'?'gb18030':'utf-8',truncated:id==='truncated',notice:id==='truncated'?'仅显示部分内容，完整内容请下载原文件。':''}};},
      readLibraryBinary:async id=>{fixtureCalls.push({method:'binary',id});if(id==='retry'&&fixtureRetryFailed)throw Error('Temporary isolated failure');const row=fixtureDefinitions.find(r=>r[0]===id);if(!row)throw Error('Unexpected id '+id);return{blob:new Blob([row[4]?Uint8Array.from(atob(row[3]),c=>c.charCodeAt(0)):row[3]],{type:row[2]}),filename:row[1]};},
      downloadLibraryItem:async(id,name,file)=>{fixtureActions.push({action:'download',id,name,file});return{ok:true};},
      openLibraryExternally:async(id,file)=>{fixtureActions.push({action:'system',id,file});return{ok:true};},
      revealLibraryItem:async(id,file)=>{fixtureActions.push({action:'reveal',id,file});return{ok:true};},
      getDelivery:async id=>{fixtureCalls.push({method:'manifest',id});if(id==='rawHtmlDelivery'&&window.fixtureHtmlManifestFailure)throw Error('Temporary HTML manifest failure');if(id==='failedDelivery'&&window.fixtureDeliveryFailure!==false)throw Error('Temporary manifest failure');if(['rawTextDelivery','rawHtmlDelivery','failedDelivery'].includes(id)){const html=id==='rawHtmlDelivery';return{delivery:{id,kind:'file',filename:html?'会话网页.html':'会话原文.txt',files:[{path:html?'site/index.html':'notes.txt',contentType:html?'text/html':'text/plain',size:500}]}};}return{delivery:{id,title:'网站演示',filename:'网站成果.zip',kind:'bundle',entryPath:id==='singleDelivery'?'notes.txt':'site/index.html',files:id==='singleDelivery'?[{path:'notes.txt',contentType:'text/plain',size:25}]:[{path:'site/index.html',contentType:'text/html',size:300},{path:'site/site.css',contentType:'text/css',size:60},{path:'notes.txt',contentType:'text/plain',size:25},{path:'utf16.txt',contentType:'text/plain',size:24},{path:'gb18030.txt',contentType:'text/plain',size:4}],externalDependencies:[]}};},
      readDeliveryFile:async(id,path)=>{fixtureCalls.push({method:'delivery',id,path});if(id==='rawHtmlDelivery')return new Blob([${JSON.stringify(htmlSource)}],{type:'text/html'});const files={'site/index.html':['<!doctype html><html><head><link rel="stylesheet" href="site.css"></head><body><h1>Packaged website</h1><script>window.fixtureLoaded=true</script></body></html>','text/html'],'site/site.css':['body{background:rgb(11,71,53);color:white}','text/css'],'notes.txt':['Packaged notes 原始文件','text/plain'],'utf16.txt':[${JSON.stringify(utf16)},'text/plain',true],'gb18030.txt':[${JSON.stringify(gb18030)},'text/plain',true]};if(!files[path])throw Error('Unexpected path '+path);const row=files[path];return new Blob([row[2]?Uint8Array.from(atob(row[0]),c=>c.charCodeAt(0)):row[0]],{type:row[1]});}
    };window.fixtureUrls=[];window.fixtureRevoked=[];window.fixtureCreateURL=URL.createObjectURL.bind(URL);window.fixtureRevokeURL=URL.revokeObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=fixtureCreateURL(blob);fixtureUrls.push(url);return url;};URL.revokeObjectURL=url=>{fixtureRevoked.push(url);return fixtureRevokeURL(url);};void 0;`);
    // Real dependencies, not duplicate implementations of the preview logic.
    for (const file of ['vendor/markdown/marked.umd.js', 'vendor/markdown/purify.min.js', 'components/panels/library-delivery.js']) await js(read(file) + '\nvoid 0;');
    assert.ok(fs.existsSync(path.join(client, 'components/panels/library-preview-pane.js')), 'The production preview popup module must exist');
    await js(read('components/panels/library-preview-html.js') + '\nvoid 0;');
    await js(read('components/panels/library-preview-archive.js') + '\nvoid 0;');
    await js(read('components/panels/library-preview-pane.js') + '\nvoid 0;');
    for (const file of ['components/panels/library-file-icons.js', 'components/panels/panels-library-dialogs.js', 'components/panels/panels-library.js']) await js(read(file) + '\nvoid 0;');
    await js('openLibraryPanel();void 0;'); await until('document.querySelectorAll(".library-file-card").length===7');
    const originalListLayout = await js('(()=>{const e=document.querySelector(".library-page");return{width:e.getBoundingClientRect().width,overflow:e.scrollWidth-e.clientWidth}})()');
    await js('window.fixturePreview=SoduWorkLibraryPreview.create({root:document.querySelector("#libraryPanel"),openSource:sessionId=>fixtureActions.push({action:"source",sessionId})});void 0;');

    await js('window.soduWorkAPI={...(window.soduWorkAPI||{}),getWindowTitlebar:async()=>({mode:"overlay"}),setWindowTitlebarTheme:async()=>({ok:true})};void 0;');
    await js(read('components/workspace/window-menu.js')+'\nvoid 0;');
    await until('document.documentElement.dataset.windowTitlebar==="overlay"');
    await open('markdown', false);
    const motion = await js(`(()=>{const pane=document.querySelector('.library-preview-pane');
      const animation=pane.getAnimations().find(a=>a.animationName==='library-preview-enter');
      if(!animation)throw Error('Missing preview entry animation');
      animation.pause(); window.fixtureEntryAnimation=animation;
      const sample=time=>{animation.currentTime=time;const s=getComputedStyle(pane),r=pane.getBoundingClientRect();return{opacity:Number(s.opacity),width:r.width,top:r.top}};
      const duration=animation.effect.getTiming().duration;
      const first=sample(0),middle=sample(duration/2),last=sample(duration);
      const bar=document.querySelector('.window-menu').getBoundingClientRect();
      const backdrop=getComputedStyle(pane,'::backdrop');
      const close=pane.querySelector('[data-preview-close]');
      animation.currentTime=duration/2;
      return{duration,first,middle,last,titlebarBottom:bar.bottom,backdropTop:parseFloat(backdrop.top),
        closeInitiallyFocused:document.activeElement===close,closeBorder:getComputedStyle(close).borderTopWidth};})()`);
    assert.ok(motion.last.top >= motion.titlebarBottom+16, 'Preview must leave a clear gap below the native titlebar: '+JSON.stringify(motion));
    assert.ok(motion.backdropTop >= motion.titlebarBottom, 'Backdrop must not dim only the DOM half of the native titlebar');
    assert.ok(motion.duration>=240&&motion.duration<=360&&motion.first.opacity===0&&motion.last.opacity===1&&
      motion.first.width<motion.last.width-8&&motion.middle.opacity>0&&motion.middle.opacity<1,
      'Entry must have visible intermediate scale and opacity, not only an animation name: '+JSON.stringify(motion));
    assert.equal(motion.closeInitiallyFocused,false,'Opening by mouse should not put a focus box around the close icon');
    assert.equal(motion.closeBorder,'0px');
    report.openingMotion=motion; await shot('preview-entry-midpoint');
    await js('fixtureEntryAnimation.finish();fixturePreview.close();void 0;');
    report.cases.push('Native titlebar remains clear; preview and backdrop respect its safe area, with visible entry animation frames');

    await js('window.soduWorkAPI={...(window.soduWorkAPI||{}),getWindowTitlebar:async()=>({mode:"overlay"}),setWindowTitlebarTheme:async()=>({ok:true})};void 0;');
    await js(read('components/workspace/window-menu.js')+'\nvoid 0;');
    await until('document.documentElement.dataset.windowTitlebar==="overlay"');
    await open('markdown', false);
    const motion = await js(`(()=>{const pane=document.querySelector('.library-preview-pane');
      const animation=pane.getAnimations().find(a=>a.animationName==='library-preview-enter');
      if(!animation)throw Error('Missing preview entry animation');
      animation.pause(); window.fixtureEntryAnimation=animation;
      const sample=time=>{animation.currentTime=time;const s=getComputedStyle(pane),r=pane.getBoundingClientRect();return{opacity:Number(s.opacity),width:r.width,top:r.top}};
      const duration=animation.effect.getTiming().duration;
      const first=sample(0),middle=sample(duration/2),last=sample(duration);
      const bar=document.querySelector('.window-menu').getBoundingClientRect();
      const backdrop=getComputedStyle(pane,'::backdrop');
      const close=pane.querySelector('[data-preview-close]');
      animation.currentTime=duration/2;
      return{duration,first,middle,last,titlebarBottom:bar.bottom,backdropTop:parseFloat(backdrop.top),
        closeInitiallyFocused:document.activeElement===close,closeBorder:getComputedStyle(close).borderTopWidth};})()`);
    assert.ok(motion.last.top >= motion.titlebarBottom+16, 'Preview must leave a clear gap below the native titlebar: '+JSON.stringify(motion));
    assert.ok(motion.backdropTop >= motion.titlebarBottom, 'Backdrop must not dim only the DOM half of the native titlebar');
    assert.ok(motion.duration>=240&&motion.duration<=360&&motion.first.opacity===0&&motion.last.opacity===1&&
      motion.first.width<motion.last.width-8&&motion.middle.opacity>0&&motion.middle.opacity<1,
      'Entry must have visible intermediate scale and opacity, not only an animation name: '+JSON.stringify(motion));
    assert.equal(motion.closeInitiallyFocused,false,'Opening by mouse should not put a focus box around the close icon');
    assert.equal(motion.closeBorder,'0px');
    report.openingMotion=motion; await shot('preview-entry-midpoint');
    await js('fixtureEntryAnimation.finish();fixturePreview.close();void 0;');
    report.cases.push('Native titlebar remains clear; preview and backdrop respect its safe area, with visible entry animation frames');

    await open('text'); await until(`document.querySelector('[data-preview-body]').textContent.includes('首行')`);
    assert.equal(await js('document.querySelector("[data-preview-body] pre").textContent'), textSource, 'Text must preserve exact Unicode, tags and newlines');
    assert.equal(await js('document.querySelectorAll("[data-preview-body] b").length'), 0, 'Literal markup must not render as HTML');
    await assertNoTabs('Ordinary TXT');
    report.cases.push('Ordinary text renders original Unicode/newlines without interpreting tags');

    for (const backend of ['nfs', 'minio']) {
      for (const kind of ['html', 'markdown']) {
        const id = backend + '-' + kind;
        await open(id);
        if (kind === 'html') await findWebsiteFrame();
        else await until('document.querySelector("[data-preview-body] h1")?.textContent==="月度摘要"');
        await assertNoTabs('Remote ' + kind); await assertLocalActions(false, backend + ' documents only expose download');
        assert.equal(await js('document.querySelectorAll("[data-preview-body] pre").length'), 0, 'Rendered remote documents must not display source code');
        await click('[data-preview-download]');
        assert.deepEqual(await js('({action:fixtureActions.at(-1).action,id:fixtureActions.at(-1).id})'), { action: 'download', id });
      }
      await open(backend + '-text'); await until('document.querySelector("[data-preview-body] pre")?.textContent.includes("首行")');
      await assertNoTabs('Remote TXT'); await assertLocalActions(false, 'Remote TXT only exposes download');
    }
    await open('text'); await until('document.querySelector("[data-preview-body] pre")?.textContent.includes("首行")');
    await assertLocalActions(true, 'Returning to local files restores local actions');
    report.cases.push('NFS and MinIO HTML/Markdown render directly; remote TXT remains literal; remote files only expose download and local actions restore when switching back');

    for (const id of ['unreadable-html', 'unreadable-markdown']) {
      await open(id); await until('!document.querySelector("[data-preview-body]").hasAttribute("aria-busy")');
      await assertNoTabs('Undecodable document');
      assert.match(await bodyText(), /无法识别文件的文本编码/);
      assert.equal(await js('document.querySelectorAll("[data-preview-body] pre").length'), 0, 'Decode failures must not fabricate source text');
      await assertLocalActions(false, 'Unreadable remote documents retain download only');
      await click('[data-preview-download]');
      assert.deepEqual(await js('({action:fixtureActions.at(-1).action,id:fixtureActions.at(-1).id})'), { action: 'download', id });
    }
    report.cases.push('Undecodable HTML/Markdown explain the encoding failure, fabricate no text and retain original-file download');

    await open('textMislabel'); await until('!document.querySelector("[data-preview-body]").hasAttribute("aria-busy")');
    assert.equal(await js('document.querySelector("[data-preview-body] pre")?.textContent'), textSource, 'Known .txt extension must override misleading HTML MIME and keep original text');
    assert.equal(await js('document.querySelector("[data-preview-body] pre")?.checkVisibility()'), true, 'TXT must show its original text directly');
    assert.equal(await js('document.querySelectorAll("[data-preview-body] iframe").length'), 0, 'TXT markup must not enter the HTML renderer');
    await assertNoTabs('Mislabeled TXT');
    await open('markdownMislabel'); await until('!document.querySelector("[data-preview-body]").hasAttribute("aria-busy")');
    assert.equal(await js('document.querySelector("[data-preview-body] h1")?.textContent'), '月度摘要', 'Known .md extension must override misleading HTML MIME and render Markdown');
    await assertNoTabs('Mislabeled Markdown');
    await open('code'); await until('document.querySelector("[data-preview-body] pre")?.checkVisibility()');
    assert.equal(await js('document.querySelector("[data-preview-body] pre").textContent'), definitions.find(row => row[0] === 'code')[3]);
    assert.equal(await js('document.querySelectorAll("[data-preview-body] iframe,[data-preview-body] h1").length'), 0);
    await assertNoTabs('Source code');
    report.cases.push('Filename extensions override misleading MIME: TXT stays literal and Markdown renders headings');

    await open('markdown'); await until('document.querySelector("[data-preview-body] h1")?.textContent==="月度摘要"');
    await assertIconToolbar();
    assert.equal(await js('window.markdownLeak||false'), false);
    assert.equal(await js('document.querySelectorAll("[data-preview-body] pre").length'), 0);
    await js('document.querySelector("[data-preview-download]").focus();void 0;');
    for (const action of ['system', 'reveal', 'close']) {
      await key('Tab'); assert.equal(await js(`document.activeElement.hasAttribute('data-preview-${action}')`), true, 'Keyboard reaches ' + action);
    }
    await shot('markdown-wide'); report.cases.push('Markdown renders safe headings/list directly without a source mode');
    report.cases.push('Filename and source tabs are removed; icon-only actions and close share one row with tooltips, accessible labels and keyboard navigation');

    await open('html'); let frame = await findWebsiteFrame();
    await assertNoTabs('HTML');
    assert.equal(await frame.executeJavaScript('getComputedStyle(document.body).backgroundColor'), 'rgb(24, 34, 52)');
    await frame.executeJavaScript('document.querySelector("#action").click()');
    assert.equal(await frame.executeJavaScript('document.querySelector("#action").textContent'), 'Clicked');
    assert.equal(await frame.executeJavaScript('window.parentBlocked'), true);
    assert.equal(await js('document.body.dataset.previewLeak||""'), '');
    assert.equal(await js('document.querySelector("[data-preview-body] iframe").sandbox.contains("allow-same-origin")'), false);
    await shot('html-wide');
    assert.equal(await js('document.querySelectorAll("[data-preview-body] pre").length'), 0);
    report.cases.push('HTML retains styles/scripts in sandbox without host DOM access or a source-code view');

    await open('markdown'); await until('document.querySelector("[data-preview-body] h1")?.textContent==="月度摘要"'); await assertNoTabs('Markdown selection');
    await open('html'); await findWebsiteFrame(); await assertNoTabs('HTML selection');
    report.cases.push('Switching between HTML/Markdown files keeps rendered content without leftover source controls');

    for (const [id, renderer] of [['html', 'buildHtmlDocument'], ['markdown', 'safeMarkdown']]) {
      await js(`window.fixtureOriginalRenderer=LibraryDelivery[${JSON.stringify(renderer)}];LibraryDelivery[${JSON.stringify(renderer)}]=()=>{throw Error('Synthetic rendering failure')};void 0;`);
      await open(id); await until('!document.querySelector("[data-preview-body]").hasAttribute("aria-busy")');
      await assertNoTabs('Rendering error');
      assert.match(await bodyText(), /Synthetic rendering failure/, 'Rendering errors must remain visible in the preview panel');
      await click('[data-preview-download]');
      assert.deepEqual(await js('({action:fixtureActions.at(-1).action,id:fixtureActions.at(-1).id})'), { action: 'download', id });
      await js(`LibraryDelivery[${JSON.stringify(renderer)}]=fixtureOriginalRenderer;delete window.fixtureOriginalRenderer;void 0;`);
      await click('[data-preview-retry]');
      if (id === 'html') await findWebsiteFrame();
      else await until('document.querySelector("[data-preview-body] h1")?.textContent==="月度摘要"');
    }
    report.cases.push('HTML/Markdown rendering failure retains original-file download and a working retry back to rendered preview');

    await open('image'); await until('document.querySelector("[data-preview-body] img")?.naturalWidth>0');
    await assertNoTabs('Image');
    const imageUrl = await js('document.querySelector("[data-preview-body] img").src'); await shot('image-wide');
    await open('text'); await until('document.querySelector("[data-preview-body]").textContent.includes("首行")');
    assert.ok(await js(`fixtureRevoked.includes(${JSON.stringify(imageUrl)})`), 'Replacing an image must release its object URL');
    report.cases.push('Image decodes and replacing it releases its object URL');
    await open('gb'); await until('document.querySelector("[data-preview-body]").textContent.includes("正确解码")');
    assert.match(await js('document.querySelector("[data-preview-status]").textContent'), /GB18030/i);
    await open('truncated'); await until('document.querySelector("[data-preview-body]").textContent.includes("File excerpt")');
    assert.match(await js('document.querySelector(".library-preview-pane").textContent'), /仅显示部分内容/);
    report.cases.push('Decoded legacy Chinese text retains encoding status and truncated content carries the server notice');

    await open('audio'); await until('document.querySelector("[data-preview-body] audio")?.readyState>=1');
    await assertNoTabs('Audio');
    assert.equal(await js('document.querySelector("[data-preview-body] audio").controls'), true);
    assert.equal(await js('document.querySelector("[data-preview-body] audio").duration'), 1);
    await open('pdf'); await until('document.querySelector("[data-preview-body] iframe")?.src.startsWith("blob:")');
    await assertNoTabs('PDF');
    const pdfInfo = await js('(async()=>{const src=document.querySelector("[data-preview-body] iframe").src;const blob=await (await fetch(src)).blob();return{type:blob.type,header:(await blob.text()).slice(0,8)}})()');
    assert.deepEqual(pdfInfo, { type: 'application/pdf', header: '%PDF-1.4' });
    await delay(300); await shot('pdf');
    report.cases.push('Audio metadata decodes with native controls; PDF frame receives original valid PDF bytes and PDF MIME type');

    for (const id of ['unknown', 'large']) {
      const count = await js('fixtureCalls.length'); await open(id); await delay(70);
      assert.equal(await js('fixtureCalls.length'), count, 'Unsupported or oversized file must not be fetched into memory');
      assert.equal(await js('document.querySelectorAll("[data-preview-body] iframe,[data-preview-body] img").length'), 0);
      for (const action of ['download', 'system', 'reveal']) { await click('[data-preview-' + action + ']'); assert.deepEqual(await js('({action:fixtureActions.at(-1).action,id:fixtureActions.at(-1).id})'), { action, id }); }
    }
    await shot('unsupported'); report.cases.push('Unknown/oversized files skip content fetching and route download/system-open/reveal to the selected item');

    await open('retry'); await until('document.querySelector("[data-preview-retry]")?.checkVisibility()');
    await js('fixtureRetryFailed=false;void 0;'); await click('[data-preview-retry]');
    await until('document.querySelector("[data-preview-body]").textContent.includes("Recovered content")');
    report.cases.push('Read failure stays in pane with a functional retry action');

    await open('bundle'); frame = await findWebsiteFrame();
    assert.equal(await frame.executeJavaScript('document.querySelector("h1").textContent'), 'Packaged website');
    assert.equal(await frame.executeJavaScript('getComputedStyle(document.body).backgroundColor'), 'rgb(11, 71, 53)');
    await assertIconToolbar();
    assert.equal(await js('document.querySelectorAll("[data-preview-source]").length'), 0, 'Conversation provenance must not occupy the removed title row');
    await selectFile('notes.txt');
    await until('document.querySelector("[data-preview-body]").textContent.includes("Packaged notes 原始文件")');
    await assertNoTabs('Delivery text member');
    for (const action of ['download', 'system', 'reveal']) {
      await click('[data-preview-' + action + ']');
      assert.deepEqual(await js('({action:fixtureActions.at(-1).action,id:fixtureActions.at(-1).id,path:fixtureActions.at(-1).file?.path})'), { action, id: 'bundle', path: 'notes.txt' }, 'Member actions must target selected file, not whole archive');
    }
    await selectFile('utf16.txt'); await until('document.querySelector("[data-preview-body]").textContent.includes("UTF16")');
    assert.equal(await js('document.querySelector("[data-preview-body] pre").textContent'), 'UTF16 中文\r\n');
    await selectFile('gb18030.txt'); await until('document.querySelector("[data-preview-body] pre")?.textContent==="中文"');
    await open('singleDelivery'); await until('document.querySelector("[data-preview-body]").textContent.includes("Packaged notes 原始文件")');
    assert.equal(await js('fixtureCalls.filter(c=>c.id==="singleDelivery"&&c.method==="content").length'), 0, 'Single-member delivery must read member bytes instead of archive text API');
    assert.equal(await js('document.querySelector("[data-preview-download-archive]").checkVisibility()'), true, 'An actual one-member bundle still has an original ZIP');
    assert.equal(await js('document.querySelector("[data-archive-root]").checkVisibility()'), true, 'A one-member bundle retains folder navigation');
    report.cases.push('Delivery resolves packaged CSS and folder navigation previews another member without restoring a title/source row');
    report.cases.push('Selected member actions keep its path; UTF16/GB18030 bytes decode correctly and a one-member ZIP reads its member');

    for (const id of ['rawTextDelivery', 'rawHtmlDelivery']) {
      await open(id);
      if (id === 'rawHtmlDelivery') {
        frame = await findWebsiteFrame(); assert.equal(await frame.executeJavaScript('document.querySelector("h1").textContent'), 'Website preview');
        await assertNoTabs('Raw HTML delivery');
      } else { await until('document.querySelector("[data-preview-body] pre")?.textContent==="Packaged notes 原始文件"'); await assertNoTabs('Raw delivery text'); }
      assert.equal(await js('document.querySelector("[data-preview-download-archive]").checkVisibility()'), false, 'A raw single file must not show a misleading ZIP download');
      assert.equal(await js('!!document.querySelector("[data-archive-root]")'), false, 'Raw single files have no archive directory');
      await click('[data-preview-download]');
      assert.deepEqual(await js('({id:fixtureActions.at(-1).id,path:fixtureActions.at(-1).file?.path,archive:Boolean(fixtureActions.at(-1).file?.archive)})'), { id, path: id === 'rawHtmlDelivery' ? 'site/index.html' : 'notes.txt', archive: false });
    }
    report.cases.push('Raw single TXT/HTML conversation deliveries preview directly without ZIP navigation or misleading download labels; actual single-member bundles retain both');
    await open('failedDelivery'); await until('document.querySelector("[data-preview-retry]")?.checkVisibility()');
    assert.equal(await js('document.querySelector("[data-preview-download-archive]").title'), '下载原文件');
    assert.equal(await js('document.querySelector("[data-preview-download-archive]").getAttribute("aria-label")'), '下载原文件');
    assert.equal(await js('document.querySelector("[data-preview-download-archive]").textContent.trim()'), '');
    await click('[data-preview-download-archive]');
    assert.deepEqual(await js('({id:fixtureActions.at(-1).id,file:fixtureActions.at(-1).file||null})'), { id: 'failedDelivery', file: null });
    await js('fixtureDeliveryFailure=false;void 0;'); await click('[data-preview-retry]');
    await until('document.querySelector("[data-preview-body] pre")?.textContent==="Packaged notes 原始文件"');
    assert.equal(await js('fixturePreview.selectedId()'), 'failedDelivery');
    assert.equal(await js('document.querySelector("[data-preview-download-archive]").checkVisibility()'), false);
    report.cases.push('Failed delivery metadata retains original-file download and retry recovers the same raw file');

    await js('fixtureHtmlManifestFailure=true;void 0;');
    await open('rawHtmlDelivery'); await until('document.querySelector("[data-preview-retry]")?.checkVisibility()');
    await assertNoTabs('Failed HTML delivery');
    assert.match(await bodyText(), /Temporary HTML manifest failure/);
    assert.equal(await js('document.querySelectorAll("[data-preview-body] pre").length'), 0, 'Missing delivery metadata must not fabricate source');
    const failedManifestReads = await js('fixtureCalls.filter(call=>call.method==="manifest"&&call.id==="rawHtmlDelivery").length');
    await js('fixtureHtmlManifestFailure=false;void 0;');
    await click('.library-preview-pane [data-preview-retry]');
    await findWebsiteFrame(); await assertNoTabs('Recovered HTML delivery');
    assert.equal(await js('fixtureCalls.filter(call=>call.method==="manifest"&&call.id==="rawHtmlDelivery").length'), failedManifestReads + 1, 'Retry must reload failed delivery metadata');
    assert.equal(await js('document.querySelectorAll("[data-preview-body] pre").length'), 0);
    report.cases.push('Known HTML conversation files explain metadata failure and retry reloads the manifest before restoring rendered preview');

    await open('slow'); await until('!!fixtureRelease'); await open('text'); await js('fixtureRelease();fixtureRelease=null;void 0;'); await delay(100);
    assert.equal(await js('fixturePreview.selectedId()'), 'text'); assert.equal(await js('document.querySelector("[data-preview-body] pre").textContent'), textSource);
    await open('slow'); await until('!!fixtureRelease'); await click('[data-preview-close]'); await js('fixtureRelease();fixtureRelease=null;void 0;'); await delay(100);
    assert.equal(await js('fixturePreview.selectedId()'), ''); assert.equal(await js('document.querySelector("#libraryPanel").classList.contains("library-preview-open")'), false);
    await open('slow'); await until('!!fixtureRelease'); await js('fixtureScope="second-user";dispatchEvent(new Event("soduwork-data-scope-changed"));fixtureRelease();fixtureRelease=null;void 0;'); await delay(100);
    assert.equal(await js('fixturePreview.selectedId()'), ''); assert.equal(await js('document.querySelectorAll(".library-preview-pane").length'), 0);
    report.cases.push('Late responses cannot replace a newer selection, reopen a closed pane or expose previous-account content');

    await open('markdown'); await until('!!document.querySelector("[data-preview-body] h1")');
    const wide = await js('(()=>{const r=document.querySelector("#libraryPanel").getBoundingClientRect(),dialog=document.querySelector(".library-preview-pane"),p=dialog.getBoundingClientRect(),list=document.querySelector(".library-page"),l=list.getBoundingClientRect();return{root:{left:r.left,right:r.right,width:r.width},pane:{left:p.left,right:p.right,top:p.top,bottom:p.bottom,width:p.width,height:p.height,modal:dialog.matches(":modal")},viewport:{width:innerWidth,height:innerHeight},list:{left:l.left,right:l.right,width:l.width,overflow:list.scrollWidth-list.clientWidth}}})()');
    report.layout = { wide, overflowElements: await js('(()=>{const list=document.querySelector(".library-page"),right=list.getBoundingClientRect().right;return [...list.querySelectorAll("*")].map(e=>({tag:e.tagName,cls:e.className,right:e.getBoundingClientRect().right})).filter(r=>r.right>right+1).slice(0,8)})()') };
    assert.equal(wide.pane.modal, true, 'Preview must enter the native dialog top layer');
    assert.ok(Math.abs(wide.list.width - originalListLayout.width) <= 2, 'Opening preview must not compress the library list: ' + JSON.stringify({originalListLayout,wide}));
    assert.ok(wide.pane.width > wide.viewport.width * .8 && wide.pane.height > wide.viewport.height * .8, 'Preview should be close to the client size: ' + JSON.stringify(wide));
    const titlebarHeight = await js('document.querySelector(".window-menu").getBoundingClientRect().height');
    assert.ok(Math.abs(wide.pane.left + wide.pane.right - wide.viewport.width) <= 2 && Math.abs(wide.pane.top + wide.pane.bottom - wide.viewport.height-titlebarHeight) <= 2, 'Preview must be centered below the native titlebar: ' + JSON.stringify(wide));
    assert.ok(wide.list.overflow <= originalListLayout.overflow + 1, 'Preview must not introduce horizontal overflow in the library: ' + JSON.stringify({originalListLayout,wide}));
    const chrome = await js('(()=>{const pane=document.querySelector(".library-preview-pane"),toolbar=pane.querySelector(".library-preview-head"),body=pane.querySelector(".library-preview-body");return{height:pane.clientHeight,bodyHeight:body.clientHeight,toolbarHeight:toolbar.getBoundingClientRect().height,icons:toolbar.querySelectorAll(".library-preview-icon").length,enterAnimation:getComputedStyle(pane).animationName}})()');
    assert.ok(chrome.toolbarHeight <= 58 && chrome.bodyHeight > chrome.height * .88, 'One compact toolbar must leave at least 88% of a wide popup for content: ' + JSON.stringify(chrome));
    await assertIconToolbar(); assert.ok(chrome.icons >= 4); assert.equal(chrome.enterAnimation, 'library-preview-enter');
    report.layout.chrome = chrome;
    win.setSize(760, 760); await delay(200); await shot('markdown-narrow');
    const narrow = await js('(()=>{const p=document.querySelector(".library-preview-pane").getBoundingClientRect();return{viewport:{width:innerWidth,height:innerHeight},pane:{left:p.left,right:p.right,top:p.top,bottom:p.bottom},overflow:document.documentElement.scrollWidth>innerWidth}})()');
    assert.ok(narrow.pane.left >= 0 && narrow.pane.right <= narrow.viewport.width && narrow.pane.top >= 0 && narrow.pane.bottom <= narrow.viewport.height && !narrow.overflow, JSON.stringify(narrow));
    win.setSize(480, 700); await delay(200); await shot('preview-compact');
    const compact = await js('(()=>{const pane=document.querySelector(".library-preview-pane"),toolbar=pane.querySelector(".library-preview-head"),box=pane.getBoundingClientRect();return{overflow:toolbar.scrollWidth-toolbar.clientWidth,bodyHeight:pane.querySelector(".library-preview-body").clientHeight,controls:[...pane.querySelectorAll("button")].filter(b=>b.checkVisibility()).every(b=>{const r=b.getBoundingClientRect();return r.left>=box.left&&r.right<=box.right&&r.top>=box.top&&r.bottom<=box.bottom})}})()');
    assert.ok(compact.overflow <= 1 && compact.controls && compact.bodyHeight > 350, 'Compact toolbar must keep every action visible without horizontal overflow: ' + JSON.stringify(compact));
    await assertIconToolbar();
    report.layout.compact = compact;
    await js('document.querySelector("[data-preview-close]").click();void 0;');
    assert.equal(await js('document.querySelector(".library-preview-pane").classList.contains("is-closing")'), true, 'User dismissal has a short exit animation');
    await open('text'); await delay(170);
    assert.equal(await js('fixturePreview.selectedId()'), 'text', 'A quick new selection must survive the previous dismissal callback');
    assert.equal(await js('document.querySelector(".library-preview-pane").inert'), false);
    await js('document.querySelector("[data-preview-close]").click();fixturePreview.close();void 0;');
    assert.equal(await js('document.querySelector(".library-preview-pane")'), null, 'Programmatic navigation during exit must release immediately');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await open('markdown');
    assert.equal(await js('getComputedStyle(document.querySelector(".library-preview-pane")).animationName'), 'none');
    await js('document.querySelector("[data-preview-close]").click();void 0;');
    assert.equal(await js('document.querySelector(".library-preview-pane")'), null, 'Reduced motion dismisses without animation');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }); win.webContents.debugger.detach();
    report.cases.push('Compact icon toolbar maximizes content; entry/exit motion respects reduced motion, rapid reopen and immediate lifecycle cleanup');
    await open('markdown');
    await click('[data-preview-close]');
    assert.ok(await js('document.querySelector(".library-page").checkVisibility()'), 'Closing compact preview returns to the file list');
    report.cases.push('Preview is a centered client-size native modal without compressing the library; narrow windows stay within the viewport');

    await open('image'); await until('document.querySelector("[data-preview-body] img")?.naturalWidth>0');
    const finalImageUrl = await js('document.querySelector("[data-preview-body] img").src'); await click('[data-preview-close]');
    assert.ok(await js(`fixtureRevoked.includes(${JSON.stringify(finalImageUrl)})`), 'Closing must revoke its preview object URL');
    win.setSize(1440, 900); await delay(150);
    await click('[data-library-file-preview="text"]'); await until('document.querySelector("[data-preview-body]")?.textContent.includes("首行")');
    assert.equal(await js('document.querySelectorAll(".library-preview-pane").length'), 1, 'Ordinary file activation must create one shared preview');
    assert.equal(await js('document.querySelector("[data-library-file-preview=text]").getAttribute("aria-pressed")'), 'true');
    await click('[data-preview-close]');
    await click('[data-library-file-preview="markdown"]'); await until('document.querySelector("[data-preview-body] h1")?.textContent==="月度摘要"');
    assert.equal(await js('document.querySelectorAll(".library-preview-pane").length'), 1);
    assert.equal(await js('document.querySelector("[data-library-file-preview=text]").getAttribute("aria-pressed")'), 'false');
    await shot('library-integrated-wide'); await js('closeLibraryPanel();void 0;');
    assert.equal(await js('document.querySelectorAll(".library-preview-pane").length'), 0, 'Leaving the library must destroy preview resources');
    assert.deepEqual(await js('fixtureUrls.filter(url=>!fixtureRevoked.includes(url))'), [], 'Leaving library must revoke preview and thumbnail URLs');
    report.cases.push('Real library row click opens one modal, closing permits another file selection, and navigation destroys preview');
    // Client-owned records carry the local- namespace; backend alone does not grant native file actions.
    await js(`window.fixtureListing=['doc','docx','xls','xlsx','ppt','pptx'].map(ext=>({...fixtureItems.find(i=>i.id==='office'),id:'local-office-'+ext,filename:'业务文档.'+ext,title:'业务文档.'+ext}));openLibraryPanel();void 0;`);
    await until('document.querySelectorAll(".library-file-card").length===6');
    assert.deepEqual(await js(`['open-system','reveal','download'].map(action=>document.querySelectorAll('[data-library-'+action+']').length)`), [6, 6, 6], 'Local file menus retain system-open, location and download');
    for (const ext of ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']) {
      const id = 'local-office-' + ext;
      await click('.library-card-main[data-library-file-preview="' + id + '"],.library-card-main[data-library-open-system="' + id + '"]');
      await until(`fixtureActions.at(-1)?.action==='system'&&fixtureActions.at(-1)?.id===${JSON.stringify(id)}`);
      assert.equal(await js('document.querySelectorAll(".library-preview-pane").length'), 0, 'Office must open externally without a preview column');
      assert.equal(await js(`fixtureCalls.filter(c=>c.id===${JSON.stringify(id)}).length`), 0, 'Office activation must not request extracted content');
    }
    report.cases.push('Word/Excel/PowerPoint old and new formats activate the system app without opening a pane or extracting text');
    for (const backend of ['nfs', 'minio']) {
      await js(`closeLibraryPanel();window.fixtureListing=['doc','docx','xls','xlsx','ppt','pptx'].map(ext=>({...fixtureItems.find(i=>i.id===${JSON.stringify(backend + '-office')}),id:${JSON.stringify(backend + '-office-')}+ext,filename:'远程文档.'+ext,title:'远程文档.'+ext}));openLibraryPanel();void 0;`);
      await until('document.querySelectorAll(".library-file-card").length===6');
      assert.deepEqual(await js(`['open-system','reveal','download'].map(action=>document.querySelectorAll('[data-library-'+action+']').length)`), [0, 0, 6], 'Remote file menus only offer download among native file actions');
      const nativeActions = await js('fixtureActions.filter(action=>["system","reveal"].includes(action.action)).length');
      await js(`(()=>{for(const action of ['open-system','reveal']){const button=document.createElement('button');button.setAttribute('data-library-'+action,${JSON.stringify(backend + '-office-docx')});document.querySelector('#libraryPanel').append(button);button.click();button.remove();}})()`);
      await delay(70);
      assert.equal(await js('fixtureActions.filter(action=>["system","reveal"].includes(action.action)).length'), nativeActions, 'Delegated native handlers must reject remote items even when a button is injected');
      for (const ext of ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']) {
        const id = backend + '-office-' + ext;
        const systemActions = await js('fixtureActions.filter(action=>action.action==="system").length');
        await click('.library-card-main[data-library-file-preview="' + id + '"],.library-card-main[data-library-open-system="' + id + '"]');
        assert.equal(await js('fixtureActions.filter(action=>action.action==="system").length'), systemActions, 'Remote Office activation must not call a native application');
        await until('document.querySelectorAll(".library-preview-pane").length===1');
        await assertNoTabs('Remote Office'); await assertLocalActions(false, backend + ' Office only exposes download');
        assert.match(await bodyText(), /下载/, 'Unsupported remote Office must explain downloading the original');
        assert.equal(await js(`fixtureCalls.filter(c=>c.id===${JSON.stringify(id)}).length`), 0, 'Remote Office must not extract text or fetch full bytes for preview');
        await click('[data-preview-download]');
        assert.deepEqual(await js('({action:fixtureActions.at(-1).action,id:fixtureActions.at(-1).id})'), { action: 'download', id });
        await click('[data-preview-close]');
      }
    }
    report.cases.push('Actual NFS/MinIO Office rows open download cards for all Word/Excel/PowerPoint formats, never call native apps, and download the selected remote item');
    report.cases.push('Remote menus omit system-open/location and reject injected delegated native actions; local menus retain all native actions');
    assert.deepEqual(await js('errors'), []); report.ok = true;
  }).catch(async error => { report.error = String(error.stack || error); if (win && !win.isDestroyed()) { report.rendererErrors = await js('window.errors||[]').catch(() => []); await shot('failure').catch(() => {}); } })
    .finally(() => { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); if (win && !win.isDestroyed()) win.destroy(); app.exit(report.ok ? 0 : 1); });
}
