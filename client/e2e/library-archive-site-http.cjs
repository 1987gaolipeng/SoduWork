'use strict';
// Upload a real ZIP into isolated SQLite/local storage, then exercise shipping
// renderer/API modules with real Chromium mouse events and opaque child frames.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 120000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
  const assert = require('node:assert/strict'), { spawn, spawnSync } = require('node:child_process');
  const fixture = require('./fixtures/library-archive-site.cjs');
  const client = path.resolve(__dirname, '..'), backend = path.resolve(client, '../hub-backend');
  const output = path.resolve(client, '../outputs/library-archive-site-http');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-library-e2e-'));
  const python = process.env.SODUWORK_E2E_PYTHON || path.join(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  const report = { ok: false, boundary: 'Real multipart upload, production library/archive routes, isolated SQLite/storage and real Electron shipping modules. No user service/account changes. Optional input ZIP is read-only and uploaded only into this isolated fixture.', cases: [], screenshots: [], errors: [] };
  let win, server, serverLogs = '';
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const js = code => win.webContents.executeJavaScript(code, true);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(fn, label) { for (let i = 0; i < 180; i++) { if (await fn()) return; await sleep(35); } throw Error('Timed out: ' + label); }
  async function click(selector) {
    const point = await js(`(()=>{let e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing target');e=e.querySelector('.library-card-name')||e;e.scrollIntoView({block:'nearest'});if(!e.checkVisibility())throw Error('Hidden target');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
    await sleep(60);
    if (selector === '[data-preview-close]') await until(() => js('!document.querySelector(".library-preview-pane")'), 'Animated dismissal releases the modal');
  }
  async function clickFrame(frame, selector) {
    await frame.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});void 0;`);
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await sleep(100);
    const host = await js('(()=>{const r=document.querySelector("[data-preview-body] iframe").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width}})()');
    const child = await frame.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth}})()`);
    const point = { x: host.x + child.x * host.width / child.width, y: host.y + child.y * host.width / child.width };
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
  }
  async function shot(name) {
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await sleep(100);
    const destination = path.join(output, name + '.png'); fs.writeFileSync(destination, (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); report.screenshots.push(destination);
  }
  async function siteFrame(page) {
    let found;
    await until(async () => {
      for (const frame of win.webContents.mainFrame.frames) if (!frame.isDestroyed() && await frame.executeJavaScript(`window.siteFixture===${JSON.stringify(page)}`).catch(() => false)) { found = frame; return true; }
      return false;
    }, 'site frame ' + page);
    return found;
  }
  async function startServer() {
    const probe = require('node:net').createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    server = spawn(python, ['-m', 'uvicorn', 'tests.library_browser_server:app', '--host', '127.0.0.1', '--port', String(port)], { cwd: backend, windowsHide: true, env: { ...process.env, SODUWORK_LIBRARY_E2E_ROOT: temporary }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', data => serverLogs += data); server.stderr.on('data', data => serverLogs += data); server.on('error', error => serverLogs += error.message);
    const url = 'http://127.0.0.1:' + port;
    await until(async () => { try { return (await fetch(url + '/ready')).ok; } catch (_) { if (server.exitCode !== null) throw Error(serverLogs); return false; } }, 'isolated server ready');
    return url;
  }
  function zipBytes() {
    const source = 'import base64,io,json,sys,zipfile; rows=json.loads(sys.stdin.buffer.read().decode("utf-8")); b=io.BytesIO(); z=zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED); [z.writestr(r[0],base64.b64decode(r[2]) if len(r)>3 and r[3] else r[2]) for r in rows]; z.close(); print(base64.b64encode(b.getvalue()).decode())';
    const packed = spawnSync(python, ['-c', source], { input: JSON.stringify(fixture.definitions), encoding: 'utf8', windowsHide: true });
    assert.equal(packed.status, 0, packed.stderr); return Buffer.from(packed.stdout.trim(), 'base64');
  }
  async function upload(bytes, name) {
    return js(`(async()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),c=>c.charCodeAt(0));return(await SoduWorkAPI.uploadLibraryFile(new File([bytes],${JSON.stringify(name)},{type:'application/zip'}))).item})()`);
  }
  async function show(item) {
    await js('openLibraryPanel();void 0;');
    await until(() => js(`!!document.querySelector('[data-library-file-preview=${JSON.stringify(item.id)}]')`), 'uploaded ZIP in list');
    await click('[data-library-file-preview=' + JSON.stringify(item.id) + ']');
  }
  async function checkAssets(frame) {
    await until(() => frame.executeJavaScript('document.querySelector("#responsive").naturalWidth===1'), 'relative image decoded');
    assert.equal(await frame.executeJavaScript('getComputedStyle(document.body).backgroundColor'), 'rgb(21, 71, 53)');
    assert.equal(await frame.executeJavaScript('getComputedStyle(document.querySelector("h1")).letterSpacing'), '2px', 'Nested CSS import must resolve relative to its own stylesheet');
    assert.equal(await frame.executeJavaScript('document.querySelector("#script-state").textContent'), 'Static JS loaded');
    assert.match(await frame.executeJavaScript('document.querySelector("#responsive").srcset'), /^data:image\/png;base64,/);
    assert.equal(await frame.executeJavaScript('window.parentBlocked'), true);
    assert.equal(await js('document.body.dataset.siteLeak||""'), '');
  }
  app.whenReady().then(async () => {
    const url = await startServer();
    win = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => done({ cancel: !request.url.startsWith(url + '/') }));
    await win.loadFile(path.join(__dirname, 'fixtures/library.html'));
    win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const stylesheets = [...read('desk.html').matchAll(/<link\s+rel=["']stylesheet["']\s+href=["']([^"']+)["']/g)].map(match => require('node:url').pathToFileURL(path.join(client, match[1])).href);
    await js(`(async()=>{document.querySelectorAll('link[rel=stylesheet]').forEach(link=>link.remove());await Promise.all(${JSON.stringify(stylesheets)}.map(href=>new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href=href;link.onload=resolve;link.onerror=()=>reject(Error(href));document.head.append(link)})));})()`);
    await js(`localStorage.setItem('soduwork_work_hub_environment_v1','development');localStorage.setItem('soduwork_work_development_hub_url_v1',${JSON.stringify(url)});localStorage.setItem('soduwork_work_user_id','site-fixture-user');window.errors=[];addEventListener('error',event=>errors.push(event.message));addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));window.petSay=()=>{};window.WorkspaceHost={open:()=>{}};void 0;`);
    await js('window.__SODUWORK_TEST_HUB_CONFIG__ = { allowSwitch: true };');
    await js(read('core/api-work-plugins.js') + '\n' + read('api.js') + '\nvoid 0;');
    const scripts = [...read('desk.html').matchAll(/<script\s+src=["']([^"']+)["']/g)].map(match => match[1]);
    for (const file of scripts.filter(file => /components\/panels\/(?:library-delivery|library-preview[^/]*|library-file-icons|panels-library-dialogs|panels-library)\.js$/.test(file))) await js(read(file) + '\nvoid 0;');
    await js('window.siteCalls=[];const originalArchiveRead=SoduWorkAPI.readLibraryArchiveFile;SoduWorkAPI.readLibraryArchiveFile=async(...args)=>{siteCalls.push({id:args[0],path:args[1],preview:Boolean(args[2]?.preview)});return originalArchiveRead(...args)};void 0;');
    const item = await upload(zipBytes(), '完整网站.zip'); await show(item); let frame = await siteFrame('index');
    assert.equal(await js('document.querySelector("[data-archive-file=\\"site/index.html\\"]").getAttribute("aria-pressed")'), 'true');
    await checkAssets(frame);
    assert.match(await frame.executeJavaScript('getComputedStyle(document.querySelector(".hero")).backgroundImage'), /data:image\/png;base64,/);
    await shot('automatic-home');
    report.cases.push('Real ZIP upload auto-opens the single wrapped index despite macOS metadata, with relative CSS/imports/images/static JavaScript and srcset');

    const readsBeforeAnchor = await js('siteCalls.filter(call=>call.preview).length');
    report.anchorBefore = await frame.executeJavaScript('(()=>{const link=document.querySelector("#same"),target=document.querySelector("#anchor");return{url:location.href,base:document.baseURI,href:link.href,scrollY,scrolling:document.scrollingElement?.tagName,scrollHeight:document.scrollingElement?.scrollHeight,clientHeight:innerHeight,targetTop:target.getBoundingClientRect().top}})()');
    await clickFrame(frame, '#same'); await sleep(150);
    report.anchorAfter = await frame.executeJavaScript('(()=>{const target=document.querySelector("#anchor");return{url:location.href,scrollY,targetTop:target?.getBoundingClientRect().top}})()').catch(error=>({error:String(error)}));
    await until(() => frame.executeJavaScript('scrollY>0'), 'same-document anchor scroll');
    assert.equal(await js('siteCalls.filter(call=>call.preview).length'), readsBeforeAnchor);
    assert.equal(await frame.executeJavaScript('document.querySelector("#same").getAttribute("href")'), '#anchor');
    for (const selector of ['#outside', '#external', '#invented']) {
      await clickFrame(frame, selector); await sleep(100);
      assert.equal(await frame.executeJavaScript('window.siteFixture'), 'index');
      assert.equal(await js('siteCalls.filter(call=>call.preview).length'), readsBeforeAnchor, 'Invalid or forged anchor must not select another member');
    }
    assert.equal(await frame.executeJavaScript('document.querySelector("#invented").hasAttribute("data-soduwork-preview-path")'), false);
    report.cases.push('Same-page anchor scroll preserves the current file; traversal, external links and invented navigation markers cannot change archive selection');

    await clickFrame(frame, '#about'); frame = await siteFrame('about'); await checkAssets(frame);
    assert.equal(await js('document.querySelector("[data-archive-file=\\"site/pages/about.html\\"]").getAttribute("aria-pressed")'), 'true');
    await until(() => frame.executeJavaScript('scrollY>0'), 'cross-file fragment scroll');
    assert.equal(await frame.executeJavaScript('document.querySelector("h1").textContent'), 'ZIP website about');
    assert.equal(await js('document.querySelectorAll("[data-preview-tab], [data-preview-title]").length'), 0);
    await shot('navigated-about');
    await clickFrame(frame, '#back'); frame = await siteFrame('index'); await until(() => frame.executeJavaScript('scrollY>0'), 'relative parent link and fragment');
    assert.equal(await js('document.querySelector("[data-archive-file=\\"site/index.html\\"]").getAttribute("aria-pressed")'), 'true');
    report.cases.push('Real iframe mouse clicks navigate nested relative HTML paths, sync folder selection, resolve each page assets and honor fragments in the direct preview');
    const readPaths = await js('siteCalls.map(call=>call.path)');
    for (const memberPath of ['site/assets/css/site.css', 'site/assets/css/palette.css', 'site/assets/js/site.js', 'site/assets/images/pixel.png', 'site/assets/images/pixel@2x.png', 'site/pages/about.html']) assert.ok(readPaths.includes(memberPath), 'Missing actual HTTP member read: ' + memberPath);
    assert.ok(readPaths.every(memberPath => !memberPath.includes('..') && !memberPath.includes('://')));
    await click('[data-preview-close]'); assert.equal(await js('document.querySelectorAll(".library-preview-pane").length'), 0);
    assert.deepEqual(await js('errors'), []);

    if (process.env.SODUWORK_LIBRARY_SITE_ZIP) {
      const inputPath = path.resolve(process.env.SODUWORK_LIBRARY_SITE_ZIP), before = fs.readFileSync(inputPath);
      const digest = crypto.createHash('sha256').update(before).digest('hex');
      const inputName = process.env.SODUWORK_LIBRARY_SITE_ZIP_NAME || (/\.zip$/i.test(inputPath) ? path.basename(inputPath) : 'provided.zip');
      const original = await upload(before, inputName); await show(original);
      const manifest = await js(`(async()=>await SoduWorkAPI.getLibraryArchive(${JSON.stringify(original.id)}))()`);
      const initialEntry = await js(`SoduWorkLibraryArchive.findEntry(${JSON.stringify(manifest.archive.files)})`);
      const selected = initialEntry || manifest.archive.files.find(file => /\.html?$/i.test(file.path));
      assert.ok(selected, 'Optional ZIP should contain a previewable HTML file');
      if (!initialEntry) {
        await until(() => js('!!document.querySelector("[data-archive-root]")'), 'optional ZIP folder listing');
        await click('[data-archive-root]'); const parts = selected.path.split('/');
        for (let i = 1; i < parts.length; i++) await click('[data-archive-folder=' + JSON.stringify(parts.slice(0, i).join('/')) + ']');
        await click('[data-archive-file=' + JSON.stringify(selected.path) + ']');
      }
      const expectedError = process.env.SODUWORK_LIBRARY_SITE_EXPECT_PREVIEW_ERROR;
      if (expectedError) {
        const rejected = await js(`(async()=>{try{await SoduWorkAPI.readLibraryArchiveFile(${JSON.stringify(original.id)},${JSON.stringify(selected.path)},{preview:true});return{status:200}}catch(error){return{status:error.status,message:error.message}}})()`);
        assert.equal(rejected.status, 415, 'The optional negative fixture must be rejected by the production preview API');
        assert.ok(rejected.message.includes(expectedError));
        await until(() => js(`document.querySelector('[data-preview-body]')?.textContent.includes(${JSON.stringify(expectedError)})`), 'provided ZIP has the expected readable error');
        assert.equal(await js('document.querySelectorAll("[data-preview-body] iframe").length'), 0, 'Unsupported binary content must not become an HTML document');
        assert.equal(await js('document.querySelector("[data-preview-system]").disabled'), false);
        assert.equal(await js('document.querySelectorAll("[data-preview-tab], [role=tablist], [data-preview-title]").length'), 0, 'Unreadable HTML keeps the direct preview without source controls');
        const unavailable = await js('document.querySelector("[data-preview-body]").textContent');
        assert.ok(unavailable.includes(expectedError));
        assert.doesNotMatch(unavailable, /\ufffd/);
        const downloaded = await js(`(async()=>{const{blob}=await SoduWorkAPI.readLibraryBinary(${JSON.stringify(original.id)});const bytes=new Uint8Array(await blob.arrayBuffer());return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(value=>value.toString(16).padStart(2,'0')).join('')})()`);
        assert.equal(downloaded, digest, 'The original ZIP must remain downloadable byte-for-byte');
        await shot('provided-zip-unsupported');
        report.cases.push('Provided ZIP opens its folder and selects its homepage, but explicitly rejects the expected unsupported member bytes without interpreting binary content as HTML');
      } else {
        await until(() => js('!!document.querySelector("[data-preview-body] iframe")?.srcdoc'), 'optional ZIP actual HTML preview');
        const source = await js(`(async()=>await SoduWorkAPI.readLibraryArchiveFile(${JSON.stringify(original.id)},${JSON.stringify(selected.path)},{preview:true}))()`);
        assert.equal(typeof source.content, 'string');
        assert.ok(source.content.length > 0);
        assert.equal(await js('document.querySelectorAll("[data-preview-tab], [data-preview-title]").length'), 0);
        assert.equal(await js('document.querySelector("[data-preview-body] iframe").getAttribute("sandbox")'), 'allow-scripts');
        const downloaded = await js(`(async()=>{const{blob}=await SoduWorkAPI.readLibraryBinary(${JSON.stringify(original.id)});const bytes=new Uint8Array(await blob.arrayBuffer());return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(value=>value.toString(16).padStart(2,'0')).join('')})()`);
        assert.equal(downloaded, digest, 'Direct preview must preserve the original downloadable ZIP bytes');
        await shot('provided-zip-preview');
        report.cases.push('Provided ZIP was read-only, uploaded into isolated storage and rendered directly in an opaque HTML sandbox while preserving original downloadable bytes');
      }
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(inputPath)).digest('hex'), digest, 'Original input ZIP must remain byte-for-byte unchanged');
      report.providedZip = { filename: inputName, sha256: digest, files: manifest.archive.files.length, entry: selected.path, automaticallySelected: Boolean(initialEntry), rendered: !expectedError, expectedError: expectedError || null };
      await click('[data-preview-close]');
    }
    report.ok = true;
  }).catch(async error => {
    report.error = String(error.stack || error); report.backendLog = serverLogs;
    if (win && !win.isDestroyed()) report.frames = await Promise.all(win.webContents.mainFrame.frames.map(frame=>frame.executeJavaScript('({page:window.siteFixture,url:location.href,scrollY,height:innerHeight,scrollHeight:document.scrollingElement?.scrollHeight,anchor:document.getElementById("anchor")?.getBoundingClientRect().top,details:document.getElementById("details")?.getBoundingClientRect().top})').catch(error=>({error:String(error)}))));
    if (win && !win.isDestroyed()) { report.current = await js('({title:document.querySelector("[data-preview-title]")?.textContent,body:document.querySelector("[data-preview-body]")?.textContent,errors:window.errors,calls:window.siteCalls})').catch(() => null); await shot('failure').catch(() => {}); }
  }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ok: report.ok, cases: report.cases, error: report.error, report: path.join(output, 'report.json') }));
    win?.destroy(); server?.kill(); app.exit(report.ok ? 0 : 1);
  });
}
