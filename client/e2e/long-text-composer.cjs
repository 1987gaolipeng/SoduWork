'use strict';
// Production composer/attachment controller in isolated Chromium. Clipboard
// events are synthetic; clicks and inserted text use Chromium input dispatch.
// No user profile, system clipboard, live model or network request is used.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = path.resolve(root, '../outputs/long-text-composer-20261023');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-text-composer-'));
  const report = { ok: false, cases: [], layouts: [], errors: [] };
  let win;
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  app.setPath('userData', path.join(temporary, 'profile'));
  async function click(selector) {
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
    await delay(60);
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
      const p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
      if(!e.contains(document.elementFromPoint(p.x,p.y)))throw Error('Covered button');return p})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await delay(60);
  }
  async function measure(name, width, font = 14.5) {
    win.setContentSize(width, 600);
    await js(`document.documentElement.style.setProperty('--font-min-readable',${JSON.stringify(font + 'px')})`);
    await delay(90);
    const g = await js(`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
      const card=document.querySelector('.catt-text'),restore=card.querySelector('[data-catt-restore]'),remove=card.querySelector('[data-catt-remove]');
      return{card:rect(card),restore:rect(restore),remove:rect(remove),copy:rect(card.querySelector('.catt-copy')),viewport:innerWidth,
        overflow:document.documentElement.scrollWidth>innerWidth,heading:card.querySelector('b').textContent}})()`);
    assert.ok(g.card.left >= 0 && g.card.right <= width, 'Card stays in the viewport');
    assert.ok(g.restore.left >= g.card.left && g.restore.right <= g.remove.left, 'Restore and remove do not overlap');
    assert.ok(g.copy.right <= g.remove.left, 'Title and remove occupy separate columns');
    assert.ok(g.remove.right <= g.card.right && g.remove.top >= g.card.top, 'Remove is inside card');
    assert.equal(g.overflow, false);
    report.layouts.push({ name, ...g });
    fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  app.whenReady().then(async () => {
    fs.mkdirSync(out, { recursive: true });
    const css = ['theme/variables.css', 'components/panels/work-composer.css', 'components/panels/conversation-attachments.css'].map(read).join('\n');
    const fixture = path.join(temporary, 'fixture.html');
    fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><style>' + css +
      '</style><style>body{margin:0;background:var(--bg-0);font:15px system-ui}.fixture{width:min(850px,calc(100vw - 32px));margin:40px auto}</style><main class="fixture"></main>');
    win = new BrowserWindow({ show: false, width: 1000, height: 600,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_r, done) => done({ cancel: true }));
    win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
    await win.loadFile(fixture);
    for (const name of ['work-composer', 'conversation-attachments']) await js(read('components/panels/' + name + '.js') + '\nvoid 0;');
    await js(`document.querySelector('main').innerHTML=WorkComposer.html({inputId:'input',sendId:'send',placeholder:'输入你的需求',beforeInput:'<div class="catt-tray"></div>'});
      window.input=document.querySelector('#input');window.uploads=[];window.LibraryTransfer={trackFile:f=>uploads.push(f.name)};
      window.ctrl=ConversationAttachments.create({host:document.querySelector('.work-composer'),input,tray:document.querySelector('.catt-tray')});void 0;`);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    // The threshold crosses during actual Chromium text insertion, not only a paste handler.
    await js(`input.value='字'.repeat(1500);input.focus();input.setSelectionRange(1500,1500);void 0;`);
    await win.webContents.insertText('末'); await delay(70);
    assert.equal(await js(`input.value===''&&ctrl.submissionText('')==='字'.repeat(1500)+'末'`), true);
    report.cases.push('1501st typed character folds immediately and preserves the entire requirement');
    const text = '  SELECT <script>preserve as text</script>\n' + '完整原始需求，不能改写。'.repeat(200) + '\n  末尾原文  ';
    await js(`ctrl.clear();window.original=${JSON.stringify(text)};const dt=new DataTransfer();dt.setData('text/plain',original);
      input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,cancelable:true,bubbles:true}));void 0;`);
    assert.equal(await js(`input.value===''&&ctrl.submissionText('')===original`), true);
    assert.equal(await js(`document.querySelectorAll('.catt-text script').length`), 0);
    assert.equal(await js(`uploads.length`), 0);
    for (const [name, width, font] of [['wide', 1000, 14.5], ['narrow', 360, 14.5], ['large-font', 400, 18]]) await measure(name, width, font);
    await js(`document.documentElement.setAttribute('data-theme','warm');void 0;`);
    await measure('warm-theme', 700);
    report.cases.push('long clipboard text creates an escaped, removable card with no unsent library upload');
    await click('[data-catt-restore]');
    assert.equal(await js(`input.value===original&&!ctrl.has()&&document.activeElement===input`), true);
    assert.equal(await js(`Math.abs(input.getBoundingClientRect().height-Math.min(624,innerHeight*.4))<1&&input.scrollHeight>input.clientHeight+1&&getComputedStyle(input).overflowY==='auto'`), true);
    await win.webContents.insertText('追加'); await delay(60);
    assert.equal(await js(`input.value===original+'追加'&&!ctrl.has()`), true);
    report.cases.push('restore uses a real click, returns focus and allows expanded editing without refolding');
    await js(`input.value='';input.dispatchEvent(new Event('input'));input.value=original;input.dispatchEvent(new Event('input'));void 0;`);
    await click('[data-catt-remove]');
    assert.equal(await js(`!ctrl.has()&&ctrl.submissionText(input.value)===''`), true);
    report.cases.push('remove discards the folded request and emptying input resets the auto-fold behavior');
    assert.deepEqual(report.errors, []);
    report.ok = true;
  }).catch(error => { report.error = error.stack; process.exitCode = 1; }).finally(() => {
    fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
