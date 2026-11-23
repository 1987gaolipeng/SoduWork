'use strict';
// Production card/modal rendering with synthetic package metadata and API replies.
// No Hub, user profile, package installation, or model request is used.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const client = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(client, '../outputs/app-delivery-verification'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-delivery-scope-'));
app.setPath('userData', path.join(profile, 'profile')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const report = { ok: false, cases: [], boundary: 'Real Electron renderer, production card/modal/CSS/locales, synthetic API; no live model, installation or reporter environment verification.' };
let win;
const js = code => win.webContents.executeJavaScript(code);
const url = file => pathToFileURL(path.join(client, file)).href;
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const styles = ['theme/variables.css', 'components/panels/panels-base.css',
    'components/panels/panels-schedules.css', 'components/panels/panels-capabilities.css', 'components/panels/panels-capability-plugins.css',
    'components/panels/panels-chat.css'];
  const scripts = [...JSON.parse(fs.readFileSync(path.join(client, 'core/locales/manifest.json'), 'utf8')).map(f => 'core/locales/' + f),
    'core/i18n-dom.js', 'core/i18n.js', 'components/panels/chat-plugin-draft-placement.js', 'components/panels/chat-output-links.js',
    'components/panels/plugin-catalog-format.js', 'components/panels/panels-capability-plugins.js'];
  const html = '<!doctype html><meta charset="utf-8"><title>Delivery verification fixture</title>' +
    styles.map(f => '<link rel="stylesheet" href="' + url(f) + '">').join('') +
    '<style>body{margin:0;background:var(--bg-0);color:var(--ink);font:14.5px/1.5 sans-serif}main{padding:24px;max-width:820px;margin:auto}*{box-sizing:border-box}</style>' +
    '<main><h1>Delivery verification fixture</h1><section id="chat"></section></main>' +
    '<script>window.installCalls=0;window.SoduWorkAPI={pluginCatalog:async()=>({items:[]}),createPluginDraft:async()=>{installCalls++;return {ok:true,plugin:{name:"Fixture app"}}}};</script>' +
    scripts.map(f => '<script src="' + url(f) + '"></script>').join('');
  const page = path.join(profile, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1100, height: 850, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadFile(page);
  await js(`window.renderCard = (skill = false) => {
    const root = document.getElementById('chat'); root.innerHTML = '<article class="nmsg ai"><p data-user-content>Fixture delivery</p></article>';
    ChatOutputLinks.pluginDrafts(root, [{artifactId:'fixture',path:'fixture.json',relative:'fixture.json',pluginDraft:true,
      pluginIdentity:'fixture',pluginName:'Fixture app',pluginValidation:{state:'ready'},skillPackage:skill}], 'fixture');
  };
  window.modalContext = {
    openModal(title, subtitle, body, footer) {
      document.getElementById('fixtureModal')?.remove();
      const layer = document.createElement('div'); layer.id='fixtureModal'; layer.className='cap-modal-layer';
      layer.innerHTML='<section class="cap-modal" role="dialog"><header class="cap-modal-head"><div><b></b><span></span></div><button id="capModalClose">×</button></header><div class="cap-modal-body"></div><footer class="cap-modal-foot"></footer></section>';
      layer.querySelector('b').textContent=title;layer.querySelector('header span').textContent=subtitle;
      layer.querySelector('.cap-modal-body').innerHTML=body;layer.querySelector('footer').innerHTML=footer;
      document.body.appendChild(layer);return layer;
    }, closeModal(){document.getElementById('fixtureModal')?.remove()}, say(){}, refresh(){}
  };
  window.openFixture = (template='app') => SoduWorkCapabilityPlugins.openLocalImport({template},
    {ok:true,manifest:{template,name:'Fixture app',version:'1.0.0'},capabilities:{runtime:[]}},modalContext);
  window.measure = selector => {
    const el=document.querySelector(selector), r=el.getBoundingClientRect();
    return {text:el.textContent,width:r.width,height:r.height,left:r.left,right:r.right,viewport:innerWidth,
      overflow:el.scrollWidth>el.clientWidth+1,font:parseFloat(getComputedStyle(el).fontSize)};
  }; void 0;`);
  const phrase = '安装检查仅验证包结构与声明，不代表真实 AI 或业务功能已验证。';
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
    for (const width of [1100, 420]) {
      win.setContentSize(width, 850);
      await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)});renderCard();`);
      const expected = await js(`SoduWorkI18n.translateText(${JSON.stringify(phrase)})`);
      const card = await js("measure('.nplugin-verification-note')");
      assert.equal(card.text, expected); assert.ok(card.height > 0 && card.font >= 14, JSON.stringify(card));
      assert.ok(!card.overflow && card.left >= 0 && card.right <= card.viewport, JSON.stringify(card));
      if (locale === 'en-US' && width === 420) fs.writeFileSync(path.join(out, 'english-card-narrow.png'), (await win.webContents.capturePage()).toPNG());
      await js('openFixture()');
      await js('new Promise(resolve => setTimeout(resolve, 50))');
      const note = await js("measure('.cap-local-verification')");
      assert.ok(note.text.includes(expected)); assert.ok(!note.overflow && note.font >= 14);
      assert.ok(note.left >= 0 && note.right <= note.viewport, JSON.stringify(note));
      const install = await js("measure('#capLocalInstall')");
      assert.ok(install.left >= 0 && install.right <= install.viewport && !install.overflow, JSON.stringify(install));
      assert.equal(await js('installCalls'), 0, 'rendering a notice must not install or call a model');
      if (width === 420) fs.writeFileSync(path.join(out, locale + '-modal-narrow.png'), (await win.webContents.capturePage()).toPNG());
      await js("document.getElementById('capLocalCancel').click()");
      assert.equal(await js("!!document.getElementById('fixtureModal')"), false);
      report.cases.push({ locale, width, card: card.text, modal: note.text });
    }
  }
  await js("SoduWorkI18n.setLocale('zh-CN');renderCard();SoduWorkI18n.setLocale('en-US')");
  assert.equal(await js("document.querySelector('.nplugin-verification-note').textContent"),
    await js(`SoduWorkI18n.translateText(${JSON.stringify(phrase)})`));
  await js('renderCard(true)'); assert.equal(await js("!!document.querySelector('.nplugin-verification-note')"), false);
  await js("openFixture('method')"); assert.equal(await js("!!document.querySelector('.cap-local-verification')"), false);
  await js('modalContext.closeModal();openFixture();document.getElementById("capLocalOnly").click()');
  assert.equal(await js('installCalls'), 1, 'the existing explicit install action still works');
  report.ok = true;
}).catch(error => { report.error = error.stack; process.exitCode = 1; }).finally(() => {
  fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); if (win && !win.isDestroyed()) win.destroy(); app.exit(report.ok ? 0 : 1);
});
