'use strict';
// Isolated Electron renderer: production settings, locale engine and picker; no account or network writes.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const root = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-language-picker-'));
  const out = path.resolve(process.argv[2] || path.join(root, '../outputs/settings-language-picker'));
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', path.join(temporary, 'profile'));
  app.disableHardwareAcceleration();
  const report = { ok: false, cases: [], screenshots: [], errors: [], liveAccount: false };
  const read = name => fs.readFileSync(path.join(root, name), 'utf8');
  const trigger = '.set-language .fwd-select-trigger';
  let win;
  const js = code => win.webContents.executeJavaScript(code, true).catch(error => { throw Error(error.message + "\nRenderer script: " + code); });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) {
    for (let i = 0; i < 100; i++) { if (await js(code)) return; await delay(20); }
    throw Error('Timed out: ' + code);
  }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});
      if(!e)throw Error('Missing control: '+${JSON.stringify(selector)});
      const r=e.getBoundingClientRect(),p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
      if(!e.contains(document.elementFromPoint(p.x,p.y)))throw Error('Control is covered: '+${JSON.stringify(selector)}+' at '+JSON.stringify(p)+' scroll '+document.querySelector('#settingsPanel').scrollTop);
      return p;})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type, ...point, button:'left', clickCount:1});
    await delay(35);
  }
  async function key(keyCode) {
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({type, keyCode});
    await delay(35);
  }
  async function reveal() {
    await js(`document.querySelector(${JSON.stringify(trigger)}).scrollIntoView({block:'center',behavior:'instant'});void 0;`);
    await delay(60);
  }
  async function open() {
    await reveal(); await click(trigger);
    await until(`document.querySelectorAll('.fwd-select-popup [role=option]').length===4`);
    assert.equal(await js(`document.querySelector('.fwd-select-search').placeholder`), await js(`SoduWorkI18n.translateText('搜索')`));
    assert.equal(await js(`document.querySelector('.fwd-select-search').getAttribute('aria-label')`), await js(`SoduWorkI18n.translateText('搜索')`));
    assert.equal(await js(`document.querySelector(${JSON.stringify(trigger)}).getAttribute('aria-expanded')`), 'true');
  }
  async function shot(name) {
    const file = path.join(out, name + '.png');
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');
    const capture = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {format:'png'});
    fs.writeFileSync(file, Buffer.from(capture.data, 'base64'));
    report.screenshots.push(file);
  }
  async function checkMenu() {
    assert.deepEqual(await js(`(()=>{const m=document.querySelector('.fwd-select-popup'),r=m.getBoundingClientRect();return {
      attached:m.parentElement===document.body,visible:r.width>0&&r.height>0,
      bounded:r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,
      reachable:[...m.querySelectorAll('[role=option]')].every(e=>{const b=e.getBoundingClientRect();return e.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));})};})()`),
      {attached:true,visible:true,bounded:true,reachable:true});
  }
  async function load() {
    await win.loadFile(path.join(temporary, 'fixture.html'));
    await js(`window.errors=[];addEventListener('error',e=>errors.push(e.message));
      window.cfg={locale:localStorage.getItem('fixture-locale')||'zh-CN'};window.saved=0;window.rendered=0;
      window.saveCfg=()=>{saved++;localStorage.setItem('fixture-locale',cfg.locale)};window.render=()=>rendered++;
      window.petSay=()=>{};window.User={id:'fixture',name:'Test'};
      window.soduWorkAPI={onLocaleChange:fn=>window.receiveLocale=fn,setLocale:()=>Promise.resolve()};void 0;`);
    for (const name of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + name));
    for (const name of ['core/i18n-dom.js', 'core/i18n.js', 'components/panels/panels-forward-select.js', 'components/settings/settings.js']) {
      await js(read(name) + '\nvoid 0;');
    }
    await js('openSettings();new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');
  }
  app.whenReady().then(async () => {
    const desk = read('desk.html');
    const settings = desk.slice(desk.indexOf('<div class="panel" id="settingsPanel">'), desk.indexOf('<div class="skin-manager"'));
    const styles = [...desk.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(m => m[1]);
    fs.writeFileSync(path.join(temporary, 'fixture.html'), '<!doctype html><html data-desk-panel="workspace" data-workspace-view="settings"><head><meta charset="utf-8">' +
      styles.map(name => '<link rel="stylesheet" href="'+pathToFileURL(path.join(root,name)).href+'">').join('') +
      '</head><body>' + settings + '</body></html>');
    win = new BrowserWindow({show:false,width:1100,height:820,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
    win.webContents.debugger.attach('1.3');
    win.webContents.on('console-message', details => { if(details.level==='error')console.error(details.message); });
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (_details, cb) => cb({cancel:true}));
    await load();
    await open(); await checkMenu(); await shot('language-zh-open');
    const label = await js(`document.querySelector('${trigger}').getAttribute('aria-label')`);
    assert.match(label, /语言/);
    await key('Escape');
    assert.equal(await js(`document.activeElement.matches('${trigger}')`), true);
    assert.equal(await js(`!!document.querySelector('.fwd-select-popup')`), false);
    report.cases.push('First click opens four visible, hit-testable choices; Escape restores trigger focus');

    for (const [locale, title] of [['en-US','Language'],['ja-JP','言語'],['ko-KR','언어'],['zh-CN','语言']]) {
      const before = await js('saved');
      await open(); await click('.fwd-select-option[data-value="'+locale+'"]');
      await until('SoduWorkI18n.getLocale()==='+JSON.stringify(locale));
      assert.equal(await js('cfg.locale'), locale);
      assert.equal(await js('saved'), before+1);
      assert.equal(await js(`document.querySelector('#settingsLanguageLabel').textContent`), title);
      assert.equal(await js(`document.querySelector('${trigger} .fwd-select-value').textContent===document.querySelector('#localeSelect').selectedOptions[0].textContent`), true);
      assert.equal(await js(`document.querySelectorAll('${trigger}').length`), 1);
    }
    report.cases.push('Mouse selection applies and persists zh/en/ja/ko once, keeping label and selected value synchronized');

    for (let i=0;i<8;i++) {
      await open(); await click(trigger);
      assert.equal(await js(`!!document.querySelector('.fwd-select-popup')`), false);
      await open(); await js('closeSettings();void 0;');
      assert.equal(await js(`!!document.querySelector('.fwd-select-popup')`), false);
      await js('openSettings();new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');
    }
    report.cases.push('Repeated toggles and eight settings close/reopen cycles leave no stale menu or duplicate trigger');

    await reveal(); await js(`document.querySelector('${trigger}').focus();void 0;`);
    await key('ArrowDown'); await key('End'); await key('Enter');
    assert.equal(await js('cfg.locale'), 'ko-KR');
    await open(); await key('Tab');
    assert.equal(await js(`document.activeElement.id`), 'workRootInput');
    await open(); await click('#settingsLanguageLabel');
    assert.equal(await js(`!!document.querySelector('.fwd-select-popup')`), false);
    report.cases.push('Keyboard selection, Tab navigation and outside click close the menu without trapping focus');

    await open();
    const before = await js('saved');
    await js(`receiveLocale('ja-JP');void 0;`); await delay(100);
    assert.equal(await js('SoduWorkI18n.getLocale()'), 'ja-JP');
    assert.equal(await js('saved'), before);
    assert.equal(await js(`document.querySelector('.fwd-select-option[aria-selected=true]').dataset.value`), 'ja-JP');
    await checkMenu(); await key('Escape');
    report.cases.push('Incoming locale update refreshes the open menu without saving or rebroadcasting');

    for (const [width,height,zoom] of [[820,650,1],[1100,820,1.25]]) {
      win.setSize(width,height);win.webContents.setZoomFactor(zoom);await delay(100);
      await open(); await checkMenu();
      await js(`document.querySelector('#settingsPanel').scrollTop+=30;void 0;`);await delay(80);
      await checkMenu();await shot('language-menu-'+width+'-'+zoom);
      await js(`document.querySelector('#settingsPanel').scrollTop=0;void 0;`);await delay(80);
      assert.equal(await js(`!!document.querySelector('.fwd-select-popup')`), false);
      await open();await key('Escape');
    }
    report.cases.push('Narrow and zoomed windows keep choices on screen; scrolling follows the control and closes offscreen menus');

    await open();await click('.fwd-select-option[data-value="en-US"]');
    await load();await open();
    assert.equal(await js(`document.querySelector('.fwd-select-option[aria-selected=true]').dataset.value`), 'en-US');
    await checkMenu();
    report.cases.push('Renderer reload restores the saved locale and opens correctly on its first click');
    report.errors = await js('errors');assert.deepEqual(report.errors,[]);report.ok=true;
  }).catch(error => {report.error=error.stack;}).finally(async () => {
    if(!report.ok && win) await shot('failure').catch(()=>{});
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));win?.destroy();app.exit(report.ok?0:1);
  });
}
