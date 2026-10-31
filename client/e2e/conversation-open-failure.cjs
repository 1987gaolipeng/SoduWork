'use strict';
// Production navigation, work-card guard, drafts and renderer in isolated
// Electron. Only native IPC is a fixture; no account, Hub or model is accessed.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], {
    env, windowsHide:true, stdio:'inherit', timeout:60000,
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const {app, BrowserWindow} = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), {pathToFileURL} = require('node:url');
const client = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-open-failure-'));
const out = path.resolve(client, '../outputs/conversation-open-failure-20261020');
fs.mkdirSync(out, {recursive:true});
app.setPath('userData', path.join(temp, 'profile'));
app.disableHardwareAcceleration();
let win;
const report = {ok:false, cases:[], errors:[], realModel:false, businessDatabase:false};
const js = source => win.webContents.executeJavaScript(source, true);
app.whenReady().then(async () => {
  let html = fs.readFileSync(path.join(client, 'tests/new-conversation.html'), 'utf8');
  html = html.slice(0, html.lastIndexOf('<script>')) + '</body></html>';
  html = html.replace('<head>', '<head><base href="' + pathToFileURL(path.join(client, 'tests') + path.sep).href + '">');
  html = html.replace('<script src="../components/panels/panels-chat.js">',
    '<script src="../components/panels/chat-work-cards.js"></script><script src="../components/panels/panels-chat.js">');
  const desk = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
  const styles = [...desk.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)]
    .map(match => fs.readFileSync(path.join(client, match[1]), 'utf8')).join('\n');
  html = html.replace('</head>', '<style>' + styles + '#out{display:none}</style></head>');
  const fixture = path.join(temp, 'fixture.html');
  fs.writeFileSync(fixture, html);
  win = new BrowserWindow({show:false, width:1200, height:800, webPreferences:{
    contextIsolation:true, nodeIntegration:false, offscreen:true, backgroundThrottling:false,
  }});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']}, (_request, done) => done({cancel:true}));
  win.webContents.on('console-message', event => {if (event.level === 'error') report.errors.push(event.message);});
  await win.loadFile(fixture);
  await js(`window.authScope='fixture-account'; SoduWorkAPI.taskStorageKey=()=>authScope;
    window.toasts=[]; window.petSay=value=>toasts.push(value); window.cardMode='allowed';
    soduWorkAPI.conversationSession.workCards=async id=>{
      if(cardMode==='held')return new Promise((_resolve,reject)=>window.rejectCards=reject);
      if(cardMode==='throws')throw Error('工作卡片连接中断');
      return cardMode==='denied'?{ok:false,reason:'这条会话属于另一个账号或服务，请切回原账号'}:{ok:true,cards:[]};
    };
    WorkspaceShell.mount();WorkspaceShell.setActive('create');openComposePanel({newSession:true});
    document.getElementById('composePanel').dataset.stage='chat';void 0;`);
  assert.equal(await js(`NativeChat.enter('', 'original-chat')`), true);
  await js(`const input=document.getElementById('nchatInput');input.value='保留在原会话的未发送修订';input.dispatchEvent(new Event('input',{bubbles:true}));cardMode='denied';void 0;`);
  assert.equal(await js(`NativeChat.enter('', 'original-chat')`), false);
  const failure = await js(`({loading:!!document.querySelector('.nchat-opening'),
    error:document.querySelector('.nbad.show')?.textContent,
    visible:document.querySelector('.nbad.show')?.getBoundingClientRect().height,
    errorTop:document.querySelector('.nbad.show')?.getBoundingClientRect().top,
    errorBottom:document.querySelector('.nbad.show')?.getBoundingClientRect().bottom,
    input:document.getElementById('nchatInput')?.value,opened:opened.length,sent:sent.length,
    detached:closed.includes('history:original-chat'),ref:NativeChat.sessionInfo().ref})`);
  assert.equal(failure.loading, false); assert.ok(failure.visible > 0);
  assert.ok(failure.errorTop >= 0 && failure.errorBottom <= 800, 'The persistent error must be inside the viewport');
  assert.match(failure.error, /请切回原账号/); assert.equal(failure.input, '保留在原会话的未发送修订');
  assert.equal(failure.ref, ''); assert.equal(failure.detached, true);
  assert.equal(await js('NativeChat.send()'), false);
  assert.deepEqual(await js('({opened:opened.length,sent:sent.length})'), {opened:failure.opened,sent:failure.sent});
  assert.equal(await js('document.getElementById("nchatInput").value'), failure.input);
  report.cases.push('Denied archive replaces spinner with visible owner error, detaches old handle, preserves draft and prevents accidental open/send.');
  await new Promise(resolve => setTimeout(resolve, 250));
  fs.writeFileSync(path.join(out,'blocked-conversation.png'), (await win.webContents.capturePage()).toPNG());
  await js(`cardMode='allowed';document.querySelector('[data-session-retry]')?.click();void 0;`);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await js('NativeChat.sessionInfo().sessionId'), 'original-chat');
  assert.ok(await js('Boolean(NativeChat.sessionInfo().ref)'));
  assert.equal(await js('Boolean(document.querySelector(".nbad.show"))'), false);
  report.cases.push('历史会话错误态的“重新打开会话”按钮会接回原会话并清除错误。');
  assert.equal(await js('opened.at(-1).chatId'), 'original-chat');
  assert.equal(await js('document.getElementById("nchatInput").value'), failure.input);
  assert.equal(await js('NativeChat.send()'), true);
  assert.deepEqual(await js('sent.at(-1)'), {ref:'history:original-chat',text:failure.input});
  report.cases.push('Explicitly reopening the same archive revalidates its identity, restores draft and sends only to its original native ref.');
  await js(`cardMode='throws';void 0;`);
  assert.equal(await js(`NativeChat.enter('', 'unreachable-chat')`), false);
  assert.equal(await js('Boolean(document.querySelector(".nchat-opening"))'), false);
  assert.match(await js('document.querySelector(".nbad.show").textContent'), /连接中断/);
  report.cases.push('Rejected work-card IPC also ends loading with a persistent error.');
  await js(`cardMode='held';window.oldOpen=NativeChat.enter('', 'old-chat');void 0;`);
  await js(`cardMode='allowed';void 0;`);
  assert.equal(await js(`NativeChat.enter('', 'current-chat')`), true);
  await js(`rejectCards(Error('old navigation failure'));void 0;`);
  assert.equal(await js('oldOpen'), false);
  assert.equal(await js('NativeChat.sessionInfo().sessionId'), 'current-chat');
  assert.equal(await js('Boolean(document.querySelector(".nbad.show"))'), false);
  report.cases.push('Late rejected restore cannot replace a subsequently opened conversation.');
  assert.deepEqual(report.errors, []); report.ok = true;
}).catch(error => {report.error = String(error.stack || error);}).finally(() => {
  fs.writeFileSync(path.join(out,'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); win?.destroy(); app.exit(report.ok ? 0 : 1);
});
