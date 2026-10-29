'use strict';

const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-message-follow-up-'));
  const fixture = path.join(temporary, 'fixture.html');
  const preload = path.join(temporary, 'preload.cjs');
  const report = { ok: false, cases: [], errors: [] };
  let win;

  fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><main id="app"></main>');
  fs.writeFileSync(preload, "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('soduWorkAPI',{readAttachmentBinary:p=>ipcRenderer.invoke('read',p)});");
  const read = file => fs.readFileSync(path.join(client, file), 'utf8');
  const js = code => win.webContents.executeJavaScript(code, true);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) {
    for (let index = 0; index < 120; index += 1) { if (await js(code)) return; await wait(25); }
    throw Error('Timed out: ' + code);
  }
  async function click(selector) {
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing enabled action');const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
    await wait(50);
  }

  app.setPath('userData', path.join(temporary, 'profile'));
  ipcMain.handle('read', (_event, payload) => {
    assert.equal(payload.filename, 'report.txt');
    assert.match(payload.url, /attachment-1/);
    return { ok: true, name: 'report.txt', mimeType: 'text/plain', size: 3, data: 'YWJj' };
  });

  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
    win.webContents.on('console-message', (_event, level, text) => { if (level >= 3) report.errors.push(text); });
    await win.loadFile(fixture);
    await js(`window.toasts=[];window.handoffs=[];window.readCount=0;window.readFailure=false;window.scope='scope-1';window.messageId='message-1';
      window.petSay=message=>toasts.push(message);window.esc=value=>String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
      window._nkIcon=()=>'';window.WorkspaceHost={open:(view,payload)=>{handoffs.push({view,payload});return true;}};
      window.SoduWorkAPI={taskStorageKey:kind=>scope+':'+kind,mateMessages:async folder=>({ok:true,items:[{id:messageId,messageId,senderId:'sender',recipientId:'recipient',senderName:'Colleague',recipientName:'Recipient',text:'Please improve this result',status:folder==='sent'?'accepted':'delivered',createdAt:Date.now(),attachments:messageId==='message-3'?[]:[{id:'attachment-1',name:'report.txt',size:3}]}]}),
        mateMessageFile:async id=>({id,filename:'report.txt',contentType:'text/plain',url:'/api/v1/attachments/attachment-1?ticket=validticket123456'}),attachmentUrl:row=>'https://hub.test'+row.url,
        markMateMessageRead:async()=>{readCount+=1;if(readFailure)throw Error('isolated read acknowledgement failed');return {ok:true,status:'read',readAt:Date.now(),deliveredAt:Date.now()}}};
      window._taskStorageKey=kind=>SoduWorkAPI.taskStorageKey(kind);window.LS_KEY=()=>_taskStorageKey('tasks');void 0;`);
    const store = read('core/store.js');
    await js(store.slice(store.indexOf('const LS_NOTICES='), store.indexOf('function _nextRecurAt(')) + '\nvoid 0;');
    await js(read('core/mate-notice-sync.js') + '\nvoid 0;');
    await js(read('components/panels/message-follow-up.js') + '\nvoid 0;');
    await js(read('components/panels/panels-desk.js') + '\nvoid 0;');
    await js('openNoticePanel();void 0;');
    await until("!!document.querySelector('.np-chat-clip')");
    assert.equal(await js("!!document.querySelector('.np-message-meta .np-chat-clip')"), true);
    assert.equal(await js("document.querySelector('.np-chat-clip').getAttribute('aria-label')"), '\u57fa\u4e8e\u6b64\u7ee7\u7eed');
    await js("document.querySelector('.np-chat-clip').click();void 0;");
    await until('handoffs.length===1 && readCount===1');
    const handoff = await js('handoffs[0].payload');
    assert.equal(await js('handoffs[0].view'), 'create');
    assert.equal(handoff.newSession, true);
    assert.equal(handoff.source, 'mate-message-follow-up');
    assert.match(handoff.prefill, /Please improve this result/);
    assert.equal(handoff.initialFiles.length, 1);
    assert.equal(await js('handoffs[0].payload.initialFiles[0].text()'), 'abc');
    assert.equal('conversationId' in handoff, false);
    assert.equal('chatId' in handoff, false);
    assert.equal('send' in handoff, false);
    assert.equal(await js('noticeUnread()'), 0);
    report.cases.push('Received message action opens a new session with text and imported bytes, marks read, and never sends or carries conversation identity');
    await js("messageId='message-2';readFailure=true;MateNoticeSync.refresh('received');");
    await js("document.querySelector('[data-server-message=message-2] .np-chat-clip').click();void 0;");
    await until('handoffs.length===2 && readCount===2');
    await until("document.body.innerText.includes('isolated read acknowledgement failed')");
    assert.equal(await js('noticeUnread()'), 1);
    await js("readFailure=false;document.querySelector('[data-server-message=message-2] .np-chat-clip').click();void 0;");
    await until('handoffs.length===3 && readCount===3 && noticeUnread()===0');
    report.cases.push('Failed follow-up read acknowledgement preserves the real notice store and error; retry confirms read');
    await js("window.acceptFollowUp=WorkspaceHost.open;WorkspaceHost.open=()=>false;document.querySelector('.np-chat-clip').click();void 0;");
    await until('toasts.length>0');
    assert.equal(await js('readCount'), 3);
    await js('WorkspaceHost.open=acceptFollowUp;void 0;');
    report.cases.push('A rejected new conversation never consumes or acknowledges its source notice');
    await js("scope='scope-2';document.querySelector('.np-chat-clip').click();void 0;");
    await wait(100);
    assert.equal(await js('handoffs.length'), 3);
    assert.equal(await js('readCount'), 3);
    report.cases.push('A stale button cannot carry the previous account message into a new account scope');
    await js("scope='scope-1';void 0;");
    await js("messageId='message-3';MateNoticeSync.refresh('received');");
    await until("!!document.querySelector('[data-server-message=message-3]')");
    assert.equal(await js("!!document.querySelector('[data-server-message=message-3] .np-chat-clip')"), false);
    assert.equal(await js("!!document.querySelector('[data-server-message=message-1] .np-chat-clip')"), true);
    report.cases.push('Text-only colleague messages no longer expose the follow-up entry');
    await js("messageId='message-2';MateNoticeSync.refresh('received');");
    await until("!!document.querySelector('.np-chat-clip')");
    await click('[data-notice-folder="sent"]');
    await until("document.querySelector('[data-notice-folder=sent].is-active')");
    assert.equal(await js("!!document.querySelector('.np-chat-clip')"), false);
    report.cases.push('Sent messages do not expose the received-message follow-up action');
    assert.deepEqual(report.errors, []);
    report.ok = true;
  }).catch(async error => {
    report.error = String(error.stack || error);
    if (win && !win.isDestroyed()) report.state = await js('({handoffs,readCount,notices,button:document.querySelector(\'.np-chat-clip\')?.outerHTML||\'\',body:document.body.innerText})').catch(() => ({}));
  }).finally(() => {
    console.log(JSON.stringify(report));
    win?.destroy();
    app.exit(report.ok ? 0 : 1);
  });
}
