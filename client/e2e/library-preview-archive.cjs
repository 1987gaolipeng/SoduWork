'use strict';
// Production popup, archive navigator and renderers in real Electron. Synthetic
// API files exercise UI boundaries without user data, messages or OS launches.
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
  const client = path.resolve(__dirname, '..'), output = path.resolve(client, '../outputs/library-preview-archive');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-library-archive-'));
  fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  const report = { ok: false, boundary: 'Real Electron native modal, layout, navigation and opaque HTML iframe using shipping CSS/modules. Synthetic archive API; backend ZIP/security is verified separately. No live user data or operating-system launch.', cases: [], screenshots: [] };
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKk0AAAAASUVORK5CYII=';
  const siteDefinitions = require('./fixtures/library-archive-site.cjs').definitions;
  const siteFiles = siteDefinitions.map(([memberPath, contentType, content]) => ({ path: memberPath, filename: memberPath.split('/').pop(), size: Buffer.byteLength(content), contentType, isDirectory: false }));
  const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="assets/site.css"></head><body><h1>ZIP website</h1><img id="pixel" src="assets/pixel.png"><button id="change">Change</button><script>window.archiveFixture=true;document.querySelector("#change").onclick=()=>document.querySelector("h1").textContent="Clicked";try{parent.document.body.dataset.archiveLeak="yes"}catch(e){window.parentBlocked=true}</script></body></html>';
  const definitions = [
    ['README.md', 'text/markdown', '# 压缩包说明\n\n**粗体文字**\n'],
    ['notes.txt', 'text/plain', '原始文本\r\n<b>不是 HTML</b>\n'],
    ['slow.txt', 'text/plain', 'Stale private member'],
    ['retry.txt', 'text/plain', 'Member recovered'],
    ['资料/说明.txt', 'text/plain', '中文路径内容'],
    ['site/index.html', 'text/html', html],
    ['site/assets/site.css', 'text/css', 'body{margin:0;background:rgb(21,71,53);color:white}h1{font:32px sans-serif}'],
    ['site/assets/pixel.png', 'image/png', pixel, true],
    ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'Office original'],
    ['nested.zip', 'application/zip', 'Nested ZIP bytes'],
    ['<img src=x onerror=alert(1)>.txt', 'text/plain', 'Safe filename'],
    ['broken.html', 'text/html', 'Undecodable fixture'],
    ['broken.md', 'text/markdown', 'Undecodable fixture'],
    ['incomplete.html', 'text/html', 'Incomplete response fixture'],
    ['large.html', 'text/html', 'Oversized fixture'],
  ];
  const files = definitions.map(([memberPath, contentType, content]) => ({ path: memberPath, filename: memberPath.split('/').pop(), size: content.length, contentType, isDirectory: false }));
  files.find(file=>file.path==='large.html').size = 9 * 1024 * 1024;
  files.push({ path: 'empty/', filename: 'empty', size: 0, contentType: '', isDirectory: true });
  const items = ['archive', 'broken', 'slowArchive', 'emptyArchive'].map(id => ({ id, filename: id + '.zip', title: id + '.zip', size: 1024, contentType: 'application/zip', kind: 'document', storage: 'local', extra: {}, sourceType: 'upload' }));
  items.push({ ...items[0], id: 'rawZipDelivery', filename: '会话压缩包.zip', extra: { soduWorkDelivery: { schemaVersion: 1, source: 'local', sessionId: 'zip-session' } }, sourceType: 'conversation', sessionId: 'zip-session', conversationTitle: '保存原始压缩包' });
  items.push({ ...items[0], id: 'website', filename: '网站文件夹.zip' });
  for (const backend of ['minio', 'nfs']) items.push({ ...items[0], id: 'remote-' + backend, backend });
  for (const name of ['broken.html', 'broken.md', 'incomplete.html', 'large.html']) {
    const member = files.find(file=>file.path===name);
    items.push({ ...items[0], ...member, id: 'ordinary-' + name, title: name, backend: 'nfs' });
  }
  let win;
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code, message = code) { for (let i = 0; i < 180; i++) { if (await js(code)) return; await delay(35); } throw Error('Timed out: ' + message); }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.checkVisibility())throw Error('Unavailable '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
    await delay(60);
    if (selector === '[data-preview-close]') await until('!document.querySelector(".library-preview-pane")', 'Animated dismissal releases the modal');
  }
  async function folder(memberPath) {
    const selector = await js(`(()=>{const e=[...document.querySelectorAll('[data-archive-folder]')].find(e=>e.dataset.archiveFolder.replace(/\\/$/,'')===${JSON.stringify(memberPath.replace(/\/$/, ''))});if(!e)throw Error('Missing folder '+${JSON.stringify(memberPath)});return '[data-archive-folder='+JSON.stringify(e.dataset.archiveFolder)+']'})()`);
    await click(selector);
  }
  const file = memberPath => click('[data-archive-file=' + JSON.stringify(memberPath) + ']');
  async function open(id = 'archive') {
    await js(`void fixturePreview.open(fixtureItems.find(item=>item.id===${JSON.stringify(id)}))`);
    await until(`fixturePreview.selectedId()===${JSON.stringify(id)}&&!!document.querySelector('[data-preview-body]')`);
  }
  async function ready() { await until('!!document.querySelector("[data-archive-file=\\"notes.txt\\"]")'); }
  async function shot(name) {
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await delay(120);
    const filePath = path.join(output, name + '.png'); fs.writeFileSync(filePath, (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); report.screenshots.push(filePath);
  }
  async function websiteFrame() {
    for (let i = 0; i < 180; i++) {
      for (const frame of win.webContents.mainFrame.frames) if (!frame.isDestroyed() && await frame.executeJavaScript('Boolean(window.archiveFixture)').catch(() => false)) return frame;
      await delay(35);
    }
    throw Error('Archive HTML script did not execute');
  }
  async function siteFrame(page) {
    for (let attempt = 0; attempt < 180; attempt++) {
      for (const frame of win.webContents.mainFrame.frames) if (!frame.isDestroyed() && await frame.executeJavaScript(`window.siteFixture===${JSON.stringify(page)}`).catch(() => false)) return frame;
      await delay(35);
    }
    throw Error('Website page did not load: ' + page);
  }
  async function clickFrame(frame, selector) {
    // Native mouse routing to an opaque iframe requires its final compositor
    // geometry. Do not derive click coordinates while the dialog is entering.
    await js('Promise.all(document.querySelector(".library-preview-pane").getAnimations().map(animation=>animation.finished.catch(()=>{})))');
    await frame.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});void 0;`);
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await delay(120);
    const host = await js('(()=>{const r=document.querySelector("[data-preview-body] iframe").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width}})()');
    const child = await frame.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth}})()`);
    const point = { x: host.x + child.x * host.width / child.width, y: host.y + child.y * host.width / child.width };
    await frame.executeJavaScript('window.fixturePointerEvents=[];for(const type of ["pointerdown","mousedown","click"])document.addEventListener(type,event=>fixturePointerEvents.push({type,x:event.clientX,y:event.clientY,target:event.target.id||event.target.tagName}));void 0;');
    report.navigationInput = { selector, host, child, point, hit: await js(`(()=>{const node=document.elementFromPoint(${point.x},${point.y});return{tag:node?.tagName,cls:node?.className}})()`) };
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
    report.navigationInput.events = await frame.executeJavaScript('window.fixturePointerEvents').catch(() => ['Frame navigated']);
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }));
    await win.loadFile(path.join(__dirname, 'fixtures/library.html'));
    win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const stylesheets = [...read('desk.html').matchAll(/<link\s+rel=["']stylesheet["']\s+href=["']([^"']+)["']/g)].map(match => require('node:url').pathToFileURL(path.join(client, match[1])).href);
    await js(`(async()=>{document.querySelectorAll('link[rel=stylesheet]').forEach(link=>link.remove());await Promise.all(${JSON.stringify(stylesheets)}.map(href=>new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.onload=resolve;link.onerror=()=>reject(Error('Stylesheet failed: '+href));document.head.append(link)})));})()`);
    await js(`window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));window.fixtureItems=${JSON.stringify(items)};window.fixtureFiles=${JSON.stringify(files)};window.fixtureDefinitions=${JSON.stringify(definitions)};window.siteFiles=${JSON.stringify(siteFiles)};window.siteDefinitions=${JSON.stringify(siteDefinitions)};window.fixtureCalls=[];window.fixtureActions=[];window.fixtureScope='first-user';window.fixtureBroken=true;window.fixtureMemberFailure=true;window.fixtureRelease=null;window.fixtureArchiveRelease=null;window.fixtureBackgroundClicks=0;window.petSay=()=>{};window.SoduWorkAPI={
      taskStorageKey:()=>fixtureScope,
      getDelivery:async id=>{fixtureCalls.push({method:'manifest',id});return{delivery:{id,kind:'file',filename:'会话压缩包.zip',files:[{path:'generated/raw.zip',contentType:'application/zip',size:1024}]}};},
      readDeliveryFile:async()=>{throw Error('Raw ZIP delivery must read archive members through archive API');},
      getLibraryArchive:async id=>{fixtureCalls.push({method:'archive',id});if(id==='broken'&&fixtureBroken)throw Error('Invalid ZIP fixture');if(id==='slowArchive')return new Promise(resolve=>fixtureArchiveRelease=()=>resolve({archive:{files:fixtureFiles}}));return{archive:{files:id==='website'?siteFiles:id==='emptyArchive'?[]:fixtureFiles}};},
      readLibraryArchiveFile:async(id,path,options)=>{fixtureCalls.push({method:'member',id,path,preview:Boolean(options?.preview)});const row=(id==='website'?siteDefinitions:fixtureDefinitions).find(row=>row[0]===path);if(!row)throw Error('Unexpected member '+path);if(path==='retry.txt'&&fixtureMemberFailure)throw Error('Temporary member failure');if(path==='slow.txt')await new Promise(resolve=>fixtureRelease=resolve);if(options?.preview&&path.startsWith('broken.'))throw Object.assign(Error('无法识别文件的文本编码，请使用系统应用打开'),{status:415});if(options?.preview&&path==='incomplete.html')return{};if(options?.preview)return{content:row[2],preview:{encoding:'utf-8'}};return new Blob([row[3]?Uint8Array.from(atob(row[2]),c=>c.charCodeAt(0)):row[2]],{type:row[1]});},
      readLibraryContent:async(id)=>{if(id==='ordinary-incomplete.html')return{};if(id.startsWith('ordinary-broken.'))throw Object.assign(Error('无法识别文件的文本编码，请使用系统应用打开'),{status:415});throw Error('Generic ZIP must never enter ordinary text API');},
      readLibraryBinary:async()=>{throw Error('ZIP listing must not fetch whole archive into renderer');},
      downloadLibraryItem:async(id,name,member)=>{fixtureActions.push({action:'download',id,name,member});return{ok:true};},
      openLibraryExternally:async(id,member)=>{fixtureActions.push({action:'system',id,member});return{ok:true};},
      revealLibraryItem:async(id,member)=>{fixtureActions.push({action:'reveal',id,member});return{ok:true};}
    };window.fixtureUrls=[];window.fixtureRevoked=[];const nativeCreate=URL.createObjectURL.bind(URL),nativeRevoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=nativeCreate(blob);fixtureUrls.push(url);return url};URL.revokeObjectURL=url=>{fixtureRevoked.push(url);return nativeRevoke(url)};const opener=document.createElement('button');opener.id='fixture-opener';opener.textContent='打开压缩包';opener.onclick=()=>{fixtureBackgroundClicks++;void fixturePreview.open(fixtureItems[0])};document.body.append(opener);void 0;`);
    for (const filePath of ['vendor/markdown/marked.umd.js', 'vendor/markdown/purify.min.js']) await js(read(filePath) + '\nvoid 0;');
    const shipped = [...read('desk.html').matchAll(/<script\s+src=["']([^"']+)["']/g)].map(match => match[1]);
    for (const filePath of shipped.filter(filePath => /components\/panels\/(?:library-delivery|library-preview[^/]*|library-file-icons)\.js$/.test(filePath))) await js(read(filePath) + '\nvoid 0;');
    await js('window.fixturePreview=SoduWorkLibraryPreview.create({root:document.querySelector("#libraryPanel")||document.body});document.querySelector("#fixture-opener").focus();void fixturePreview.open(fixtureItems[0]);');
    await ready();
    assert.equal(await js('document.querySelector(".library-preview-pane").matches(":modal")'), true);
    assert.equal(await js('fixtureCalls.filter(call=>call.method==="member").length'), 0, 'Opening ZIP should list folders without automatically opening HTML');
    assert.equal(await js('document.querySelectorAll("[data-preview-body] iframe").length'), 0);
    await js('document.querySelector("#fixture-opener").focus();void 0;');
    assert.equal(await js('document.activeElement.id==="fixture-opener"'), false, 'Native modal must make background controls inert');
    for (let index = 0; index < 14; index++) {
      for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Tab' });
      await delay(20);
      assert.equal(await js('document.querySelector(".library-preview-pane").contains(document.activeElement)'), true, 'Tab traversal must stay inside the modal');
    }
    assert.equal(await js('document.querySelectorAll("[data-archive-file] img[src=x]").length'), 0, 'Archive member names must be treated as text');
    await shot('archive-root'); report.cases.push('ZIP opens as a folder navigator in a native modal without eagerly reading members; background is inert and filenames stay literal');

    await folder('empty');
    assert.equal(await js('document.querySelectorAll("[data-archive-file]").length'), 0, 'Explicit empty directory must remain navigable');
    await click('[data-archive-up]'); await ready();
    await folder('资料'); await file('资料/说明.txt');
    await until('document.querySelector("[data-preview-body] pre")?.textContent==="中文路径内容"');
    await click('[data-archive-root]'); await ready();
    await file('notes.txt'); await until('document.querySelector("[data-preview-body] pre")?.textContent.includes("原始文本")');
    assert.equal(await js('document.querySelector("[data-preview-body] pre").textContent'), definitions.find(row => row[0] === 'notes.txt')[2]);
    assert.equal(await js('document.querySelectorAll("[data-preview-tab], [role=tablist]").length'), 0);
    assert.equal(await js('document.querySelectorAll("[data-preview-body] b").length'), 0);
    for (const action of ['download', 'system', 'reveal']) {
      await click('[data-preview-' + action + ']');
      assert.deepEqual(await js('(()=>{const a=fixtureActions.at(-1);return{action:a.action,id:a.id,path:a.member?.path,archive:a.member?.archive}})()'), { action, id: 'archive', path: 'notes.txt', archive: true });
    }
    await click('[data-preview-download-archive]');
    assert.deepEqual(await js('(()=>{const a=fixtureActions.at(-1);return{action:a.action,id:a.id,member:a.member||null}})()'), { action: 'download', id: 'archive', member: null });
    report.cases.push('Empty and Chinese folders support navigation; TXT stays literal; member actions carry exact ZIP path while archive download targets the original ZIP');

    await file('README.md'); await until('document.querySelector("[data-preview-body] h1")?.textContent==="压缩包说明"');
    assert.equal(await js('document.querySelector("[data-preview-body] strong").textContent'), '粗体文字');
    assert.equal(await js('document.querySelectorAll("[data-preview-tab], [data-preview-title]").length'), 0);
    await folder('site'); await file('site/index.html'); let frame = await websiteFrame();
    assert.equal(await frame.executeJavaScript('document.querySelector("h1").textContent'), 'ZIP website');
    assert.equal(await frame.executeJavaScript('getComputedStyle(document.body).backgroundColor'), 'rgb(21, 71, 53)');
    for (let attempt = 0; attempt < 100 && !await frame.executeJavaScript('document.querySelector("#pixel").naturalWidth>0'); attempt++) await delay(30);
    assert.equal(await frame.executeJavaScript('document.querySelector("#pixel").naturalWidth'), 1, 'HTML relative image must resolve from ZIP member');
    assert.equal(await frame.executeJavaScript('window.parentBlocked'), true);
    assert.equal(await js('document.body.dataset.archiveLeak||""'), '');
    assert.equal(await js('document.querySelectorAll("[data-preview-body] pre, [data-preview-tab]").length'), 0);
    await shot('archive-html');
    await frame.executeJavaScript('window.archiveKeyEvents=[];document.addEventListener("keydown",event=>archiveKeyEvents.push(event.key));document.querySelector("#change").focus();void 0;');
    assert.equal(await js('document.activeElement.tagName'), 'IFRAME', 'Keyboard must enter the opaque document for this close check');
    await js('(()=>{const channel=document.querySelector("[data-preview-body] iframe").srcdoc.match(/library-html-[a-zA-Z0-9-]+/)[0];window.postMessage({type:"soduwork-html-escape",channel},"*")})()');
    await frame.executeJavaScript('parent.postMessage({type:"soduwork-html-escape",channel:"wrong-channel"},"*");document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));void 0;');
    await delay(80);
    assert.equal(await js('document.querySelector(".library-preview-pane").matches(":modal")'), true, 'Wrong source/channel and synthetic Escape must not close the popup');
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    for (let attempt = 0; attempt < 20 && await js('!!document.querySelector(".library-preview-pane")'); attempt++) await delay(25);
    report.iframeEscape = { events: await frame.executeJavaScript('window.archiveKeyEvents').catch(() => ['Frame closed']), closed: await js('document.querySelectorAll(".library-preview-pane").length===0') };
    if (!report.iframeEscape.closed) await click('[data-preview-close]');
    await open(); await ready(); await folder('site');
    await folder('site/assets'); await file('site/assets/pixel.png'); await until('document.querySelector("[data-preview-body] img")?.naturalWidth===1');
    assert.equal(await js('document.querySelectorAll("[role=tablist]").length'), 0);
    report.cases.push('Markdown and HTML render directly without source controls; HTML loads relative CSS/image in an opaque sandbox; Escape works from the focused iframe and image members preview directly');

    for (const width of [480, 760, 1440]) {
      win.setSize(width, 900); await delay(150);
      const layout = await js('(()=>{const p=document.querySelector(".library-preview-pane").getBoundingClientRect();return{left:p.left,right:p.right,top:p.top,bottom:p.bottom,width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth-innerWidth}})()');
      assert.ok(layout.left >= 0 && layout.right <= layout.width && layout.top >= 0 && layout.bottom <= layout.height && layout.overflow <= 1, JSON.stringify(layout));
      assert.ok(Math.abs(layout.left + layout.right - layout.width) <= 2 && Math.abs(layout.top + layout.bottom - layout.height) <= 2, JSON.stringify(layout));
      await shot('archive-image-' + width);
    }
    await click('[data-archive-root]'); await ready();
    for (const memberPath of ['slides.pptx', 'nested.zip']) {
      const count = await js('fixtureCalls.length'); await file(memberPath); await delay(60);
      assert.equal(await js('fixtureCalls.length'), count, 'Office and nested ZIP must not be fed to text or recursive archive reads');
      await click('[data-preview-system]'); assert.equal(await js('fixtureActions.at(-1).member.path'), memberPath);
    }
    await file('retry.txt'); await until('document.querySelector("[data-preview-retry]")?.checkVisibility()');
    await js('fixtureMemberFailure=false;void 0;'); await click('[data-preview-retry]');
    await until('document.querySelector("[data-preview-body] pre")?.textContent==="Member recovered"');
    report.cases.push('Popup resizes within the viewport; unsupported members remain available to system-open; failed member reads can be retried');

    await file('slow.txt'); await until('!!fixtureRelease'); await file('notes.txt'); await js('fixtureRelease();fixtureRelease=null;void 0;'); await delay(100);
    assert.equal(await js('document.querySelector("[data-preview-body] pre").textContent'), definitions[1][2], 'A late member response must not replace current selection');
    await file('slow.txt'); await until('!!fixtureRelease'); await click('[data-preview-close]'); await js('fixtureRelease();fixtureRelease=null;void 0;'); await delay(100);
    assert.equal(await js('document.querySelectorAll(".library-preview-pane").length'), 0);
    await open('broken'); await until('document.querySelector("[data-preview-retry]")?.checkVisibility()');
    await js('fixtureBroken=false;void 0;'); await click('[data-preview-retry]'); await ready();
    assert.equal(await js('fixtureCalls.filter(call=>call.method==="archive"&&call.id==="broken").length'), 2);
    await open('slowArchive'); await until('!!fixtureArchiveRelease'); await open(); await ready(); await js('fixtureArchiveRelease();fixtureArchiveRelease=null;void 0;'); await delay(100);
    assert.equal(await js('fixturePreview.selectedId()'), 'archive');
    await file('slow.txt'); await until('!!fixtureRelease'); await js('fixtureScope="second-user";dispatchEvent(new Event("soduwork-data-scope-changed"));fixtureRelease();fixtureRelease=null;void 0;'); await delay(100);
    assert.equal(await js('document.querySelectorAll(".library-preview-pane").length'), 0);
    report.cases.push('ZIP listing errors can retry; late listing/member replies cannot overwrite another file, reopen a closed popup or leak across accounts');

    await open('rawZipDelivery'); await ready();
    assert.equal(await js('fixtureCalls.filter(call=>call.id==="rawZipDelivery"&&call.method==="manifest").length'), 1);
    assert.equal(await js('fixtureCalls.filter(call=>call.id==="rawZipDelivery"&&call.method==="archive").length'), 1);
    await file('notes.txt'); await until('document.querySelector("[data-preview-body] pre")?.textContent.includes("原始文本")');
    for (const action of ['download', 'system', 'reveal']) {
      await click('[data-preview-' + action + ']');
      assert.deepEqual(await js('(()=>{const a=fixtureActions.at(-1);return{action:a.action,id:a.id,path:a.member?.path,archive:a.member?.archive}})()'), { action, id: 'rawZipDelivery', path: 'notes.txt', archive: true });
    }
    await click('[data-preview-download-archive]');
    assert.deepEqual(await js('(()=>{const a=fixtureActions.at(-1);return{id:a.id,member:a.member||null}})()'), { id: 'rawZipDelivery', member: null });
    report.cases.push('A raw ZIP saved from a conversation opens through the archive API and member actions preserve archive routing');

    await open('website'); frame = await siteFrame('index');
    assert.equal(await js('document.querySelector("[data-archive-file=\\"site/index.html\\"]").getAttribute("aria-pressed")'), 'true');
    assert.equal(await frame.executeJavaScript('getComputedStyle(document.body).backgroundColor'), 'rgb(21, 71, 53)');
    assert.equal(await frame.executeJavaScript('document.querySelector("#script-state").textContent'), 'Static JS loaded');
    for (let attempt = 0; attempt < 100 && !await frame.executeJavaScript('document.querySelector("#responsive").naturalWidth>0'); attempt++) await delay(30);
    assert.equal(await frame.executeJavaScript('document.querySelector("#responsive").naturalWidth'), 1);
    assert.match(await frame.executeJavaScript('document.querySelector("#responsive").srcset'), /^data:image\/png;base64,/);
    assert.equal(await frame.executeJavaScript('window.parentBlocked'), true);
    await clickFrame(frame, '#about'); frame = await siteFrame('about');
    assert.equal(await js('document.querySelector("[data-archive-file=\\"site/pages/about.html\\"]").getAttribute("aria-pressed")'), 'true');
    assert.equal(await frame.executeJavaScript('getComputedStyle(document.body).backgroundColor'), 'rgb(21, 71, 53)');
    assert.equal(await frame.executeJavaScript('document.querySelector("h1").textContent'), 'ZIP website about');
    assert.equal(await js('document.querySelectorAll("[data-preview-tab], [data-preview-title]").length'), 0);
    await shot('website-about');
    report.cases.push('A single wrapper website auto-opens its index with relative CSS/images/static JS/srcset; trusted iframe link navigation updates the selected archive member in the direct preview');

    const launchesBefore = await js('fixtureActions.filter(action=>action.action==="system").length');
    await frame.executeJavaScript('(()=>{const script=[...document.scripts].map(node=>node.textContent).join("\\n");const channel=script.match(/library-html-[a-zA-Z0-9-]+/)[0];parent.postMessage({type:"soduwork-html-navigate",channel,path:"site/handbook.docx",fragment:""},"*")})();');
    await until('document.querySelector(".library-preview-pane")?.getAttribute("aria-label").endsWith("handbook.docx") && !document.querySelector("[data-preview-body]").hasAttribute("aria-busy")');
    assert.equal(await js('fixtureActions.filter(action=>action.action==="system").length'), launchesBefore, 'Sandbox navigation must never trigger an operating-system launch');
    assert.match(await js('document.querySelector("[data-preview-body]").textContent'), /系统/);
    await click('[data-preview-system]');
    assert.equal(await js('fixtureActions.filter(action=>action.action==="system").length'), launchesBefore + 1, 'Only the explicit system-open action may launch this member');
    assert.equal(await js('fixtureActions.at(-1).member.path'), 'site/handbook.docx');
    report.cases.push('Untrusted HTML bridge navigation to Office stays in a manual-open card and never triggers the host operating system without its explicit button');

    async function visibleAction(action) { return js(`!!document.querySelector('[data-preview-${action}]')?.checkVisibility()`); }
    async function assertDirectPreview() {
      assert.equal(await js('document.querySelectorAll("[data-preview-tab], [role=tablist], [data-preview-title]").length'), 0);
      assert.equal(await visibleAction('close'), true);
    }
    for (const backend of ['minio', 'nfs']) {
      await open('remote-' + backend); await ready();
      assert.equal(await visibleAction('system'), false, backend + ' must hide system-open');
      assert.equal(await visibleAction('reveal'), false, backend + ' must hide file-location');
      assert.equal(await visibleAction('download-archive'), true);
      await folder('site'); await file('site/index.html'); frame = await websiteFrame(); await assertDirectPreview();
      assert.equal(await frame.executeJavaScript('document.querySelector("h1").textContent'), 'ZIP website');
      await shot('remote-' + backend + '-html');
      await click('[data-preview-download]');
      assert.deepEqual(await js('(()=>{const action=fixtureActions.at(-1);return{id:action.id,path:action.member.path,backend:action.member.backend||null}})()'), { id: 'remote-' + backend, path: 'site/index.html', backend: null });
      await click('[data-archive-root]'); await file('README.md');
      await until('document.querySelector("[data-preview-body] h1")?.textContent==="压缩包说明"'); await assertDirectPreview();
      assert.equal(await js('document.querySelector("[data-preview-body] strong").textContent'), '粗体文字');
      const nativeBefore = await js('fixtureActions.filter(action=>action.action==="system"||action.action==="reveal").length');
      await file('slides.pptx'); await until('!document.querySelector("[data-preview-body]").hasAttribute("aria-busy")');
      assert.equal(await js('fixtureActions.filter(action=>action.action==="system"||action.action==="reveal").length'), nativeBefore, 'Remote Office selection cannot launch a local app');
      assert.equal(await visibleAction('download'), true);
      assert.doesNotMatch(await js('document.querySelector("[data-preview-body]").textContent'), /系统|文件位置/);
    }
    await js('window.reusedPreview=document.querySelector(".library-preview-pane");void 0;');
    await open(); await ready();
    assert.equal(await js('document.querySelector(".library-preview-pane")===reusedPreview'), true);
    assert.equal(await visibleAction('system'), true); assert.equal(await visibleAction('reveal'), true);
    const localBefore = await js('fixtureActions.filter(action=>action.action==="system").length');
    await file('slides.pptx'); await until('!document.querySelector("[data-preview-body]").hasAttribute("aria-busy")');
    assert.equal(await js('fixtureActions.filter(action=>action.action==="system").length'), localBefore + 1, 'Local archive Office keeps its automatic system-open behavior');
    report.cases.push('MinIO and NFS archive members inherit parent storage, render HTML/Markdown directly and retain download, hide native actions, and restore local actions in the same popup');

    async function assertUnreadable(remote, name) {
      await until('!document.querySelector("[data-preview-body]").hasAttribute("aria-busy")'); await assertDirectPreview();
      assert.equal(await js('document.querySelectorAll("[data-preview-body] iframe").length'), 0);
      assert.equal(await visibleAction('download'), true);
      if (remote) assert.doesNotMatch(await js('document.querySelector("[data-preview-body]").textContent+document.querySelector("[data-preview-status]").textContent'), /系统|文件位置/);
      const message = await js('document.querySelector("[data-preview-body]").textContent');
      assert.match(message, name === 'large.html' ? /文件较大/ : name === 'incomplete.html' ? /内容返回不完整/ : /无法识别文件的文本编码/);
      assert.doesNotMatch(message, /\ufffd|Undecodable fixture|Incomplete response fixture|Oversized fixture/);
    }
    for (const id of ['archive', 'remote-minio', 'remote-nfs']) {
      await open(id); await ready();
      for (const name of ['broken.html', 'broken.md', 'incomplete.html', 'large.html']) { await file(name); await assertUnreadable(id!=='archive', name); }
    }
    for (const name of ['broken.html', 'broken.md', 'incomplete.html', 'large.html']) { await open('ordinary-' + name); await assertUnreadable(true, name); }
    await shot('unreadable-direct-preview');
    report.cases.push('Ordinary and ZIP HTML/Markdown expose readable errors for decode failures, oversized files and incomplete responses without source controls, fake text or remote native-open advice');

    await open('emptyArchive'); await until('!document.querySelector("[data-preview-body]").hasAttribute("aria-busy")');
    assert.equal(await js('document.querySelectorAll("[data-archive-file]").length'), 0);
    await click('[data-preview-close]');
    await js('document.querySelector("#fixture-opener").focus();void fixturePreview.open(fixtureItems[0]);'); await ready();
    await file('notes.txt');
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Escape' });
    await until('document.querySelectorAll(".library-preview-pane").length===0');
    assert.equal(await js('document.activeElement.id'), 'fixture-opener');
    assert.deepEqual(await js('fixtureUrls.filter(url=>!fixtureRevoked.includes(url))'), []);
    assert.deepEqual(await js('errors'), []);
    assert.equal(report.iframeEscape.closed, true, 'Escape from the focused opaque iframe must close its host preview');
    report.cases.push('Empty ZIP remains a usable preview; Escape closes the modal, restores its opener and releases every preview URL');
    report.ok = true;
  }).catch(async error => { report.error = String(error.stack || error); if (win && !win.isDestroyed()) { report.rendererErrors = await js('window.errors||[]').catch(() => []); report.current = await js('({title:document.querySelector("[data-preview-title]")?.textContent,body:document.querySelector(".library-preview-pane")?.textContent,calls:window.fixtureCalls})').catch(() => null); await shot('failure').catch(() => {}); } })
    .finally(() => { fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ok: report.ok, cases: report.cases, error: report.error, report: path.join(output, 'report.json') })); if (win && !win.isDestroyed()) win.destroy(); app.exit(report.ok ? 0 : 1); });
}
