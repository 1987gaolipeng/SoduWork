'use strict';
// Actual production forms, store, HTTP/services, SQLite and WS. Only identity,
// model parsing and native desktop integration are isolated test substitutes.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  const timeout = setTimeout(() => { child.kill(); process.exitCode = 1; }, 120000);
  child.on('exit', code => { clearTimeout(timeout); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), backend = path.resolve(client, '../hub-backend');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-collab-e2e-'));
  const out = path.resolve(process.argv[2] || path.join(client, '../outputs/task-assignment-notices-20261015'));
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  const report = { ok: false, cases: [], errors: [], realModel: false, businessDatabase: false };
  const windows = [], blockedReads = new Set();
  let server, logs = '', url;
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = (win, code) => win.webContents.executeJavaScript(code, true).catch(error => {
    report.failedScript = code.slice(0, 200); throw error;
  });
  async function until(win, code) {
    for (let i = 0; i < 160; i++) { if (await js(win, code)) return; await delay(50); }
    throw Error('Timed out: ' + code);
  }
  async function click(win, selector) {
    await js(win, `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`);
    await delay(250);
    const point = await js(win, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();const point={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};const hit=document.elementFromPoint(point.x,point.y);if(!e.contains(hit))throw Error('Click blocked for '+${JSON.stringify(selector)}+': '+hit?.outerHTML.slice(0,300));return point})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(100);
  }
  async function startServer() {
    const socket = require('node:net').createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    server = require('node:child_process').spawn(path.join(backend, '.venv/Scripts/python.exe'),
      ['-m', 'uvicorn', 'tests.task_notification_browser_server:app', '--host', '127.0.0.1', '--port', String(port)], {
        cwd: backend, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
          SODUWORK_COLLAB_E2E_ROOT: temporary, AUTH_SECRET: 'isolated-notification-browser-secret',
          ADMIN_PASS: 'isolated-notification-browser-password', REDIS_URL: '', CLUSTER_BUS_ENABLED: 'false' },
      });
    server.stdout.on('data', data => { logs += data; }); server.stderr.on('data', data => { logs += data; });
    url = 'http://127.0.0.1:' + port;
    for (let i = 0; i < 180; i++) {
      try { if ((await (await fetch(url + '/ready')).json()).isolated) return; } catch (_) {}
      if (server.exitCode !== null) break;
      await delay(100);
    }
    throw Error('Isolated server failed: ' + logs);
  }
  async function createWindow(identity) {
    const win = new BrowserWindow({ show: false, width: 1200, height: 1100,
      webPreferences: { partition: 'task-notices-' + identity, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    windows.push(win);
    win.webContents.on('console-message', event => {
      if (event.level === 'error' && !/net::ERR_/.test(event.message)) report.errors.push(event.message);
    });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, callback) => {
      const local = request.url.startsWith(url + '/') || request.url.startsWith(url.replace('http:', 'ws:') + '/');
      callback({ cancel: !local || (blockedReads.has(identity) && /\/team\/messages\/[^/]+\/read$/.test(request.url)) });
    });
    await win.loadFile(path.join(temporary, 'fixture.html'));
    await js(win, `window.__SODUWORK_TEST_HUB_CONFIG__={allowSwitch:true};localStorage.setItem('soduwork_work_hub_environment_v1','development');localStorage.setItem('soduwork_work_development_hub_url_v1',${JSON.stringify(url)});localStorage.setItem('soduwork_work_user_id',${JSON.stringify('e2e-' + identity)});window.errors=[];window.noticesSaid=[];window.opened=[];window.petSay=text=>noticesSaid.push(text);window.openDetailEntry=id=>opened.push(id);window.updateNoticeBadge=()=>{document.getElementById('badge').textContent=String(noticeUnread());if(document.getElementById('noticePanel')?.classList.contains('show'))_renderNoticePanel();};addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));void 0;`);
    for (const file of ['core/api-work-plugins.js', 'api.js', 'core/task-sync.js', 'core/mate-notice-sync.js', 'core/store-lifecycle.js', 'core/store.js', 'core/requirements.js',
      'components/panels/task-priority.js', 'components/panels/task-execution-client.js', 'components/panels/plugin-ui-host.js',
      'components/panels/panels-compose-submit.js', 'components/panels/requirement-routing.js', 'components/panels/panels-compose-draft.js', 'components/panels/work-entry-sheet.js',
      'components/panels/chat-work-intent.js', 'components/panels/panels-chat-work-actions.js', 'components/panels/panels-misc.js',
      'components/panels/message-follow-up.js', 'components/panels/panels-desk.js'])
      await js(win, read(file) + '\nvoid 0;');
    await js(win, `SoduWorkAPI.parseTaskText=async()=>({title:'转交缺陷清单',note:'仅模型摘要，不含完整缺陷',assignee:'接收验收',checklist:['完整保留缺陷清单']});SoduWorkAPI.taskExecutionOptions=async()=>({substrates:[],workflows:[],repos:[]});SoduWorkAPI.workCatalog=async()=>({scenarios:[]});SoduWorkAPI.registerClient=async()=>({ok:true});SoduWorkAPI.connectWS=onEvent=>{window.fixtureSocket=new WebSocket(${JSON.stringify(url.replace('http:', 'ws:') + '/fixture/ws/e2e-' + identity)});fixtureSocket.onmessage=e=>onEvent(JSON.parse(e.data));fixtureSocket.onopen=()=>dispatchEvent(new Event('soduwork-ws-open'));return()=>fixtureSocket.close()};initData();void 0;`);
    await until(win, 'Store._remoteReady');
    return win;
  }
  app.whenReady().then(async () => {
    await startServer();
    const { pathToFileURL } = require('node:url');
    const styles = ['theme/variables.css', 'components/workspace/workspace-shell.css', 'components/panels/plugin-ui-host.css',
      'components/panels/work-entry-sheet.css', 'components/panels/panels-desk.css', 'components/panels/notice-surface.css', 'components/panels/notice-type-scale.css'];
    fs.writeFileSync(path.join(temporary, 'fixture.html'), '<!doctype html><meta charset="utf-8">' + styles.map(file =>
      '<link rel="stylesheet" href="' + pathToFileURL(path.join(client, file)).href + '">').join('') +
      '<style>body{margin:24px;background:var(--bg-0);font:14px var(--font-ui)}#host{max-width:900px;margin:auto}.notice-panel{inset:50px 40px!important;width:auto!important;height:950px!important;transform:none!important}#badge{position:fixed;top:8px;right:24px}</style><output id="badge">0</output><main id="host"></main><textarea id="nchatInput"></textarea>');
    const sender = await createWindow('sender');
    const list = '# 缺陷清单\n首项：登录失败\n' + '详细复现与证据。\n'.repeat(1250) + '\n尾项：撤权后不得运行';
    const instruction = '请将这个缺陷清单转给接收验收';
    await js(sender, `window.fixtureIntent=ChatWorkIntent.create({_snap:{messages:[{role:'assistant',blocks:[{kind:'text',text:${JSON.stringify(list)}}]}]}});window.selected=PluginUIHost.actions().find(a=>a.id==='work.requirement.create');ChatWorkActions.route({text:${JSON.stringify(instruction)},mention:{action:()=>selected}}, {conversationContext:fixtureIntent._workConversationContext,open:(command,options)=>ChatWorkActions.open(command,options,{mount:()=>document.body,dismissProposal(){},bridge:()=>({})})})`);
    await until(sender, 'Boolean(document.querySelector("#cpCreate"))');
    const note = await js(sender, 'document.querySelector("#cpNote").value');
    assert.equal(note, '仅模型摘要，不含完整缺陷');
    assert((await js(sender, 'document.querySelector("#cpSourceNote").value')).includes(list));
    await click(sender, '#cpCreate');
    await until(sender, 'Boolean(document.querySelector(".cp-ok"))');
    const sent = await js(sender, 'SoduWorkAPI.mateMessages("sent").then(r=>r.items)');
    assert.equal(sent.length, 1); assert.equal(sent[0].status, 'accepted'); assert(sent[0].taskId);
    const taskId = sent[0].taskId, messageId = sent[0].id;
    const headers = { 'X-Soduwork-Device': 'e2e-recipient' };
    const task = await (await fetch(url + '/api/v1/tasks/' + taskId, { headers })).json();
    assert((task.task || task).note.includes(list));
    assert((task.task || task).note.startsWith(note));
    await click(sender, '[data-cp-receipt-close]');
    report.cases.push('Explicit conversation reference -> real editable requirement -> real assigned API retains complete source; offline recipient has durable accepted notification');
    await js(sender, 'MateNoticeSync.refresh();');
    assert(await js(sender, 'noticeUnread()') > 0);
    const recipient = await createWindow('recipient');
    await until(recipient, 'noticeUnread()===1');
    assert.equal(await js(recipient, 'Boolean(document.querySelector("#noticePanel"))'), false);
    await js(recipient, 'MateNoticeSync.refresh();');
    await js(sender, 'MateNoticeSync.refresh();');
    assert.equal(await js(sender, 'SoduWorkAPI.mateMessages("sent").then(r=>r.items[0].status)'), 'delivered');
    report.cases.push('Recipient recovers offline notification and badge before opening inbox; actual client acknowledgement advances sender delivery status');
    const secondary = await createWindow('recipient-other');
    await until(secondary, 'noticeUnread()===1');
    for (const win of [sender, recipient, secondary]) await until(win, 'fixtureSocket.readyState===1');
    await js(recipient, 'openNoticePanel();');
    await until(recipient, 'document.querySelectorAll(".np-row.unread").length===1');
    blockedReads.add('recipient');
    await click(recipient, '.np-row.unread');
    assert.equal(await js(recipient, 'noticeUnread()'), 1);
    blockedReads.delete('recipient');
    await click(recipient, '.np-row.unread');
    await until(recipient, 'noticeUnread()===0');
    await until(secondary, 'noticeUnread()===0');
    await until(sender, 'MateNoticeSync.rows("sent").some(row=>row.sentStatus==="read"||row.status==="read")');
    const receipt = await js(sender, 'SoduWorkAPI.mateMessages("sent").then(r=>r.items[0])');
    assert(receipt.readAt); assert.equal(receipt.status, 'read');
    report.cases.push('Failed read acknowledgement preserves unread; retry confirms read, real WS updates sender receipt and recipient secondary device');
    await js(recipient, 'clearNotices();MateNoticeSync.refresh();');
    assert.equal(await js(recipient, 'noticeUnread()'), 0);
    const otherHeaders = { 'X-Soduwork-Device': 'e2e-other' };
    for (const action of ['delivered', 'read']) assert.equal((await fetch(url + '/api/v1/team/messages/' + messageId + '/' + action, { method: 'POST', headers: otherHeaders })).status, 404);
    assert.equal((await (await fetch(url + '/api/v1/team/messages?folder=received', { headers: otherHeaders })).json()).items.length, 0);
    report.cases.push('Replay does not resurrect cleared/read notifications; unrelated identity cannot list or acknowledge the assignment');
    for (const win of windows) assert.deepEqual(await js(win, 'errors'), []);
    fs.writeFileSync(path.join(out, 'recipient-read.png'), (await recipient.webContents.capturePage()).toPNG());
    await js(sender, 'openNoticePanel();');
    await delay(200);
    fs.writeFileSync(path.join(out, 'sender-receipts.png'), (await sender.webContents.capturePage()).toPNG());
    report.ok = true;
  }).catch(async error => {
    report.errors.push(error.stack);
    report.windowStates = [];
    for (const win of windows) report.errors.push(...await js(win, 'window.errors||[]').catch(() => []));
    for (const win of windows) report.windowStates.push(await js(win,
      '({count:noticeUnread(),notices:MateNoticeSync.rows("received").map(({id,kind,folder,status,read,taskId})=>({id,kind,folder,status,read,taskId})),sent:MateNoticeSync.rows("sent").map(({id,status})=>({id,status})),taskState:Store.taskState})').catch(() => ({})));
    for (let i = 0; i < windows.length; i++) fs.writeFileSync(path.join(out, 'failure-window-' + i + '.png'), (await windows[i].webContents.capturePage()).toPNG());
  }).finally(async () => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(out, 'server.log'), logs); console.log(JSON.stringify(report));
    for (const win of windows) win.destroy();
    if (server && server.exitCode === null) { server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(3000)]); }
    app.exit(report.ok ? 0 : 1);
  });
}
