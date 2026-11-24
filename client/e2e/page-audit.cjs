'use strict';
// The complete production DOM/script/theme graph, fresh profile, synthetic API.
// All network requests and execution paths are disabled in this test process.
const electron = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    {env, windowsHide: true, stdio: 'inherit'});
  const timer = setTimeout(() => child.kill(), 120000);
  child.on('exit', code => {clearTimeout(timer); process.exitCode = code ?? 1;});
} else {
  const {app, BrowserWindow, session, net} = electron;
  const {fileURLToPath} = require('node:url'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..');
  const out = path.resolve(process.argv[2] || path.join(client, '../outputs/page-audit-20261014'));
  fs.mkdirSync(out, {recursive: true});
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-page-audit-'));
  const settingsLayout = process.argv.includes('--settings-layout');
  const settingsAlignment = process.argv.includes('--settings-alignment');
  const settingsWindow = settingsLayout || settingsAlignment || process.argv.includes('--settings-window');
  app.setPath('userData', profile);
  const report = {ok: false, scope: 'Production renderer, synthetic API/bridge, blocked networking',
    profile, pages: [], checks: [], findings: [], errors: []};
  let win;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  async function until(code, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {if (await js('Boolean(' + code + ')')) return; await delay(25);}
    throw Error('Timeout: ' + code);
  }
  async function click(selector) {
    const p = await js(`(async()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});await new Promise(r=>requestAnimationFrame(r));const b=e.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2),hit=document.elementFromPoint(x,y);if(!e.contains(hit))throw Error('Occluded '+${JSON.stringify(selector)}+' by '+hit?.outerHTML.slice(0,120));return{x,y};})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type, ...p, button: 'left', clickCount: 1});
    await delay(65);
  }
  async function type(selector, value) {
    await click(selector);
    await js(`{const e=document.querySelector(${JSON.stringify(selector)});e.value='';e.dispatchEvent(new Event('input',{bubbles:true}));}void 0;`);
    await win.webContents.insertText(value);
  }
  async function shot(name) {fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());}
  async function navigate(view) {
    const direct = await js(`!!document.querySelector('.ws-rail [data-rail-view="${view}"]')`);
    if (direct) await click(`[data-rail-view="${view}"]`);
    else if (['aidesk','briefs','team'].includes(view)) {
      // Hidden menus do not remove the existing panels or their regression coverage.
      assert.equal(await js(`document.querySelectorAll('[data-rail-view="${view}"], #wsNav [data-view="${view}"]').length`), 0);
      await js(`WorkspaceHost.open(${JSON.stringify(view)});void 0;`);
    } else if (view === 'memory') {
      await click('[data-rail-menu="more"]'); await click(`#wsRailMoreMenu [data-rail-view="${view}"]`);
    } else {
      if (!(await js('document.documentElement.dataset.workspaceLayout==="settings"'))) await click('#wsRailMine');
      await click(`[data-view="${view}"]`);
    }
    await until(`WorkspaceHost.view===${JSON.stringify(view)}`);
    await delay(100);
  }
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest({urls: ['http://*/*','https://*/*','ws://*/*','wss://*/*']}, (_r, cb) => cb({cancel: true}));
    session.defaultSession.protocol.handle('file', request => {
      if (path.basename(fileURLToPath(request.url.split('?')[0])) !== 'desk.html') return net.fetch(request.url, {bypassCustomProtocolHandlers: true});
      const early = '<script>' + fs.readFileSync(path.join(__dirname, 'fixtures/page-audit-api.js'), 'utf8') + '</script>';
      const setup = settingsWindow ? `
        const initSettingsData = window.initData;
        fixtureInstallApi();
        window.initData = initSettingsData;
        const demoUser = {id:'demo-01', username:'demo', displayName:'示例用户'};
        let session = {state:'legacy', user:null}, resume;
        const registration = new Promise(resolve => {resume = resolve;});
        SoduWorkAPI.hubBase = () => 'fixture';
        SoduWorkAPI.clientAuthSnapshot = () => session;
        fixtureOverrides.registerClient = () => registration;
        fixtureOverrides.clientAuthMe = () => ({user:demoUser});
        fixtureOverrides.getTasksSnapshot = () => ({online:true, items:[]});
        fixtureOverrides.syncConfig = () => false;
        localStorage.setItem('soduwork_work_cfg_v5_sync_pending', '1');
        window.setFixtureAuth = state => {
          session = {state, user:state === 'active' ? demoUser : null};
          dispatchEvent(new CustomEvent('soduwork-device-auth', {detail:session}));
          if (session.user) resume({ok:true, user:session.user});
        };` : 'fixtureInstallApi();soduWorkAPI.openDeskWindow=undefined;';
      const html = fs.readFileSync(path.join(client, 'desk.html'), 'utf8').replace('<head>', '<head>' + early)
        .replace('<script src="desk-boot.js"></script>', '<script>'+setup+'</script><script src="desk-boot.js"></script>');
      return new Response(html, {headers: {'content-type': 'text/html;charset=utf-8'}});
    });
    win = new BrowserWindow({show: false, width: 1440, height: 1000,
      webPreferences: {contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false}});
    win.webContents.on('console-message', event => {if (event.level === 'error') report.errors.push(event.message);});
    try {
      await win.loadFile(path.join(client, 'desk.html'), {query: {panel: settingsWindow ? 'preferences' : 'workspace'}});
      if (settingsAlignment) {
        await until('window.WorkspaceHost?.view === "account"');
        await js(`setFixtureAuth("active");
          const usage = {summary:{tokens:0}, trend:[{key:"2026-11-01",tokens:0},{key:"2026-11-30",tokens:0}]};
          fixtureData.myUsage = {hub:usage, local:usage, quota:{enabled:true,totalLimited:false,used:0}};`);
        await until('document.querySelector("#account-tab-security[aria-selected=true]")');
        const frames = {
          account: '.personal-account-summary, .personal-account-content',
          usage: '.usage-grid, .usage-toolbar, .usage-records',
          agents: '#agBody > *', models: '.cfg-master-detail', cloud: '.ce-content',
          codeacct: '.cfg-master-detail', archive: '.archive-history-filters',
          shortcuts: '.shortcuts-search, .shortcut-group', skin: '.skin-grid', settings: '.set-group'
        };
        const byWidth = new Map();
        for (const [view, selector] of Object.entries(frames)) {
          await click(`#wsSettingsDialog [data-view="${view}"]`);
          await until('WorkspaceHost.view === ' + JSON.stringify(view));
          for (const width of [960, 1440, 560, 1920]) {
            win.setContentSize(width, 700);
            await until('innerWidth === ' + width);
            await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
            const row = await js(`(() => {
              const panel = document.querySelector('#wsSettingsContent > .show');
              const bounds = panel.getBoundingClientRect();
              const boxes = [...panel.querySelectorAll(${JSON.stringify(selector)})]
                .filter(e => e.checkVisibility()).map(e => e.getBoundingClientRect());
              const title = panel.querySelector('h1, .sch-h-title, .sm-title, .set-page-main-title');
              const actions = [...panel.querySelectorAll('.ag-tabs, .sch-h-acts, .shortcuts-page-actions')]
                .filter(e => e.offsetWidth > 0);
              const filter = panel.querySelector('.usage-toolbar .usage-range');
              const insideCards = [...panel.querySelectorAll('#usageQuotaDetails, #usageGroup, .usage-records .usage-line small')]
                .filter(e => !e.closest('.usage-foot')).map(e => bounds.right - e.getBoundingClientRect().right);
              return {left: boxes.map(b => b.left - bounds.left), right: boxes.map(b => bounds.right - b.right),
                title: title?.getBoundingClientRect().left - bounds.left,
                actions: actions.length ? bounds.right - Math.max(...actions.map(e => e.getBoundingClientRect().right)) : null,
                filter: filter ? bounds.right - filter.getBoundingClientRect().right : null, insideCards};
            })()`);
            report.pages.push({view, width, ...row});
            if ((view === 'account' || view === 'usage') && width === 1440) {
              await delay(100);
              await shot(`alignment-${view}-${width}`);
            }
            if (view === 'account') byWidth.set(width, row.left[0]);
          }
          if (view === 'account') {
            for (const tab of ['devices', 'privacy', 'security']) {
              await click(`#personalAccountPanel [data-tab="${tab}"]`);
              await until(`document.querySelector('#account-tab-${tab}[aria-selected=true]')`);
            }
          } else if (view === 'usage') {
            await click('[data-days="7"]');
            await click('.usage-toolbar [data-source="hub"]');
            await until(`document.querySelector('.usage-toolbar [data-source="hub"][aria-pressed=true]')`);
          } else if (view === 'agents') {
            await click('[data-agtab="runners"]');
            await click('#agRefresh');
            await click('[data-agtab="agents"]');
          }
        }
        for (const row of report.pages) {
          const gutter = byWidth.get(row.width);
          const near = (value, expected) => assert.ok(Math.abs(value - expected) <= 1,
            `${row.view} at ${row.width}: expected ${expected}, got ${value}`);
          // Settings groups share a multi-column grid. Compare its two outside edges.
          for (const edges of [row.left, row.right]) {
            if (row.view === 'settings') near(Math.min(...edges), gutter);
            else { assert.ok(edges.length, row.view + ' has content'); edges.forEach(edge => near(edge, gutter)); }
          }
          near(row.title, gutter + 8);
          if (row.actions !== null) near(row.actions, gutter + 8);
          if (row.filter !== null) near(row.filter, gutter + 8);
          if (row.view === 'usage') {
            assert.equal(row.insideCards.length, 3);
            row.insideCards.forEach(edge => near(edge, row.insideCards[0]));
          }
        }
        report.ok = true;
      } else if (settingsLayout) {
        await until('window.WorkspaceHost?.view === "account"');
        await js(`setFixtureAuth("active");
          fixtureData.myModels.providers = [{id:'demo-models', name:'示例模型服务', modelNames:[]}];
          fixtureData.runners.runners = [{runnerId:'demo', label:'示例用户的执行机', owned:true,
            online:true, manageable:true, scope:'current-instance', agents:[{name:'Pi',version:'1.4.0'}]}];`);
        await click('#wsSettingsDialog [data-view="agents"]');
        await click('[data-agtab="runners"]');
        await until('document.querySelector(".rn-card")');
        for (const width of [1120, 960, 620]) {
          win.setContentSize(width, 700);
          await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
          const geometry = await js(`(() => {
            const card = document.querySelector('.rn-card');
            const box = card.getBoundingClientRect(), dir = document.querySelector('.rn-directory').getBoundingClientRect();
            const actions = Array.from(card.querySelectorAll('.rn-actions button'));
            return { fits: card.scrollWidth <= card.clientWidth && actions.every(b => b.offsetHeight < 40),
              stacked: dir.top >= box.bottom, aligned: Math.abs(dir.left - box.left) < 1 };
          })()`);
          assert.ok(geometry.fits, 'Runner card content fits at ' + width);
          if (width <= 960) assert.ok(geometry.stacked && geometry.aligned, 'Runner cards align at ' + width);
          await delay(100);
          await shot('runner-' + width);
        }
        await click('[data-rn-card-toggle="demo"]');
        await until('document.querySelector(".rn-card.is-expanded")');
        report.pages.push({view:'runners', loaded:true});
        win.setContentSize(960, 700);
        for (const key of ['models', 'codeacct']) {
          await click('#wsSettingsDialog [data-view="' + key + '"]');
          await until('document.querySelector("#wsSettingsContent > .show .cfg-master-detail")');
          assert.ok(await js(`(() => {
            const s = getComputedStyle(document.querySelector('#wsSettingsContent > .show .cfg-master-detail'));
            return s.borderTopWidth === '1px' && s.borderRadius === '12px';
          })()`), key + ' outer frame');
          if (key === 'models') await click('[data-mdselect="demo-models"]');
          await shot(key);
          report.pages.push({view:key, loaded:true});
        }
        await click('[data-caopen="ssh"]'); await click('[data-caopen="identity"]');
        await click('#wsSettingsDialog [data-view="shortcuts"]');
        assert.equal(await js('getComputedStyle(document.querySelector(".shortcuts-toolbar")).borderBottomWidth'), '0px');
        await shot('shortcuts');
        await type('[data-shortcut-search]', 'Ctrl');
        await click('[data-shortcut-edit]'); await click('[data-shortcut-cancel]');
        report.pages.push({view:'shortcuts', loaded:true});
        await click('#wsSettingsDialog [data-view="settings"]');
        const sizes = [];
        for (const scale of ['small', 'medium', 'large']) {
          await click('#fontSeg [data-font="' + scale + '"]');
          assert.equal(await js('JSON.parse(localStorage.getItem("soduwork_work_cfg_v5")).fontScale'), scale);
          sizes.push(await js('parseFloat(getComputedStyle(document.querySelector("#fontSeg button")).fontSize)'));
        }
        assert.ok(sizes[0] >= 12 && sizes[0] < sizes[1] && sizes[1] < sizes[2], 'Rendered font sizes: ' + sizes);
        report.fontSizes = sizes;
        report.pages.push({view:'settings', loaded:true});
        report.uiErrors = await js('fixtureErrors');
        assert.deepEqual(report.uiErrors, []);
        report.ok = true;
      } else if (settingsWindow) {
        await until('window.WorkspaceHost?.view === "account"');
        const accountText = 'document.getElementById("personalAccountContent").textContent';
        assert.equal(await js(accountText), await js('SoduWorkI18n.translateText("正在加载…")'));
        await js('setFixtureAuth("pending")');
        assert.equal(await js(accountText), await js('SoduWorkI18n.translateText("请先登录后管理个人信息。")'));
        assert.ok(await js('getComputedStyle(personalAccountContent).paddingTop === getComputedStyle(personalAccountContent).paddingBottom'));
        await js('setFixtureAuth("active")');
        await until('document.querySelector("#account-tab-security[aria-selected=true]")');
        await until('fixtureCalls.some(call => call.key === "syncConfig")');
        assert.equal(await js('!!document.querySelector("#deskToast.show")'), false);
        report.checks.push('delayed login restores account tabs; a background sync failure stays silent');
        const keys = await js('[...document.querySelectorAll("#wsSettingsDialog [data-view]")].map(item=>item.dataset.view)');
        assert.equal(keys.length, 10);
        for (const width of [960,800,620]) {
          win.setContentSize(width, 700);
          for (const key of keys) {
            await click(`#wsSettingsDialog [data-view="${key}"]`);
            await until('WorkspaceHost.view === ' + JSON.stringify(key));
            await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
            assert.ok(await js(`(() => {
              const panel = document.querySelector('#wsSettingsContent > .workspace-hosted.show');
              const cell = wsSettingsContent.getBoundingClientRect(), box = panel?.getBoundingClientRect();
              return !!box && box.width > 0 && Math.abs(cell.x - box.x) < 2 && Math.abs(cell.width - box.width) < 2 &&
                Math.abs(cell.y - box.y) < 2 && Math.abs(cell.height - box.height) < 2 &&
                panel.scrollWidth <= panel.clientWidth + 1 && panel.contains(document.elementFromPoint(box.x + box.width / 2, box.y + 25));
            })()`), key + ' geometry at ' + width);
            if (key === 'account' || key === 'usage') {
              const inset = await js(`(() => {
                const panel = document.querySelector('#wsSettingsContent > .workspace-hosted.show');
                const title = panel.querySelector('h1');
                const card = panel.querySelector('.personal-account-summary, .usage-card');
                return title.getBoundingClientRect().left - card.getBoundingClientRect().left;
              })()`);
              assert.ok(Math.abs(inset - 8) < 1, key + ' heading inset at ' + width + ': ' + inset);
            }
            if (key === 'account') {
              await click('[data-tab="devices"]'); await click('[data-tab="privacy"]'); await click('[data-tab="security"]');
              await click('[data-email-change]'); await click('.ac-email-change [data-ac-close]');
              await shot('settings-account-' + width);
            } else if (width === 960) await shot('settings-' + key);
            report.pages.push({view:key,width,loaded:true});
          }
          await click('#skinOpenBtn');
          await until('WorkspaceHost.view === "skin" && document.querySelector("#wsSettingsContent > #skinManager.show")');
          await click('#wsSettingsDialog [data-view="agents"]');
          await click('[data-agtab=runners]'); await click('[data-agtab=agents]');
          await click('#wsSettingsDialog [data-view="codeacct"]');
          for (const tab of ['token','ssh','test','identity']) await click(`[data-caopen="${tab}"]`);
          await click('#wsSettingsDialog [data-view="shortcuts"]');
          await click('[data-shortcut-edit]'); await click('[data-shortcut-cancel]');
        }
        await click('#wsSettingsDialog [data-view="settings"]');
        await click('#fontSeg [data-font="large"]');
        await until('document.querySelector("#deskToast.show")?.textContent.includes("后台暂不可达")');
        assert.equal(await js('JSON.parse(localStorage.getItem("soduwork_work_cfg_v5")).fontScale'), 'large');
        report.checks.push('an explicit preference edit still saves locally and reports sync failure');
        report.uiErrors = await js('fixtureErrors');
        assert.deepEqual(report.uiErrors, []);
        report.ok = true;
      } else if (process.argv.includes('--usage-only')) {
        await until('fixtureReady && document.querySelector(".workspace-shell")');
        await navigate('usage');
        await require('./page-audit-usage.cjs')({js, click, until, win, delay, shot});
        report.uiErrors = await js('fixtureErrors');
        assert.deepEqual(report.uiErrors, []);
        report.ok = true;
      } else {
        await until('fixtureReady && document.querySelector(".workspace-shell")');
        await auditWorkspace();
      }
    } catch (error) {report.failure = String(error.stack || error); await shot('failure');}

    async function auditWorkspace() {
      const views = {create:'composePanel',history:'historyBoard',skills:'capPanel',schedules:'schPanel',
        library:'libraryPanel',notices:'noticePanel',aidesk:'aiDeskPanel',briefs:'briefPanel',team:'teamPanel',
        memory:'sessionMemoryPanel',usage:'usagePanel',agents:'agPanel',models:'mdPanel',cloud:'cloudEnvironmentPanel',
        codeacct:'caPanel',archive:'archivePanel',skin:'skinManager',settings:'settingsPanel',shortcuts:'shortcutsPanel'};
      for (const [view, id] of Object.entries(views)) {
        try {
          await navigate(view);
          await until(`document.getElementById(${JSON.stringify(id)})?.getBoundingClientRect().width>0`);
          const geometry = await js(`(()=>{const e=document.getElementById(${JSON.stringify(id)});return{visible:e.checkVisibility(),body:e.innerText.slice(0,400),overflow:document.documentElement.scrollWidth>innerWidth+1}})()`);
          report.pages.push({view, id, loaded: true, ...geometry});
          await shot(view);
        } catch (error) {report.pages.push({view, loaded: false, error: String(error)});}
      }
      await require('./page-audit-actions.cjs')({js, click, type, navigate, until, report, win, delay, shot});
      await navigate('codeacct'); await until('document.querySelector("[data-cf=name]")');
      await js('fixtureOverrides.myGit=()=>new Promise(resolve=>window.releaseOlderGit=resolve);window.oldGitLoad=_caLoad();void 0;');
      await js('fixtureOverrides.myGit=async()=>({git:{name:"Newer server name",email:"newer@example.test"},repos:[]});void 0;');
      await js('_caLoad()');
      await js('releaseOlderGit({git:{name:"Obsolete server name",email:"obsolete@example.test"},repos:[]});oldGitLoad');
      const observed = await js('document.querySelector("[data-cf=name]").value');
      report.findings.push({id:'codeacct-late-load', expected:'Newer server name', observed, reproduced:observed==='Obsolete server name'});
      await shot('codeacct-late-response');
      await type('[data-cf=name]', 'Unsaved fixture name');
      await click('[data-caopen=token]'); await type('[data-cf=token]', 'synthetic-unsaved-token');
      await click('[data-caopen=identity]');
      assert.equal(await js('document.querySelector("[data-cf=name]").value'), 'Unsaved fixture name');
      await js('fixtureOverrides.myGit=()=>new Promise(resolve=>window.releaseDraftGit=resolve);window.draftGitLoad=_caLoad();void 0;');
      await type('[data-cf=name]', 'Edited while loading');
      await js('releaseDraftGit({git:{name:"Server name",email:"server@example.test"},repos:[]});draftGitLoad');
      const draft = await js('document.querySelector("[data-cf=name]").value');
      report.findings.push({id:'codeacct-edit-during-load', expected:'Edited while loading', observed:draft, reproduced:draft!=='Edited while loading'});
      await js('fixtureOverrides.myGit=()=>new Promise(resolve=>window.releaseClosedGit=resolve);window.closedGitLoad=_caLoad();window.beforeClosedGit=_caData.git.name;void 0;');
      await navigate('settings');
      await js('releaseClosedGit({git:{name:"Closed page response",email:"closed@example.test"},repos:[]});closedGitLoad');
      const closed = await js('_caData.git.name===beforeClosedGit');
      report.findings.push({id:'codeacct-close-late-load', expected:true, observed:closed, reproduced:!closed});
      await js('fixtureOverrides.myGit=async()=>({git:{name:"Reopened name",email:"reopened@example.test"},repos:[]});void 0;');
      await navigate('codeacct');
      await js('window.accountGitPending=[];fixtureOverrides.myGit=()=>new Promise(resolve=>accountGitPending.push(resolve));window.accountGitLoad=_caLoad();fixtureOwner="page-audit-other-owner";dispatchEvent(new CustomEvent("soduwork-device-auth",{detail:{state:"active",user:{id:"fixture-other"}}}));void 0;');
      await js('fixtureOverrides.myGit=async()=>({git:{name:"Other account name",email:"other@example.test"},repos:[]});void 0;');
      await navigate('settings'); await navigate('codeacct');
      await js('accountGitPending.forEach(resolve=>resolve({git:{name:"Former account name",email:"former@example.test"},repos:[]}));accountGitLoad');
      const account = await js('document.querySelector("[data-cf=name]").value');
      await click('[data-caopen=token]');
      const leakedDraft = await js('!!document.querySelector("[data-cf=token]").value');
      report.findings.push({id:'codeacct-account-switch', expected:'Other account name', observed:account, leakedDraft, reproduced:account!=='Other account name'||leakedDraft});
      await click('[data-caopen=identity]');
      await js('window.pendingGitSaves=[];window.gitSaveBodies=[];fixtureOverrides.saveMyGit=body=>new Promise(resolve=>{gitSaveBodies.push(structuredClone(body));pendingGitSaves.push(resolve);});void 0;');
      await type('[data-cf=name]', 'Submitted name'); await click('#caSave');
      await type('[data-cf=name]', 'Next unsaved name');
      const saveBlocked = await js('document.querySelector("#caSave").disabled');
      if (!saveBlocked) await click('#caSave');
      report.findings.push({id:'codeacct-save-duplicate',expected:1,observed:await js('gitSaveBodies.length'),reproduced:!saveBlocked});
      await js('fixtureOverrides.myGit=async()=>({git:{name:"Submitted name",email:"other@example.test"},repos:[]});pendingGitSaves.forEach(resolve=>resolve({ok:true}));void 0;');
      await delay(100);
      const pendingDraft = await js('document.querySelector("[data-cf=name]").value');
      report.findings.push({id:'codeacct-save-late-edit',expected:'Next unsaved name',observed:pendingDraft,reproduced:pendingDraft!=='Next unsaved name'});
      await click('[data-caopen=test]'); await type('#caUrl', 'https://repository.example.test/synthetic.git');
      await js('fixtureOverrides.saveMyGit=async()=>({ok:true});window.pendingGitTests=[];fixtureOverrides.testMyGit=url=>new Promise(resolve=>pendingGitTests.push(resolve));void 0;');
      await click('#caTest');
      const testBlocked = await js('document.querySelector("#caTest").disabled');
      if (!testBlocked) await click('#caTest');
      report.findings.push({id:'codeacct-test-duplicate',expected:1,observed:await js('pendingGitTests.length'),reproduced:!testBlocked});
      await js('pendingGitTests.forEach(resolve=>resolve({ok:true,detail:"Synthetic read-only probe"}));void 0;');
      await until('document.querySelector(".ca-test-r.is-ok")');
      await js('fixtureOverrides.testMyGit=()=>new Promise((resolve,reject)=>window.rejectOlderGitTest=reject);void 0;');
      await click('#caTest'); await type('#caUrl', 'https://repository.example.test/next.git');
      await js('rejectOlderGitTest(Error("Previous repository probe failed"));void 0;'); await delay(100);
      const staleFailure = await js('!!document.querySelector(".ca-test-r.is-bad")');
      report.findings.push({id:'codeacct-test-repository-change',expected:false,observed:staleFailure,reproduced:staleFailure});
      for (const failed of [false,true]) {
        await js('fixtureOverrides.testMyGit=()=>new Promise((resolve,reject)=>{window.finishCredentialProbe=resolve;window.failCredentialProbe=reject;});void 0;');
        await click('#caTest'); await click('[data-caopen=token]');
        await type('[data-cf=token]', failed ? 'synthetic-next-key-two' : 'synthetic-next-key-one');
        await js(failed ? 'failCredentialProbe(Error("Earlier credentials failed"));void 0;' : 'finishCredentialProbe({ok:true,detail:"Earlier credentials accepted"});void 0;');
        await delay(100); await click('[data-caopen=test]');
        const staleCredential = await js('!!document.querySelector(".ca-test-r.is-ok,.ca-test-r.is-bad")');
        report.findings.push({id:'codeacct-test-credential-change-'+(failed?'failure':'success'),expected:false,observed:staleCredential,reproduced:staleCredential});
      }
      await click('[data-caopen=token]'); await type('[data-cf=token]', 'synthetic-preserved-draft');
      await click('[data-caopen=identity]'); await click('[data-caopen=token]');
      const secretRestored = await js('document.querySelector("[data-cf=token]").value==="synthetic-preserved-draft"');
      report.findings.push({id:'codeacct-secret-section-draft',expected:true,observed:secretRestored,reproduced:!secretRestored});
      await click('[data-caopen=identity]'); await type('[data-cf=name]', 'Pending before close');
      await js('window.reopenGitBodies=[];window.reopenGitPending=[];fixtureOverrides.saveMyGit=body=>new Promise(resolve=>{reopenGitBodies.push(structuredClone(body));reopenGitPending.push(resolve);});void 0;');
      await click('#caSave'); await navigate('settings'); await navigate('codeacct');
      await type('[data-cf=name]', 'Edited after reopen');
      const reopenBlocked = await js('document.querySelector("#caSave").disabled');
      if (!reopenBlocked) await click('#caSave');
      report.findings.push({id:'codeacct-save-close-reopen',expected:1,observed:await js('reopenGitBodies.length'),reproduced:!reopenBlocked});
      await js('reopenGitPending.forEach(resolve=>resolve({ok:true}));void 0;'); await delay(100);
      const reopenUsable = await js('!document.querySelector("#caSave").disabled&&document.querySelector("[data-cf=name]").value==="Edited after reopen"');
      report.findings.push({id:'codeacct-save-reopen-settle',expected:true,observed:reopenUsable,reproduced:!reopenUsable});
      await js('window.ownerSaveBodies=[];window.ownerSavePending=[];fixtureOverrides.saveMyGit=body=>new Promise(resolve=>{ownerSaveBodies.push({owner:fixtureOwner});ownerSavePending.push(resolve);});void 0;');
      const firstOwner = await js('fixtureOwner');
      await click('#caSave');
      await js('fixtureOwner="page-audit-intervening-owner";dispatchEvent(new CustomEvent("soduwork-device-auth",{detail:{state:"active"}}));void 0;');
      await until('document.querySelector("[data-cf=name]")'); await type('[data-cf=name]', 'Independent other owner'); await click('#caSave');
      const otherOwnerCalls = await js('ownerSaveBodies.filter(row=>row.owner==="page-audit-intervening-owner").length');
      await js(`fixtureOwner=${JSON.stringify(firstOwner)};dispatchEvent(new CustomEvent("soduwork-device-auth",{detail:{state:"active"}}));void 0;`);
      await until('document.querySelector("[data-cf=name]")'); await type('[data-cf=name]', 'Returned owner newer draft');
      const ownerSaveBlocked = await js('document.querySelector("#caSave").disabled');
      if (!ownerSaveBlocked) await click('#caSave');
      const ownerSaveCalls = await js(`ownerSaveBodies.filter(row=>row.owner===${JSON.stringify(firstOwner)}).length`);
      report.findings.push({id:'codeacct-save-owner-return',expected:1,observed:ownerSaveCalls,otherOwnerCalls,reproduced:ownerSaveCalls!==1||otherOwnerCalls!==1});
      await js('ownerSavePending.forEach(resolve=>resolve({ok:true}));fixtureOverrides.saveMyGit=async()=>({ok:true});void 0;'); await delay(100);
      await click('[data-caopen=test]'); await type('#caUrl', 'https://repository.example.test/owner-return.git');
      await js('window.ownerTestCalls=[];window.ownerTestPending=[];fixtureOverrides.testMyGit=()=>new Promise(resolve=>{ownerTestCalls.push(fixtureOwner);ownerTestPending.push(resolve);});void 0;');
      await click('#caTest');
      await js('fixtureOwner="page-audit-intervening-owner";dispatchEvent(new CustomEvent("soduwork-device-auth",{detail:{state:"active"}}));void 0;');
      await until('document.querySelector("[data-caopen=test]")'); await click('[data-caopen=test]'); await type('#caUrl', 'https://repository.example.test/independent-owner.git'); await click('#caTest');
      await js(`fixtureOwner=${JSON.stringify(firstOwner)};dispatchEvent(new CustomEvent("soduwork-device-auth",{detail:{state:"active"}}));void 0;`);
      await until('document.querySelector("[data-caopen=test]")'); await click('[data-caopen=test]'); await type('#caUrl', 'https://repository.example.test/returned-owner.git');
      const ownerTestBlocked = await js('document.querySelector("#caTest").disabled');
      if (!ownerTestBlocked) await click('#caTest');
      const ownerTestCount = await js(`ownerTestCalls.filter(owner=>owner===${JSON.stringify(firstOwner)}).length`);
      report.findings.push({id:'codeacct-test-owner-return',expected:1,observed:ownerTestCount,reproduced:ownerTestCount!==1});
      await navigate('settings'); await navigate('codeacct'); await click('[data-caopen=test]');
      await js('ownerTestPending.forEach(resolve=>resolve({ok:true,detail:"Earlier owner probe"}));void 0;'); await delay(100);
      const testReopenReady = await js('!document.querySelector("#caTest").disabled&&!document.querySelector(".ca-test-r.is-ok,.ca-test-r.is-bad")');
      report.findings.push({id:'codeacct-test-reopen-settle',expected:true,observed:testReopenReady,reproduced:!testReopenReady});
      // The production maintenance snapshot identifies chatId by sessionId,
      // while ref identifies the live handle used only for cancellation.
      await navigate('settings');
      await js('_paintClientUpdateStatus({state:"waiting",currentVersion:"1.12.78",blockers:[{kind:"conversation",id:"session-id",ref:"runtime-ref",title:"Synthetic busy conversation"}]});window.originalHostOpen=WorkspaceHost.open;window.capturedRoute=null;WorkspaceHost.open=(view,payload)=>{capturedRoute={view,payload};return true;};void 0;');
      await click('#clientUpdateBlockers button:last-child');
      const route = await js('capturedRoute');
      assert.equal(route?.payload?.chatId, 'session-id');
      await js('WorkspaceHost.open=originalHostOpen;void 0;');
      report.checks.push('Complete production workspace navigation, original DOM/scripts/themes, draft switch, overlapping API requests, update blocker action');
      report.uiErrors = await js('fixtureErrors');
      report.ok = report.pages.every(p=>p.loaded) && report.actions.every(row=>row.ok) &&
        report.responsive.every(row=>!row.overflow&&!row.error) && !report.findings.some(f=>f.reproduced) && report.uiErrors.length===0;
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ok:report.ok,output:out,pages:report.pages.map(p=>({view:p.view,loaded:p.loaded,error:p.error})),
      actions:report.actions,findings:report.findings,responsive:report.responsive,uiErrors:report.uiErrors,failure:report.failure},null,2));
    win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
