'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 45000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { pathToFileURL } = require('node:url');
  const assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), out = path.resolve(client, '../outputs/task-picker-streaming');
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-picker-stream-')));
  app.on('window-all-closed', () => {});
  const report = { ok: false, cases: [], boundary: 'Production NativeChat, renderer, collaboration and preload in Electron; controlled streaming and task IPC fixtures, no live task dispatch or model call.' };
  const snapshot = { status: 'streaming', messages: [{ role: 'user', text: '继续处理当前工作' },
    { role: 'assistant', done: false, blocks: [{ kind: 'text', text: '正在处理' }] }], tools: [],
    execution: { running: true, elapsedMs: 0, turnQueue: { tasks: [] } } };
  let win, ticker;
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(check, label) {
    for (let i = 0; i < 160; i++) { if (await check()) return; await delay(25); }
    throw Error('Timed out: ' + label);
  }
  async function click(selector, hold = 140, whileHeld) {
    const point = await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Unavailable control');const r=n.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);if(!n.contains(document.elementFromPoint(x,y)))throw Error('Occluded control');return{x,y}})()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    if (whileHeld) { await delay(25); await whileHeld(); }
    await delay(hold);
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await delay(30);
  }
  app.whenReady().then(async () => {
    try {
      ipcMain.handle('pi-session-open', () => ({ ok: true, ref: 'picker-stream', sessionId: 'picker-stream', adapterId: 'pi', snapshot }));
      ipcMain.handle('pi-session-snapshot', () => ({ ok: true, snapshot }));
      for (const [channel, value] of Object.entries({ 'pi-session-history': { ok: true, chats: [] },
        'pi-session-outputs': { ok: true, items: [] }, 'pi-session-release': { ok: true },
        'pi-session-runtime-models': { ok: true, items: [] }, 'work-preview-hide': { ok: true },
        'work-preview-destroy': { ok: true } })) ipcMain.handle(channel, () => value);
      win = new BrowserWindow({ show: false, width: 1200, height: 850,
        webPreferences: { preload: path.join(client, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
      const fixture = path.join(__dirname, 'fixtures/workbench-annotations.html'), scripts = [];
      let html = fs.readFileSync(fixture, 'utf8').replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_, attrs, body) => {
        const src = attrs.match(/src=["']([^"']+)/);
        scripts.push(src ? fs.readFileSync(path.resolve(path.dirname(fixture), src[1]), 'utf8') : body); return '';
      });
      html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="' + pathToFileURL(path.dirname(fixture) + path.sep).href + '"><link rel="stylesheet" href="../../components/panels/chat-collaboration.css">');
      const page = path.join(out, 'native-chat.html'); fs.writeFileSync(page, html);
      await win.loadFile(page); win.showInactive();
      for (const file of ['core/i18n-dom.js', 'core/i18n.js', 'components/panels/compose-candidate-navigation.js',
        'components/panels/chat-plugin-mention-model.js', 'components/panels/chat-plugin-mention.js'])
        await js(fs.readFileSync(path.join(client, file), 'utf8') + '\n;void 0;');
      for (const source of scripts) await js(source + '\n;void 0;');
      await js(fs.readFileSync(path.join(client, 'components/panels/chat-collaboration.js'), 'utf8'));
      await js(`window.taskCalls=0;window.releaseTasks=null;window.taskDelay=true;
        SoduWorkAPI.getTasksSnapshot=()=>{taskCalls++;return taskDelay?new Promise(resolve=>releaseTasks=resolve):Promise.resolve({online:true,items:[{id:'todo-one',title:'检查交付结果',status:'todo'}]})};
        NativeChat.enter('', 'picker-stream', {adapterId:'pi'});void 0`);
      await until(() => js('NativeChat.sessionInfo().ref === "picker-stream"'), 'conversation opened');
      let seq = 0;
      ticker = setInterval(() => {
        snapshot.messages[1].blocks[0].text = '正在处理当前工作，输出更新 ' + ++seq;
        win.webContents.send('pi-session-event', { ref: 'picker-stream', kind: 'block', snapshot });
      }, 35);
      await delay(200);
      await js('window.messageNode=document.querySelector("[data-chat-node=\\"message:1\\"]")');
      await click('[data-queue-action="add"]');
      await until(() => js('!!document.querySelector(".ncollab-picker")'), 'picker opens during streaming');
      assert.equal(await js('document.querySelector(".ncollab-picker").textContent.includes("正在读取待办需求")'), true);
      // Repeated entry events must not restart the request while it is loading.
      await js('document.querySelector("[data-queue-action=add]").click();document.querySelector("[data-queue-action=add]").click()');
      assert.equal(await js('taskCalls'), 1);
      await click('[data-collab-picker-close]', 250);
      await until(() => js('!document.querySelector(".ncollab-picker")'), 'loading close');
      await js('releaseTasks({online:true,items:[{id:"late",title:"迟到需求",status:"todo"}]})');
      await delay(180);
      assert.equal(await js('!!document.querySelector(".ncollab-picker")'), false);
      report.cases.push('Streaming opens the loading panel immediately; repeated entry shares one request; close ignores the late response.');

      await click('[data-queue-action="add"]');
      await until(() => js('!!document.querySelector(".ncollab-picker")'), 'loading race open');
      await delay(180); // Let the existing 160ms reveal animation finish before measuring layout.
      await js('window.pressedClose=document.querySelector("[data-collab-picker-close]");window.pressedRect=pressedClose.getBoundingClientRect().toJSON()');
      await click('[data-collab-picker-close]', 250, async () => {
        await js('releaseTasks({online:true,items:[]})');
        await delay(60);
        assert.equal(await js('pressedClose===document.querySelector("[data-collab-picker-close]")'), true);
        assert.deepEqual(await js('pressedClose.getBoundingClientRect().toJSON()'), await js('pressedRect'));
      });
      await until(() => js('!document.querySelector(".ncollab-picker")'), 'close survives a list response between mouse down/up');
      report.cases.push('A list response during a held close click cannot replace or move the clicked control.');

      await js('taskDelay=false');
      await click('[data-queue-action="add"]');
      await until(() => js('!!document.querySelector("[data-collab-task-select=todo-one]")'), 'loaded tasks');
      await click('[data-collab-search]');
      await js('window.searchNode=document.querySelector("[data-collab-search]");window.closeNode=document.querySelector("[data-collab-picker-close]")');
      await win.webContents.insertText('交付');
      await delay(450);
      assert.deepEqual(await js('({same:searchNode===document.querySelector("[data-collab-search]"),focused:document.activeElement===searchNode,value:searchNode.value,close:closeNode===document.querySelector("[data-collab-picker-close]")})'),
        { same: true, focused: true, value: '交付', close: true });
      assert.equal(await js('messageNode===document.querySelector("[data-chat-node=\\"message:1\\"]")'), true);
      await click('[data-collab-task-select="todo-one"]', 220);
      assert.equal(await js('document.querySelector("[data-collab-task-select=todo-one]").getAttribute("aria-checked")'), 'true');
      assert.equal(await js('document.querySelector("[data-collab-picker-submit]").disabled'), false);
      await click('[data-collab-picker-close]', 250);
      await until(() => js('!document.querySelector(".ncollab-picker")'), 'loaded close');
      report.cases.push('Search and close controls retain their DOM/focus during token updates; slow mouse clicks select and close on the first attempt; transcript fast path stays active.');

      for (let i = 0; i < 4; i++) {
        await click('[data-queue-action="add"]');
        await until(() => js('!!document.querySelector("[data-collab-picker-close]")'), 'repeat open');
        await click('[data-collab-picker-close]', 180);
        await until(() => js('!document.querySelector(".ncollab-picker")'), 'repeat close');
      }
      await click('[data-queue-action="add"]');
      await until(() => js('!!document.querySelector(".ncollab-picker")'), 'escape open');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await until(() => js('!document.querySelector(".ncollab-picker")'), 'escape close');
      await click('#nchatInput'); await win.webContents.insertText('保留正在输入的草稿');
      await delay(200);
      assert.equal(await js('document.querySelector("#nchatInput").value'), '保留正在输入的草稿');
      assert.deepEqual(await js('window.errors'), []);
      report.cases.push('Repeated open/close, Escape and ordinary draft input work throughout streaming; no task is dispatched.');
      report.ok = true;
    } catch (error) {
      report.error = String(error.stack || error); console.error(report.error);
    } finally {
      clearInterval(ticker);
      fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
      if (win && !win.isDestroyed()) {
        try { fs.writeFileSync(path.join(out, 'final.png'), (await win.webContents.capturePage()).toPNG()); } catch (_) {}
        win.destroy();
      }
      console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
    }
  });
}
