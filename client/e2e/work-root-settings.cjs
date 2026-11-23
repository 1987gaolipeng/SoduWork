'use strict';
// Production settings, widget DOM and Store preferences in an isolated Electron profile.
// Native folder dialogs are mocked; widget checks do not certify the native overlay compositor.
// node client/e2e/work-root-settings.cjs [output-directory]
const electron = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');

if (typeof electron === 'string') {
  const output = path.resolve(process.argv[2] || path.join(__dirname, '../../outputs/work-root-settings'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-work-root-'));
  fs.mkdirSync(output, {recursive: true});
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  async function run(stage) {
    const child = require('node:child_process').spawn(electron, [__filename, '--fixture', temporary, output, stage],
      {env, windowsHide: true, stdio: 'inherit'});
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    try {
      const code = await new Promise((resolve, reject) => {child.on('error', reject); child.on('exit', resolve);});
      assert.equal(code, 0, 'Isolated Electron stage failed: ' + stage);
    } finally { clearTimeout(timer); }
  }
  (async () => {
    await run('interactions');
    await run('cold-restart');
    const results = ['interactions', 'cold-restart'].map(stage => JSON.parse(fs.readFileSync(path.join(output, stage + '.json'), 'utf8')));
    assert.notEqual(results[0].processId, results[1].processId, 'Cold restart must use a new browser process');
    const report = {ok: true, scope: 'Real Electron settings/widget DOM, CSS, Store defaults, localStorage and API migration; mocked native folder picker/persistence, widget DOM embedded in the fixture rather than the production native overlay controller, two separate browser processes',
      processIds: results.map(result => result.processId), checks: results.flatMap(result => result.checks), screenshots: results.flatMap(result => result.screenshots)};
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ok: true, checks: report.checks.length, output}));
  })().catch(error => {console.error(error); process.exitCode = 1;});
} else {
  const {app, BrowserWindow} = electron;
  const {pathToFileURL} = require('node:url');
  const marker = process.argv.indexOf('--fixture');
  const [temporary, output, stage] = process.argv.slice(marker + 1);
  const client = path.resolve(__dirname, '..');
  app.setPath('userData', path.join(temporary, 'profile'));
  app.disableHardwareAcceleration();
  const report = {ok: false, stage, processId: process.pid, checks: [], screenshots: []};
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let win;
  const js = source => win.webContents.executeJavaScript(source, true);
  const phase = label => console.log(JSON.stringify({stage, phase: label}));
  function check(value, label) {assert(value, label); report.checks.push(label);}
  async function until(source) {
    for (let attempt = 0; attempt < 100; attempt++) {if (await js(source)) return; await delay(20);}
    throw Error('Timed out: ' + source);
  }
  async function clickPicker(waitForCompletion = true) {
    const before = await js('pickerCalls.length');
    const point = await js(`(()=>{
      const button=document.querySelector('#workRootSave');button.scrollIntoView({block:'center',behavior:'instant'});
      const rect=button.getBoundingClientRect(),point={x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
      if(!button.contains(document.elementFromPoint(point.x,point.y)))throw Error('Folder picker is obscured');
      return point;
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',
      {type, ...point, button: 'left', clickCount: 1});
    await until(`pickerCalls.length === ${before + 1}`);
    // Observe the real async handler rather than assuming it settled in 50 ms.
    if (waitForCompletion) await until(`!document.querySelector('#workRootSave').disabled`);
  }
  async function toggleWidget(id) {
    const before = await js(`document.getElementById(${JSON.stringify(id)}).checked`);
    const point = await js(`(()=>{
      const input=document.getElementById(${JSON.stringify(id)});input.scrollIntoView({block:'center',behavior:'instant'});
      const rect=input.getBoundingClientRect(),x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2);
      if(!input.contains(document.elementFromPoint(x,y)))throw Error('Widget checkbox is obscured');
      return{x,y};
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',
      {type, ...point, button: 'left', clickCount: 1});
    await until(`document.getElementById(${JSON.stringify(id)}).checked === ${!before}`);
  }
  async function widgetState(enabled, label) {
    check(await js(`document.querySelector('#petVisibleChk').checked === ${enabled} &&
      document.querySelector('#dockVisibleChk').checked === ${enabled}`), label + ': settings checkboxes');
    check(await js(`(getComputedStyle(document.querySelector('#pet')).display !== 'none') === ${enabled} &&
      document.querySelector('#edgeDock').classList.contains('show') === ${enabled} &&
      document.querySelector('#edgeDock').checkVisibility() === ${enabled}`), label + ': production pet/dock DOM visibility');
  }
  async function shot(name) {
    const file = path.join(output, name + '.png');
    const capture = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {format: 'png'});
    fs.writeFileSync(file, Buffer.from(capture.data, 'base64'));report.screenshots.push(file);
  }
  async function load() {
    phase('loading fixture');
    await win.loadFile(path.join(temporary, 'fixture.html'));
    phase('fixture loaded');
    await js(`window.testErrors=[];window.pickerCalls=[];window.pickerResults=[];window.saveCalls=[];window.saveResults=[];
      addEventListener('error',event=>testErrors.push(event.message));
      addEventListener('unhandledrejection',event=>testErrors.push(String(event.reason)));
      window.petSay=()=>{};window.currentSkinId=()=>'test';
      window.SkinRegistry={getSkin:()=>({name:'Test'})};window.User={name:'Test',id:'isolated'};
      window.soduWorkAPI={getDefaultWorkRoot:async()=>'C:/Isolated/SoduWork',
        clientUpdateStatus:async()=>({state:'current',currentVersion:'test'}),onClientUpdateStatus:()=>{},
        conversationSession:{pickWorkdir:async options=>{pickerCalls.push(options);const next=pickerResults.shift();return typeof next==='function'?next():next;},
          saveWorkdir:async dir=>{saveCalls.push(dir);const next=saveResults.shift();return next||{ok:true,dir};}}};
      window.SoduWorkAPI={getTeamCapability:async()=>({assigned:true,meName:'Test'})};void 0;`);
    const migration = read('api.js').match(/\(function migrateLegacyStorageKeys\(\) \{[\s\S]*?\n\}\)\(\);/)?.[0];
    assert(migration, 'Production startup storage migration is required');
    await js(migration);
    for (const file of ['core/task-sync.js', 'core/store-lifecycle.js', 'core/store.js', 'components/pet/pet-dock.js']) {
      await js(read(file) + '\nvoid 0;');
      phase('loaded ' + file);
    }
    await js(read('components/settings/settings.js') + '\nvoid 0;');
    await js('openSettings();void 0;');
    phase('settings ready');
  }
  app.whenReady().then(async () => {
    phase('Electron ready');
    const desk = read('desk.html');
    const panel = desk.match(/<div class="panel" id="settingsPanel">[\s\S]*?\r?\n<\/div>/)?.[0];
    assert(panel, 'Production settings panel is required');
    const widgets = read('index.html').match(/<div class="stage">[\s\S]*?\n<\/div>/)?.[0];
    assert(widgets, 'Production desktop widget DOM is required');
    const styles = [...desk.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(match => match[1]);
    styles.push('components/pet/pet.css');
    fs.writeFileSync(path.join(temporary, 'fixture.html'), '<!doctype html><html lang="zh-CN" data-desk-panel="workspace" data-workspace-view="settings"><head><meta charset="utf-8">' +
      styles.map(file => '<link rel="stylesheet" href="' + pathToFileURL(path.join(client, file)).href + '">').join('') +
      '</head><body>' + panel + widgets + '</body></html>');
    win = new BrowserWindow({show: false, width: 1440, height: 1000,
      webPreferences: {contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false}});
    win.webContents.debugger.attach('1.3');
    win.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_details, callback) => callback({cancel: true}));
    await load();
    if (stage === 'cold-restart') {
      await widgetState(true, 'explicit widget preferences survive a new Electron process');
      check(await js(`JSON.parse(localStorage.getItem('soduwork_work_cfg_v5')).petVisible === true &&
        JSON.parse(localStorage.getItem('soduwork_work_cfg_v5')).dockVisible === true`), 'cold restart retains the explicitly saved widget values');
      await toggleWidget('petVisibleChk'); await toggleWidget('dockVisibleChk');
      await load();
      await widgetState(false, 'explicitly hiding widgets survives renderer reload');
      await until(`document.querySelector('#workRootInput')?.value === 'C:\\\\'`);
      check(await js(`workRoot()==='C:\\\\'`), 'selected folder survives a separate Electron process with the same profile');
      await js(`document.querySelector('#workRootSave').scrollIntoView({block:'center',behavior:'instant'});void 0;`);
      await shot('work-root-cold-restart');
    } else {
      check(await js(`localStorage.getItem('soduwork_work_cfg_v5') === null`), 'fresh profile has no saved widget preferences');
      await widgetState(false, 'fresh production Store defaults');
      await shot('desktop-widgets-default-hidden');
      await toggleWidget('petVisibleChk'); await toggleWidget('dockVisibleChk');
      await widgetState(true, 'real checkbox clicks explicitly enable the widgets');
      check(await js(`JSON.parse(localStorage.getItem('soduwork_work_cfg_v5')).petVisible === true &&
        JSON.parse(localStorage.getItem('soduwork_work_cfg_v5')).dockVisible === true`), 'real Store.saveCfg persists the explicit widget choices');
      await load();
      await widgetState(true, 'explicit widget preferences survive renderer reload');
      await until(`document.querySelector('#workRootInput')?.value === 'C:/Isolated/SoduWork'`);
      check(await js(`document.querySelector('#workRootInput').readOnly`), 'path display is read-only');
      check(await js(`document.querySelector('#workRootSave').textContent.trim()==='选择文件夹'`), 'folder selection action is labeled');
      await js(`pickerResults.push({ok:true,dir:'D:/Isolated/Project'});void 0;`);await clickPicker();
      check(await js(`workRoot()==='D:/Isolated/Project'&&document.querySelector('#workRootInput').value===workRoot()`), 'selected folder is saved and displayed');
      check(await js(`pickerCalls[0].defaultPath==='C:/Isolated/SoduWork'&&pickerCalls[0].persist===false&&saveCalls[0]===workRoot()`), 'native picker uses current folder and persistence follows selection');
      await js(`window.savedNote=document.querySelector('#workRootNote').textContent;pickerResults.push({ok:false,canceled:true});void 0;`);await clickPicker();
      check(await js(`workRoot()==='D:/Isolated/Project'&&document.querySelector('#workRootNote').textContent===savedNote&&saveCalls.length===1`), 'cancel preserves the folder and status without saving');
      check(await js(`pickerCalls.at(-1).defaultPath==='D:/Isolated/Project'`), 'later selections start at the saved folder');
      await js(`pickerResults.push(()=>new Promise(resolve=>window.finishPicker=resolve));void 0;`);await clickPicker(false);
      check(await js(`document.querySelector('#workRootSave').disabled`), 'pending picker blocks duplicate invocations');
      await js(`finishPicker({ok:false,canceled:true});void 0;`);await until(`!document.querySelector('#workRootSave').disabled`);
      await load();await until(`document.querySelector('#workRootInput')?.value==='D:/Isolated/Project'`);
      check(await js(`workRoot()==='D:/Isolated/Project'`), 'custom folder survives renderer reload and real API migration');
      await js(`pickerResults.push({ok:true,dir:'E:/Rejected'});saveResults.push({ok:false,error:'Synthetic persistence failure'});void 0;`);await clickPicker();
      check(await js(`workRoot()==='D:/Isolated/Project'&&document.querySelector('#workRootInput').value===workRoot()&&!document.querySelector('#workRootSave').disabled`), 'native save failure rolls back renderer storage and allows retry');
      await js(`pickerResults.push(()=>Promise.reject(Error('Synthetic picker failure')));void 0;`);await clickPicker();
      check(await js(`workRoot()==='D:/Isolated/Project'&&!document.querySelector('#workRootSave').disabled`), 'picker failure preserves previous folder and allows retry');
      await js(`pickerResults.push({ok:true,dir:'C:\\\\'});void 0;`);await clickPicker();
      assert.equal(await js('workRoot()'), 'C:\\', 'drive root separator is retained');
      report.checks.push('drive root separator is retained');
      await load();await until(`document.querySelector('#workRootInput')?.value==='C:\\\\'`);
      check(await js(`workRoot()==='C:\\\\'`), 'drive root survives renderer reload');
      await js(`document.querySelector('#workRootSave').scrollIntoView({block:'center',behavior:'instant'});void 0;`);
      await shot('work-root-folder-picker');
    }
    check(await js('testErrors.length===0'), 'no renderer errors');
    win.webContents.session.flushStorageData();
    report.ok = true;
  }).catch(error => {report.error = error.stack;}).finally(async () => {
    if (!report.ok && win) await shot('failure-' + stage).catch(() => {});
    fs.writeFileSync(path.join(output, stage + '.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));win?.destroy();app.exit(report.ok ? 0 : 1);
  });
}
