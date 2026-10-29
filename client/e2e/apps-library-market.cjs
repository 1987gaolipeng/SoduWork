'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 45000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  app.disableHardwareAcceleration();
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-apps-library-'));
  const out = path.resolve(__dirname, '../../outputs/apps-library-market-20261020');
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(temp, 'profile'));
  const report = { ok: false, cases: [], boundary: 'Actual Chromium with production app list/CSS, isolated profile and fixture catalog. DOM actions verify layout and handlers, not native mouse input or real remote installation.' };
  let win, coverServer;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function capture() {
    for (let attempt = 0; ; attempt++) {
      try { return await win.webContents.capturePage(); }
      catch (error) {
        if (attempt >= 2 || !String(error.message).includes('UnknownVizError')) throw error;
        win.webContents.invalidate();
        await delay(100);
      }
    }
  }
  const until = async (fn, label) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(20); } throw Error('Timeout: ' + label); };
  app.whenReady().then(async () => {
    coverServer=require('node:http').createServer((_req,res)=>{res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="400"><rect width="1000" height="400" fill="#c7d2fe"/><circle cx="850" cy="100" r="190" fill="#a5b4fc"/><text x="55" y="230" font-size="70" font-family="sans-serif" fill="#312e81">APPLICATION</text></svg>')});
    await new Promise(resolve=>coverServer.listen(0,'127.0.0.1',resolve));
    const coverUrl='http://127.0.0.1:'+coverServer.address().port+'/cover.svg';
    const asset = file => pathToFileURL(path.resolve(__dirname, '..', file)).href;
    fs.writeFileSync(path.join(temp, 'index.html'), '<!doctype html><html lang="zh-CN" data-desk-panel="workspace"><meta charset="utf-8">' +
      '<link rel="stylesheet" href="' + asset('theme/variables.css') + '">' +
      '<link rel="stylesheet" href="' + asset('theme/cursor.css') + '">' +
      '<link rel="stylesheet" href="' + asset('components/panels/panels-apps.css') + '">' +
      '<style>*{box-sizing:border-box}body{margin:0;background:var(--bg-0);font:14px "Segoe UI",sans-serif}.sch-panel.appsx{display:none}.sch-panel.appsx.show{display:flex;flex-direction:column;width:100%;height:100vh;max-height:none}</style>' +
      '<script src="' + asset('components/panels/panels-plugin-builder-entry.js') + '"></script>' +
      '<script src="' + asset('components/panels/panels-apps.js') + '"></script></html>');
    win = new BrowserWindow({ show: false, width: 1180, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await win.loadFile(path.join(temp, 'index.html'));
    const js = async source => {
      try { return await win.webContents.executeJavaScript(source); }
      catch (error) { throw Error(String(error.message) + '\nFixture expression: ' + source, { cause: error }); }
    };
    await js(`(async()=>{window.catalogCalls=0;window.opened=[];window.installs=[];window.removed=[];window.catalogError='';window.failCatalog=false;
      window.makeApp=(id,name,extra={})=>({pluginId:id,name,description:'用于验证应用目录与卡片操作',enabled:true,ui:{contributions:[{id:'main',slot:'workspace.navigation'}]},...extra});
      window.fixtureItems=[makeApp('local:flow','流程画布',{personal:true}),makeApp('local:ops','运营云端版',{personal:true}),
        makeApp('remote:installed','团队应用',{installed:true}),makeApp('remote:new','远端新应用',{installed:false}),
        makeApp('remote:unlisted','已下架但已安装',{installed:true,listed:false}),
        makeApp('remote:denied','无使用权限',{permissions:{canUse:false}}),makeApp('local:disabled','停用应用',{personal:true,enabled:false}),
        {pluginId:'local:no-ui',name:'普通插件',personal:true}];
      window.SoduWorkAPI={pluginCatalog:async()=>{catalogCalls++;if(failCatalog)throw Error('fixture offline');return {items:fixtureItems,remoteError:catalogError}},
        setEnterprisePluginInstalled:async(id,enabled)=>{installs.push(id);const item=fixtureItems.find(x=>x.pluginId===id);if(item)item.installed=enabled;if(item)item.updateAvailable=false;return {ok:true,installation:{installed:enabled}}},
        deletePersonalPlugin:async(id)=>{removed.push(id);fixtureItems=fixtureItems.filter(x=>x.pluginId!==id);return {ok:true}}};
      window.PluginUIHost={openContribution:async(row,context)=>{opened.push(context.item.pluginId)}};
      window.openCapabilityPlugin=async id=>{installs.push(id)};
      localStorage.setItem('soduwork-apps-favorites',JSON.stringify(['local:flow','remote:installed','remote:new']));
      SoduWorkApps.open();await SoduWorkApps.render(true);})()`);
    const sections = () => js('[...document.querySelectorAll(".appsx-section")].filter(s=>s.dataset.appsSection!=="recommended").map(s=>({key:s.dataset.appsSection,title:s.querySelector("h2").textContent,names:[...s.querySelectorAll(".appsx-card-txt b")].map(b=>b.textContent)}))');
    assert.deepEqual(await js('[...document.querySelectorAll("[role=tab]")].map(t=>t.textContent)'), ['我的', '市场']);
    assert.deepEqual(await js('[...document.querySelector(".appsx-tools").children].map(node=>node.className)'), ['appsx-search', 'appsx-tabs', 'appsx-icon-btn', 'appsx-pill', 'appsx-icon-btn']);
    assert.equal(await js('document.querySelector(".appsx-banner")'), null);
    let groups = await sections(); assert.deepEqual(groups.map(x => x.title), ['常用', '我的']);
    assert.deepEqual(groups[0].names, ['团队应用', '流程画布']);
    assert.deepEqual(new Set(groups[1].names), new Set(['运营云端版', '已下架但已安装']));
    report.cases.push('Exactly two top tabs; My shows Common first and My below. Local/installed remote apps are usable; unavailable, disabled and non-UI entries are excluded.');
    await js('document.activeElement.blur()');win.webContents.sendInputEvent({type:'mouseMove',x:0,y:0});await delay(50);
    assert.equal(await js(`[...document.querySelectorAll('.appsx-card')].every(card=>{const star=card.querySelector('.appsx-fav');if(!star)return false;for(let el=star;el;el=el.parentElement){const style=getComputedStyle(el);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)<.99)return false}return true})`),true,'all application stars are visible without hover or focus');
    await js(`window.savedSettings=[];window.soduWorkAPI={appSettings:{
      get:async()=>({ok:true,revision:2,values:{theme:'dark'},secretKeys:['ukey'],secretMasks:{ukey:'ak-26****'},configuredKeys:['ukey','theme']}),
      update:async(id,value)=>{savedSettings.push({id,...value});return {ok:true,revision:3,values:{theme:'dark',model:'legacy-model'},secretKeys:['ukey'],secretMasks:{ukey:'ak-26****'},configuredKeys:['ukey','theme','model']}}}};
      localStorage.setItem('soduwork-app-settings:local:ops',JSON.stringify({model:'legacy-model',ukey:'obsolete-legacy-key'}));
      [...document.querySelectorAll('.appsx-card')].find(e=>e.textContent.includes('运营云端版')).querySelector('.appsx-set').click()`);
    await until(()=>js('!!document.getElementById("appsSetModel")'),'secure app settings form');
    assert.equal(await js('appsSetModel.value'),'legacy-model');
    assert.equal(await js('appsSettingsMask.textContent.includes("已配置：ukey")'),true);
    assert.equal(await js('appsSetUkeyMask.textContent'),'ak-26****');
    assert.equal(await js('appsSetUkey.hidden'),true);
    assert.equal(await js('JSON.stringify(savedSettings).includes("obsolete-legacy-key")'),false);
    assert.equal(await js('localStorage.getItem("soduwork-app-settings:local:ops")'),null);
    await js(`appsSetParams.value=JSON.stringify({theme:'light',customValue:42});appsSetSave.click()`);
    await until(()=>js('!appsSettingsMask.classList.contains("show")'),'settings save');
    assert.equal(await js('savedSettings.at(-1).values.customValue'),42);
    assert.equal(await js('savedSettings.at(-1).values.ukey'),undefined);
    report.cases.push('Settings form uses the scoped main settings API, masks configured ukey, migrates legacy preferences without replacing newer credentials, and saves arbitrary parameters.');
    const calls = await js('catalogCalls');
    await js(`document.querySelector('[data-apps-section="mine"] .appsx-card').click()`);
    const selectedName = await js(`document.querySelector('[data-apps-section="mine"] .appsx-card-txt b').textContent`);
    assert.equal(await js('fixtureItems.find(x=>x.pluginId===opened[0]).name'), selectedName);
    await js(`document.querySelector('[data-apps-section="favorites"] .appsx-fav').click()`);
    groups = await sections(); assert.deepEqual(groups[0].names, ['流程画布']);
    assert.ok(groups[1].names.includes('团队应用'));
    assert.equal(await js(`document.querySelectorAll('.appsx-fav.is-fav').length`), 1);
    await js(`document.querySelector('[data-apps-section="mine"] .appsx-card').querySelector('.appsx-fav').click()`);
    groups = await sections();
    assert.equal(groups[0].names.filter(x => groups[1].names.includes(x)).length, 0);
    assert.ok(!groups[1].names.includes(groups[0].names[0]));
    await js(`document.querySelector('[data-apps-section="favorites"] .appsx-card').querySelector('.appsx-fav').click()`);
    groups = await sections();
    assert.equal(groups[0].names.length, 1); assert.equal(groups[1].names.length, 3);
    assert.equal(await js('catalogCalls'), calls);
    report.cases.push('Common and My are disjoint. Favoriting moves the card to Common; unfavoriting restores it under My without refetching or changing installation.');
    for (const size of [[1180, 900], [680, 850]]) {
      win.setContentSize(...size); await delay(50);
      assert.equal(await js('document.querySelector("#appsPanel").scrollWidth>innerWidth'), false);
      fs.writeFileSync(path.join(out, 'mine-' + size[0] + '.png'), (await capture()).toPNG());
    }
    await js(`document.querySelector('[data-tab="market"]').click()`);
    groups = await sections(); assert.deepEqual(groups.map(x => x.title), ['市场']);
    assert.deepEqual(new Set(groups[0].names), new Set(['团队应用', '远端新应用']));
    assert.equal(await js('document.querySelectorAll(".appsx-fav").length===document.querySelectorAll(".appsx-card").length'),true,'uninstalled market applications also have stars');
    await js(`document.querySelector('.appsx-card-add').closest('.appsx-card').click()`);
    assert.deepEqual(await js('installs'), ['remote:new']);
    await until(()=>js('opened.at(-1)==="remote:new"'),'market app opened after add');
    assert.equal(await js('opened.length'), 2);
    assert.equal(await js('catalogCalls'), calls + 1);
    fs.writeFileSync(path.join(out, 'market.png'), (await capture()).toPNG());
    report.cases.push('Market contains remote listed apps including uninstalled ones; plus adds, synchronizes and opens an app in one flow.');
    await js(`fixtureItems.find(x=>x.pluginId==='remote:new').installed=true;window.dispatchEvent(new Event('soduwork:plugins-changed'))`);
    await until(() => js('!document.querySelector(".appsx-card-add")'), 'installation refresh');
    await js(`document.querySelector('[data-tab="mine"]').click()`);
    groups = await sections();
    assert.ok(groups[0].names.includes('远端新应用'));
    assert.ok(!groups[1].names.includes('远端新应用'));
    await js(`appsSearch.value='运营';appsSearch.dispatchEvent(new Event('input'))`);
    groups = await sections(); assert.equal(groups[0].names.length, 0); assert.deepEqual(groups[1].names, ['运营云端版']);
    await js(`appsSearch.value='';appsSearch.dispatchEvent(new Event('input'));localStorage.setItem('soduwork-apps-favorites',JSON.stringify(fixtureItems.map(x=>x.pluginId)));SoduWorkApps.render(false)`);
    groups = await sections(); assert.equal(groups[1].names.length, 0);
    assert.equal(await js(`document.querySelector('[data-apps-section="mine"]').textContent.includes('已安装的应用可在上方分组中打开')`), true);
    await js(`appsSearch.value='';appsSearch.dispatchEvent(new Event('input'));fixtureItems=[];window.dispatchEvent(new Event('soduwork-data-scope-changed'))`);
    await until(() => js('document.querySelectorAll(".appsx-card").length===0'), 'scope invalidation');
    assert.deepEqual((await sections()).map(x => x.title), ['常用', '我的']);
    report.cases.push('Installed remote app enters the library and a previously starred app goes to Common only; search filters both flat sections; identity change clears cached apps and empty My retains both section headings.');
    await js(`(async()=>{catalogError='fixture remote offline';await SoduWorkApps.render(true);document.querySelector('[data-tab="market"]').click()})()`);
    assert.equal(await js('!!document.querySelector(".appsx-market-error")'), true);
    assert.equal(await js('appsBody.textContent.includes("市场暂无应用")'), false);
    await js('(async()=>{failCatalog=true;await SoduWorkApps.render(true)})()');
    assert.equal(await js('!!document.querySelector("[data-apps-retry]")'), true);
    await js('failCatalog=false;catalogError="";document.querySelector("[data-apps-retry]").click()');
    await until(() => js('!!document.querySelector("[data-apps-section=market]")'), 'retry');
    report.cases.push('Remote errors remain distinguishable from an empty market; failed catalog shows a working retry action.');
    await js(`(async()=>{
      fixtureItems=[makeApp('recommended:new','推荐未安装应用',{key:'rec-new',description:'应用描述超过两行时应当截断并保持卡片整齐。'.repeat(12),marketPolicy:{featured:true},coverUrl:${JSON.stringify(coverUrl)}}),
        makeApp('local:ops','示例运营应用',{key:'fixture-operations-app',personal:true,sourcePluginId:'recommended:ops'}),
        makeApp('recommended:ops','示例运营应用',{key:'fixture-operations-app',marketPolicy:{featured:true},coverUrl:${JSON.stringify(coverUrl)}}),
        makeApp('recommended:third','团队知识库',{marketPolicy:{featured:true},coverUrl:${JSON.stringify(coverUrl)}}),
        makeApp('recommended:hidden','下架推荐',{listed:false,marketPolicy:{featured:true}}),
        makeApp('recommended:denied','无权限推荐',{permissions:{canUse:false},marketPolicy:{featured:true}})];
      catalogError='';localStorage.setItem('soduwork-apps-favorites',JSON.stringify(['local:flow','local:ops']));await SoduWorkApps.render(true);document.querySelector('[data-tab="mine"]').click();
    })()`);
    assert.equal(await js('document.querySelector(".appsx-section").dataset.appsSection'),'recommended');
    assert.equal(await js('document.querySelectorAll(".appsx-cover-card").length'),3);
    assert.equal(await js('getComputedStyle(document.querySelector(".appsx-cover-card .appsx-app-ico")).borderRadius'),'50%');
    const recommendationGroups = await js(`Object.fromEntries([...document.querySelectorAll('.appsx-section')].map(section=>[section.dataset.appsSection,[...section.querySelectorAll('.appsx-card-txt b')].map(node=>node.textContent)]))`);
    assert.ok(recommendationGroups.recommended.includes('示例运营应用'));
    assert.ok(recommendationGroups.favorites.includes('示例运营应用'));
    assert.ok(!recommendationGroups.mine.includes('示例运营应用'));
    const beforeStarActions=await js('({opened:opened.length,installs:installs.length})');
    const beforeStarPressed=await js("document.querySelector('.appsx-cover-card .appsx-fav').getAttribute('aria-pressed')");
    await js(`document.querySelector('.appsx-cover-card .appsx-fav').click()`);
    assert.equal(await js("document.querySelector('.appsx-cover-card .appsx-fav').getAttribute('aria-pressed')"),beforeStarPressed==='true'?'false':'true');
    assert.deepEqual(await js('({opened:opened.length,installs:installs.length})'),beforeStarActions,'recommendation star does not open or install the app');
    await js(`document.querySelector('.appsx-cover-card .appsx-fav').click()`);
    assert.equal(await js("document.querySelector('.appsx-cover-card .appsx-fav').getAttribute('aria-pressed')"),beforeStarPressed);
    await until(()=>js('[...document.querySelectorAll(".appsx-cover img")].every(img=>img.complete&&img.naturalWidth>0)'),'cover images loaded');
    assert.equal(await js('[...document.querySelectorAll(".appsx-cover-desc")].every(p=>p.clientHeight<=38)'),true);
    assert.equal(await js('[...document.querySelectorAll(".appsx-card-txt b")].filter(e=>e.textContent==="示例运营应用").length'),2);
    const rec=await js(`(()=>{const card=[...document.querySelectorAll('.appsx-cover-card')].find(c=>c.textContent.includes('示例运营应用')),info=card.querySelector('.appsx-cover-info').getBoundingClientRect(),button=card.querySelector('.appsx-set').getBoundingClientRect(),star=card.querySelector('.appsx-fav').getBoundingClientRect(),open=card.querySelector('.appsx-card-open').getBoundingClientRect(),copy=card.querySelector('.appsx-cover-copy').getBoundingClientRect();return {inside:button.left>=info.left&&button.right<=info.right&&button.top>=info.top&&button.bottom<=info.bottom,twoRows:Math.abs(star.top-button.top)<1&&star.right<=button.left&&open.top>=button.bottom&&open.left>=copy.right,action:card.querySelector('.appsx-card-open').textContent}})()`);
    assert.equal(rec.inside,true);assert.equal(rec.twoRows,true);assert.equal(rec.action,'打开应用');
    const recommendedActions=await js(`(()=>{const buttons=[...document.querySelectorAll('.appsx-cover-card .appsx-card-open')];return buttons.map(button=>{const style=getComputedStyle(button);return {label:button.textContent,accessibleLabel:button.getAttribute('aria-label'),icon:!!button.querySelector('svg'),background:style.backgroundColor,color:style.color,borderRadius:style.borderRadius,height:button.getBoundingClientRect().height}})})()`);
    assert.ok(recommendedActions.length>=2);
    assert.ok(recommendedActions.every(action=>action.label==='打开应用'&&action.accessibleLabel==='打开应用'&&!action.icon),'all recommendation installation states use the Open App text button');
    assert.ok(recommendedActions.every(action=>JSON.stringify(action)===JSON.stringify(recommendedActions[0])),'uninstalled recommendations use the same button appearance as installed apps');
    const installedOpenBefore=await js('({opened:opened.length,installs:installs.length})');
    await js(`window.originalOpen=PluginUIHost.openContribution;window.testOpenCard=[...document.querySelectorAll('.appsx-cover-card')].find(card=>card.textContent.includes('示例运营应用'));
      PluginUIHost.openContribution=async(row,context)=>{opened.push(context.item.pluginId);await new Promise((resolve,reject)=>{window.finishOpen=resolve;window.failOpen=reject})};
      testOpenCard.querySelector('.appsx-card-open').click()`);
    assert.equal(await js(`testOpenCard.querySelector('.appsx-card-open').textContent`),'打开应用','an installed app does not display installation loading while its window opens');
    assert.equal(await js(`testOpenCard.getAttribute('aria-busy')`),'true');
    await js(`testOpenCard.querySelector('.appsx-card-open').click()`);
    assert.equal(await js('opened.length'),installedOpenBefore.opened+1,'pending opens cannot be duplicated');
    assert.equal(await js('installs.length'),installedOpenBefore.installs,'opening an installed app never reinstalls it');
    await js('finishOpen()');
    await until(()=>js('!testOpenCard.hasAttribute("aria-busy")'),'installed app open settles');
    assert.equal(await js(`testOpenCard.querySelector('.appsx-card-open').textContent`),'打开应用');
    await js(`testOpenCard.querySelector('.appsx-card-open').click();failOpen(Error('fixture open failed'))`);
    await until(()=>js('!testOpenCard.hasAttribute("aria-busy")'),'failed installed app open settles');
    assert.equal(await js(`testOpenCard.querySelector('.appsx-card-open').textContent`),'打开应用','a failed window open remains retryable');
    assert.equal(await js(`appsBody.textContent.includes('fixture open failed')`),true);
    await js(`PluginUIHost.openContribution=originalOpen;document.querySelector('.apps-inline-note')?.remove();
      window.originalInstall=SoduWorkAPI.setEnterprisePluginInstalled;window.syncAttempts=0;
      SoduWorkAPI.setEnterprisePluginInstalled=()=>{syncAttempts++;return new Promise((_resolve,reject)=>{window.failSync=reject})};
      window.testSyncCard=[...document.querySelectorAll('.appsx-cover-card')].find(card=>card.textContent.includes('推荐未安装应用'));testSyncCard.querySelector('.appsx-card-open').click()`);
    assert.equal(await js(`testSyncCard.querySelector('.appsx-card-open').textContent`),'加载中…','actual synchronization keeps its pending feedback');
    await js(`testSyncCard.querySelector('.appsx-card-open').click();failSync(Error('fixture sync failed'))`);
    await until(()=>js('!testSyncCard.hasAttribute("aria-busy")'),'failed app sync settles');
    assert.equal(await js('syncAttempts'),1);
    assert.equal(await js(`testSyncCard.querySelector('.appsx-card-open').textContent`),'打开应用','failed synchronization restores the action label');
    await js(`SoduWorkAPI.setEnterprisePluginInstalled=originalInstall;document.querySelector('.apps-inline-note')?.remove()`);
    report.cases.push('Installed app opens keep the Open App label and never reinstall; pending duplicate opens are ignored; successful and failed opens clear busy state, and failed synchronization restores a retryable label.');
    fs.writeFileSync(path.join(out,'recommendations-open-uninstalled.png'),(await win.webContents.capturePage()).toPNG());
    const beforeInstall=await js('installs.length');
    await js(`[...document.querySelectorAll('.appsx-cover-card')].find(card=>card.textContent.includes('推荐未安装应用')).querySelector('.appsx-card-open').click()`);
    await until(()=>js('installs.length>'+beforeInstall),'recommended app add');
    assert.equal(await js('installs.at(-1)'),'recommended:new');
    await until(()=>js('opened.at(-1)==="recommended:new"'),'recommended app opened after add');
    await js(`document.querySelector('.appsx-cover-card .appsx-set').click()`);
    await until(()=>js('appsSettingsMask.classList.contains("show")'),'recommended settings');
    assert.equal(await js('appsSetUkeyMask.textContent'),'ak-26****');
    win.webContents.invalidate(); await delay(120);
    assert.equal(await js("(()=>{const r=appsSetUkeyMask.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===appsSetUkeyMask})()"),true,'masked ukey is visible and hit-testable above the catalog');
    await js('appsSetUkeyEdit.click();appsSetSave.click()');
    assert.equal(await js('appsSetError.hidden'),false);
    await js("appsSetUkey.value='fixture-new-ukey';appsSetSave.click()");
    await until(()=>js('!appsSettingsMask.classList.contains("show")'),'replacement ukey saved');
    assert.equal(await js('savedSettings.at(-1).values.ukey'),'fixture-new-ukey');
    assert.equal(await js('appsSetUkey.value'),'');
    await js(`document.querySelector('.appsx-cover-card .appsx-set').click()`);
    await until(()=>js('appsSettingsMask.classList.contains("show")'),'remove settings');
    await js('appsSetRemove.click()');
    await until(()=>js('!appsSettingsMask.classList.contains("show")'),'app removal');
    assert.deepEqual(await js('removed'), ['local:ops']);
    report.cases.push('Every installed app settings dialog exposes removal; removal uninstalls the personal app and refreshes the catalog.');
    win.setContentSize(1180,900);await delay(50);
    assert.equal(await js('getComputedStyle(document.querySelector("[data-apps-section=recommended] .appsx-grid")).gridTemplateColumns.split(" ").length'),2);
    assert.equal(await js('getComputedStyle(document.querySelector(".appsx-cover-card")).maxWidth'),'680px');
    assert.equal(await js('getComputedStyle(document.querySelector(".appsx-cover-card")).maxHeight'),'340px');
    fs.writeFileSync(path.join(out,'recommended.png'),(await capture()).toPNG());
    win.setContentSize(1600,900);await delay(50);
    assert.equal(await js('getComputedStyle(document.querySelector("[data-apps-section=recommended] .appsx-grid")).gridTemplateColumns.split(" ").length'),2);
    assert.equal(await js(`(()=>{const grid=document.querySelector('[data-apps-section=recommended] .appsx-grid'),card=grid?.querySelector('.appsx-cover-card');return Boolean(grid&&card)&&Math.abs(card.getBoundingClientRect().left-grid.getBoundingClientRect().left)<1})()`),true,'multiple recommendations stay left aligned on wide screens');
    const coverLayout=await js(`(()=>{const card=document.querySelector('.appsx-cover-card'),c=card.getBoundingClientRect(),cover=card.querySelector('.appsx-cover').getBoundingClientRect(),info=card.querySelector('.appsx-cover-info'),i=info.getBoundingClientRect(),style=getComputedStyle(info);return {coverFills:Math.abs(c.width-cover.width-2)<1&&Math.abs(c.height-cover.height-2)<1,bottomOverlay:Math.abs(c.bottom-i.bottom-1)<1&&i.top>c.top,titleSize:getComputedStyle(card.querySelector('b')).fontSize,blur:style.backdropFilter,background:style.backgroundColor}})()`);
    assert.equal(coverLayout.coverFills,true);assert.equal(coverLayout.bottomOverlay,true);
    assert.equal(coverLayout.titleSize,'24px');assert.ok(coverLayout.blur.includes('blur(18px)'));
    report.coverLayout=coverLayout;
    fs.writeFileSync(path.join(out,'recommended-wide.png'),(await capture()).toPNG());
    await js(`document.querySelector('[data-apps-section=recommended]').style.width='900px'`);await delay(50);
    assert.equal(await js('getComputedStyle(document.querySelector("[data-apps-section=recommended] .appsx-grid")).gridTemplateColumns.split(" ").length'),2,'columns follow container width even in a wide window');
    await js(`document.querySelector('[data-apps-section=recommended]').style.width=''`);
    await js(`(async()=>{fixtureItems=[fixtureItems.find(x=>x.pluginId==='recommended:new')].filter(Boolean);await SoduWorkApps.render(true);document.querySelector('[data-tab="mine"]').click()})()`);
    win.setContentSize(1600,900);await delay(50);
    assert.equal(await js(`(()=>{const grid=document.querySelector('[data-apps-section=recommended] .appsx-grid'),card=grid?.querySelector('.appsx-cover-card');return Boolean(grid&&card)&&Math.abs(card.getBoundingClientRect().left-grid.getBoundingClientRect().left)<1})()`),true,'single recommendation stays left aligned on wide screens');
    report.cases.push('A single recommendation and multiple recommendations remain left aligned on wide screens.');
    win.setContentSize(390,850);await delay(50);
    assert.equal(await js('getComputedStyle(document.querySelector("[data-apps-section=recommended] .appsx-grid")).gridTemplateColumns.split(" ").length'),1);
    assert.equal(await js('appsPanel.scrollWidth>innerWidth'),false);
    report.narrowLayout=await js(`[appsBody,...document.querySelectorAll('[data-apps-section=recommended],.appsx-cover-card,.appsx-cover-info,.appsx-cover-meta')].map(e=>({class:e.className,width:e.getBoundingClientRect().width,scroll:e.scrollWidth,client:e.clientWidth,style:e.getAttribute('style')}))`);
    assert.equal(await js('appsBody.scrollWidth>appsBody.clientWidth'),false,'narrow recommendation content has no horizontal overflow');
    win.webContents.invalidate();await delay(160);
    fs.writeFileSync(path.join(out,'recommended-narrow.png'),(await capture()).toPNG());
    report.cases.push('Recommendation covers fill the card, 24px titles and two-line descriptions float in a translucent blurred bottom panel; wide and medium containers use two columns, narrow containers use one.');
    const refreshCalls=await js('catalogCalls');await js('SoduWorkApps.close();SoduWorkApps.open()');
    await until(()=>js('catalogCalls>'+refreshCalls),'reopen fetches current recommendations');
    report.cases.push('Recommendations include authorized uninstalled apps, retain overlap with Common for starred installed apps while My excludes starred apps, exclude unlisted/denied entries; star and settings share the upper right row above matching Open App text buttons for installed and uninstalled apps; Open App adds, synchronizes and opens when needed; masked ukey replacement validates and clears; reopening refetches.');
    await js(fs.readFileSync(path.resolve(__dirname, '../components/panels/panels-capabilities.js'), 'utf8') + '\n;void 0;');
    await js(`window.detailOpened=[];window.detailSnapshot={items:[{pluginId:'remote:new'}]};
      window.SoduWorkCapabilityPlugins={load:async()=>detailSnapshot,open:(id,ctx)=>{detailOpened.push({id,modal:typeof ctx.openModal,api:ctx.api===SoduWorkAPI})}};void 0`);
    await js('openCapabilityPlugin("remote:new")');
    assert.deepEqual(await js('detailOpened'), [{ id: 'remote:new', modal: 'function', api: true }]);
    assert.equal(await js('(async()=>{detailSnapshot={items:[]};try{await openCapabilityPlugin("remote:new");return false}catch(e){return true}})()'), true);
    assert.equal(await js('(async()=>{detailSnapshot={items:[{pluginId:"remote:new"}],remoteError:"fixture offline"};try{await openCapabilityPlugin("remote:new");return false}catch(e){return true}})()'), true);
    assert.equal(await js('detailOpened.length'), 1);
    report.cases.push('Production detail entry supplies the existing installation modal context and rejects missing or unavailable remote catalog entries.');
    /* Local apps show a gray source label; market apps, including installed ones, have no source label. */
    await js(`(async()=>{
      fixtureItems=[makeApp('local:lite','轻量画板',{personal:true}),
        makeApp('local:web','网页服务',{personal:true,template:'app',ui:{contributions:[{id:'main',slot:'workspace.navigation',source:{type:'external',url:'https://app.example.com',openMode:'workspace'}}]}}),
        makeApp('remote:mweb','市场网页应用',{installed:false,listed:true,template:'app',ui:{contributions:[{id:'main',slot:'workspace.navigation',source:{type:'external',url:'https://market.example.com',openMode:'workspace'}}]}}),
        makeApp('remote:installed-source','市场已安装应用',{installed:true,listed:true}),
        makeApp('remote:feat','精选网页应用',{listed:true,template:'app',marketPolicy:{featured:true},coverUrl:${JSON.stringify(coverUrl)},ui:{contributions:[{id:'main',slot:'workspace.navigation',source:{type:'external',url:'https://feat.example.com',openMode:'workspace'}}]}})];
      catalogError='';localStorage.setItem('soduwork-apps-favorites','[]');await SoduWorkApps.render(true);document.querySelector('[data-tab="mine"]').click();
    })()`);
    await until(()=>js('document.querySelectorAll(".appsx-source-tag").length===2'),'local source tags rendered');
    assert.deepEqual(await js(`Object.fromEntries([...document.querySelectorAll('[data-apps-section="mine"] .appsx-card-headline')].map(row=>[row.querySelector('b').textContent,row.querySelector('.appsx-source-tag')?.textContent||null]))`),
      {'轻量画板':'本机安装','网页服务':'本机安装','市场已安装应用':null},
      'local web and light apps have a source label; installed market apps do not');
    const sourceColors=await js(`[...document.querySelectorAll('.appsx-source-tag')].map(tag=>{const s=getComputedStyle(tag);return {color:s.color,background:s.backgroundColor,border:s.borderTopColor,shadow:s.boxShadow,image:s.backgroundImage}})`);
    for(const style of sourceColors){
      for(const color of [style.color,style.background,style.border]){
        const channels=color.match(/[\d.]+/g).slice(0,3).map(Number);
        assert.ok(Math.max(...channels)-Math.min(...channels)<=10,'source tag text, fill and border are neutral gray');
      }
      assert.equal(style.shadow,'none');assert.equal(style.image,'none');
    }
    win.setContentSize(1180,900);await delay(50);
    fs.writeFileSync(path.join(out,'source-tags.png'),(await win.webContents.capturePage()).toPNG());
    await js(`localStorage.setItem('soduwork-apps-favorites',JSON.stringify(['local:web','remote:installed-source']));SoduWorkApps.render(false)`);
    assert.deepEqual(await js(`Object.fromEntries([...document.querySelectorAll('[data-apps-section="favorites"] .appsx-card-headline')].map(row=>[row.querySelector('b').textContent,row.querySelector('.appsx-source-tag')?.textContent||null]))`),
      {'网页服务':'本机安装','市场已安装应用':null},'favorites retain the same source distinction');
    await js(`document.querySelector('[data-tab="market"]').click()`);
    assert.equal(await js(`document.querySelectorAll('.appsx-source-tag,.appsx-kind').length`),0,'market rows have no tags whether installed or not');
    await js(`document.querySelector('[data-tab="mine"]').click()`);
    assert.equal(await js(`document.querySelectorAll('.appsx-cover-card .appsx-source-tag,.appsx-kind').length`),0,'recommendations have no source or colored type tags');
    win.setContentSize(390,900);await delay(50);
    assert.equal(await js('appsBody.scrollWidth>appsBody.clientWidth'),false,'source labels fit narrow app rows');
    fs.writeFileSync(path.join(out,'source-tags-narrow.png'),(await win.webContents.capturePage()).toPNG());
    report.cases.push('Mine and Favorites mark only local apps as 本机安装 using neutral gray text/fill/borders without glow; market and recommendation cards have no tags, including installed market apps; narrow rows do not overflow.');
    /* ---- Create-app dialog: select the type before entering the existing conversation flow. ---- */
    await js(`window.developerCalls=[];window.WorkspaceHost={open:(route,payload)=>developerCalls.push({route,payload})};document.querySelector("#appsAdd").click()`);
    assert.equal(await js('document.getElementById("appsCreateMask").classList.contains("show")'),true,'Add opens the create-app dialog first');
    assert.deepEqual(await js('[...document.querySelectorAll(".appsx-create-opt")].map(o=>o.querySelector("b").textContent)'), ['轻应用','网页应用','桌面客户端']);
    assert.equal(await js('document.querySelector("#appsCreateGo").disabled'),true,'Create stays disabled until a type is picked');
    assert.equal(await js('developerCalls.length'),0);
    await js(`document.querySelector('.appsx-create-opt[data-kind="web"]').click()`);
    await until(()=>js("getComputedStyle(document.querySelector('.appsx-create-opt.selected .appsx-create-mark')).backgroundColor==='rgb(61, 139, 255)'"),'create selection transition completes');
    fs.writeFileSync(path.join(out,'create-dialog.png'),(await win.webContents.capturePage()).toPNG());
    assert.equal(await js(`document.querySelector('.appsx-create-opt[data-kind="web"]').getAttribute("aria-checked")`),'true');
    const selStyle = await js(`(()=>{const opt=document.querySelector('.appsx-create-opt[data-kind="web"]');const mark=opt.querySelector('.appsx-create-mark');const s=getComputedStyle(opt),m=getComputedStyle(mark);return {optBorder:s.borderColor,markBorder:m.borderColor,markBg:m.backgroundColor,markColor:m.color,markSvg:!!mark.querySelector('svg')}})()`);
    const optBorders = await js(`[...document.querySelectorAll('.appsx-create-opt')].map(o=>getComputedStyle(o).borderColor)`);
    assert.notEqual(optBorders[0], optBorders[1], 'selected option gets an accent border');
    assert.equal(selStyle.markSvg,true,'selected mark contains the check icon');
    assert.equal(selStyle.markBg,'rgb(61, 139, 255)','selected mark fills with accent');
    assert.equal(await js('document.querySelector("#appsCreateGo").disabled'),false);
    await js('document.querySelector("#appsCreateGo").click()');
    assert.equal(await js('document.getElementById("appsCreateMask").classList.contains("show")'),false,'dialog closes on create');
    assert.equal(await js('developerCalls[0].route'),'create');
    assert.equal(await js('developerCalls[0].payload.pluginId'),'local:app-developer');
    assert.equal(await js('developerCalls[0].payload.newSession'),true);
    assert.equal(await js('developerCalls[0].payload.prefill'),'创建网页类应用：');
    await js(`document.querySelector("#appsAdd").click();document.querySelector('.appsx-create-opt[data-kind="desktop"]').click();document.querySelector("#appsCreateGo").click()`);
    assert.equal(await js('developerCalls[1].payload.prefill'),'创建桌面客户端：');
    await js(`document.querySelector("#appsAdd").click();document.querySelector('.appsx-create-opt[data-kind="lite"]').click();document.querySelector("#appsCreateGo").click()`);
    assert.equal(await js('developerCalls[2].payload.prefill'),'创建轻应用：');
    await js(`document.querySelector("#appsAdd").click()`);
    assert.equal(await js(`document.querySelector("#appsCreateGo").disabled`),true,'reopening clears the previous selection');
    await js(`document.querySelector("#appsCreateCancel").click()`);
    assert.equal(await js('document.getElementById("appsCreateMask").classList.contains("show")'),false);
    assert.equal(await js('developerCalls.length'),3,'cancel does not create');
    assert.equal(await js(`!!document.getElementById("appsCreateInstall")`),true,'package install stays reachable in the dialog');
    report.cases.push('Add opens a create-app dialog with Web/Desktop/Light types; picking one enables 立即创建 which routes to the shared new-conversation entry with a type prefill like 创建网页类应用：; cancel and reopen reset the selection and package install remains reachable.');
    await js(`document.querySelector('#appsAdd').click()`);
    assert.equal(await js('appsCreateInstall.textContent'), '导入应用包');
    const localeScripts = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../core/locales/manifest.json'), 'utf8'))
      .map(file => asset('core/locales/' + file)).concat([asset('core/i18n-dom.js'), asset('core/i18n.js')]);
    await js(`(async()=>{for(const src of ${JSON.stringify(localeScripts)})await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=reject;document.head.appendChild(s)})})()`);
    for (const locale of ['zh-CN', 'en-US']) {
      await js(`SoduWorkI18n.setLocale(${JSON.stringify(locale)},{persist:false,broadcast:false})`);
      await until(() => js(`appsCreateInstall.textContent===${JSON.stringify(locale === 'zh-CN' ? '导入应用包' : 'Import app package')}`), 'import package translation');
      assert.equal(await js('appsCreateGo.textContent'), locale === 'zh-CN' ? '立即创建' : 'Create now');
      assert.deepEqual(await js(`Array.from(document.querySelectorAll('.appsx-create-opt'),row=>row.dataset.kind)`), ['lite', 'web', 'desktop']);
      assert.equal(await js(`document.querySelector('.appsx-create-easy').textContent`), locale === 'zh-CN' ? '简易' : 'Easy');
      assert.equal(await js(`document.querySelectorAll('.appsx-create-easy').length`), 1);
      for (const width of [320, 700]) {
        win.setContentSize(width, 900); await delay(80);
        const layout = await js(`(()=>{const a=appsCreateInstall,b=appsCreateGo,r=a.getBoundingClientRect(),s=getComputedStyle(a);return {bg:s.backgroundColor,primary:getComputedStyle(b).backgroundColor,radius:parseFloat(s.borderRadius),fits:r.left>=0&&r.right<=innerWidth,overflow:document.querySelector('.appsx-create').scrollWidth>document.querySelector('.appsx-create').clientWidth+1}})()`);
        assert.equal(layout.bg, layout.primary); assert.notEqual(layout.bg, 'rgba(0, 0, 0, 0)');
        assert.ok(layout.radius >= 16); assert.equal(layout.fits, true); assert.equal(layout.overflow, false);
        const badge = await js(`(()=>{const e=document.querySelector('.appsx-create-easy'),r=e.getBoundingClientRect(),p=e.closest('button').getBoundingClientRect(),m=e.closest('button').querySelector('.appsx-create-mark').getBoundingClientRect(),s=getComputedStyle(e);return {bg:s.backgroundColor,color:s.color,fits:r.right<=p.right+1&&r.left>=p.left&&r.top>=p.top-1,clear:r.bottom<=m.top}})()`);
        assert.equal(badge.bg, 'rgb(24, 24, 27)'); assert.equal(badge.color, 'rgb(255, 255, 255)');
        assert.equal(badge.fits, true); assert.equal(badge.clear, true, 'badge does not cover the selection control');
        fs.writeFileSync(path.join(out, 'create-dialog-'+locale+'-'+width+'.png'), (await win.webContents.capturePage()).toPNG());
      }
    }
    await js(`SoduWorkI18n.setLocale('zh-CN',{persist:false,broadcast:false})`);
    await until(() => js('appsCreateInstall.textContent==="导入应用包"'), 'Chinese label restores');
    report.cases.push('Import app package uses the same solid rounded button as Create now; real Chinese/English catalogs switch the full creation dialog and fit 320/700px widths.');
    report.cases.push('Light app comes first with one black Easy/简易 corner badge; both locales fit narrow and wide dialogs without covering the selection control.');
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); if (win && !win.isDestroyed()) win.destroy(); if(coverServer)coverServer.close(); app.exit(report.ok ? 0 : 1);
  });
}
