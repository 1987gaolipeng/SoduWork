'use strict';
// Production maker in a disposable Chromium renderer. All API replies and
// persistence are inert fixtures; no user profile, platform or model is opened.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const args = [__filename, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
  if (process.platform === 'linux' && !env.DISPLAY) args.push('--ozone-platform=headless');
  const result = require('node:child_process').spawnSync(electron, args, { env, encoding: 'utf8', timeout: 60000 });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error.message);
  process.exit(result.status === 0 && /"ok":true/.test(result.stdout || '') ? 0 : 1);
}
const { app, BrowserWindow } = electron;
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-maker-fields-'));
app.setPath('userData', path.join(temporary, 'profile')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => app.exit(1), 45000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: !/^(?:data:|about:)/.test(details.url) }));
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><body></body>'));
  const run = code => win.webContents.executeJavaScript(code, true);
  await run(`window.checked=[];window.saved=[];window.notices=[];
    window.SoduWorkAPI={myMcpServers:async()=>({personal:[],company:[]}),mySkills:async()=>({items:[]}),listAIAgents:async()=>({agents:[]}),
      preflightPluginDraft:async body=>{checked.push(structuredClone(body));return{manifest:body,simulation:{order:[]},checks:[]}},
      createPluginDraft:async body=>{saved.push(structuredClone(body));return{ok:true,plugin:{}}}};
    window.SoduWorkPluginPresentation={dialog(){}};window.SoduWorkCapabilityPlugins={toneClass:()=>'',iconKind:()=>'',brandIcon:()=>''};
    window.fixtureContext={say:text=>notices.push(text),errorText:error=>error.message,closeModal(){document.querySelector('.fixture-layer')?.remove()},
      openModal(title,description,body,footer){const layer=document.createElement('div');layer.className='fixture-layer';
        layer.innerHTML='<div class="cap-modal">'+body+'<footer>'+footer+'</footer></div>';document.body.append(layer);return layer}};void 0;`);
  for (const file of ['core/plugin-platforms.js', 'components/panels/panels-plugin-maker-utils.js',
    'components/panels/plugin-route-directory.js', 'components/panels/panels-plugin-maker-skills.js',
    'components/panels/panels-plugin-maker-fields.js', 'components/panels/panels-plugin-maker.js']) {
    const full = file.endsWith('/panels-plugin-maker.js') && process.env.SODUWORK_MAKER_SOURCE
      ? process.env.SODUWORK_MAKER_SOURCE : path.join(__dirname, '..', file);
    await run(fs.readFileSync(full, 'utf8') + '\nvoid 0;');
  }
  const result = await run(`(async()=>{
    const initial={key:'fields-fixture',name:'字段样例',version:'1.0.0',template:'method',description:'保留字段',instructions:'完成工作',
      inputs:[{key:'enabled',type:'boolean',default:false},{key:'count',type:'number',default:0}],
      setup:{title:'偏好',preferences:[{key:'groups',type:'multiselect',options:['one','two'],default:['one']}]}};
    const before=JSON.stringify(initial);SoduWorkPluginMaker.open(fixtureContext,{},initial,[]);
    const click=s=>document.querySelector(s).click();const set=(s,v,e='input')=>{const el=document.querySelector(s);el.value=v;el.dispatchEvent(new Event(e,{bubbles:true}))};
    const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
    const markup=[document.querySelector('#capInputRows').innerHTML,document.querySelector('#capSetupRows').innerHTML];
    click('#capMakerDo');await flush();const first=structuredClone(checked.at(-1));
    set('[data-input-index="0"] [data-input-field="defaultValue"]','true','change');const resetLabel=document.querySelector('#capMakerDo').textContent;
    click('#capInputAdd');set('[data-input-index="2"] [data-input-field="type"]','select','change');
    set('[data-input-index="2"] [data-input-field="options"]','brief | 简短\\nfull | 完整');set('[data-input-index="2"] [data-input-field="defaultValue"]','brief');
    set('[data-setup-index="0"] [data-setup-field="defaultValue"]','one\\ntwo');click('#capMakerDo');await flush();
    const edited=structuredClone(checked.at(-1)),savesBeforeConfirmation=saved.length;click('#capMakerDo');await flush();const savedBody=structuredClone(saved.at(-1));
    SoduWorkPluginMaker.open(fixtureContext,{}, {...initial,inputs:[],setup:{}},[]);click('#capMakerDo');await flush();
    return {first,edited,savedBody,savesBeforeConfirmation,resetLabel,untouched:JSON.stringify(initial)===before,reopened:checked.at(-1),markup};
  })()`);
  assert.equal(result.first.inputs[0].default, false); assert.equal(result.first.inputs[1].default, 0);
  assert.equal(result.resetLabel, '检查并继续'); assert.equal(result.edited.inputs[0].default, true);
  assert.deepEqual(result.edited.inputs[2].options, [{ value: 'brief', label: '简短' }, { value: 'full', label: '完整' }]);
  assert.deepEqual(result.edited.setup.preferences[0].default, ['one', 'two']); assert.equal(result.savesBeforeConfirmation, 0);
  assert.deepEqual(result.savedBody, result.edited); assert.equal(result.untouched, true);
  assert.deepEqual(result.reopened.inputs, []); assert.deepEqual(result.reopened.setup.preferences, []);
  fs.writeSync(1, JSON.stringify({ ok: true, scenarios: 7,
    markupHash: require('node:crypto').createHash('sha256').update(JSON.stringify(result.markup)).digest('hex') }) + '\n');
  win.destroy();
}).catch(error => { fs.writeSync(2, String(error.stack || error) + '\n'); process.exitCode = 1; }).finally(() => {
  clearTimeout(deadline); fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 }); app.exit(process.exitCode || 0);
});
