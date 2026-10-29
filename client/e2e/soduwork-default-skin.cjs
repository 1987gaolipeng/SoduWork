'use strict';
// Native Chromium rendering with an isolated profile and a local fixture server.
// The shipped skin/store/bridge/pet scripts run in their usual order. Only the
// desktop IPC relay and unrelated overlay controls are fixtures; no Hub is used.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '../outputs/default-logo-20261019');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-default-logo-'));
const cfgKey = 'soduwork_work_cfg_v5';
const channel = 'default-logo-fixture-broadcast';
const preload = path.join(profile, 'preload.cjs');
const report = { ok:false, isolated:true, realModel:false, cases:[], errors:[] };
const requests = [];
const windows = new Set();
const frames = new Map();
let server, base, broadcasts = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = (window, code) => window.webContents.executeJavaScript(code, true);

fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('soduWorkAPI', {
  broadcast:(kind,payload)=>ipcRenderer.send(${JSON.stringify(channel)},kind,payload),
  onBroadcast:cb=>ipcRenderer.on(${JSON.stringify(channel)},(_event,kind,payload)=>cb(kind,payload))
});`);
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
ipcMain.on(channel, (event, kind, payload) => {
  broadcasts++;
  for (const window of windows) {
    if (!window.isDestroyed() && window.webContents !== event.sender) window.webContents.send(channel, kind, payload);
  }
});

function html(pet) {
  const files = ['core/task-sync.js', 'core/store-lifecycle.js', 'core/store.js',
    'core/skin-registry.js', 'core/win-bridge.js'];
  if (pet) files.push('components/pet/characters.js', 'components/pet/pet-ui.js');
  files.push('components/skin-manager/skin-model.js');
  files.push(pet ? 'components/pet/soduwork-pet-skin.js' : 'components/skin-manager/skin-manager.js');
  return `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="theme/variables.css"><link rel="stylesheet" href="components/pet/pet.css">
    <link rel="stylesheet" href="components/skin-manager/skin-manager.css">
    <style>body{margin:0;background:var(--bg-0);color:var(--ink);font:14px sans-serif}
    .pet{left:36px;top:36px;right:auto;bottom:auto}.skin-manager{width:560px}
    </style></head><body>${pet ? '<div class="pet awake" id="pet"><div class="pet-shadow"></div><svg id="petSvg" class="pet-svg" viewBox="0 0 120 120"></svg></div><div id="petBubble" class="pet-bubble"></div>'
    : '<div id="skinManager" class="skin-manager show"><div class="sm-body" id="skinBody"></div></div>'}
    <script>window.fixtureErrors=[];window.addEventListener('error',e=>fixtureErrors.push(e.message));
      window.addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)));
      function _syncSidebar(){} function expandForOverlay(){} function shrinkFromOverlay(){}
      window.__deskPanel=${pet ? 'null' : "'skin'"};</script>
    ${files.map(file => '<script src="' + file + '"></script>').join('\n')}
    <script>applyTheme();${pet ? 'updatePet();' : 'renderSkinGrid();'}window.fixtureReady=true;</script>
    </body></html>`;
}

async function until(window, code, label) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const value = await run(window, code);
    if (value) return value;
    await delay(25);
  }
  throw Error('Timed out: ' + label);
}

async function open(pet, saved) {
  const window = new BrowserWindow({ show:false, width:680, height:760,
    webPreferences:{ preload, contextIsolation:true, nodeIntegration:false, backgroundThrottling:false, offscreen:true } });
  windows.add(window);
  window.webContents.on('paint', (_event, _rect, image) => frames.set(window, image));
  window.on('closed', () => { windows.delete(window); frames.delete(window); });
  await window.loadURL(base + '/seed');
  if (saved !== undefined) await run(window, `localStorage.clear();${saved ? 'localStorage.setItem(' + JSON.stringify(cfgKey) + ',' + JSON.stringify(JSON.stringify(saved)) + ')' : ''}`);
  await window.loadURL(base + (pet ? '/pet' : '/skins'));
  window.setSize(680, 760);
  await until(window, 'innerWidth === 680 && innerHeight === 760', 'headless viewport size');
  await until(window, 'window.fixtureReady', 'fixture scripts initialized');
  return window;
}

async function close(window) {
  report.errors.push(...await run(window, 'fixtureErrors'));
  window.destroy();
}

async function screenshot(window, file, crop) {
  // Read the real offscreen paint pixels. Headless Ozone has no native surface
  // for capturePage(rect), even though Chromium has painted the whole frame.
  await delay(120);
  const image = frames.get(window);
  assert.ok(image && !image.isEmpty(), 'Chromium painted a nonempty frame');
  assert.ok(image.getSize().width >= 680 && image.getSize().height >= 760, 'paint covers the viewport');
  const png = (crop ? image.crop(crop) : image).toPNG();
  assert.ok(png.length > 100, 'screenshot contains actual pixels');
  fs.writeFileSync(path.join(output, file), png);
}

async function assertLogo(window) {
  assert.equal(await run(window, `currentSkinId() === 'soduwork-logo' && document.documentElement.dataset.character === 'soduwork'`), true);
  assert.equal(await run(window, `document.querySelector('#petSvg image')?.getAttribute('href') === 'icon.png' && !document.querySelector('#pet').classList.contains('soduwork-sprite-active')`), true);
  assert.equal(await run(window, `getComputedStyle(document.querySelector('#petSvg')).display !== 'none' && document.querySelector('#petSvg').getBoundingClientRect().width > 0`), true);
  const image = await run(window, `(async()=>{const image=new Image();image.src='icon.png';await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    return {width:image.width,cornerAlpha:ctx.getImageData(0,0,1,1).data[3],centerAlpha:ctx.getImageData(image.width/2,image.height/2,1,1).data[3]};})()`);
  assert.equal(image.width, 1024);
  assert.equal(image.cornerAlpha, 0);
  assert.ok(image.centerAlpha > 240);
}

async function click(window, id) {
  await delay(300);
  const point = await run(window, `(()=>{const card=document.querySelector('.skin-card[data-id=${JSON.stringify(id)}]');
    card.scrollIntoView({block:'center',behavior:'instant'});const rect=card.getBoundingClientRect();
    const x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2);
    return {x,y,hit:document.elementFromPoint(x,y)?.closest('.skin-card')?.dataset.id,
      target:document.elementFromPoint(x,y)?.outerHTML.slice(0,200),
      manager:document.querySelector('#skinManager').getBoundingClientRect().toJSON()};})()`);
  assert.equal(point.hit, id, 'card is visible and receives input: ' + JSON.stringify(point));
  window.webContents.focus();
  window.webContents.sendInputEvent({type:'mouseMove', x:point.x, y:point.y});
  window.webContents.sendInputEvent({type:'mouseDown', button:'left', clickCount:1, x:point.x, y:point.y});
  window.webContents.sendInputEvent({type:'mouseUp', button:'left', clickCount:1, x:point.x, y:point.y});
  await until(window, 'cfg._lastSkinId === ' + JSON.stringify(id), 'native click selects ' + id);
}

app.whenReady().then(async () => {
  server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://fixture').pathname.slice(1);
    requests.push(name);
    if (['pet', 'skins', 'seed'].includes(name)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(name === 'seed' ? '<!doctype html><body></body>' : html(name === 'pet'));
    }
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep) || !fs.statSync(file, {throwIfNoEntry:false})?.isFile()) { res.writeHead(404); return res.end(); }
    const mime = {'.js':'text/javascript', '.css':'text/css', '.png':'image/png'}[path.extname(file)];
    if (!mime) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', mime);
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  fs.mkdirSync(output, {recursive:true});
  let pet = await open(true, null);
  await assertLogo(pet);
  assert.equal(broadcasts, 0);
  assert.equal(requests.some(name => name.includes('/soduwork-actions/')), false);
  report.cases.push('Fresh install: visible transparent color logo, no config writes or old action frames');
  for (const theme of ['light', 'dark']) {
    await run(pet, `document.body.style.background=${JSON.stringify(theme === 'light' ? '#ffffff' : '#1f2937')};applyTheme();updatePet();`);
    await assertLogo(pet);
    await run(pet, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await screenshot(pet, 'pet-' + theme + '.png', {x:20,y:20,width:110,height:110});
  }
  report.cases.push('Actual SVG image decode and native screenshots on light/dark backgrounds');
  for (const [state, status] of [['resting',null],['ready','todo'],['working','doing'],['complete','done']]) {
    await run(pet, `tasks.length=0;${status ? 'tasks.push({id:"isolated-state-fixture",status:' + JSON.stringify(status) + '});' : ''}updatePet()`);
    assert.equal(await run(pet, 'SoduWorkPetSkin.currentState()'), state);
    await assertLogo(pet);
  }
  await run(pet, 'tasks.length=0;updatePet()');
  assert.equal(requests.some(name => name.includes('/soduwork-actions/')), false);
  report.cases.push('State updates retain the new logo without activating legacy sprites');
  await close(pet);
  for (const saved of [
    {character:'box',theme:'vivid',_lastSkinId:'box-biz',hubX:36,hubY:36},
    {character:'soduwork',theme:'signature',_lastSkinId:'soduwork-signature',hubX:36,hubY:36},
  ]) {
    pet = await open(true, saved);
    await assertLogo(pet);
    assert.equal(await run(pet, `JSON.parse(localStorage.getItem(${JSON.stringify(cfgKey)}))._lastSkinId`), 'soduwork-logo');
    report.cases.push('Upgrade persisted for ' + saved._lastSkinId);
    await close(pet);
  }
  pet = await open(true);
  await assertLogo(pet);
  const desk = await open(false);
  assert.equal(await run(desk, `document.querySelector('.skin-card').dataset.id`), 'soduwork-logo');
  assert.equal(await run(desk, `document.querySelector('.skin-card[data-id="soduwork-logo"] img').getAttribute('src')`), 'icon.png');
  const before = broadcasts;
  await click(desk, 'soduwork-signature');
  await until(pet, `SoduWorkPetSkin.isSpriteReady() && document.querySelector('#pet').classList.contains('soduwork-sprite-active')`, 'old skin manually selectable');
  await click(desk, 'soduwork-logo');
  await until(pet, `cfg._lastSkinId === 'soduwork-logo' && !document.querySelector('#pet').classList.contains('soduwork-sprite-active')`, 'new skin synchronized');
  await assertLogo(pet);
  await delay(100);
  assert.equal(broadcasts - before, 2, 'one broadcast per selection, no feedback loop');
  await screenshot(desk, 'appearance.png');
  report.cases.push('Native appearance-card clicks update the other renderer via IPC, clear old sprite, and do not echo');
  await click(desk, 'box-biz');
  await until(pet, `currentSkinId() === 'box-biz'`, 'old box synchronized');
  await close(pet); await close(desk);
  pet = await open(true);
  assert.equal(await run(pet, 'currentSkinId()'), 'box-biz');
  report.cases.push('Explicit old skin choice survives closing and reopening the renderer');
  await close(pet);
  pet = await open(true, {character:'bear',theme:'azure',_lastSkinId:'flat-azure-glass'});
  assert.equal(await run(pet, 'currentSkinId()'), 'flat-azure-glass');
  report.cases.push('Existing non-default skin is preserved');
  for (const window of windows) report.errors.push(...await run(window, 'fixtureErrors'));
  assert.deepEqual(report.errors, []);
  report.ok = true;
}).catch(error => {
  report.errors.push(error.stack || String(error));
  process.exitCode = 1;
}).finally(async () => {
  fs.mkdirSync(output, {recursive:true});
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  for (const window of windows) window.destroy();
  if (server) await new Promise(resolve => server.close(resolve));
  ipcMain.removeAllListeners(channel);
  app.exit(process.exitCode || 0);
});
