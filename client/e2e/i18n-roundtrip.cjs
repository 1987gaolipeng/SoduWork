'use strict';
// Real DOM regression for UI created after English is already selected.
// Uses an isolated profile and production renderers; never connects to services.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence directory required');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-locale-roundtrip-')));
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const report = { cases: [], errors: [] };
let win;
const js = code => win.webContents.executeJavaScript(code);
const tick = () => js('new Promise(resolve => setTimeout(resolve, 35))');
async function locale(value) { await js(`SoduWorkI18n.setLocale(${JSON.stringify(value)})`); await tick(); }
async function run() {
  win = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
  await win.loadFile(path.join(__dirname, 'fixtures/i18n-roundtrip.html'));
  await js(`document.documentElement.dataset.deskPanel='workspace';window.opened=[];
    window.SoduWorkAPI={hubBase:()=> 'https://locale-fixture.invalid',clientAuthSnapshot:()=>({clientId:'fixture-device',user:{id:'fixture-account'}})};
    window.WorkspaceHost={open:(key,options)=>{opened.push({key,options});WorkspaceShell.setActive(key)}};void 0;`);
  for (const name of JSON.parse(read('core/locales/manifest.json'))) await js(read('core/locales/' + name));
  for (const name of ['core/i18n-dom.js', 'core/i18n.js']) await js(read(name));
  await locale('en-US');
  await js(read('components/panels/agent-brand.js'));
  for (const name of ['workspace-chat-history.js', 'workspace-sidebar-state.js', 'workspace-sidebar-drag.js', 'workspace-sidebar-projects.js', 'workspace-chat-list.js', 'workspace-shell.js']) {
    await js(read('components/workspace/' + name));
  }
  await js(`WorkspaceShell.mount();WorkspaceShell.setActive('create');WorkspaceShell.setConnected(true);
    WorkspaceShell.setChats([{id:'literal-zh',title:'保存',state:'running',adapterId:'pi'},
      {id:'literal-en',title:'New chat',state:'completed',adapterId:'codex'},
      {id:'literal-file',title:'D:/保存/New chat.md',state:'completed',adapterId:'pi'}]);
    WorkspaceShell.setTasks([{id:'task-zh',title:'删除',status:'todo'},{id:'task-en',title:'Settings',status:'done'}]);`);
  await tick();
  assert.equal(await js(`document.querySelector('.ws-new-chat [data-view="create"] span').textContent`), 'New chat');
  assert.equal(await js(`document.querySelector('[data-i18n="nav.history"]').textContent`), 'Issues');
  assert.equal(await js(`document.querySelector('#wsRecentToggle span').textContent`), 'Recent issues');
  await locale('zh-CN');
  assert.equal(await js(`document.querySelector('.ws-new-chat [data-view="create"] span').textContent`), '新对话');
  assert.equal(await js(`document.querySelector('.ws-new-chat').getAttribute('aria-label')`), '新对话');
  assert.equal(await js(`document.querySelector('[data-i18n="nav.history"]').textContent`), '需求池');
  assert.equal(await js(`document.querySelector('#wsRecentToggle span').textContent`), '最近需求');
  assert.equal(await js(`document.querySelector('#wsHubState').textContent`), '已连接 SoduWork 服务');
  report.cases.push('English-first sidebar returns to Chinese and preserves the actual connection state');

  await locale('en-US');
  assert.deepEqual(await js(`Array.from(document.querySelectorAll('.ws-chat-title'),node=>node.textContent).sort()`), ['D:/保存/New chat.md', 'New chat', '保存'].sort());
  assert.deepEqual(await js(`Array.from(document.querySelectorAll('#wsRecent .ws-task span'),node=>node.textContent).sort()`), ['Settings', '删除'].sort());
  assert.equal(await js(`document.querySelector('[data-chat-id="literal-zh"]').title`), '保存 · Running · Pi');
  assert.equal(await js(`document.querySelector('[data-chat-id="literal-zh"]').getAttribute('aria-label')`), '保存, Running, Pi');
  await js(`WorkspaceShell.upsertChat({id:'literal-zh',title:'保存',state:'failed',adapterId:'pi'});WorkspaceShell.setActive('settings');`);
  await tick();
  const failureTitle = await js(`document.querySelector('[data-chat-id="literal-zh"]').title`);
  assert.equal(failureTitle, '保存 · Execution failed · Pi');
  await locale('zh-CN');
  assert.equal(await js(`document.querySelector('[data-chat-id="literal-zh"]').title`), '保存 · 执行失败 · Pi');
  assert.equal(await js(`document.querySelector('#wsNav [data-view="settings"] span').textContent`), '设置');
  await js(`WorkspaceShell.setActive('library');WorkspaceShell.setActive('create');document.querySelector('#wsChatsToggle').click();`);
  await tick();
  assert.equal(await js(`document.querySelector('#wsChatsToggle').title`), '展开最近聊天');
  await locale('en-US');
  assert.equal(await js(`document.querySelector('#wsChatsToggle').title`), 'Expand recent chats');
  await locale('zh-CN');
  assert.equal(await js(`document.querySelector('#wsChatsToggle').title`), '展开最近聊天');
  report.cases.push('Module changes, current chat state and collapsed-group tooltips round-trip without translating user names');

  await js(`document.querySelector('#wsCanvas').innerHTML='<button id="dynamicUi" title="复制页面地址">复制</button><input id="draft" placeholder="搜索" value="未发送 draft"><div data-user-content title="Settings" id="fileName">保存.md</div>'`);
  await tick();
  for (let i = 0; i < 3; i++) {
    await locale('en-US');
    assert.equal(await js(`document.querySelector('#dynamicUi').title`), 'Copy page URL');
    await locale('zh-CN');
    assert.equal(await js(`document.querySelector('#dynamicUi').title`), '复制页面地址');
    assert.equal(await js(`document.querySelector('#dynamicUi').textContent`), '复制');
    assert.equal(await js(`document.querySelector('.ws-new-chat [data-view="create"] span').textContent`), '新对话');
  }
  assert.equal(await js(`document.querySelector('#draft').value`), '未发送 draft');
  assert.equal(await js(`document.querySelector('#fileName').textContent`), '保存.md');
  assert.equal(await js(`document.querySelector('#fileName').title`), 'Settings');
  report.cases.push('Repeated switching preserves drafts and filenames while updating late-created UI and tooltips');

  await locale('en-US');
  await js(read('components/panels/access-controls.js'));
  await js(`window.escapeMarkup=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    document.querySelector('#wsCanvas').innerHTML=AccessControls.render({requestId:'request-1',policyRevision:7,
      action:'file.write',tool:'保存',target:'D:/资料/Settings.md',arguments:{path:'保存.md',content:'Delete'}},escapeMarkup);
    window.approvalButton=document.querySelector('[data-ui-value="once"]');
    document.querySelector('.access-request details').open=true;void 0;`);
  await tick();
  assert.equal(await js(`approvalButton.textContent`), 'Allow once');
  assert.equal(await js(`document.querySelector('.access-request').getAttribute('aria-label')`), 'Access approval');
  await locale('zh-CN');
  assert.equal(await js(`approvalButton.textContent`), '允许一次');
  assert.equal(await js(`document.querySelector('.access-request').getAttribute('aria-label')`), '权限确认');
  assert.equal(await js(`document.querySelector('.access-head b').textContent`), '允许修改文件？');
  assert.equal(await js(`document.querySelector('.access-request details summary [data-user-content]').textContent`), '保存');
  assert.equal(await js(`document.querySelector('.access-target').textContent`), 'D:/资料/Settings.md');
  assert.equal(await js(`document.querySelector('.access-request details').open`), true);
  assert.equal(await js(`document.querySelector('[data-ui-value="once"]')===approvalButton`), true);
  await js(`AccessControls.answer(approvalButton,{answerUi:async(ref,response)=>{window.answer={ref,response};return {ok:true}}},'chat-1')`);
  assert.deepEqual(await js('answer'), { ref: 'chat-1', response: { requestId: 'request-1', policyRevision: 7, decision: 'once' } });
  assert.equal(await js('approvalButton.disabled'), true);
  assert.equal(await js(`document.querySelector('.access-request').hidden`), true);
  report.cases.push('An English-first approval card restores Chinese without replacing controls or modifying the actual approval request');
  assert.deepEqual(report.errors, []);
  report.ok = true;
}
app.whenReady().then(run).catch(error => { report.error = error.stack; }).finally(() => {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  win?.destroy(); app.exit(report.ok ? 0 : 1);
});
