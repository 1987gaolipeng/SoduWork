'use strict';
const electron = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const client = path.resolve(__dirname, '..');
if (typeof electron === 'string') {
  const output = path.resolve(client, '../outputs/workspace-sidebar-upgrade');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-sidebar-upgrade-'));
  fs.mkdirSync(output, { recursive: true });
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const report = { ok: false, boundary: 'Three isolated Electron processes share one temporary profile across different version directories. Production API authentication, shell, sidebar and archive components; synthetic history and auth only; network blocked.', phases: [] };
  try {
    for (const phase of ['seed', 'upgrade', 'restart']) {
      const child = require('node:child_process').spawnSync(electron, [__filename, phase, profile, output], { env, windowsHide: true, encoding: 'utf8', timeout: 60000 });
      if (child.stdout) process.stdout.write(child.stdout);
      if (child.stderr) process.stderr.write(child.stderr);
      assert.equal(child.status, 0, phase + ': ' + (child.error?.message || 'Electron regression failed'));
      report.phases.push(JSON.parse(fs.readFileSync(path.join(output, phase + '.json'), 'utf8')));
    }
    report.ok = true;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
} else {
  const { app, BrowserWindow } = electron;
  const [phase, profile, output] = process.argv.slice(2);
  app.setPath('userData', profile);
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const url = file => require('node:url').pathToFileURL(path.join(client, file)).href;
  const previousKey = 'soduwork_sidebar_projects_v1:' + encodeURIComponent('soduwork_work_tasks_v5@' + ['http://127.0.0.1:18989', 'former-device', 'user-a'].map(encodeURIComponent).join('@'));
  const previous = JSON.stringify({ version: 1, pins: ['long-chat'], rows: [
    { id: 'long-chat', title: '长期合作：保留升级前的置顶会话', usedHarnesses: ['pi', 'qwen'], adapterId: 'opencode' },
    { id: 'archived-chat', title: '已归档会话' }],
    projects: [{ id: 'project-active', name: '持续合作', folders: [], chatIds: ['long-chat'] }],
    archivedProjects: [{ id: 'project-archived', name: '账号 A 的归档项目', folders: [], chatIds: ['archived-chat'], archivedAt: 1000 }] });
  const report = { phase, ok: false, cases: [], screenshots: [], errors: [], requests: [] };
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) { for (let i = 0; i < 100; i++) { if (await js(code)) return; await delay(30); } throw Error('Timed out: ' + code); }
  async function shot(name) {
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const file = path.join(output, name + '.png'); fs.writeFileSync(file, (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); report.screenshots.push(file);
  }
  function fixture() {
    const sheets = [...read('desk.html').matchAll(/<link\s+rel=["']stylesheet["']\s+href=["']([^"']+)["']/g)].map(match => '<link rel="stylesheet" href="' + url(match[1]) + '">').join('');
    const panel = read('desk.html').match(/<section class="archive-history-panel"[\s\S]*?<\/section>\s*<div class="skin-manager"/)[0].replace(/<div class="skin-manager"$/, '');
    const files = ['core/api-work-plugins.js', 'api.js', 'components/panels/agent-brand.js', 'components/workspace/workspace-chat-history.js',
      'components/workspace/workspace-sidebar-state.js', 'components/workspace/workspace-sidebar-drag.js', 'components/workspace/workspace-sidebar-projects.js',
      'components/workspace/workspace-chat-list.js', 'components/workspace/workspace-shell.js', 'components/archive/archive-history-panel.js'];
    return '<!doctype html><html data-desk-panel="workspace" data-skin="box"><head><meta charset="utf-8"><base href="' + url('') + '/">' + sheets + '</head><body>' + panel + `<script>
      window.fixtureUser='user-a';window.fixtureDevice=${JSON.stringify('replacement-' + phase)};window.fixtureErrors=[];window.authEvents=0;window.pendingHistory=[];
      addEventListener('error',event=>fixtureErrors.push(event.message));addEventListener('soduwork-device-auth',()=>authEvents++);
      window.petSay=message=>window.lastNotice=message;
      window.WorkspaceHost={open:()=>{}};
      window.soduWorkAPI={deviceAuthBootstrap:async()=>({ok:true,stored:true,clientId:fixtureDevice,user:{id:fixtureUser},session:'synthetic-session',expiresIn:1800}),conversationSession:{
        history:()=>window.deferHistory?new Promise(resolve=>pendingHistory.push({user:fixtureUser,resolve})):Promise.resolve({ok:true,chats:[{id:'recent',title:'最近的一次聊天',usedHarnesses:['pi'],at:2000}]}),
        archivedHistory:()=>window.deferArchive?new Promise(resolve=>window.finishArchive=resolve):Promise.resolve({ok:true,chats:[]})}};
      </script>` + files.map(file => '<script src="' + url(file) + '"></script>').join('') + `<script>
      WorkspaceShell.mount();WorkspaceShell.setActive('create');
      document.querySelector('#wsCanvas').innerHTML='<div style="padding:40px;color:var(--ink-3)">客户端升级后的侧栏恢复验证</div>';
      </script></body></html>`;
  }
  app.whenReady().then(async () => {
    const directory = path.join(profile, 'version-' + phase); fs.mkdirSync(directory, { recursive: true });
    const html = path.join(directory, 'desk.html'); fs.writeFileSync(html, phase === 'seed' ? '<!doctype html><title>Isolated previous version</title>' : fixture());
    win = new BrowserWindow({ show: false, width: 1200, height: 820, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => { report.requests.push(request.url); done({ cancel: true }); });
    await win.loadFile(html);
    if (phase === 'seed') {
      await js(`localStorage.setItem(${JSON.stringify(previousKey)},${JSON.stringify(previous)});void 0;`);
      report.cases.push('The previous version writes a scoped legacy layout in this temporary profile');
    } else {
      await until('!!document.querySelector("#wsChats .ws-chat")');
      assert.equal(await js('document.querySelectorAll("#wsPinnedChats .ws-chat").length'), 0);
      const before = await js('localStorage.length');
      await js('WorkspaceShell.setChats([{id:"recent",title:"最近的一次聊天"}]);void 0;');
      assert.equal(await js('localStorage.length'), before, 'Unbound sidebar must not persist a new layout');
      await js('SoduWorkAPI.registerClient()');
      assert.ok(await js('authEvents>0'));
      if (phase === 'upgrade') {
        await until('document.querySelectorAll("#wsPinnedChats .ws-chat").length===1');
        assert.equal(await js('document.querySelector("#wsPinnedChats .ws-chat-title").textContent'), '长期合作：保留升级前的置顶会话');
        assert.deepEqual(await js('[...document.querySelectorAll("#wsPinnedChats [data-agent-brand]")].map(e=>e.dataset.agentBrand)'), ['pi', 'qwen']);
        report.cases.push('Real API bootstrap changes unbound/device scope and its auth event immediately restores pins, projects and complete harness metadata');
        for (const width of [280, 180]) {
          await js(`document.documentElement.style.setProperty('--ws-side-w','${width}px');void 0;`);
          await shot('recovered-sidebar-' + width);
          assert.equal(await js('Math.round(document.querySelector(".ws-side").getBoundingClientRect().width)'), width);
          assert.ok(await js('[...document.querySelectorAll("#wsPinnedChats .ws-chat-row")].every(e=>e.scrollWidth<=e.clientWidth+1)'));
        }
        await js('openArchiveHistory();void 0;');
        await until('document.querySelectorAll("#archiveProjectsList .archive-history-item").length===1');
        await js('WorkspaceShell.setChats([{id:"private-a",title:"账号 A 的私有对话",usedHarnesses:["pi","qwen"]}]);deferHistory=true;window.oldHistory=WorkspaceShell.refreshConversationHistory();void 0;');
        await until('pendingHistory.length===1');
        await js('fixtureUser="user-b";window.deferArchive=true;SoduWorkAPI.registerClient()');
        assert.equal(await js('document.querySelectorAll("#wsPinnedChats .ws-chat").length'), 0);
        assert.equal(await js('document.querySelector("#wsChats").textContent.includes("账号 A 的私有对话")'), false);
        assert.equal(await js('document.querySelectorAll("#archiveProjectsList .archive-history-item").length'), 0, 'Old account content disappears before the new request completes');
        await until('pendingHistory.length===2');
        await js('pendingHistory[0].resolve({ok:true,chats:[{id:"private-a",title:"账号 A 的迟到私有对话",usedHarnesses:["pi","qwen"]}]});oldHistory');
        assert.equal(await js('document.querySelector("#wsChats").textContent.includes("账号 A")'), false);
        await js('pendingHistory[1].resolve({ok:true,chats:[{id:"private-b",title:"账号 B 的当前对话",usedHarnesses:["claude"]}]});void 0;');
        await until('document.querySelector("#wsChats").textContent.includes("账号 B 的当前对话")');
        assert.deepEqual(await js('[...document.querySelectorAll("#wsChats [data-agent-brand]")].map(node=>node.dataset.agentBrand)'), ['claude']);
        const stableB = await js('localStorage.getItem(WorkspaceSidebarState.accountOptions({storage:localStorage,api:SoduWorkAPI}).key)');
        assert.doesNotMatch(stableB || '', /private-a|账号 A/);
        await shot('account-b-rejects-late-history');
        report.cases.push('Switching accounts clears recent titles and harness icons immediately; a delayed A history response cannot enter B or clear its in-flight request');
        await js('deferHistory=false;void 0;');
        await js('deferArchive=false;finishArchive({ok:true,chats:[]});fixtureUser="user-a";SoduWorkAPI.registerClient()');
        await until('document.querySelectorAll("#wsPinnedChats .ws-chat").length===1');
        await until('document.querySelectorAll("#archiveProjectsList .archive-history-item").length===1');
        report.cases.push('Account switch immediately clears sidebar and open archive, rejects stale pending history and restores the original account independently');
        await js('closeArchiveHistory();void 0;');
        const point = await js('(()=>{const r=document.querySelector("#wsPinnedChats .ws-chat-pin").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
        win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await delay(60);
        for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
        await until('document.querySelectorAll("#wsPinnedChats .ws-chat").length===0');
        report.cases.push('Native mouse unpins the recovered conversation while preserving project membership');
      } else {
        assert.equal(await js('document.querySelectorAll("#wsPinnedChats .ws-chat").length'), 0);
        assert.equal(await js('document.querySelector(".ws-project-toggle span").textContent'), '持续合作');
        assert.ok(await js('!!document.querySelector(".ws-project [data-chat-id=long-chat]")'));
        report.cases.push('Another complete process restart, version directory and device identity retain explicit unpin and project membership');
        await shot('restart-keeps-unpinned');
      }
      assert.equal(await js('localStorage.getItem(' + JSON.stringify(previousKey) + ')'), previous);
      assert.deepEqual(await js('fixtureErrors'), []);
      assert.deepEqual(report.requests, []);
    }
    await win.webContents.session.flushStorageData();
    report.ok = true;
  }).catch(async error => { report.error = error.stack; if (win) { report.errors = await js('window.fixtureErrors||[]').catch(() => []); await shot(phase + '-failure').catch(() => {}); } })
    .finally(() => { fs.writeFileSync(path.join(output, phase + '.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); win?.destroy(); app.exit(report.ok ? 0 : 1); });
}
