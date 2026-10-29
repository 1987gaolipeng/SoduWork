'use strict';
// Native Chromium input against the production pickers; no network or model.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-candidate-keyboard-'));
  const label = process.argv.find(value => /^--label=/.test(value))?.slice(8) || 'current';
  const out = path.resolve(client, '../outputs/candidate-keyboard-20261014', label);
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', path.join(root, 'profile'));
  const report = { ok: false, cases: [], errors: [] };
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code, name) {
    const end = Date.now() + 8000;
    while (Date.now() < end) { const result = await js(code); if (result) return result; await delay(20); }
    throw Error('Timed out: ' + name);
  }
  async function key(keyCode, count = 1) {
    for (let i = 0; i < count; i++) {
      for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode });
      await delay(12);
    }
    await delay(30);
  }
  async function type(value) {
    await js(`(()=>{pluginPicker.clear();skillPicker.clear();input.value='';input.focus()})()`);
    await win.webContents.insertText(value);
    await until(`document.querySelector(${JSON.stringify(value.startsWith('/') ? '.nplugin-menu:not([hidden]) .nplugin-option' : '.cp-skill-menu.show .cp-skill-option')})`, 'menu ready');
  }
  async function state(kind) {
    return js(`(()=>{const menu=document.querySelector(${JSON.stringify(kind === 'plugin' ? '.nplugin-menu' : '.cp-skill-menu')});
      const option=menu.querySelector(${JSON.stringify(kind === 'plugin' ? '.is-active' : '.active')});
      const r=option?.getBoundingClientRect(),m=menu.getBoundingClientRect();
      return {name:option?.querySelector('b')?.textContent,disabled:option?.disabled||option?.getAttribute('aria-disabled')==='true',
        visible:!!r&&r.top>=m.top+menu.clientTop-1&&r.bottom<=m.top+menu.clientTop+menu.clientHeight+1,
        scroll:menu.scrollTop,page:document.querySelector('#outer').scrollTop,count:menu.querySelectorAll('[role=option]').length,
        active:input.getAttribute('aria-activedescendant'),optionId:option?.id}})()`);
  }
  async function wheel(kind, bottom = false) {
    const point = await js(`(()=>{const r=document.querySelector(${JSON.stringify(kind === 'plugin' ? '.nplugin-menu' : '.cp-skill-menu')}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.focus(); win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await delay(80);
    win.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaY: -2500, deltaX: 0 });
    await until(`document.querySelector(${JSON.stringify(kind === 'plugin' ? '.nplugin-menu' : '.cp-skill-menu')}).scrollTop>300`, 'native wheel scroll');
    await delay(100);
    if (bottom) {
      for (let i = 0; i < 15; i++) {
        if (await js(`(()=>{const m=document.querySelector(${JSON.stringify(kind === 'plugin' ? '.nplugin-menu' : '.cp-skill-menu')});return m.scrollTop+m.clientHeight>=m.scrollHeight-2})()`)) return;
        win.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaY: -2500, deltaX: 0 });
        await delay(100);
      }
      throw Error('Native wheel did not reach final option');
    }
  }
  async function click(selector) {
    const point = await js(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});const r=b.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!b.contains(document.elementFromPoint(x,y)))throw Error('occluded bottom option');return{x,y}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(50);
  }
  async function verify(name, action) {
    try { await action(); report.cases.push({ name, ok: true }); }
    catch (error) {
      report.cases.push({ name, ok: false, error: error.stack });
      fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
    }
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: true, title: 'SoduWork candidate keyboard regression (isolated)',
      skipTaskbar: true, width: 1100, height: 850, webPreferences: {
        contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
      (_request, callback) => callback({ cancel: true }));
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message); });
    const styles = ['theme/variables.css', 'components/panels/chat-plugin-mention.css', 'components/panels/panels-compose-skills.css'];
    const html = '<!doctype html><meta charset="utf-8">' + styles.map(file =>
      '<link rel="stylesheet" href="' + pathToFileURL(path.join(client, file)).href + '">').join('') +
      '<style>body{margin:0;font-family:Arial}#outer{height:820px;overflow:auto}.spacer{height:700px}' +
      '#host{position:relative;width:670px;margin:0 70px}textarea{width:650px;height:70px}</style>' +
      '<div id="outer"><div class="spacer"></div><div id="host" class="work-composer"><textarea id="input"></textarea></div><div class="spacer"></div></div>';
    const file = path.join(root, 'picker.html'); fs.writeFileSync(file, html);
    await win.loadFile(file);
    for (const file of ['compose-candidate-navigation.js', 'chat-plugin-mention-model.js', 'chat-plugin-mention.js', 'panels-compose-skills.js']) {
      const source = path.join(client, 'components/panels', file);
      if (fs.existsSync(source)) await js(fs.readFileSync(source, 'utf8') + '\nvoid 0;');
    }
    await js(`(()=>{window.input=document.querySelector('#input');window.messages=[];window.installRequests=[];
      window.SoduWorkPluginInstallSetup={openInline(item){installRequests.push(item.pluginId);return {}}};
      window.PluginUIHost={mount(){return {}}};
      const catalog=Array.from({length:28},(_,i)=>({pluginId:'p'+i,key:'picker'+i,name:'Picker '+String(i).padStart(2,'0'),personal:true,enabled:true}));
      catalog.push(...Array.from({length:4},(_,i)=>({pluginId:'blocked'+i,name:'Picker blocked '+i,personal:true,enabled:false,
        conversationUse:{available:false,code:'disabled',label:'Disabled'}})));
      catalog.push(...Array.from({length:3},(_,i)=>({pluginId:'remote'+i,name:'Picker remote '+i,installed:false,
        marketPolicy:{installation:'self_service'},conversationUse:{available:false,code:'install_required',label:'Install'}})));
      window.pluginPicker=ChatPluginMention.create({input,host:document.querySelector('#host'),catalog:async()=>({items:catalog}),say:m=>messages.push(m)});
      window.skillPicker=ComposeSkills.create({input,host:document.querySelector('#host'),loading:false,say:m=>messages.push(m)});
      window.skills=Array.from({length:35},(_,i)=>({name:'picker-'+String(i).padStart(2,'0'),description:'Keyboard fixture',installed:true,selectable:i%6!==2}));
      skillPicker.setItems(skills);document.querySelector('#outer').scrollTop=160;input.focus()})()`);

    await verify('plugin-overflow-visible', async () => {
      await type('/picker'); await key('Down', 18);
      const s = await state('plugin');
      assert.equal(s.name, 'Picker 18'); assert.ok(s.visible, 'keyboard active row must be visible');
      assert.ok(s.scroll > 0); assert.equal(s.page, 160); assert.equal(s.active, s.optionId);
      fs.writeFileSync(path.join(out, 'plugin-active-bottom.png'), (await win.webContents.capturePage()).toPNG());
    });
    await verify('plugin-disabled-indices-and-tab', async () => {
      await type('/picker'); await key('Down', 28);
      const s = await state('plugin');
      assert.equal(s.name, 'Picker remote 0'); assert.equal(s.disabled, false); assert.ok(s.visible);
      await key('Tab'); assert.deepEqual(await js('installRequests.splice(0)'), ['remote0']);
    });
    await verify('plugin-wrap-up-and-down', async () => {
      await type('/picker'); await key('Up');
      assert.equal((await state('plugin')).name, 'Picker remote 2');
      await key('Down'); assert.equal((await state('plugin')).name, 'Picker 00');
      await key('Down', 30); assert.equal((await state('plugin')).name, 'Picker remote 2');
      await key('Down'); assert.equal((await state('plugin')).name, 'Picker 00');
    });
    await verify('plugin-filter-and-enter', async () => {
      await type('/picker'); await key('Down', 20);
      await win.webContents.insertText(' 27');
      // Whitespace ends a slash token; typing a fresh filtered token checks reset.
      await type('/picker27');
      assert.equal((await state('plugin')).name, 'Picker 27'); await key('Return');
      assert.deepEqual(await js('pluginPicker.selected().map(item=>item.pluginId)'), ['p27']);
      assert.equal(await js('input.value'), '');
    });
    await verify('plugin-wheel-and-refresh-preserve-scroll', async () => {
      await type('/picker');
      await wheel('plugin');
      const before = (await state('plugin')).scroll;
      await js('window.dispatchEvent(new Event("soduwork:plugins-changed"))'); await delay(100);
      assert.equal((await state('plugin')).scroll, before, 'catalog repaint must preserve wheel position');
      await key('Down'); assert.ok((await state('plugin')).visible);
    });
    await verify('plugin-wheel-bottom-click', async () => {
      await type('/picker'); await wheel('plugin', true);
      await click('.nplugin-option:last-child');
      assert.deepEqual(await js('installRequests.splice(0)'), ['remote2']);
      assert.equal(await js('document.querySelector("#outer").scrollTop'), 160);
    });
    await verify('plugin-all-disabled-cannot-select', async () => {
      await type('/blocked'); await key('Down'); await key('Return'); await key('Tab');
      assert.deepEqual(await js('pluginPicker.selected()'), []); assert.equal(await js('input.value'), '/blocked');
      assert.equal(await js('input.getAttribute("aria-activedescendant")'), null);
    });
    await verify('skill-full-list-and-disabled', async () => {
      await type('#picker'); assert.equal((await state('skill')).count, 35, 'all matching skills must be rendered');
      await key('Down', 18);
      const s = await state('skill');
      assert.equal(s.name, '#picker-22'); assert.equal(s.disabled, false); assert.ok(s.visible);
      assert.ok(s.scroll > 0); assert.equal(s.page, 160); assert.equal(s.active, s.optionId);
      fs.writeFileSync(path.join(out, 'skill-active-bottom.png'), (await win.webContents.capturePage()).toPNG());
    });
    await verify('skill-wrap-and-enter', async () => {
      await type('#picker'); await key('Up');
      assert.equal((await state('skill')).name, '#picker-34');
      await key('Down'); assert.equal((await state('skill')).name, '#picker-00');
      await key('Up'); await key('Return');
      assert.deepEqual(await js('skillPicker.selected()'), ['picker-34']);
      assert.equal(await js('input.value'), '');
    });
    await verify('skill-filter-and-tab', async () => {
      await type('#picker'); await key('Down', 15);
      await win.webContents.insertText('-33');
      assert.equal((await state('skill')).name, '#picker-33');
      await key('Tab'); assert.deepEqual(await js('skillPicker.selected()'), ['picker-33']);
    });
    await verify('skill-all-disabled-cannot-select', async () => {
      await js('skillPicker.setItems([{name:"blocked",installed:true,selectable:false,reason:"Disabled"}])');
      await type('#blocked'); await key('Down'); await key('Return'); await key('Tab');
      assert.deepEqual(await js('skillPicker.selected()'), []); assert.equal(await js('input.value'), '#blocked');
      assert.equal(await js('input.getAttribute("aria-activedescendant")'), null);
    });
    await verify('skill-wheel-refresh-bottom-click', async () => {
      await js('skillPicker.setItems(skills);localStorage.removeItem("soduwork.compose.skill.recent.v1")');
      await type('#picker'); await wheel('skill', true);
      const before = (await state('skill')).scroll;
      await js('skillPicker.setItems(skills)');
      assert.equal((await state('skill')).scroll, before);
      await click('[data-skill-name="picker-34"]');
      assert.deepEqual(await js('skillPicker.selected()'), ['picker-34']);
      assert.equal(await js('document.querySelector("#outer").scrollTop'), 160);
    });
    await verify('literal-body-has-no-metadata', async () => {
      await js('skillPicker.setItems(skills)');
      await type('#picker'); await key('Escape');
      const result = await js('ComposeSkills.submission(input.value,skillPicker.selected())');
      assert.deepEqual(result, { text: '#picker', skills: [] });
      await type('/picker'); await key('Escape');
      assert.deepEqual(await js('pluginPicker.selected()'), []); assert.equal(await js('input.value'), '/picker');
    });
    report.ok = report.cases.every(row => row.ok) && !report.errors.length;
  }).catch(error => report.errors.push(error.stack)).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, cases: report.cases.map(row => ({ name: row.name, ok: row.ok, error: row.error?.split('\n')[0] })), errors: report.errors, out }, null, 2));
    if (win && !win.isDestroyed()) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
