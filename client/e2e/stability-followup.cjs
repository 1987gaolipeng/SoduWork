'use strict';
// Native Electron input against production renderer scripts with isolated data.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), electron = require('electron');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence directory required');
if (typeof electron === 'string') {
  (async () => {
    assert.equal(process.platform, 'win32', 'This native input/packaged-resource fixture targets Windows');
    fs.mkdirSync(output, { recursive: true });
    await require('@electron/asar').createPackageWithOptions(path.resolve(__dirname, '..').replace(/\\/g, '/'),
      path.join(output, 'catalog-worker.asar'), { pattern: '/{main,core,sdk}/**/*' });
    // Give the worker the real packaged resource layout without editing the
    // shared development runtime. Vendor binaries are linked, never modified.
    const staged = fs.mkdtempSync(path.join(output, 'electron-asar-')), distribution = path.dirname(electron);
    for (const entry of fs.readdirSync(distribution, { withFileTypes: true })) {
      if (entry.isFile()) fs.linkSync(path.join(distribution, entry.name), path.join(staged, entry.name));
    }
    for (const folder of ['locales', 'resources']) fs.mkdirSync(path.join(staged, folder));
    for (const file of ['locales/en-US.pak', 'locales/zh-CN.pak', 'resources/default_app.asar'])
      fs.linkSync(path.join(distribution, file), path.join(staged, file));
    fs.writeFileSync(path.join(staged, 'resources', 'agent_catalog.json'),
      fs.readFileSync(path.resolve(__dirname, '../../hub-backend/app/agent_catalog.json')));
    const resource = (source, destination) => {
      const target = path.join(staged, 'resources', destination);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, fs.readFileSync(source));
    };
    for (const [skill, module] of [['app-developer', 'app-developer-plugin.cjs'], ['product-incubator', 'product-incubator-plugin.js'],
      ['mcp-studio', 'mcp-studio-plugin.js'], ['skill-studio', 'skill-studio-plugin.js']]) {
      for (const name of require('../main/' + module).FILES)
        resource(path.resolve(__dirname, '../../skills', skill, name), 'skills/' + skill + '/' + name);
    }
    for (const name of ['api-definition.cjs', 'api-network.cjs', 'validation.cjs'])
      resource(path.resolve(__dirname, '../../skills/mcp-tools/connectors', name), 'skills/mcp-tools/connectors/' + name);
    resource(path.resolve(__dirname, '../../hub-backend/plugins/product-incubator.json'), 'product-incubator-plugin.json');
    const env = { ...process.env };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
    const child = require('node:child_process').spawnSync(path.join(staged, path.basename(electron)), [__filename, output],
      { env, windowsHide: true, encoding: 'utf8', timeout: 120000 });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    assert.equal(child.status, 0, child.error?.message || 'Electron regression failed');
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = electron;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-followup-ui-'));
  app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  fs.mkdirSync(output, { recursive: true });
  const report = { ok: false, boundary: 'Isolated Electron, native input, synthetic catalogs and tasks. No installed client, real Hub or paid model.' };
  let win;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => Promise.race([win.webContents.executeJavaScript(code, true).catch(error => { throw Error(code.slice(0, 160) + ': ' + error.message); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Renderer evaluation timed out: ' + code.slice(0, 100))), 10000); timer.unref(); })]);
  function inline(name) {
    const file = path.join(__dirname, 'fixtures', name), dir = path.dirname(file);
    const css = file => fs.readFileSync(file, 'utf8').replace(/@import\s+["']([^"']+)["'];/g, (_, p) => css(path.resolve(path.dirname(file), p)));
    return fs.readFileSync(file, 'utf8')
      .replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, p) => '<style>' + css(path.resolve(dir, p)) + '</style>')
      .replace(/<script src="([^"]+)"><\/script>/g, (_, p) => '<script>' + fs.readFileSync(path.resolve(dir, p), 'utf8').replace(/<\/script/gi, '<\\/script') + '</script>');
  }
  async function until(code) {
    for (let i = 0; i < 150; i++) { if (await js('Boolean(' + code + ')')) return; await sleep(30); }
    throw Error('Timed out: ' + code);
  }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable input');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await sleep(80);
  }
  async function load(name) {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(inline(name)));
    await js(fs.readFileSync(path.join(__dirname, '../core/page-performance.js'), 'utf8'));
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1440, height: 1000,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_req, done) => done({ cancel: true }));
    await load('schedule-card-actions.html');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await until('document.querySelectorAll(".sch-icon-action").length===16');
    await js(`window.nativeCalls=0; rows[0].modelName='fixture-model';rows[0].assigneeId='local:pi';
      SoduWorkAPI.taskExecutionOptions=()=>new Promise(resolve=>window.releaseOptions=resolve);
      soduWorkAPI={conversationSession:{runtimeModels:()=>{nativeCalls++;return new Promise(()=>{})}},
        personalPlugins:{list:()=>new Promise(resolve=>window.releasePlugins=resolve)}};void 0;`);
    await click('.sch-item[data-sid="schedule-0"] [data-act="edit"]');
    await until('document.querySelector("#schEditorLayer.show") && window.releaseOptions && window.releasePlugins');
    assert.equal(await js('document.querySelector("#schSave").disabled'), true);
    await click('#schTitle');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
    await until(`document.activeElement.id === 'schTitle' && document.activeElement.selectionStart === 0 &&
      document.activeElement.selectionEnd === document.activeElement.value.length`);
    await win.webContents.insertText('  Preserved typed draft  ');
    await sleep(500);
    assert.equal(await js('document.querySelector("#schTitle").value'), '  Preserved typed draft  ');
    await js(`releaseOptions({substrates:[{key:'local:pi',name:'Pi',modelPick:true,available:true},
      {key:'local:codex',cli:'codex',name:'Codex',nativeModelPick:true,available:true}],modelOptions:[{name:'fixture-model',label:'Fixture model'}]});
      releasePlugins({items:[]});`);
    await until('!document.querySelector("#schSave").disabled');
    assert.equal(await js('nativeCalls'), 0);
    assert.equal(await js('document.querySelector("#schTitle").value'), '  Preserved typed draft  ');
    assert.equal(await js('document.querySelector("#schModel").value'), 'fixture-model');
    assert.equal(await js('document.activeElement.id'), 'schTitle');
    report.schedule = await js('SoduWorkPagePerformance.snapshot()');
    assert.ok(report.schedule.events.find(row => row.kind === 'interaction').stages.shell < 500);
    fs.writeFileSync(path.join(output, 'schedule-ready.png'), (await win.webContents.capturePage()).toPNG());
    await click('[data-editor-close]');
    await click('.sch-item[data-sid="schedule-0"] [data-act="edit"]');
    await click('[data-editor-close]');
    await js('releaseOptions({substrates:[]});releasePlugins({items:[]})'); await sleep(100);
    assert.equal(await js('Boolean(document.querySelector("#schEditorLayer.show"))'), false);
    assert.deepEqual(await js('errors'), []);

    await load('requirements-board.html');
    await js(`Store.tasks=tasks;window.detailAborted=false;SoduWorkAPI.getTask=(id,options)=>new Promise(resolve=>{
      window.releaseDetail=()=>resolve(structuredClone(tasks.find(row=>row.id===id)));
      options?.signal?.addEventListener('abort',()=>window.detailAborted=true);
    });document.body.insertAdjacentHTML('beforeend','<button id="fixtureOpen" style="position:fixed;top:0;left:0;z-index:9999999">Open isolated detail</button>');
    document.querySelector('#fixtureOpen').onclick=()=>RequirementsDetail.open('ready-0');void 0;`);
    await click('#fixtureOpen');
    await until('window.releaseDetail && document.querySelector(".rq-detail-loading")');
    const preview = await js(`({text:document.querySelector('.rq-detail-content').textContent,title:tasks.find(row=>row.id==='ready-0').title,
      actions:document.querySelector('.rq-detail-footer').querySelectorAll('button').length})`);
    assert.ok(preview.text.includes(preview.title)); assert.equal(preview.actions, 0);
    fs.writeFileSync(path.join(output, 'detail-waiting.png'), (await win.webContents.capturePage()).toPNG());
    await click('[data-rq-dismiss]');
    assert.equal(await js('detailAborted'), true);
    await js('releaseDetail()'); await sleep(100);
    assert.equal(await js('Boolean(document.querySelector(".rq-detail-loading"))'), false);
    report.detail = await js('SoduWorkPagePerformance.snapshot()');
    assert.deepEqual(await js('fixtureErrors'), []);
    report.boardPressure = await js(`(()=>{
      const template=tasks.find(row=>row.id==='ready-0');
      tasks=Array.from({length:5000},(_,index)=>({...template,id:'pressure-'+index,title:'Isolated requirement '+index}));
      Store.tasks=tasks;
      const start=performance.now();RequirementsBoard.render(true);const initialMs=performance.now()-start;
      const first=document.querySelector('[data-hbid]'), timings=[];
      for(let i=0;i<10;i++){const before=performance.now();RequirementsBoard.render();timings.push(performance.now()-before)}
      timings.sort((a,b)=>a-b);
      return {tasks:tasks.length,initialMs,unchangedP95Ms:timings[9],renderedCards:document.querySelectorAll('[data-hbid]').length,
        retainedDom:document.querySelector('[data-hbid]')===first};
    })()`);
    assert.ok(report.boardPressure.renderedCards > 0 && report.boardPressure.renderedCards <= 400);
    assert.equal(report.boardPressure.retainedDom, true);
    const catalog = await require('../main/personal-plugin-catalog-worker.cjs').catalog({ isPackaged: false, getPath: () => root });
    assert.ok(catalog.length >= 5); report.electronWorkerPlugins = catalog.length;
    const fixtureApp = { isPackaged: true, getPath: () => root };
    const personal = require('../main/personal-plugins').create(fixtureApp, { key: 'asar-fixture', name: 'ASAR fixture',
      template: 'method', description: 'An isolated packaged worker fixture', instructions: 'Summarize the supplied fixture input.' });
    const packed = await require(path.join(output, 'catalog-worker.asar', 'main', 'personal-plugin-catalog-worker.cjs')).catalog(fixtureApp);
    assert.equal(typeof personal.plugin.pluginId, 'string');
    assert.ok(packed.some(item => item.pluginId === personal.plugin.pluginId && item.key === 'asar-fixture'));
    assert.deepEqual(packed.map(item => item.key).sort(), [...catalog.map(item => item.key), 'asar-fixture'].sort());
    report.asarWorker = true; report.asarWorkerPlugins = packed.length;
    report.ok = true;
  }).catch(error => { report.error = error.stack; process.exitCode = 1; }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, error: report.error, report: path.join(output, 'report.json') }));
    win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
