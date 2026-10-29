'use strict';
// Compare old/new production styles in real Chromium without opening the app.
// Pass a baseline CSS file, e.g. one exported from the pre-extraction Git ref.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const args = [__filename, ...process.argv.slice(2), '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
  if (process.platform === 'linux' && !env.DISPLAY) args.push('--ozone-platform=headless');
  const result = require('node:child_process').spawnSync(electron, args, { env, encoding: 'utf8', timeout: 60000 });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error.message);
  process.exit(result.status === 0 && /"ok":true/.test(result.stdout || '') ? 0 : 1);
}
const { app, BrowserWindow } = electron;
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const client = path.join(__dirname, '..');
const baseline = process.argv.slice(2).find(value => !value.startsWith('--'));
if (!baseline || !fs.statSync(baseline, { throwIfNoEntry: false })?.isFile()) {
  fs.writeSync(2, 'Pass the pre-extraction panels-schedules.css path.\n'); app.exit(1);
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-schedule-style-'));
app.setPath('userData', path.join(temporary, 'profile')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { fs.writeSync(2, 'Stylesheet comparison timed out.\n'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: !/^(?:file:|data:|about:)/.test(details.url) }));
  const url = file => pathToFileURL(path.resolve(file)).href;
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
    '<link rel="stylesheet" href="' + url(path.join(client, 'theme/variables.css')) + '">' +
    '<link id="entry" rel="stylesheet" href="' + url(baseline) + '">' +
    '<link rel="stylesheet" href="' + url(path.join(client, 'components/panels/panels-connections.css')) + '">' +
    '<style>*{animation:none!important;transition:none!important;box-sizing:border-box}body{margin:0}.sch-panel{position:relative!important;inset:auto!important;width:100%!important}</style>' +
    '<body><section id="schPanel" class="sch-panel show"><div class="sch-body">' +
    '<div class="sch-recipes"><header><div><b>Recipes</b><span>Choose</span></div></header><div><button data-probe><i>1</i><span>Template</span></button></div></div>' +
    '<div class="sch-list"><article class="sch-item" data-probe><div class="sch-i-body" data-probe><b class="sch-i-title">Schedule</b><div class="sch-i-when"><b>daily</b><i>12:00</i></div></div><footer class="sch-i-foot" data-probe><div class="sch-i-ops"><button class="btn-mini">Run</button></div></footer></article></div>' +
    '<button class="md-clear" data-probe>Clear</button><button class="md-addbtn" data-probe>Add</button><span class="sk-c-src" data-probe>Source</span></div></section>' +
    '<section id="mdPanel" class="sch-panel show"><div class="sch-body"><div class="md-top" data-probe><span class="md-stat is-mine" data-probe><b>2</b></span><input class="md-q" data-probe></div>' +
    '<div class="md-rows" data-probe><article class="md-row is-mine" data-probe><div class="md-rbody" data-probe><input class="md-in" data-probe><button class="md-clear" data-probe>Clear</button></div></article></div>' +
    '<article class="md-prov is-mine" data-probe><div class="md-prov-h" data-probe><b>Provider</b><span class="md-prov-tag is-org" data-probe>Ready</span></div><div class="md-prov-ms"><span class="md-mtag is-more" data-probe>Model</span></div></article>' +
    '<div class="md-blank" data-probe><b>Empty</b></div><div class="md-list"><article class="md-item" data-probe><div class="md-item-m"><b class="md-nm" data-probe>Name</b><span class="md-from is-mine" data-probe>Own</span></div></article></div></div></section>' +
    '<section id="skillsPanel" class="sch-panel show"><div class="sch-body"><div class="sk-grid" data-probe><button class="sk-card on" data-probe><span class="sk-c-ico" data-probe>Icon</span><span class="sk-c-main"><b>Skill</b><i class="sk-c-desc" data-probe>Description</i></span></button></div>' +
    '<div class="sk-tip" data-probe>Hint</div><div class="sk-revoked" data-probe>Revoked</div><label class="sk-row on" data-probe><input type="checkbox"><span class="sk-r-main" data-probe><b>Skill</b><i>Detail</i></span></label></div></section></body></html>';
  const page = path.join(temporary, 'styles.html'); fs.writeFileSync(page, html);
  await win.loadFile(page);
  const run = code => win.webContents.executeJavaScript(code, true);
  const loadSheet = href => run(`new Promise((resolve,reject)=>{const old=document.querySelector('#entry'),link=document.createElement('link');
    link.id='entry';link.rel='stylesheet';link.onload=()=>setTimeout(resolve,30);link.onerror=()=>reject(Error('Stylesheet failed to load'));
    link.href=${JSON.stringify(href)};old.replaceWith(link)})`);
  const sample = `Array.from(document.querySelectorAll('[data-probe]'),el=>{const style=getComputedStyle(el),rect=el.getBoundingClientRect();return{
    style:Object.fromEntries(Array.from(style,key=>[key,style.getPropertyValue(key)])),rect:[rect.x,rect.y,rect.width,rect.height]}})`;
  let probes = 0;
  for (const width of [1360, 700, 420]) {
    win.setContentSize(width, 900);
    await loadSheet(url(baseline));
    const before = await run(sample);
    await loadSheet(url(path.join(client, 'components/panels/panels-schedules.css')));
    const after = await run(sample), differences = [];
    assert.equal(after.length, before.length);
    before.forEach((row, index) => {
      for (const [property, value] of Object.entries(row.style)) if (after[index].style[property] !== value) differences.push({ index, property, before: value, after: after[index].style[property] });
      if (JSON.stringify(row.rect) !== JSON.stringify(after[index].rect)) differences.push({ index, property: 'bounds', before: row.rect, after: after[index].rect });
    });
    assert.deepEqual(differences, [], 'computed style/bounds changed at width ' + width);
    probes = after.length;
  }
  fs.writeSync(1, JSON.stringify({ ok: true, widths: 3, probes, properties: 'all computed properties and element bounds' }) + '\n');
  win.destroy();
}).catch(error => { fs.writeSync(2, String(error.stack || error) + '\n'); process.exitCode = 1; }).finally(() => {
  clearTimeout(deadline); fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 }); app.exit(process.exitCode || 0);
});
