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
      '<link rel="stylesheet" href="' + asset('components/panels/plugin-install-setup.css') + '">' +
      '<link rel="stylesheet" href="' + asset('components/panels/panels-capabilities.css') + '">' +
      '<link rel="stylesheet" href="' + asset('components/panels/panels-schedules.css') + '">' +
      '<link rel="stylesheet" href="' + asset('components/panels/panels-capability-plugins.css') + '">' +
      '<style>*{box-sizing:border-box}body{margin:0;background:var(--bg-0);font:14px "Segoe UI",sans-serif}.sch-panel.appsx{display:none}.sch-panel.appsx.show{display:flex;flex-direction:column;width:100%;height:100vh;max-height:none}</style>' +
      '<script src="' + asset('components/panels/panels-plugin-builder-entry.js') + '"></script>' +
      '<script src="' + asset('core/plugin-icon.js') + '"></script>' +
      '<script src="' + asset('components/panels/plugin-install-setup.js') + '"></script>' +
      '<script src="' + asset('components/panels/plugin-catalog-format.js') + '"></script>' +
      '<script src="' + asset('components/panels/plugin-publication-ux.js') + '"></script>' +
      '<script src="' + asset('components/panels/panels-capability-plugins.js') + '"></script>' +
      '<script src="' + asset('components/panels/panels-capabilities.js') + '"></script>' +
      '<script src="' + asset('components/panels/panels-apps.js') + '"></script></html>');
    win = new BrowserWindow({ show: false, width: 1180, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await win.loadFile(path.join(temp, 'index.html'));
    const js = async source => {
      try { return await win.webContents.executeJavaScript(source); }
      catch (error) { throw Error(String(error.message) + '\nFixture expression: ' + source, { cause: error }); }
    };
    await js(`(async()=>{window.catalogCalls=0;window.opened=[];window.installs=[];window.removed=[];window.catalogError='';window.failCatalog=false;
      window.makeApp=(id,name,extra={})=>({pluginId:id,name,description:'用于验证应用目录与卡片操作',enabled:true,ui:{contributions:[{id:'main',slot:'workspace.navigation'}]},...extra});
      window.fixtureSubmissions=[];
      window.fixtureItems=[makeApp('local:flow','流程画布',{personal:true,version:'0.4.31'}),makeApp('local:ops','运营云端版',{personal:true,key:'ops',version:'0.4.54',checksum:'ops-v1',setup:{preferences:[{key:'modelId',label:'模型 ID',type:'text',required:true},{key:'pageSize',label:'每页数量',type:'number',minimum:1,maximum:100}]},setupConfig:{modelId:'fixture-current',pageSize:20}}),
        makeApp('remote:installed','团队应用',{installed:true,version:'2.0.0',installedVersion:'1.9.0'}),makeApp('remote:new','远端新应用',{installed:false,version:'3.0.0'}),
        makeApp('remote:unlisted','已下架但已安装',{installed:true,listed:false}),
        makeApp('remote:denied','无使用权限',{permissions:{canUse:false}}),makeApp('local:disabled','停用应用',{personal:true,enabled:false}),
        {pluginId:'local:no-ui',name:'普通插件',personal:true}];
      window.SoduWorkAPI={configurePersonalPlugin:async(id,checksum,config)=>{configured.push({id,checksum,config});const item=fixtureItems.find(x=>x.pluginId===id);item.setupConfig=config;return {ok:true,plugin:{...item}}},pluginCatalog:async()=>{catalogCalls++;if(failCatalog)throw Error('fixture offline');return {items:fixtureItems,submissions:fixtureSubmissions,remoteError:catalogError}},
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
    assert.deepEqual(await js(`[...document.querySelectorAll('[data-apps-section=mine] .appsx-version-tag,[data-apps-section=favorites] .appsx-version-tag')].map(n=>n.textContent).sort()`), ['v0.4.31', 'v0.4.54', 'v1.9.0']);
    assert.equal(await js(`appVersionTagHtml({item:{version:'<img src=x onerror=alert(1)>'}}).includes('<img')`), false);
    assert.equal(await js(`appVersionTagHtml({item:{}})`), '');
    assert.equal(await js(`appVersionTagHtml({item:{version:'3.0.0'}}).includes('市场版本：3.0.0')`), true);
    let groups = await sections(); assert.deepEqual(groups.map(x => x.title), ['常用', '我的', '市场']);
    assert.deepEqual(groups[0].names, ['团队应用', '流程画布']);
    assert.deepEqual(new Set(groups[1].names), new Set(['运营云端版', '已下架但已安装']));
    report.cases.push('No top catalog tabs; Favorites, Mine and Market are consecutive sections. Local/installed remote apps are usable; unavailable, disabled and non-UI entries are excluded.');
    assert.equal(await js(`appsEmptyHtml('', 'recommended', false)`),'','no empty recommendation hint');
    assert.equal(await js(`appsEmptyHtml('', 'favorites', false)`),'','no empty favorites hint');
    assert.equal(await js(`appsEmptyHtml('查询', 'recommended', false).includes('没有匹配结果')`),true,'search still reports no matches');
    // Exercise the production grids with enough cards and unbroken text to expose intrinsic sizing.
    await js(`window.layoutOriginals=[...document.querySelectorAll('.appsx-section .appsx-grid')].map(grid=>({grid,html:grid.innerHTML}));
      for(const {grid} of layoutOriginals){while(grid.children.length<5)grid.append(grid.firstElementChild.cloneNode(true));
        for(const card of grid.children){card.querySelector('small').textContent='超长应用详情ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(30);card.querySelector('b').textContent='超长应用名称'.repeat(20)}}`);
    for (const [width, columns] of [[320,1],[680,1],[800,2],[1180,3],[1600,3],[2400,3]]) {
      win.setContentSize(width, 900);
      await until(()=>js('innerWidth==='+width),'window resize to '+width); await delay(70);
      const layouts = await js(`layoutOriginals.map(({grid})=>{const cards=[...grid.children],r=grid.getBoundingClientRect();return {
        columns:cards.filter(card=>Math.abs(card.getBoundingClientRect().top-cards[0].getBoundingClientRect().top)<1).length,
        fits:cards.every(card=>{const c=card.getBoundingClientRect();return c.width<=680.1&&c.left>=r.left&&c.right<=r.right+.1}),
        ellipsis:cards.every(card=>{const d=card.querySelector('small'),s=getComputedStyle(d);return d.scrollWidth>d.clientWidth&&s.textOverflow==='ellipsis'&&s.whiteSpace==='nowrap'}),
        overflow:grid.scrollWidth>grid.clientWidth}})`);
      for (const layout of layouts) assert.deepEqual(layout, {columns,fits:true,ellipsis:true,overflow:false}, 'list layout at '+width);
      const header = await js(`({title:document.querySelector('.appsx-title-wrap').getBoundingClientRect().left,content:document.querySelector('.appsx-section').getBoundingClientRect().left,tools:document.querySelector('.appsx-tools').getBoundingClientRect().right})`);
      assert.ok(Math.abs(header.title-header.content)<=9,'title aligns with centered content');
      const centered = await js(`(()=>{const parent=document.querySelector('.appsx-scroll').getBoundingClientRect();return [...document.querySelectorAll('.appsx-section')].map(s=>{const r=s.getBoundingClientRect();return {width:r.width,center:Math.abs((r.left+r.right)/2-(parent.left+parent.right)/2)}})})()`);
      for (const section of centered) { assert.ok(section.width<=1440.1,'content width is capped at 1440'); assert.ok(section.center<=9,'all groups share the horizontal center including scroll gutter'); }
      fs.writeFileSync(path.join(out,'list-layout-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
    }
    await js(`appsPanel.style.width='620px'`); await delay(70);
    assert.equal(await js(`layoutOriginals.every(({grid})=>getComputedStyle(grid).gridTemplateColumns.split(' ').length===1)`),true,'a constrained panel follows its own width on a wide screen');
    await js(`appsPanel.style.width='';for(const {grid,html} of layoutOriginals)grid.innerHTML=html;delete window.layoutOriginals;SoduWorkApps.render()`);
    win.setContentSize(1180,900); await delay(70);
    report.cases.push('Common/My list grids use one/two/three columns at 320–2400px and follow constrained panel width; cards stay at most 680px and long descriptions truncate without horizontal overflow.');
    await js('document.activeElement.blur()');win.webContents.sendInputEvent({type:'mouseMove',x:0,y:0});await delay(50);
    assert.equal(await js(`[...document.querySelectorAll('.appsx-card')].every(card=>{const star=card.querySelector('.appsx-fav');if(!star)return false;for(let el=star;el;el=el.parentElement){const style=getComputedStyle(el);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)<.99)return false}return true})`),true,'all application stars are visible without hover or focus');
    const versionStyle = () => js(`(()=>{const tag=document.querySelector('.appsx-version-tag'),card=tag.closest('.appsx-card'),s=getComputedStyle(tag),r=card.getBoundingClientRect();return {visibility:s.visibility,border:s.borderTopWidth,fill:s.backgroundColor,background:getComputedStyle(card).backgroundColor,x:r.x,y:r.y,width:r.width,height:r.height}})()`);
    const resting = await versionStyle();
    assert.equal(resting.visibility, 'hidden');
    assert.equal(resting.border, '0px');
    assert.equal(resting.fill, 'rgba(0, 0, 0, 0)');
    assert.notEqual(resting.background, 'rgba(0, 0, 0, 0)');
    fs.writeFileSync(path.join(out,'version-resting.png'),(await win.webContents.capturePage()).toPNG());
    win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(resting.x+80),y:Math.round(resting.y+resting.height/2)});
    await until(async () => (await versionStyle()).visibility === 'visible', 'hover reveals plain version');
    assert.deepEqual({...await versionStyle(),visibility:'hidden'}, resting, 'hover preserves background and card geometry');
    fs.writeFileSync(path.join(out,'version-hover.png'),(await win.webContents.capturePage()).toPNG());
    win.webContents.sendInputEvent({type:'mouseMove',x:0,y:0});
    await until(async () => (await versionStyle()).visibility === 'hidden', 'pointer leave hides version');
    await js(`document.querySelector('.appsx-version-tag').closest('.appsx-card').focus()`);
    assert.equal((await versionStyle()).visibility, 'visible', 'keyboard focus reveals version');
    await js('document.activeElement.blur()');
    report.cases.push('Versions are plain text without border or fill, hidden at rest, shown on hover or keyboard focus; card background and geometry remain unchanged on hover.');
    await js(`window.savedSettings=[];window.soduWorkAPI={appSettings:{
      get:async()=>({ok:true,revision:2,values:{theme:'dark'},secretKeys:['ukey'],secretMasks:{ukey:'ak-26****'},configuredKeys:['ukey','theme']}),
      update:async(id,value)=>{savedSettings.push({id,...value});return {ok:true,revision:3,values:{theme:'dark',model:'legacy-model'},secretKeys:['ukey'],secretMasks:{ukey:'ak-26****'},configuredKeys:['ukey','theme','model']}}}};
      localStorage.setItem('soduwork-app-settings:local:ops',JSON.stringify({model:'legacy-model',ukey:'obsolete-legacy-key'}));
      [...document.querySelectorAll('.appsx-card')].find(e=>e.textContent.includes('运营云端版')).querySelector('.appsx-set').click()`);
    await until(()=>js('appsSettingsMask.classList.contains("show")'),'app settings');
    assert.equal(await js('document.querySelector(".appsx-settings-name").textContent'),'运营云端版');
    assert.equal(await js('document.querySelector(".appsx-settings-version").textContent'),'版本 v0.4.54');
    assert.equal(await js('getComputedStyle(document.querySelector(".appsx-settings-version")).visibility'),'visible');
    assert.equal(await js('document.querySelector(".appsx-settings-description").textContent'),'用于验证应用目录与卡片操作');
    assert.equal(await js('!!document.querySelector(".appsx-settings-icon svg")'),true);
    assert.equal(await js('!!document.querySelector("#appsSetModel,#appsSetParams,#appsSetUkey,#appsSetUkeyEdit")'),false);
    assert.equal(await js('/ukey|ak-26|默认模型|应用参数（JSON）/.test(appsSettingsMask.textContent)'),false);
    assert.equal(await js('savedSettings[0].values.model'),'legacy-model','legacy model still migrates');
    assert.equal(await js('JSON.stringify(savedSettings).includes("obsolete-legacy-key")'),false);
    assert.equal(await js('localStorage.getItem("soduwork-app-settings:local:ops")'),null);
    await js(`window.publishCalls=[];window.signCalls=[];window.failAudience=false;window.deferDetail=false;
      SoduWorkAPI.personalPlugin=async id=>{if(deferDetail)await new Promise(r=>window.releaseDetail=r);return {plugin:{localDraft:{template:'app',author:'即用实验室',appCategory:'other',name:'运营云端版',version:'0.4.54',ui:{contributions:[{id:'main',slot:'workspace.navigation'}]}}}}};
      soduWorkAPI.personalPlugins={updateMetadata:async(id,options)=>{const plugin=fixtureItems.find(p=>p.pluginId===id);Object.assign(plugin,{authorName:options.author,appCategory:options.appCategory,version:'0.4.55',checksum:'ops-category'});plugin.localDraft={template:'app',key:plugin.key,name:plugin.name,version:plugin.version,author:options.author,appCategory:options.appCategory,ui:plugin.ui};return {ok:true,plugin:{...plugin}}}};
      SoduWorkAPI.pluginAudienceCandidates=async()=>{if(failAudience)throw Error('fixture audience unavailable');return {items:[{id:'person-1',name:'成员',username:'member'}],orgUnits:[]}};
      SoduWorkAPI.personalPluginPublisherIdentity=async()=>({identity:{keyId:'fixture-key',fingerprint:'fixture-fingerprint'}});
      SoduWorkAPI.signPersonalPluginDraft=async draft=>{signCalls.push(draft);return {signature:'fixture-signature',identity:{keyId:'fixture-key'}}};
      SoduWorkAPI.publishPersonalPlugin=async(...args)=>{publishCalls.push(args);fixtureSubmissions=[{key:'ops',version:args[0].version,trustState:'quarantined',enabled:false}];return {message:'应用已提交审核'}};
      document.querySelector('[data-setup-key="modelId"]').value='unsaved-model';appsSetPublish.click()`);
    await until(()=>js('!!document.querySelector("#capPublishDo")'),'shared app publication dialog');
    assert.equal(await js('capModalTitle.textContent'),'申请上架');
    assert.equal(await js('capPublishAppCategory.value'),'other');
    assert.equal(await js('document.querySelectorAll("#capPublishAppCategory option").length'),4);
    assert.equal(await js('appsSettingsMask.classList.contains("show")'),false);
    assert.equal(await js('publishCalls.length'),0,'opening application publication does not submit');
    win.show(); win.focus(); win.webContents.invalidate(); await delay(220);
    fs.writeFileSync(path.join(out,'app-publication.png'),(await win.webContents.capturePage()).toPNG());
    await js('capPublishCancel.click()');
    assert.equal(await js('appsSettingsMask.classList.contains("show")'),true);
    assert.equal(await js('document.querySelector(\'[data-setup-key="modelId"]\').value'),'unsaved-model');
    await until(()=>js('!appsSetPublish.disabled'),'cancel refreshes server review status');
    await js('appsSetPublish.click()');
    await until(()=>js('!capModalLayer.hidden'),'publication header close');
    await js('capModalClose.click()');
    assert.equal(await js('appsSettingsMask.classList.contains("show")'),true,'header close also restores settings');
    await until(()=>js('!appsSetPublish.disabled'),'header close refreshes server review status');
    await js('failAudience=true;appsSetPublish.click()');
    await until(()=>js('!appsSetPublish.disabled'),'publication preparation failure');
    assert.match(await js('appsSetError.textContent'),/fixture audience unavailable/);
    await js('failAudience=false;appsSetPublish.click()');
    await until(()=>js('!capModalLayer.hidden'),'publication retry');
    await js(`document.querySelector('input[name="capAudience"][value="users"]').click();capPublishDo.click()`);
    assert.equal(await js('publishCalls.length'),0,'empty audience blocks upload');
    await js('document.querySelector("#capAudienceList input").click();capPublishAppCategory.value="game";capPublishDo.click()');
    await until(()=>js('publishCalls.length===1 && capModalLayer.hidden'),'signed publication');
    assert.deepEqual(await js('publishCalls[0].slice(1,5)'),['users',['person-1'],[],'fixture-signature']);
    assert.equal(await js('publishCalls[0][0].author'),'即用实验室');
    assert.equal(await js('publishCalls[0][0].appCategory'),'game');
    assert.equal(await js('publishCalls[0][0].version'),'0.4.55','category selection creates a new immutable version before signing');
    assert.equal(await js('signCalls[0].appCategory'),'game');
    assert.equal(await js('publishCalls[0][0].ui.contributions[0].slot'),'workspace.navigation','application manifest uses the same publication payload');
    await until(()=>js('appsSetPublish.textContent==="上架审核中" && appsSetPublish.disabled'),'server receipt replaces request listing');
    await js('appsSetPublish.click()');
    assert.equal(await js('publishCalls.length'),1,'pending version cannot be submitted again');
    await js('closeAppSettings();fixtureSubmissions=[{key:"ops",version:"0.4.53",trustState:"quarantined"}];openAppSettings({item:fixtureItems.find(x=>x.pluginId==="local:ops"),title:"运营云端版"})');
    await until(()=>js('!appsSetPublish.disabled'),'older version receipt does not block current version');
    for (const [receipt, label] of [
      [{trustState:'approved',enabled:true,catalogReady:true},'已上架'],
      [{trustState:'approved',enabled:true,catalogReady:false},'审核已通过'],
      [{trustState:'quarantined',reviewDecision:'reject'},'审核未通过'],
      [{trustState:'revoked'},'上架已撤销'],
    ]) {
      await js(`closeAppSettings();fixtureSubmissions=[{key:'ops',version:fixtureItems.find(x=>x.pluginId==='local:ops').version,...${JSON.stringify(receipt)}}];openAppSettings({item:fixtureItems.find(x=>x.pluginId==='local:ops'),title:'运营云端版'})`);
      await until(()=>js(`appsSetPublish.textContent===${JSON.stringify(label)} && appsSetPublish.disabled`),'current server receipt: '+label);
    }
    await js(`closeAppSettings();catalogError='fixture review offline';openAppSettings({item:fixtureItems.find(x=>x.pluginId==='local:ops'),title:'运营云端版'})`);
    await until(()=>js('appsSetPublish.textContent==="上架状态暂不可用" && appsSetPublish.disabled'),'remote failure never claims an unsubmitted version');
    await js(`closeAppSettings();catalogError='';fixtureSubmissions=[];openAppSettings({item:fixtureItems.find(x=>x.pluginId==='local:ops'),title:'运营云端版'})`);
    await until(()=>js('!appsSetPublish.disabled'),'server review status recovered');
    report.cases.push('Settings read authenticated server receipts: pending disables duplicate upload, older versions do not block new ones, approved/listed/rejected/revoked remain distinct, and unavailable status cannot be mistaken for no submission.');
    await js('deferDetail=true;appsSetPublish.click()');
    await until(()=>js('typeof releaseDetail==="function"'),'delayed publication prerequisites');
    await js('closeAppSettings();releaseDetail()');
    await delay(70);
    assert.equal(await js('capModalLayer.hidden'),true,'closed settings reject delayed publication dialog');
    await js('deferDetail=false;openAppSettings({item:fixtureItems.find(x=>x.pluginId==="local:ops"),title:"运营云端版",desc:"用于验证应用目录与卡片操作"})');
    report.cases.push('Local app settings reuse the production signed publication dialog; cancellation preserves unsaved preferences, audience validation blocks empty selections, errors allow retry, and closed settings discard late results.');
    await js(`document.querySelector('[data-setup-key="modelId"]').value='custom-model';document.querySelector('[data-setup-key="pageSize"]').value='42';appsSetSave.click()`);
    await until(()=>js('!appsSettingsMask.classList.contains("show")'),'declared preference save');
    assert.deepEqual(await js('configured.at(-1)'),{id:'local:ops',checksum:'ops-category',config:{modelId:'custom-model',pageSize:42}});
    assert.equal(await js('savedSettings.length'),1,'editing declared preferences does not write hidden app credentials');
    await js(`[...document.querySelectorAll('.appsx-card')].find(e=>e.textContent.includes('团队应用')).querySelector('.appsx-set').click()`);
    await until(()=>js('appsSettingsMask.classList.contains("show")'),'metadata only settings');
    assert.equal(await js('document.querySelector(".appsx-settings-version").textContent'),'版本 v1.9.0','settings show installed version, not newer market version');
    assert.equal(await js('!!document.querySelector("#appsSetParams,#appsSetSave,[data-setup-key]")'),false);
    assert.equal(await js('!!document.querySelector("#appsSetPublish")'),false,'installed enterprise apps cannot be republished');
    win.show(); win.focus(); win.webContents.invalidate(); await delay(220);
    const settingsLayout = await js(`(()=>{const e=document.querySelector('.appsx-settings-name'),r=e.getBoundingClientRect(),top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2),mask=appsSettingsMask,s=getComputedStyle(mask);return {width:r.width,height:r.height,hit:!!top&&mask.contains(top),display:s.display,z:s.zIndex,top:top?.outerHTML.slice(0,200)}})()`);
    assert.equal(settingsLayout.hit,true,JSON.stringify(settingsLayout));
    fs.writeFileSync(path.join(out,'settings-metadata-only.png'),(await win.webContents.capturePage()).toPNG());
    await js('appsSetClose.click()');
    report.cases.push('Settings always show app icon/name/description/installed version; only app-declared preferences render/save through the existing plugin configuration path, with no generic JSON/default-model/ukey fields or credential writes.');
    const calls = await js('catalogCalls');
    await js(`document.querySelector('[data-apps-section="mine"] .appsx-card').click()`);
    const selectedName = await js(`document.querySelector('[data-apps-section="mine"] .appsx-card-txt b').textContent`);
    assert.equal(await js('fixtureItems.find(x=>x.pluginId===opened[0]).name'), selectedName);
    await js(`document.querySelector('[data-apps-section="favorites"] .appsx-fav').click()`);
    groups = await sections(); assert.deepEqual(groups[0].names, ['流程画布']);
    assert.ok(groups[1].names.includes('团队应用'));
    assert.equal(await js(`document.querySelectorAll('[data-apps-section="favorites"] .appsx-fav.is-fav').length`), 1);
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
    groups = await sections(); assert.deepEqual(groups.map(x => x.title), ['常用', '我的', '市场']);
    assert.deepEqual(new Set(groups.find(group=>group.key==='market').names), new Set(['团队应用', '远端新应用']));
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
    groups = await sections();
    assert.ok(groups[0].names.includes('远端新应用'));
    assert.ok(!groups[1].names.includes('远端新应用'));
    await js(`appsSearch.value='运营';appsSearch.dispatchEvent(new Event('input'))`);
    groups = await sections(); assert.equal(groups.some(group=>group.key==='favorites'), false); assert.deepEqual(groups.find(group=>group.key==='mine').names, ['运营云端版']);
    await js(`appsSearch.value='';appsSearch.dispatchEvent(new Event('input'));localStorage.setItem('soduwork-apps-favorites',JSON.stringify(fixtureItems.map(x=>x.pluginId)));SoduWorkApps.render(false)`);
    groups = await sections(); assert.equal(groups[1].names.length, 0);
    assert.equal(await js(`document.querySelector('[data-apps-section="mine"]').textContent.includes('已安装的应用可在上方分组中打开')`), true);
    await js(`appsSearch.value='';appsSearch.dispatchEvent(new Event('input'));fixtureItems=[];window.dispatchEvent(new Event('soduwork-data-scope-changed'))`);
    await until(() => js('document.querySelectorAll(".appsx-card").length===0'), 'scope invalidation');
    assert.deepEqual((await sections()).map(x => x.title), ['我的', '市场']);
    assert.equal(await js('document.querySelector("[data-apps-section=favorites]")'), null, 'empty favorites omit the whole section including its title');
    report.cases.push('Installed remote app enters the library and a previously starred app goes to Common only; search filters every group; an empty favorite group has no heading, and identity change clears cached apps.');
    await js(`(async()=>{catalogError='fixture remote offline';await SoduWorkApps.render(true)})()`);
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
      catalogError='';localStorage.setItem('soduwork-apps-favorites',JSON.stringify(['local:flow','local:ops']));await SoduWorkApps.render(true);
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
    assert.ok(recommendedActions.every(action=>action.label==='打开即用'&&action.accessibleLabel==='打开即用'&&!action.icon),'all recommendation installation states use the Open App text button');
    assert.ok(recommendedActions.every(action=>JSON.stringify(action)===JSON.stringify(recommendedActions[0])),'uninstalled recommendations use the same button appearance as installed apps');
    const installedOpenBefore=await js('({opened:opened.length,installs:installs.length})');
    await js(`window.originalOpen=PluginUIHost.openContribution;window.testOpenCard=[...document.querySelectorAll('.appsx-cover-card')].find(card=>card.textContent.includes('示例运营应用'));
      PluginUIHost.openContribution=async(row,context)=>{opened.push(context.item.pluginId);await new Promise((resolve,reject)=>{window.finishOpen=resolve;window.failOpen=reject})};
      testOpenCard.querySelector('.appsx-card-open').click()`);
    assert.equal(await js(`testOpenCard.querySelector('.appsx-card-open').textContent`),'打开即用','an installed app does not display installation loading while its window opens');
    assert.equal(await js(`testOpenCard.getAttribute('aria-busy')`),'true');
    await js(`testOpenCard.querySelector('.appsx-card-open').click()`);
    assert.equal(await js('opened.length'),installedOpenBefore.opened+1,'pending opens cannot be duplicated');
    assert.equal(await js('installs.length'),installedOpenBefore.installs,'opening an installed app never reinstalls it');
    await js('finishOpen()');
    await until(()=>js('!testOpenCard.hasAttribute("aria-busy")'),'installed app open settles');
    assert.equal(await js(`testOpenCard.querySelector('.appsx-card-open').textContent`),'打开即用');
    await js(`testOpenCard.querySelector('.appsx-card-open').click();failOpen(Error('fixture open failed'))`);
    await until(()=>js('!testOpenCard.hasAttribute("aria-busy")'),'failed installed app open settles');
    assert.equal(await js(`testOpenCard.querySelector('.appsx-card-open').textContent`),'打开即用','a failed window open remains retryable');
    assert.equal(await js(`appsBody.textContent.includes('fixture open failed')`),true);
    await js(`PluginUIHost.openContribution=originalOpen;document.querySelector('.apps-inline-note')?.remove();
      window.originalInstall=SoduWorkAPI.setEnterprisePluginInstalled;window.syncAttempts=0;
      SoduWorkAPI.setEnterprisePluginInstalled=()=>{syncAttempts++;return new Promise((_resolve,reject)=>{window.failSync=reject})};
      window.testSyncCard=[...document.querySelectorAll('.appsx-cover-card')].find(card=>card.textContent.includes('推荐未安装应用'));testSyncCard.querySelector('.appsx-card-open').click()`);
    assert.equal(await js(`testSyncCard.querySelector('.appsx-card-open').textContent`),'加载中…','actual synchronization keeps its pending feedback');
    await js(`testSyncCard.querySelector('.appsx-card-open').click();failSync(Error('fixture sync failed'))`);
    await until(()=>js('!testSyncCard.hasAttribute("aria-busy")'),'failed app sync settles');
    assert.equal(await js('syncAttempts'),1);
    assert.equal(await js(`testSyncCard.querySelector('.appsx-card-open').textContent`),'打开即用','failed synchronization restores the action label');
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
    assert.equal(await js('!!document.getElementById("appsSetParams")'),false);
    await js(`document.querySelector('[data-setup-key="modelId"]').value='';appsSetSave.click()`);
    assert.equal(await js('appsSetError.hidden'),false);
    await js(`document.querySelector('[data-setup-key="modelId"]').value='next-model';document.querySelector('[data-setup-key="pageSize"]').value='101';appsSetSave.click()`);
    assert.equal(await js('appsSetError.hidden'),false);
    await js(`document.querySelector('[data-setup-key="pageSize"]').value='25';appsSetSave.click()`);
    await until(()=>js('!appsSettingsMask.classList.contains("show")'),'validated declared settings saved');
    assert.deepEqual(await js('configured.at(-1).config'),{modelId:'next-model',pageSize:25});
    assert.equal(await js('savedSettings.length'),1,'hidden credentials remain untouched');
    await js(`document.querySelector('.appsx-cover-card .appsx-set').click()`);
    await until(()=>js('appsSettingsMask.classList.contains("show")'),'remove settings');
    assert.equal(await js('!!appsSetDeveloper && !!appsSetEdit'),true,'local settings expose developer and edit');
    await js(`window.metadataCalls=[];soduWorkAPI.personalPlugins={updateMetadata:async(id,options)=>{metadataCalls.push({id,options});const plugin=fixtureItems.find(p=>p.pluginId===id);plugin.authorName=options.author;plugin.appCategory=options.appCategory;plugin.version='0.4.55';plugin.checksum='ops-v2';return {ok:true,plugin:{...plugin}}}};appsSetDeveloper.value='即用实验室';appsSetCategory.value='game';appsSetSave.click()`);
    await until(()=>js('!appsSettingsMask.classList.contains("show")'),'developer saved as version');
    assert.equal(await js('metadataCalls[0].options.author'),'即用实验室');
    assert.equal(await js('metadataCalls[0].options.appCategory'),'game');
    await js(`document.querySelector('.appsx-cover-card .appsx-set').click()`);
    await until(()=>js('appsSettingsMask.classList.contains("show")'),'developer settings reopen');
    assert.equal(await js('appsSetDeveloper.value'),'即用实验室');
    assert.equal(await js('appsSetCategory.value'),'game');
    await js(`window.editCalls=[];window.WorkspaceHost={open:(route,payload)=>editCalls.push({route,payload})};window.SoduWorkPluginAccess={assertEditable:async()=>{}};SoduWorkAPI.personalPlugin=async id=>({plugin:{...fixtureItems.find(p=>p.pluginId===id),template:'app',localDraft:{template:'app',name:'疯狂运营'}}});appsSetEdit.click()`);
    await until(()=>js('editCalls.length===1'),'edit starts development chat');
    const editEntry=await js('editCalls[0]');assert.equal(editEntry.route,'create');assert.equal(editEntry.payload.newSession,true);assert.equal(editEntry.payload.pluginId,'local:app-developer');assert.equal(editEntry.payload.pluginEditId,'local:ops');assert.equal(editEntry.payload.sessionId,undefined);
    report.cases.push('Developer metadata saves/reopens and editing uses a fresh app-developer chat with an installed full-source reference.');
    await js(`document.querySelector('.appsx-cover-card .appsx-set').click()`);
    await until(()=>js('appsSettingsMask.classList.contains("show")'),'remove after editing');
    await js('appsSetRemove.click()');
    await until(()=>js('!appsSettingsMask.classList.contains("show")'),'app removal');
    assert.deepEqual(await js('removed'), ['local:ops']);
    report.cases.push('Every installed app settings dialog exposes removal; removal uninstalls the personal app and refreshes the catalog.');
    win.setContentSize(1180,900);await delay(50);
    assert.equal(await js('getComputedStyle(document.querySelector("[data-apps-section=recommended] .appsx-grid")).gridTemplateColumns.split(" ").length'),3);
    assert.equal(await js('getComputedStyle(document.querySelector(".appsx-cover-card")).maxWidth'),'680px');
    assert.equal(await js('getComputedStyle(document.querySelector(".appsx-cover-card")).maxHeight'),'340px');
    fs.writeFileSync(path.join(out,'recommended.png'),(await capture()).toPNG());
    win.setContentSize(1600,900);await delay(50);
    assert.equal(await js('getComputedStyle(document.querySelector("[data-apps-section=recommended] .appsx-grid")).gridTemplateColumns.split(" ").length'),3);
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
    assert.equal(await js('document.querySelectorAll(".appsx-card-headline .appsx-source-tag").length'),0,'source labels no longer compete with names and hover versions');
    assert.equal(await js('document.querySelectorAll(".appsx-card-description .appsx-source-tag").length'),2,'source labels sit on the description line');
    assert.deepEqual(await js(`Object.fromEntries([...document.querySelectorAll('[data-apps-section="mine"] .appsx-card-txt')].map(row=>[row.querySelector('b').textContent,row.querySelector('.appsx-source-tag')?.textContent||null]))`),
      {'轻量画板':'本机','网页服务':'本机','市场已安装应用':null},
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
