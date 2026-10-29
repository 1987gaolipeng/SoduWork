'use strict';
// Full production conversation renderer with mouse/keyboard input. Only IPC is
// controlled so delayed replies can be reproduced without changing real chats.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[k];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), out = path.resolve(client, '../outputs/blocker-audit-20261001/send-boundary');
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-send-boundary-')));
  let win; const report = { ok: false, cases: [], errors: [] };
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) {
    for (let i = 0; i < 100; i++) { if (await js(code)) return; await delay(30); }
    throw Error('Timed out: ' + code);
  }
  async function click(selector) {
    const p = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.checkVisibility())throw Error('Unavailable '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...p, button: 'left', clickCount: 1 });
    await delay(50);
  }
  async function type(text) {
    await click('#nchatInput');
    await win.webContents.insertText(text);
  }
  async function enter(id) {
    assert.equal(await js(`NativeChat.enter('',${JSON.stringify(id)},{adapterId:'pi',projectId:${JSON.stringify('project-' + id)}})`), true);
    assert.equal(await js('NativeChat.sessionInfo().sessionId'), id);
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1100, height: 740, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', (_e, level, text) => { if (level >= 3) report.errors.push(text); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_r, cb) => cb({ cancel: true }));
    const source = path.join(__dirname, 'fixtures/workbench-annotations.html'), scripts = [];
    const html = fs.readFileSync(source, 'utf8').replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_, attrs, body) => {
      const src = attrs.match(/src=["']([^"']+)/); scripts.push(src ? fs.readFileSync(path.resolve(path.dirname(source), src[1]), 'utf8') : body); return '';
    });
    const fixture = path.join(out, 'fixture.html');
    fs.writeFileSync(fixture, html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="' + require('node:url').pathToFileURL(path.dirname(source) + path.sep).href + '">'));
    await win.loadFile(fixture);
    await js(`window.calls=[];window.replies=[];window.historyFor=id=>({status:'idle',messages:[{role:'assistant',blocks:[{kind:'text',text:'History '+id}]}],tools:[],usage:null,adapterId:'pi'});
      window.soduWorkAPI={conversationSession:{
        open:async options=>({ok:true,ref:'ref-'+options.chatId,sessionId:options.chatId,adapterId:'pi',displayName:'Pi',cwd:'C:/fixture',snapshot:historyFor(options.chatId)}),
        history:async()=>({ok:true,chats:[]}),outputs:async()=>({ok:true,items:[]}),release:async()=>({ok:true}),onEvent:()=>()=>{},
        send:(ref,text,files,options)=>new Promise((resolve,reject)=>{calls.push({ref,text,files,options});replies.push({resolve,reject});})
      }};void 0;`);
    for (const file of ['compose-candidate-navigation', 'chat-plugin-mention-model', 'chat-plugin-mention'])
      await js(fs.readFileSync(path.join(client, 'components/panels', file + '.js'), 'utf8') + '\nvoid 0;');
    for (const script of scripts) await js(script + '\nvoid 0;');
    for (const response of ['reject', 'not-ok']) {
      const a = 'a-' + response, b = 'b-' + response;
      await enter(a); await type('Original ' + a);
      const before = await js('calls.length'); await click('#nchatSend'); await until(`calls.length===${before + 1}`);
      assert.equal(await js('calls.at(-1).ref'), 'ref-' + a);
      await enter(b); await type('Unsent ' + b);
      await js(response === 'reject' ? `replies.shift().reject(Error('Original send failed'));void 0;` : `replies.shift().resolve({ok:false,reason:'Original send refused'});void 0;`);
      await delay(80);
      assert.equal(await js('document.querySelector("#nchatInput").value'), 'Unsent ' + b);
      assert.ok(await js(`document.querySelector('#nchatList').textContent.includes(${JSON.stringify('History ' + b)})`));
      assert.equal(await js('document.querySelector("#nchatList").textContent.includes("这一轮没发出去")'), false);
      await enter(a);
      assert.equal(await js('document.querySelector("#nchatInput").value'), 'Original ' + a);
      assert.ok(await js('document.querySelector("#nchatList").textContent.includes("这一轮没发出去")'));
      assert.equal(await js('calls.length'), before + 1, 'Returning does not resend without a click');
      await enter(b);
      assert.equal(await js('document.querySelector("#nchatInput").value'), 'Unsent ' + b);
      report.cases.push(response + ': delayed failure preserves B and restores A only on return');
    }
    await enter('success'); await type('First submitted text');
    await click('#nchatSend'); await until('replies.length===1');
    await type('New draft typed while sending');
    await js('replies.shift().resolve({ok:true});void 0;'); await delay(80);
    await enter('other'); await enter('success');
    assert.equal(await js('document.querySelector("#nchatInput").value'), 'New draft typed while sending');
    report.cases.push('Accepted send preserves text typed before its acknowledgement, including after navigation');
    await enter('scope'); await type('Old identity pending text'); await click('#nchatSend'); await until('replies.length===1');
    await js('dispatchEvent(new Event("soduwork-data-scope-changed"));void 0;');
    await enter('new-identity'); await type('New identity draft');
    await js('replies.shift().reject(Error("Old private error"));void 0;'); await delay(80);
    assert.equal(await js('document.querySelector("#nchatInput").value'), 'New identity draft');
    assert.equal(await js('document.body.textContent.includes("Old private error")'), false);
    assert.equal(await js('sessionStorage.getItem("soduwork.conversation-drafts.v1")?.includes("Old identity pending text")||false'), false);
    report.cases.push('Identity invalidation cannot receive private text or an error from a preceding send');
    assert.deepEqual(await js('errors'), []); assert.deepEqual(report.errors, []); report.ok = true;
  }).catch(error => { report.error = error.stack; }).finally(() => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); if (win) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
