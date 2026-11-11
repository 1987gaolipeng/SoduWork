// Actual workspace renderer, isolated profile and local source files only.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-enlarged-theme-'));
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
let win, overlay, server;
const results = [], errors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code, true);
async function until(source, label) {
  for (let i = 0; i < 120; i++) { if (await js(source)) return; await sleep(50); }
  throw Error('Timed out: ' + label);
}
async function appearance() {
  await js(`document.querySelector('[data-rail-view="settings"]').click()`);
  await until(`!!document.querySelector('[data-view="skin"]')`, 'appearance navigation');
  await js(`document.querySelector('[data-view="skin"]').click()`);
  await until(`!!document.querySelector('.skin-card[data-id="soduwork-enlarged"]')`, 'enlarged theme card');
}
async function select(id) {
  await js(`document.querySelector('.skin-card[data-id="${id}"]').click()`);
  await until(`document.querySelector('.skin-card.active')?.dataset.id==='${id}'`, 'active theme');
}
async function sample() {
  return js(`(()=>{
    const css = getComputedStyle(document.documentElement), label = document.querySelector('.si-desc');
    const scopes = ['#cpChat','#composePanel','.requirements-board','.ncollab-picker','.tfd-shell','.wi-tools','.wi-brief','.wi-rail'];
    const values = Object.fromEntries(scopes.map(selector=>{let el=document.querySelector(selector),added=false;if(!el&&!selector.startsWith('#')){el=document.createElement('div');el.className=selector.slice(1);document.body.append(el);added=true}const value=el&&getComputedStyle(el).getPropertyValue('--font-min-readable').trim();if(added)el.remove();return[selector,value]}));
    return { theme:document.documentElement.dataset.theme, minimum:css.getPropertyValue('--font-min-readable').trim(), label:parseFloat(getComputedStyle(label).fontSize), values, cfg:JSON.parse(localStorage.getItem('soduwork_work_cfg_v5')), width:innerWidth, pageWidth:document.documentElement.scrollWidth };
  })()`);
}
app.whenReady().then(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = path.resolve(root, decodeURIComponent(url.pathname.slice(1)));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    const ext = path.extname(file), types = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' }); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const isolated = session.fromPartition('enlarged-theme-' + Date.now());
  isolated.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('data:') }));
  win = new BrowserWindow({ show:false, width:1280, height:900, webPreferences:{ session:isolated,offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false } });
  win.webContents.on('console-message', event => { if (/Uncaught|SyntaxError/.test(event.message)) errors.push(event.message); });
  await win.loadURL(origin + '/desk.html?panel=workspace');
  await until(`!!document.querySelector('[data-rail-view="settings"]')`, 'workspace');
  await js(`dispatchEvent(new CustomEvent('soduwork-device-auth',{detail:{state:'active',user:{id:'fixture-user',displayName:'Fixture'}}})); cfg.fontScale='large';cfg.uiScale='medium';saveCfg();applyFontScale();`);
  await appearance();
  const before = await sample();
  assert.equal(before.minimum, '12px');
  await select('soduwork-enlarged');
  const enlarged = await sample();
  assert.equal(enlarged.minimum, '15px');
  assert.ok(enlarged.label >= 15 && enlarged.label > before.label);
  assert.ok(Object.values(enlarged.values).every(v => v === null || v === '15px'), JSON.stringify(enlarged.values));
  assert.equal(enlarged.cfg.fontScale, 'large');
  assert.equal(enlarged.cfg.uiScale, 'medium');
  results.push({ name:'select enlarged theme without overwriting scale preferences', before, enlarged });
  // The desktop overlay reads the same persisted choice in its own renderer.
  overlay = new BrowserWindow({show:false,width:500,height:600,webPreferences:{session:isolated,offscreen:true,contextIsolation:true,nodeIntegration:false}});
  await overlay.loadURL(origin + '/index.html');
  for (let i=0;i<100;i++) {
    if (await overlay.webContents.executeJavaScript(`document.documentElement.dataset.theme==='enlarged'`)) break;
    await sleep(50);
  }
  assert.deepEqual(await overlay.webContents.executeJavaScript(`({theme:document.documentElement.dataset.theme,minimum:getComputedStyle(document.documentElement).getPropertyValue('--font-min-readable').trim()})`),{theme:'enlarged',minimum:'15px'});
  results.push({name:'desktop overlay restores persisted enlarged theme',ok:true});
  overlay.destroy();overlay=null;
  for (const [width,height] of [[1280,900],[1000,650],[800,600]]) {
    win.setSize(width,height);await sleep(150);
    const geometry = await js(`(()=>{const els=[...document.querySelectorAll('.skin-card')];const bad=els.filter(el=>{const r=el.getBoundingClientRect();return r.left<0||r.right>innerWidth+1||el.scrollWidth>el.clientWidth+1});return {width:innerWidth,pageWidth:document.documentElement.scrollWidth,bad:bad.map(el=>el.dataset.id),bodyHeight:document.querySelector('#skinBody').clientHeight,scrollHeight:document.querySelector('#skinBody').scrollHeight};})()`);
    assert.ok(geometry.pageWidth <= geometry.width + 1, JSON.stringify(geometry));
    assert.deepEqual(geometry.bad, []);
    await js(`document.querySelector('.skin-card:last-child').scrollIntoView({block:'end'})`);
    assert.ok(await js(`(()=>{const e=document.querySelector('.skin-card:last-child .si-name'),r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()`), 'last theme remains reachable');
    results.push({ name:'theme grid fits and scrolls', width, height, geometry });
    fs.writeFileSync(path.join(output, 'enlarged-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  await win.reload();
  await until(`document.documentElement.dataset.theme==='enlarged'`, 'persisted enlarged theme');
  await js(`dispatchEvent(new CustomEvent('soduwork-device-auth',{detail:{state:'active',user:{id:'fixture-user',displayName:'Fixture'}}}))`);
  await appearance();
  assert.equal((await sample()).minimum, '15px');
  for (const [locale, label] of [['en-US','Enlarged'],['ja-JP','拡大'],['ko-KR','확대']]) {
    await js(`SoduWorkI18n.setLocale('${locale}');renderSkinGrid()`);
    await until(`document.querySelector('[data-id="soduwork-enlarged"] .si-name').textContent===${JSON.stringify(label)}`, 'translated theme name');
  }
  await select('soduwork-logo');
  const restored = await sample();
  assert.equal(restored.minimum, '12px');
  assert.equal(restored.cfg.fontScale, 'large');
  const saved = await js('localStorage.getItem("soduwork_work_cfg_v5")');
  await js('applySkin("unknown-theme-fixture")');
  assert.equal(await js('localStorage.getItem("soduwork_work_cfg_v5")'), saved, 'unknown theme must not alter settings');
  await win.reload();await until(`document.documentElement.dataset.theme==='vivid'`, 'restored theme persists');
  assert.deepEqual(errors, []);
  results.push({ name:'reload, localization, switch back and unknown selection', ok:true, restored });
  fs.writeFileSync(path.join(output,'browser-report.json'),JSON.stringify({ok:true,platform:process.platform,results,errors},null,2));
  console.log(JSON.stringify({ok:true,output,results}));
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{overlay?.destroy();win?.destroy();server?.close();app.exit(process.exitCode||0);});
