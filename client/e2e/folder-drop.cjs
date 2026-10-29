'use strict';
// Chromium drag data contains real filesystem File objects. The production
// attachment component/preload and runtime staging are used; no model is called.
const fs = require('node:fs'), path = require('node:path'), electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 45000);
  child.once('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = electron;
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), baseline = process.argv.includes('--baseline');
  const output = path.resolve(client, '../outputs/folder-drop-20261014');
  fs.mkdirSync(output, { recursive: true }); fs.mkdirSync('D:/SoduWorkTests', { recursive: true });
  const root = fs.mkdtempSync('D:/SoduWorkTests/folder-drop-electron-');
  const cwd = path.join(root, 'session'), folder = path.join(root, 'work'), empty = path.join(root, '空文件夹');
  for (const dir of [cwd, folder, empty]) fs.mkdirSync(dir);
  const original = 'Original input, untouched';
  fs.writeFileSync(path.join(folder, 'input.txt'), original);
  const ordinary = path.join(root, 'brief.txt'); fs.writeFileSync(ordinary, 'ordinary input');
  app.setPath('userData', path.join(root, 'profile'));
  const report = { ok: false, baseline, checks: [], scope: 'CDP filesystem drag, production component/preload/staging; no Explorer pointer drag or model execution' };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let win;
  app.whenReady().then(async () => {
    try {
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, reply) => reply({ cancel: true }));
      const component = path.join(client, 'components/panels/conversation-attachments.js');
      let sourcePath = component;
      if (baseline) {
        sourcePath = path.join(root, 'baseline.js');
        fs.writeFileSync(sourcePath, require('node:child_process').execFileSync('git',
          ['show', 'HEAD:client/components/panels/conversation-attachments.js'], { cwd: client, windowsHide: true }));
      }
      const fixture = path.join(root, 'fixture.html');
      fs.writeFileSync(fixture, `<!doctype html><meta charset="utf-8">
        <link rel="stylesheet" href="${pathToFileURL(path.join(client, 'components/panels/conversation-attachments.css')).href}">
        <style>.host{padding:20px;border:1px solid #ccc;margin:15px;min-height:160px}textarea{width:80%;height:60px}</style>
        <div id="initial" class="host"><textarea></textarea><input type="file" hidden><button>添加</button><div class="tray catt-tray"></div></div>
        <div id="followup" class="host"><textarea></textarea><input type="file" hidden><button>添加</button><div class="tray catt-tray"></div></div>
        <script src="${pathToFileURL(sourcePath).href}"></script><script>
          window.warnings=[];window.pickers={};window.drops={};window.errors=[];
          addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
          for(const id of ['initial','followup']){const host=document.getElementById(id);
            host.addEventListener('drop',e=>{drops[id]={files:[...e.dataTransfer.files],entries:[...e.dataTransfer.items].map(item=>({name:item.getAsFile()?.name,directory:item.webkitGetAsEntry()?.isDirectory}))}});
            pickers[id]=ConversationAttachments.create({host,input:host.querySelector('textarea'),button:host.querySelector('button'),
              fileInput:host.querySelector('input'),tray:host.querySelector('.tray'),say:m=>warnings.push(m)});
          }
        </script>`);
      win = new BrowserWindow({ show: false, width: 1100, height: 850,
        webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false,
          preload: path.join(client, 'preload.js') } });
      await win.loadFile(fixture); win.webContents.debugger.attach('1.3');
      const js = code => win.webContents.executeJavaScript(code, true);
      async function drop(id, files) {
        const point = await js(`(()=>{const b=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return{x:b.x+40,y:b.y+40}})()`);
        const data = { items: [], files, dragOperationsMask: 1 };
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
        for (const type of ['dragEnter', 'dragOver', 'drop']) await win.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type, ...point, data });
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...point });
        await delay(120);
        return js(`({entries:drops[${JSON.stringify(id)}]?.entries,names:pickers[${JSON.stringify(id)}].names(),warnings,errors})`);
      }
      const first = await drop('initial', [folder]); report.first = first;
      assert.equal(first.entries[0].directory, true, 'Chromium recognizes the dragged filesystem directory');
      if (baseline) {
        assert.equal(first.names.length, 0);
        assert.match(first.warnings[0], /企业微信临时缓存/);
        report.checks.push('unmodified HEAD reproduces rejection of a real directory as expired WeCom cache');
      } else {
        assert.deepEqual(first.names, ['work']); assert.deepEqual(first.warnings, []);
        assert.equal(await js('pickers.initial.files()[0]===drops.initial.files[0]'), true);
        const refs = await js('pickers.initial.refs(soduWorkAPI.conversationSession)');
        assert.equal(path.resolve(refs[0].path), folder);
        const runtime = require('../main/pi-session/attachments');
        const staged = await runtime.stage(cwd, refs);
        assert.equal(staged.files[0].kind, 'dir'); assert.equal(staged.files[0].path, folder);
        assert.match(runtime.prompt(staged.files), /直接列目录/);
        assert.equal(fs.existsSync(path.join(cwd, '.soduwork-inputs')), false);
        assert.equal(fs.readFileSync(path.join(folder, 'input.txt'), 'utf8'), original);
        report.checks.push('initial composer retains the directory File and native path; staging references without copying');
        await js('pickers.followup.add(pickers.initial.files(),"retry");void 0;'); await delay(100);
        assert.deepEqual(await js('pickers.followup.names()'), ['work']);
        assert.equal(await js('pickers.followup.files()[0]===drops.initial.files[0]'), true);
        await js('pickers.followup.clear();void 0;');
        report.checks.push('failed-send restoration in another composer retains the same directory classification');
        const mixed = await drop('followup', [empty, ordinary]); report.mixed = mixed;
        assert.deepEqual(mixed.names, ['空文件夹', 'brief.txt']); assert.deepEqual(mixed.warnings, []);
        assert.equal(await js('pickers.followup.files()[0]===drops.followup.files[0]'), true);
        assert.equal(await js('pickers.followup.files()[1]===drops.followup.files[1]'), false);
        const next = await js('pickers.followup.refs(soduWorkAPI.conversationSession)');
        assert.equal(path.resolve(next[0].path), empty);
        assert.equal(Buffer.from(next[1].data).toString(), 'ordinary input');
        const nextStaged = await runtime.stage(cwd, next);
        assert.equal(nextStaged.files.length, 2); assert.equal(nextStaged.warnings.length, 0);
        assert.equal(nextStaged.files[0].kind, 'dir');
        report.checks.push('follow-up composer accepts an empty Unicode directory mixed with an ordinary cached file');
      }
      assert.deepEqual(await js('errors'), []);
      report.ok = true;
    } catch (error) { report.error = String(error.stack || error); console.error(error); }
    fs.writeFileSync(path.join(output, baseline ? 'baseline.json' : 'fixed.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, baseline, checks: report.checks }));
    app.exit(report.ok ? 0 : 1);
  });
}
