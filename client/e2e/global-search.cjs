'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'soduwork-search-e2e-'));
  app.setPath('userData', profile);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    const errors = [];
    win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    const run = text => win.webContents.executeJavaScript(text, true);
    const root = path.join(__dirname, '..');
    try {
      await win.loadURL('about:blank');
      for (const file of ['theme/variables.css', 'components/workspace/workspace-navigation.css', 'components/workspace/workspace-sidebar-projects.css', 'components/workspace/global-search.css', 'theme/workspace-experience.css']) {
        await win.webContents.insertCSS(fs.readFileSync(path.join(root, file), 'utf8'));
      }
      await run(`document.documentElement.dataset.deskPanel='workspace';
        document.body.innerHTML = '<aside class="ws-side" style="width:240px;height:100vh;box-sizing:border-box"><div class="ws-brand"><span><b>SoduWork</b></span><button type="button" id="wsGlobalSearch" class="ws-global-search" aria-label="Global search"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg></button></div><div class="ws-side-scroll" id="wsSideScroll"><section class="ws-list ws-projects"><div class="ws-projects-heading"><button class="ws-section-toggle">Projects</button><button id="wsProjectAdd" class="ws-project-icon-button"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button></div><div id="fixtureOverflow"></div></section></div></aside>';
        document.body.style.cssText='margin:0;background:var(--bg-1);font-family:var(--font-ui)';
        window.fixtureLocale='zh-CN'; window.fixtureScope='a'; window.routes=[]; window.executed=[]; window.cancelRequests=[]; window.sourceCalls={tasks:0,library:0,status:0,content:0,catalog:0,schedules:0};
        window.SoduWorkI18n={getLocale:()=>fixtureLocale,translateText:value=>fixtureLocale==='zh-CN'?value:SoduWorkLocaleMessages[fixtureLocale]?.[value]||value};
        window.SoduWorkAPI={taskStorageKey:()=>fixtureScope,
          getTasksSnapshot:async()=>{sourceCalls.tasks++;return{online:true,items:[{id:'task',title:'版本更新需求',description:'version rollout'}]};},
          listLibrary:async()=>{sourceCalls.library++;return{items:[{id:'doc',title:'验收笔记',filename:'notes.txt',contentType:'text/plain',size:30}]};},
          getLibraryStorageStatus:async()=>{sourceCalls.status++;return{storage:{remote:{configured:false}}};},
          readLibraryContent:async()=>{sourceCalls.content++;return{content:'release version details'};},
          pluginCatalog:async()=>{sourceCalls.catalog++;return{items:[{pluginId:'plugin',name:'版本检查插件',description:'release plugin'},
            {pluginId:'app',name:'版本工具',installed:true,ui:{contributions:[{slot:'workspace.navigation'}]}}]};},
          listSchedules:async()=>{sourceCalls.schedules++;return[{id:'schedule',title:'版本检查',prompt:'release inspection'}];}};
        window.soduWorkAPI={conversationSession:{history:async()=>({ok:true,chats:[{id:'chat',title:'版本说明讨论',at:Date.now()}]}),
          search:async query=>{if(window.holdBody)await new Promise(resolve=>{window.releaseBody=resolve;});return{ok:true,chats:Array.from({length:55},(_,i)=>({id:'chat-'+i,title:query+' conversation '+i,text:'release version <img src=x onerror=alert(1)>',at:Date.now()-i}))};},cancelSearch:clear=>cancelRequests.push(clear===true)}};
        window.WorkspaceShell={projectForChat:()=>({name:'SoduWork'}),searchProjects:()=>[{id:'project',name:'版本项目'}],openSearchProject:id=>routes.push(['project',id])};
        window.WorkspaceHost={open:(...args)=>routes.push(args)};
        window.SoduWorkApps={openById:id=>routes.push(['app',id])};
        window.openCapabilityPlugin=id=>routes.push(['plugin',id]);
        window.ShortcutSettings={getBinding:id=>id==='open-global-search'?'Ctrl+Shift+F':'',execute:id=>executed.push(id)};
        window.NativeChat={revealSearchMatch:async()=>true}; void 0;`);
      for (const file of ['core/locales/global-search.js', 'core/shortcut-bindings.js', 'components/workspace/global-search-core.js', 'components/workspace/global-search-sources.js', 'components/workspace/global-search.js']) {
        await run(fs.readFileSync(path.join(root, file), 'utf8'));
      }
      await run(`document.getElementById('wsGlobalSearch').onclick=()=>SoduWorkGlobalSearch.open(); SoduWorkGlobalSearch.refreshEntry(); document.getElementById('wsGlobalSearch').focus(); document.getElementById('wsGlobalSearch').click();`);
      const settle = async () => {
        for (let i = 0; i < 120; i++) {
          if (await run(`document.querySelector('#globalSearchDialog input')?.getAttribute('aria-busy')==='false'`)) return;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw Error('Search did not settle');
      };
      await settle();
      const alignment = await run(`(()=>{const a=document.getElementById('wsGlobalSearch').getBoundingClientRect(),b=document.getElementById('wsProjectAdd').getBoundingClientRect();return{right:Math.abs(a.right-b.right),center:Math.abs(a.x+a.width/2-b.x-b.width/2)};})()`);
      assert.ok(alignment.right < 1 && alignment.center < 1, JSON.stringify(alignment));
      await run(`document.getElementById('fixtureOverflow').style.height='1400px'; void 0;`);
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.equal(await run(`Math.abs(document.getElementById('wsGlobalSearch').getBoundingClientRect().right-document.getElementById('wsProjectAdd').getBoundingClientRect().right)<1`), true);
      await run(`document.getElementById('fixtureOverflow').style.height=''; void 0;`);
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.deepEqual(await run(`Array.from(document.querySelectorAll('[data-search-category]'),node=>node.dataset.searchCategory)`), ['all', 'chats', 'projects', 'tasks', 'library', 'apps', 'plugins', 'schedules', 'actions']);
      const geometry = await run(`(()=>{const r=document.querySelector('dialog').getBoundingClientRect(),s=getComputedStyle(document.getElementById('wsGlobalSearch'));return{width:r.width,height:r.height,center:Math.abs(r.x+r.width/2-innerWidth/2)<2&&Math.abs(r.y+r.height/2-innerHeight/2)<2,border:s.borderTopWidth,bg:s.backgroundColor,focus:document.activeElement.tagName};})()`);
      assert.equal(geometry.width, 760); assert.equal(geometry.height, 560); assert.equal(geometry.center, true);
      const bottomTabs = () => run(`(()=>{const d=document.querySelector('dialog'),input=d.querySelector('.global-search-input').getBoundingClientRect(),results=d.querySelector('.global-search-results').getBoundingClientRect(),tabs=d.querySelector('.global-search-tabs').getBoundingClientRect(),close=d.querySelector('[data-search-close]').getBoundingClientRect();return{belowResults:tabs.top>=results.bottom,inside:d.querySelector('footer').contains(d.querySelector('[role="tablist"]')),closeInInput:close.top>=input.top&&close.bottom<=input.bottom,noOverflow:d.scrollWidth<=d.clientWidth,top:tabs.top};})()`);
      const tabLayout = await bottomTabs();
      assert.equal(tabLayout.belowResults, true); assert.equal(tabLayout.inside, true);
      assert.equal(tabLayout.closeInInput, true); assert.equal(tabLayout.noOverflow, true);
      assert.equal(await run(`document.querySelector('dialog footer kbd')`), null);
      assert.equal(geometry.border, '0px'); assert.equal(geometry.bg, 'rgba(0, 0, 0, 0)'); assert.equal(geometry.focus, 'INPUT');
      assert.equal(await run(`Array.from(document.querySelectorAll('.global-search-row')).every(row=>row.getBoundingClientRect().height<=40)`), true);
      assert.equal(await run(`(()=>{const row=document.querySelector('.global-search-row:has(time)'),title=row.querySelector('b').getBoundingClientRect(),date=row.querySelector('time').getBoundingClientRect();return Math.abs(title.top+title.height/2-date.top-date.height/2)<1;})()`), true);
      assert.deepEqual(await run(`(()=>{const s=getComputedStyle(document.querySelector('#globalSearchDialog input'));return{outline:s.outlineStyle,border:s.borderTopWidth,shadow:s.boxShadow};})()`), {outline:'none',border:'0px',shadow:'none'});
      assert.equal(await run(`getComputedStyle(document.querySelector('[data-search-clear]')).display`), 'none');
      await run(`dispatchEvent(new Event('soduwork-device-auth'));`);
      assert.equal(await run(`SoduWorkGlobalSearch.isOpen()`), true);
      const output = path.resolve(root, '../outputs/global-search-20261029'); fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, 'default-zh.png'), (await win.webContents.capturePage()).toPNG());
      await run(`window.holdBody=true; window.heldInput=document.querySelector('#globalSearchDialog input'); heldInput.value='release'; heldInput.dispatchEvent(new Event('input',{bubbles:true}));`);
      await new Promise(resolve => setTimeout(resolve, 150));
      const chosenBeforeBody = await run(`heldInput.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})); document.querySelector('.global-search-row[aria-selected="true"] b').textContent;`);
      await run(`window.holdBody=false; window.releaseBody();`); await settle();
      assert.equal(await run(`document.querySelector('.global-search-row[aria-selected="true"] b').textContent`), chosenBeforeBody);
      const immediate = await run(`(()=>{const input=document.querySelector('#globalSearchDialog input'),start=performance.now();input.value='version';input.dispatchEvent(new Event('input',{bubbles:true}));return{ms:performance.now()-start,hit:document.querySelector('#globalSearchResults').textContent.includes('版本更新需求')};})()`);
      assert.equal(immediate.hit, true);
      await new Promise(resolve => setTimeout(resolve, 130)); await settle();
      await run(`window.searchInput=document.querySelector('#globalSearchDialog input'); searchInput.value='release'; searchInput.dispatchEvent(new Event('input',{bubbles:true}));`);
      assert.equal(await run(`document.querySelector('[data-search-clear]').hidden`), false);
      assert.equal(await run(`getComputedStyle(document.querySelector('[data-search-clear]')).borderRadius`), '50%');
      assert.notEqual(await run(`getComputedStyle(document.querySelector('[data-search-clear]')).backgroundColor`), 'rgba(0, 0, 0, 0)');
      assert.equal(await run(`getComputedStyle(document.querySelector('[data-search-close]')).backgroundColor`), 'rgba(0, 0, 0, 0)');
      await run(`document.querySelector('[data-search-clear]').click()`);
      assert.equal(await run(`searchInput.value`), '');
      assert.equal(await run(`document.querySelector('[data-search-clear]').hidden`), true);
      assert.equal(await run(`SoduWorkGlobalSearch.isOpen()`), true);
      await run(`searchInput.value='release'; searchInput.dispatchEvent(new Event('input',{bubbles:true}));`);
      await new Promise(resolve => setTimeout(resolve, 230)); await settle();
      assert.deepEqual(await run(`({...sourceCalls})`), {tasks:1,library:1,status:1,content:1,catalog:1,schedules:1});
      assert.equal(await run(`document.querySelectorAll('.global-search-row[aria-selected="true"]').length`), 1);
      assert.equal(await run(`document.querySelectorAll('#globalSearchResults img').length`), 0);
      assert.equal(await run(`document.querySelectorAll('#globalSearchResults mark').length>0`), true);
      assert.equal(await run(`Array.from(document.querySelectorAll('.global-search-row')).every(row=>row.getBoundingClientRect().height<=40)`), true);
      fs.writeFileSync(path.join(output, 'results-zh.png'), (await win.webContents.capturePage()).toPNG());
      await run(`document.querySelector('.global-search-results').scrollTop=10000; void 0;`);
      assert.equal((await bottomTabs()).top, tabLayout.top);
      await run(`searchInput.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));`);
      assert.equal(await run(`searchInput.getAttribute('aria-activedescendant')`), 'search-result-1');
      await run(`searchInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));`);
      assert.equal(await run(`SoduWorkGlobalSearch.isOpen()`), true);
      await run(`document.querySelector('[data-search-category="chats"]').click()`);
      assert.equal(await run(`document.querySelectorAll('[data-search-result]').length`), 40);
      await run(`document.querySelector('[data-search-more]').click()`);
      assert.equal(await run(`document.querySelectorAll('[data-search-result]').length`), 55);
      await run(`searchInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
      assert.equal(await run(`SoduWorkGlobalSearch.isOpen()`), false);
      assert.equal(await run(`cancelRequests.at(-1)`), true);
      assert.equal(await run(`routes.at(-1)[1].chatId`), 'chat-0');
      assert.equal(await run(`document.activeElement.id`), 'wsGlobalSearch');
      await run(`SoduWorkGlobalSearch.open(); fixtureLocale='en-US'; dispatchEvent(new Event('soduwork-locale-change'));`); await settle();
      assert.equal(await run(`document.querySelector('[data-search-category="chats"]').textContent`), 'Conversations');
      assert.equal(await run(`document.querySelector('dialog footer kbd')`), null);
      fs.writeFileSync(path.join(output, 'default-en.png'), (await win.webContents.capturePage()).toPNG());
      for (const [locale, label] of [['ja-JP', '会話'], ['ko-KR', '대화']]) {
        await run(`fixtureLocale=${JSON.stringify(locale)}; dispatchEvent(new Event('soduwork-locale-change'));`); await settle();
        assert.equal(await run(`document.querySelector('[data-search-category="chats"]').textContent`), label);
      }
      await run(`fixtureScope='b'; dispatchEvent(new Event('soduwork-data-scope-changed'));`);
      assert.equal(await run(`SoduWorkGlobalSearch.isOpen()`), false);
      await run(`fixtureLocale='zh-CN'; SoduWorkGlobalSearch.open();`); await settle();
      await run(`window.input2=document.querySelector('dialog input'); input2.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));`);
      assert.equal(await run(`document.querySelector('[role="tab"][aria-selected="true"]').dataset.searchCategory`), 'chats');
      await run(`document.querySelector('dialog').dispatchEvent(new Event('cancel',{cancelable:true}));`);
      assert.equal(await run(`SoduWorkGlobalSearch.isOpen()`), false);
      win.setSize(520, 660); await run(`SoduWorkGlobalSearch.open()`); await settle();
      assert.equal(await run(`document.querySelector('dialog').getBoundingClientRect().width<innerWidth`), true);
      assert.equal(await run(`document.querySelector('dialog').getBoundingClientRect().height<innerHeight`), true);
      assert.equal((await bottomTabs()).belowResults, true); assert.equal((await bottomTabs()).noOverflow, true);
      assert.equal(await run(`Array.from(document.querySelectorAll('.global-search-row')).every(row=>row.getBoundingClientRect().height<=40&&row.scrollWidth<=row.clientWidth+1)`), true);
      fs.writeFileSync(path.join(output, 'narrow-zh.png'), (await win.webContents.capturePage()).toPNG());
      await run(`SoduWorkGlobalSearch.close(); SoduWorkI18n.t=(key,fallback)=>SoduWorkI18n.translateText(fallback||key); void 0;`);
      for (const file of ['components/panels/panels.css', 'components/panels/panels-library.css', 'components/panels/library-preview-pane.css']) {
        await win.webContents.insertCSS(fs.readFileSync(path.join(root, file), 'utf8'));
      }
      for (const file of ['components/panels/library-file-icons.js', 'components/panels/panels-library-dialogs.js', 'components/panels/library-delivery.js', 'components/panels/library-preview-pane.js', 'components/panels/panels-library.js']) {
        await run(fs.readFileSync(path.join(root, file), 'utf8'));
      }
      await run(`WorkspaceHost.open=(view,payload)=>{routes.push([view,payload]);if(view==='library')return openLibraryPanel(payload);}; SoduWorkGlobalSearch.open(); void 0;`); await settle();
      await run(`searchInput.value='release'; searchInput.dispatchEvent(new Event('input',{bubbles:true}));`);
      await new Promise(resolve => setTimeout(resolve, 230)); await settle();
      await run(`document.querySelector('[data-search-category="library"]').click(); document.querySelector('[data-search-result="0"]').click();`);
      for (let i = 0; i < 120; i++) {
        if (await run(`!!document.querySelector('.library-preview-pane [data-preview-body] pre')?.textContent.includes('release version details')`)) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(await run(`document.querySelector('.library-preview-pane')?.matches(':modal')`), true);
      assert.equal(await run(`document.querySelector('.library-preview-pane [data-preview-body] pre')?.textContent`), 'release version details');
      assert.equal(await run(`routes.at(-1)[0]`), 'library');
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ ok: true, geometry, alignment, immediateCachedResultMs: immediate.ms, checked: ['categories', 'bare icon', 'sidebar column alignment', 'instant cached filtering', 'shared list and content reads', 'centered modal', 'focus restore', 'keyboard', 'IME', 'escaped text', 'pagination', 'chat route', 'four locales', 'scope reset', 'narrow viewport', 'production library panel and preview route'], output }));
      win.destroy(); app.exit(0);
    } catch (error) { console.error(error); win.destroy(); app.exit(1); }
  });
}
