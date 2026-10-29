'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-locales-'));
  const out = path.resolve(__dirname, '../../outputs/plugin-locales-client-20261022');
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(temp, 'profile'));
  const report = { ok: false, cases: [], boundary: 'Production renderer, locale observer and catalog API in isolated Electron; fixture metadata, no business requests, models or production installation.' };
  let win;
  app.whenReady().then(async () => {
    const asset = file => pathToFileURL(path.resolve(__dirname, '..', file)).href;
    const script = file => '<script src="' + asset(file) + '"></script>';
    const packs = require('../core/locales/manifest.json');
    fs.writeFileSync(path.join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><script>window.cfg={locale:"en-US"}</script>' +
      '<link rel="stylesheet" href="' + asset('theme/variables.css') + '"><link rel="stylesheet" href="' + asset('components/panels/panels-apps.css') + '">' +
      '<style>*{box-sizing:border-box}body{margin:0;font:14px system-ui}.sch-panel.appsx{display:none}.sch-panel.appsx.show{display:flex;flex-direction:column;width:100%;height:100vh;max-height:none}</style>' +
      packs.map(file => script('core/locales/' + file)).join('') + script('core/i18n-dom.js') + script('core/i18n.js') +
      script('core/plugin-locales.js') + script('core/api-work-plugins.js') + script('components/panels/panels-apps.js'));
    win = new BrowserWindow({ show: false, width: 1180, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(path.join(temp, 'index.html'));
    const js = source => win.webContents.executeJavaScript(source);
    await js(`window.fixture={pluginId:'local:ops',key:'ops',name:'旧名称',description:'旧说明',personal:true,enabled:true,
      locales:{'zh-CN':{name:'示例应用',description:'渠道、用户与创作',ui:{main:{title:'运营工作台'}}},'en-US':{name:'Example App',description:'Channels, audiences and content',ui:{main:{title:'Operations workspace'}}},'ko-KR':{name:'예제 앱'}},
      ui:{contributions:[{id:'main',title:'旧入口',slot:'workspace.navigation',source:{type:'external',url:'https://example.invalid/'}}]}};
      window.SoduWorkAPI=SoduWorkPluginAPI.create({jfetch:async()=>({items:[]}),taskStorageKey:()=> 'fixture',registrationEpoch:()=>1,mark(){},markFromError(){},registrationBoundaryError:()=>false});
      window.soduWorkAPI={personalPlugins:{list:async()=>({items:[fixture]})}};SoduWorkApps.open();`);
    const waitName = async expected => {
      for (let i = 0; i < 80; i++) {
        if (await js(`document.querySelector('.appsx-card-txt b')?.textContent === ${JSON.stringify(expected)}`)) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw Error('Locale did not render: ' + expected);
    };
    await waitName('Example App');
    assert.equal(await js(`document.querySelector('.appsx-source-tag').textContent`), 'Installed locally');
    assert.equal(await js(`document.querySelector('.appsx-sub').textContent`), 'Connect apps so SoduWork can work across your tools');
    assert.equal(await js(`document.querySelector('#appsSearch').placeholder`), 'Search apps');
    await js(`SoduWorkI18n.setLocale('zh-CN')`); await waitName('示例应用');
    assert.equal(await js(`document.querySelector('.appsx-source-tag').textContent`), '本机安装');
    await js(`SoduWorkI18n.setLocale('ja-JP')`); await waitName('Example App');
    assert.equal(await js(`document.querySelector('.appsx-source-tag').textContent`), 'ローカルインストール');
    await js(`SoduWorkI18n.setLocale('ko-KR')`); await waitName('예제 앱');
    assert.equal(await js(`document.querySelector('.appsx-source-tag').textContent`), '로컬 설치');
    assert.equal(await js(`document.querySelector('.appsx-card-txt small').textContent`), 'Channels, audiences and content');
    report.cases.push('English, Chinese, unsupported Japanese fallback to English, optional Korean and field fallback; language changes refresh the open catalog.');
    await js(`SoduWorkI18n.setLocale('en-US')`); await waitName('Example App');
    const before = await js(`JSON.stringify(fixture)`);
    await js(`const input=document.querySelector('#appsSearch'); input.value='Example'; input.dispatchEvent(new Event('input'));`);
    assert.equal(await js(`document.querySelectorAll('.appsx-card').length`), 1);
    await js(`document.querySelector('.appsx-fav').click()`);
    assert.equal(await js(`document.querySelector('[data-apps-section="favorite"] .appsx-card') != null || document.querySelector('[data-apps-section="favorites"] .appsx-card') != null`), true);
    assert.equal(await js(`JSON.stringify(fixture)`), before);
    await js(`document.querySelector('#appsSearch').value='';document.querySelector('#appsSearch').dispatchEvent(new Event('input'));`);
    assert.equal(await js(`document.querySelector('.appsx-card').getBoundingClientRect().width > 100`), true);
    fs.writeFileSync(path.join(out, 'english.png'), (await win.webContents.capturePage()).toPNG());
    report.cases.push('Localized search and favorites preserve stable identity and raw execution configuration.');
    await js(`(async()=>{window.localizedCatalog=SoduWorkAPI.pluginCatalog;SoduWorkAPI.pluginCatalog=async()=>{const result=await localizedCatalog();return {...result,items:[...result.items,{...result.items[0],pluginId:'remote:ops',personal:false,installed:true,marketPolicy:{featured:true}}]}};
      window.PluginUIHost={openContribution:()=>new Promise((resolve,reject)=>{window.completeLocalizedOpen=resolve;window.rejectLocalizedOpen=reject})};await SoduWorkApps.render(true)})()`);
    const waitReadyLabel=async()=>{
      for(let i=0;i<80;i++){
        if(await js(`(()=>{const card=document.querySelector('.appsx-cover-card');return card&&!card.hasAttribute('aria-busy')&&card.querySelector('.appsx-card-open').textContent==='Open app'})()`))return;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      throw Error('English Open App label did not recover');
    };
    await waitReadyLabel();
    await js(`document.querySelector('.appsx-cover-card .appsx-card-open').click()`);
    assert.equal(await js(`document.querySelector('.appsx-cover-card .appsx-card-open').textContent`),'Open app');
    await js('completeLocalizedOpen()');await waitReadyLabel();
    await js(`document.querySelector('.appsx-cover-card .appsx-card-open').click();rejectLocalizedOpen(Error('fixture open failed'))`);
    await waitReadyLabel();
    report.cases.push('English recommended app actions keep Open App while opening and recover their localized label after success or failure.');
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    if (win && !win.isDestroyed()) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
