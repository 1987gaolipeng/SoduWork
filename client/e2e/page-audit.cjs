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
    else if (['briefs','team'].includes(view)) {
      // Hidden menus do not remove the existing panels or their regression coverage.
      assert.equal(await js(`document.querySelectorAll('[data-rail-view="${view}"], #wsNav [data-view="${view}"]').length`), 0);
      await js(`WorkspaceHost.open(${JSON.stringify(view)});void 0;`);
    } else if (['aidesk','memory'].includes(view)) {
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
      const html = fs.readFileSync(path.join(client, 'desk.html'), 'utf8').replace('<head>', '<head>' + early)
        .replace('<script src="desk-boot.js"></script>', '<script>fixtureInstallApi();</script><script src="desk-boot.js"></script>');
      return new Response(html, {headers: {'content-type': 'text/html;charset=utf-8'}});
    });
    win = new BrowserWindow({show: false, width: 1440, height: 1000,
      webPreferences: {contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false}});
    win.webContents.on('console-message', event => {if (event.level === 'error') report.errors.push(event.message);});
    try {
      await win.loadFile(path.join(client, 'desk.html'), {query: {panel: 'workspace'}});
      await until('fixtureReady && document.querySelector(".workspace-shell")');
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
    } catch (error) {report.failure = String(error.stack || error); await shot('failure');}
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ok:report.ok,output:out,pages:report.pages.map(p=>({view:p.view,loaded:p.loaded,error:p.error})),
      actions:report.actions,findings:report.findings,responsive:report.responsive,uiErrors:report.uiErrors,failure:report.failure},null,2));
    win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
