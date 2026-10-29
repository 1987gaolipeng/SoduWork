'use strict';
// Production delivery + library HTTP routes, real client upload API and visible UI.
// The loopback fixture isolates identity, database and object storage from user data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const output = process.argv[2], python = process.argv[3];
if (!output || !path.isAbsolute(output) || !python) throw Error('Usage: electron e2e/library-upload-dedup.cjs ABS_OUTPUT PYTHON');
fs.mkdirSync(output, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-library-e2e-'));
app.setPath('userData', path.join(temporary, 'profile'));
const client = path.resolve(__dirname, '..'), backend = path.resolve(client, '../hub-backend');
const report = { ok: false, boundary: 'Production Hub HTTP transport, real FastAPI library/delivery routes and filesystem objects with isolated SQLite and identity. The raw Hub transport is bound explicitly; native routing is covered by library-client-local.cjs.', cases: [], screenshots: [], errors: [] };
let win, server, logs = '', url;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => fs.readFileSync(path.join(client, file), 'utf8');
const js = code => win.webContents.executeJavaScript(code, true);
async function until(code) {
  for (let i = 0; i < 150; i++) { if (await js(code)) return; await sleep(40); }
  throw Error('Timed out: ' + code);
}
async function click(selector) {
  const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};if(!r.width||!r.height||!e.contains(document.elementFromPoint(p.x,p.y)))throw Error('Obscured control');return p})()`);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
  await sleep(90);
}
async function refresh(expected) {
  await js('closeLibraryPanel();openLibraryPanel();void 0;');
  await until(`!document.querySelector('.library-spinner')&&document.querySelectorAll('.library-file-card').length===${expected}`);
}
const rows = () => js('(async()=> (await SoduWorkAPI.listLibrary({scope:"all",storage:"local"})).items)()');
async function screenshot(name) {
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const file = path.join(output, name + '.png');
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); report.screenshots.push(file);
}
async function startServer() {
  const probe = require('node:net').createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  server = spawn(python, ['-m', 'uvicorn', 'tests.library_browser_server:app', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: backend, windowsHide: true, env: { ...process.env, SODUWORK_LIBRARY_E2E_ROOT: temporary }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', data => logs += data); server.stderr.on('data', data => logs += data);
  server.on('error', error => logs += error.message);
  const origin = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(origin + '/ready')).ok) return origin; } catch {}
    if (server.exitCode !== null) break; await sleep(100);
  }
  throw Error('Fixture server failed: ' + logs);
}
async function delivery(file, sessionId) {
  const manifest = { source: 'local', sessionId, revision: 'revision-one', title: file.name,
    kind: 'file', entryPath: file.name, files: [{ path: file.name, size: file.bytes.length,
      sha256: crypto.createHash('sha256').update(file.bytes).digest('hex'), contentType: file.type, role: 'primary' }] };
  const form = new FormData(); form.append('manifest', JSON.stringify(manifest));
  form.append('file', new Blob([file.bytes], { type: file.type }), file.name);
  const response = await fetch(url + '/api/v1/deliveries', { method: 'POST', body: form, headers: { 'X-Soduwork-Device': 'e2e-alice' } });
  const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text).item;
}
async function upload(file, source, expectedConflict = false) {
  return js(`(async()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(file.bytes.toString('base64'))}),c=>c.charCodeAt(0));try{return(await SoduWorkAPI.uploadLibraryFile(new File([bytes],${JSON.stringify(file.name)},{type:${JSON.stringify(file.type)}}),'','local',${JSON.stringify(source || null)})).item}catch(error){if(!${expectedConflict})throw error;return{status:error.status,code:error.code}}})()`);
}
async function downloadBytes(id) {
  return Buffer.from(await js(`(async()=>Array.from(new Uint8Array(await(await SoduWorkAPI.readLibraryBinary(${JSON.stringify(id)})).blob.arrayBuffer())))()`));
}
function websiteZip() {
  const packed = spawnSync(python, ['-c', 'import base64,io,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED); z.writestr("index.html","<!doctype html><html><body>One uploaded website</body></html>"); z.close(); print(base64.b64encode(b.getvalue()).decode())'], { encoding: 'utf8', windowsHide: true });
  assert.equal(packed.status, 0, packed.stderr); return Buffer.from(packed.stdout.trim(), 'base64');
}
app.whenReady().then(async () => {
  url = await startServer();
  win = new BrowserWindow({ show: false, width: 1280, height: 850, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => callback({ cancel: !request.url.startsWith(url + '/') }));
  await win.loadFile(path.join(__dirname, 'fixtures/library.html'));
  await js(`localStorage.setItem('soduwork_work_hub_environment_v1','development');localStorage.setItem('soduwork_work_development_hub_url_v1',${JSON.stringify(url)});localStorage.setItem('soduwork_work_user_id','e2e-alice');window.petSay=()=>{};void 0;`);
  await js('window.__SODUWORK_TEST_HUB_CONFIG__ = { allowSwitch: true };');
  // This fixture tests Hub HTTP semantics on its isolated server-local store.
  // Explicitly bind the raw transport here; never reinterpret a real PC library.
  await js('window.SoduWorkLocalLibraryAPI = { install() {} };void 0;');
  for (const file of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + file));
  for (const file of ['core/i18n-dom.js', 'core/i18n.js', 'core/api-work-plugins.js', 'api.js', 'components/panels/library-file-icons.js', 'components/panels/panels-library-dialogs.js', 'components/panels/library-delivery.js', 'components/panels/library-preview-html.js', 'components/panels/library-preview-archive.js', 'components/panels/library-preview-pane.js', 'components/panels/panels-library.js']) await js(read(file) + '\nvoid 0;');
  await js('SoduWorkI18n.setLocale("zh-CN");openLibraryPanel();void 0;');
  await until('!document.querySelector(".library-spinner")&&!!document.querySelector("[data-library-title]")');
  win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const files = [
    { name: 'simple-website.zip', type: 'application/zip', bytes: websiteZip() },
    { name: 'README.md', type: 'text/markdown', bytes: Buffer.from('# 网站说明\n同一个会话文件只保存一次。\n') },
  ];
  for (const [index, file] of files.entries()) {
    const source = { type: 'conversation', sessionId: 'dedup-session-' + index, conversationTitle: '生成简单的网站 ' + (index + 1) };
    const automatic = await delivery(file, source.sessionId);
    const saved = await upload(file, source);
    const listing = await rows(); report.lastRows = listing.map(row => ({ id: row.id, filename: row.filename, conversationTitle: row.conversationTitle }));
    await refresh(listing.length);
    await click('[data-library-view=list]');
    assert.equal(listing.filter(row => row.filename === file.name).length, 1, 'Automatic delivery + explicit save must produce one ' + file.name);
    assert.equal(saved.id, automatic.id, 'Explicit save must reuse the durable delivery');
    assert.equal(listing.find(row => row.id === saved.id).conversationTitle, source.conversationTitle);
    assert.deepEqual(await downloadBytes(saved.id), file.bytes);
    assert.equal(await js(`document.querySelectorAll('.library-source-cell [data-library-open-session=${JSON.stringify(source.sessionId)}]').length`), 1);
    assert.equal(await js(`document.querySelector('.library-source-cell [data-library-open-session=${JSON.stringify(source.sessionId)}]').textContent`), '来自会话：' + source.conversationTitle);
    report.cases.push(file.name + ': automatic delivery and explicit client save reuse one row, display the conversation title and download exact bytes');
    const retry = await upload(file, source); assert.equal(retry.id, saved.id);
    assert.equal((await rows()).filter(row => row.filename === file.name).length, 1);
  }
  report.cases.push('Repeated explicit saves of both ZIP and Markdown remain idempotent');
  await screenshot('deduplicated-list');
  await click('[data-library-view=grid]');
  assert.equal(await js('document.querySelectorAll(".library-file-card").length'), 2);
  await screenshot('deduplicated-grid');
  await click('[data-library-view=list]');
  assert.equal(await js('document.querySelectorAll(".library-file-card").length'), 2);
  report.cases.push('Real grid/list toggle shows the same two unique files');
  const changed = { ...files[1], bytes: Buffer.from('# 更新后的说明\n不同的版本必须保留。\n') };
  const changedItem = await upload(changed, { type: 'conversation', sessionId: 'dedup-session-1', conversationTitle: '生成简单的网站 2' });
  assert.equal((await rows()).filter(row => row.filename === changed.name).length, 2);
  assert.deepEqual(await downloadBytes(changedItem.id), changed.bytes);
  report.cases.push('Same conversation and filename with changed content retains a separate version');
  const beforeConflict = await rows();
  const conflict = await upload(files[0], null, true);
  assert.deepEqual(conflict, { status: 409, code: 'LIBRARY_NAME_CONFLICT' });
  assert.deepEqual((await rows()).map(row => row.id).sort(), beforeConflict.map(row => row.id).sort());
  const original = beforeConflict.find(row => row.filename === files[0].name);
  assert.deepEqual(await downloadBytes(original.id), files[0].bytes);
  report.cases.push('Manual same-name upload returns HTTP 409, retains every existing row and preserves original bytes');
  const manual = await upload({ ...files[0], name: 'manual-website.zip' });
  const final = await rows(); assert.equal(final.filter(row => row.filename === files[0].name).length, 1);
  assert.equal(final.find(row => row.id === manual.id).sourceType, 'upload');
  assert.deepEqual(await downloadBytes(manual.id), files[0].bytes);
  await refresh(4); await screenshot('distinct-versions-and-manual-upload');
  report.cases.push('A uniquely named manual upload still saves independently with upload provenance and exact bytes');
  assert.deepEqual(report.errors.filter(message => !message.includes('409 (Conflict)')), []); report.ok = true;
}).catch(async error => {
  report.error = error.stack;
  if (win && !win.isDestroyed()) await screenshot('failure').catch(() => {});
}).finally(() => {
  if (!report.ok) report.backendLog = logs;
  fs.writeFileSync(path.join(output, 'library-upload-dedup-report.json'), JSON.stringify(report, null, 2));
  win?.destroy(); server?.kill(); app.exit(report.ok ? 0 : 1);
});
