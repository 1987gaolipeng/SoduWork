'use strict';
// Production desk/store/styles with synthetic services and an isolated profile.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    {env, windowsHide: true, stdio: 'inherit'});
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => {clearTimeout(timer); process.exitCode = code ?? 1;});
} else {
  const {app, BrowserWindow, session, net} = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const {fileURLToPath} = require('node:url'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..');
  const label = process.argv.find(value => value.startsWith('--label='))?.slice(8) || 'current';
  const out = path.resolve(client, '../outputs/notice-badge-20261015', label);
  fs.mkdirSync(out, {recursive: true});
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-notice-badge-')));
  const report = {ok: false, scope: 'Production renderer/store, synthetic API/broadcast, blocked network', cases: [], errors: []};
  let win;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  async function until(code) {
    for (let i = 0; i < 200; i++) {if (await js(code)) return; await delay(20);}
    throw Error('Timeout: ' + code);
  }
  async function badge(expected) {
    const actual = await js(`(()=>{const e=document.querySelector('#wsRailNoticeBadge');
      return {visible:e.checkVisibility(),text:e.textContent,count:noticeUnread(),
        display:getComputedStyle(e).display,show:e.classList.contains('show')};})()`);
    assert.equal(actual.count, expected);
    assert.equal(actual.visible, expected > 0, JSON.stringify(actual));
    assert.equal(actual.text, expected ? expected > 99 ? '99+' : String(expected) : '');
    assert.equal(actual.show, expected > 0);
  }
  async function check(name, run) {
    try {await run(); report.cases.push({name, ok: true});}
    catch (error) {report.cases.push({name, ok: false, error: String(error)});}
  }
  async function shot(name) {fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());}
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});
      e.scrollIntoView({block:'nearest'});const b=e.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);
      if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded '+${JSON.stringify(selector)});return{x,y};})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type, ...point, button: 'left', clickCount: 1});
    await delay(50);
  }
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest({urls: ['http://*/*','https://*/*','ws://*/*','wss://*/*']}, (_r, cb) => cb({cancel: true}));
    session.defaultSession.protocol.handle('file', request => {
      if (path.basename(fileURLToPath(request.url.split('?')[0])) !== 'desk.html') return net.fetch(request.url, {bypassCustomProtocolHandlers: true});
      const early = '<script>' + fs.readFileSync(path.join(__dirname, 'fixtures/page-audit-api.js'), 'utf8') +
        ';soduWorkAPI.onBroadcast=callback=>{window.fixtureBroadcast=callback;};</script>';
      const html = fs.readFileSync(path.join(client, 'desk.html'), 'utf8').replace('<head>', '<head>' + early)
        .replace('<script src="desk-boot.js"></script>', '<script>fixtureInstallApi();SoduWorkAPI.taskStorageKey=kind=>fixtureOwner+":"+kind;</script><script src="desk-boot.js"></script>');
      return new Response(html, {headers: {'content-type': 'text/html;charset=utf-8'}});
    });
    win = new BrowserWindow({show: false, width: 1280, height: 850,
      webPreferences: {contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false}});
    try {
      await win.loadFile(path.join(client, 'desk.html'), {query: {panel: 'workspace', view: 'notices'}});
      await until('Boolean(window.fixtureReady && document.querySelector("#wsRailNoticeBadge") && document.querySelector(".np-empty"))');
      await check('empty-inbox-has-no-dot', async () => {await shot('empty'); await badge(0);});
      await check('new-unread-updates-without-opening-window', async () => {
        await js('logNotice("未读通知",null,"notice");'); await shot('unread'); await badge(1);
        assert.equal(await js('document.querySelectorAll("#npBody .np-row.unread").length'), 1,
          'an open inbox must show the unread message counted by its bell');
      });
      await check('reading-one-preserves-the-other-unread', async () => {
        await js('logNotice("待查看提醒",null,"remind");markNoticeRead(notices[0].id);'); await badge(1);
      });
      await check('all-read-hides-badge-while-history-remains', async () => {
        await js('markNoticeRead(notices[1].id);_renderNoticePanel();'); await badge(0);
        assert.equal(await js('document.querySelectorAll("#npBody .np-row").length'), 2);
      });
      await check('opening-inbox-does-not-consume-unread', async () => {
        await js('logNotice("保持未读",null,"notice");openNoticePanel();'); await badge(1);
      });
      await check('native-notice-click-clears-the-last-unread', async () => {
        await click('#npBody .np-row.unread'); await badge(0);
      });
      await check('navigation-refresh-preserves-unread-count', async () => {
        await js('logNotice("重绘后仍未读",null,"notice");WorkspaceShell.refreshNav();'); await badge(1);
      });
      await check('locale-refresh-preserves-unread-count', async () => {
        await js('dispatchEvent(new CustomEvent("soduwork-locale-change"));'); await badge(1);
      });
      await check('clearing-notifications-immediately-hides-badge', async () => {
        await js('_renderNoticePanel();'); await click('#npClear'); await badge(0);
        assert.equal(await js('Boolean(document.querySelector(".np-empty"))'), true);
      });
      await check('broadcast-new-read-and-clear-follow-existing-store', async () => {
        await js(`localStorage.setItem(SoduWorkAPI.taskStorageKey('notices'),JSON.stringify([
          {id:'remote',at:Date.now(),text:'跨窗口未读',kind:'notice',read:false}]));fixtureBroadcast('notices');`);
        await badge(1);
        await js(`localStorage.setItem(SoduWorkAPI.taskStorageKey('notices'),JSON.stringify([
          {id:'remote',at:Date.now(),text:'跨窗口已读',kind:'notice',read:true}]));fixtureBroadcast('notices');`);
        await badge(0);
        await js(`localStorage.setItem(SoduWorkAPI.taskStorageKey('notices'),'[]');fixtureBroadcast('notices');`);
        await badge(0);
      });
      await check('account-switch-cannot-retain-former-unread', async () => {
        await js('logNotice("旧账号未读",null,"notice");fixtureOwner="notice-badge-other";dispatchEvent(new CustomEvent("soduwork-data-scope-changed"));');
        await badge(0);
        await js('fixtureOwner="page-audit-owner";dispatchEvent(new CustomEvent("soduwork-data-scope-changed"));clearNotices();');
      });
      await check('foreign-private-cache-is-hidden-in-both-list-and-badge', async () => {
        await click('[data-rail-view="notices"]');
        await js(`window.fixturePriorAuth=SoduWorkAPI.clientAuthSnapshot;
          SoduWorkAPI.clientAuthSnapshot=()=>({user:{id:'notice-reader'}});
          localStorage.setItem(SoduWorkAPI.taskStorageKey('notices'),JSON.stringify([
            {id:'foreign',at:2,text:'其他用户的私信正文',kind:'mate_message',recipientId:'someone-else',read:false},
            {id:'related',at:1,text:'指定给本人的协作消息',kind:'mate_message',recipientId:'notice-reader',read:false}
          ]));fixtureBroadcast('notices');_renderNoticePanel();`);
        await badge(1);
        assert.equal(await js('document.querySelectorAll("#npBody .np-row").length'), 1);
        assert.equal(await js('document.querySelector("#npBody .np-row").checkVisibility()'), true);
        assert.equal(await js('document.querySelector("#npBody").textContent.includes("其他用户的私信正文")'), false);
        await shot('audience-private-cache');
        await js('clearNotices();SoduWorkAPI.clientAuthSnapshot=fixturePriorAuth;void 0;');
      });
      await check('current-task-roles-hide-old-false-handoff-but-keep-direct-collaboration', async () => {
        await click('[data-rail-view="notices"]');
        await js(`logNotice('旧的错误转出提示','team-notice-fixture','handoff.done');
          logNotice('本人需要处理的协作消息','team-notice-fixture','task_receipt');
          Store.applyServerEvent({type:'task.created',task:{id:'team-notice-fixture',title:'只读团队需求',
            status:'todo',myRoles:[],readOnly:true}});`);
        await badge(1);
        assert.equal(await js('document.querySelector("#npBody").textContent.includes("旧的错误转出提示")'), false);
        const content = await js('document.querySelector("#npBody").textContent');
        assert.equal(content.includes('本人需要处理的协作消息'), true, content);
        assert.equal(await js('document.querySelector("#npBody .np-row").checkVisibility()'), true);
        await shot('audience-team-history'); await js('clearNotices();');
      });
      await check('large-count-is-capped-and-clears', async () => {
        await js('for(let i=0;i<100;i++)logNotice("提醒 "+i,null,"remind");'); await badge(100);
        await shot('many'); await js('clearNotices();'); await badge(0);
      });
      await check('all-themes-hide-empty-and-display-positive-badge', async () => {
        for (const theme of ['vivid','ruby','azure','steady','warm','minimal']) {
          await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)};clearNotices();`); await badge(0);
          await js('logNotice("换肤未读",null,"notice");'); await badge(1);
        }
        await js('clearNotices();');
      });
      await check('reload-restores-empty-badge-without-residual-dot', async () => {
        const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
        win.reload(); await loaded;
        await until('Boolean(window.fixtureReady && document.querySelector("#wsRailNoticeBadge"))');
        await badge(0); await shot('reopened-empty');
      });
      report.errors = await js('fixtureErrors');
      report.ok = report.cases.every(row => row.ok) && report.errors.length === 0;
    } catch (error) {report.errors.push(String(error));}
    finally {
      fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
      if (!win.isDestroyed()) win.destroy(); app.exit(report.ok ? 0 : 1);
    }
  }).catch(error => {console.error(error); app.exit(1);});
}
