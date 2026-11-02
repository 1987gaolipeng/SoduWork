'use strict';
// Load the actual desktop document in a new profile; no live service or CLI is used.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const assert = require('node:assert/strict');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const client = path.resolve(__dirname, '..');
  const entryRoot = path.resolve(process.env.SODUWORK_CODEX_ENTRY_ROOT || client);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-codex-entry-'));
  const out = path.resolve(client, '../outputs/codex-auth-entry' + (entryRoot === client ? '' : '-packaged'));
  app.setPath('userData', profile);
  app.on('window-all-closed', () => {});
  const report = { ok: false, entryRoot, cases: [], errors: [] };
  let win;
  const js = source => win.webContents.executeJavaScript(source, true);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(expression) {
    for (let i = 0; i < 80; i++) { if (await js(expression)) return; await pause(50); }
    throw Error('Timed out: ' + expression);
  }
  async function click(selector) {
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    assert.ok(point, 'Missing control: ' + selector);
    assert.equal(await js(`document.elementFromPoint(${point.x},${point.y})===document.querySelector(${JSON.stringify(selector)})`),
      true, 'The control must receive a real mouse click: ' + selector);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  }
  app.whenReady().then(async () => {
    fs.mkdirSync(out, { recursive: true });
    for (const query of [{ panel: 'workspace', view: 'agents' }, { panel: 'agents' }]) {
      const errors = [];
      win = new BrowserWindow({ show: false, width: 1100, height: 850,
        webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
        (_request, done) => done({ cancel: true }));
      win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
      await win.loadFile(path.join(entryRoot, 'desk.html'), { query });
      // Settle the offline account gate, then provide the fixture identity through its public event.
      await until(`!!document.querySelector('.soduwork-auth-status.is-error')`);
      await js(`dispatchEvent(new CustomEvent('soduwork-device-auth',{detail:{state:'active',user:{id:'fixture-user',username:'fixture',displayName:'Fixture account'},quota:{enabled:false}}}));void 0;`);
      // The local management surface requires current-instance identity;
      // the dialog separately reads the exact selected Runner.
      const unknown = query.panel === 'agents';
      await js(`window.fixtureCalls=[];window.fixtureSetupCalls=[];window.fixtureSetup={modelCount:0,models:[],machines:[{runnerId:'fixture-runner',scope:'current-instance',isCurrentDevice:true,label:'Fixture computer',env:{ok:true},agents:[{key:'codex',name:'Codex',state:'unauthed',auth:'unauthed',authStatus:${JSON.stringify(unknown ? 'unknown' : 'unauthed')},setupState:${JSON.stringify(unknown ? 'unknown' : 'unauthed')},installed:true,present:true,version:'0.164.0',loginAvailable:true,loginFlowVersion:1}]}]};SoduWorkAPI.localAgentSetup=async()=>{fixtureSetupCalls.push('local');return fixtureSetup};SoduWorkAPI.agentSetup=async runnerId=>{fixtureSetupCalls.push(runnerId);if(runnerId!=='fixture-runner')throw Error('Unexpected Runner');return fixtureSetup};SoduWorkAPI.agentInstall=async()=>{fixtureCalls.push('unexpected authorization');throw Error('No CLI authorization is allowed in this fixture')};SoduWorkAPI.agentProbe=async()=>{fixtureCalls.push('unexpected paid probe');throw Error('No paid probe is allowed in this fixture')};openAgentsPanel();void 0;`);
      await until(`!!document.querySelector('[data-alogin="fixture-runner~codex"]')`);
      await click('[data-alogin="fixture-runner~codex"]');
      await pause(150);
      assert.equal(await js(`document.querySelector('dialog.codex-auth-dialog')?.dataset.state`), 'ready',
        'The production desktop entry opens Codex authorization without requesting an app update');
      assert.equal(await js(`document.querySelector('dialog.codex-auth-dialog').matches(':modal')`), true);
      const style = await js(`(()=>{const d=document.querySelector('dialog.codex-auth-dialog'),s=getComputedStyle(d),r=d.getBoundingClientRect();return{radius:s.borderRadius,width:r.width,position:s.position}})()`);
      assert.equal(style.radius, '18px', 'The production dialog stylesheet is loaded');
      assert.equal(style.position, 'fixed');
      assert.ok(style.width > 400 && style.width <= 440);
      assert.deepEqual(await js('fixtureCalls'), [], 'Opening checks status without starting authorization or a model probe');
      assert.ok(await js("fixtureSetupCalls.includes('local') && fixtureSetupCalls.includes('fixture-runner')"),
        'Management uses local inventory and authorization keeps the selected Runner');
      if (unknown) assert.equal(await js("document.querySelector('.codex-auth-primary').textContent"),
        await js("SoduWorkI18n.translateText('继续检查')"));
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      await pause(90);
      fs.writeFileSync(path.join(out, query.panel + '-ready.png'),
        (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
      await click('.codex-auth-secondary');
      await until(`!document.querySelector('dialog.codex-auth-dialog')`);
      report.cases.push({ query, entryUrl: win.webContents.getURL(), state: 'ready', modal: true, style, startupErrors: errors });
      win.destroy(); win = null;
    }
    report.ok = true;
  }).catch(error => { report.errors.push(String(error.stack || error)); }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(report.ok ? 0 : 1);
  });
}
