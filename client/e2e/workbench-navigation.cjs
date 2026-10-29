'use strict';
// Can run in the already-running client's main process without replacing any
// user renderer/session, or as a standalone Electron regression. Only a new
// owned test window and loopback HTTP server are created and then closed.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');

async function run(electron, options = {}) {
  const { BrowserWindow } = electron;
  const out = path.resolve(options.out || path.join(__dirname, '../../outputs/workbench-navigation'));
  fs.mkdirSync(out, { recursive: true });
  const report = { ok: false, cases: [], boundary: options.live
    ? 'Existing SoduWork process and production preload/IPC; owned test window with current renderer modules, loopback pages and synthetic tool events. Existing user conversations untouched; no model requests.'
    : 'Standalone Electron, production preload/IPC and current renderer modules; loopback pages and synthetic tool events, no user data or model requests.' };
  const requests = [], errors = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end('<!doctype html><meta charset="utf-8"><title>中文网页预览</title><style>body{font:16px system-ui;padding:48px;color:#25314a}h1{font-weight:500}</style><h1>中文网页预览</h1><p>已通过实际浏览器加载；保留路径编码与查询参数。</p>');
  });
  let win;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  const until = async (fn, label) => {
    for (let i = 0; i < 120; i++) { if (await fn()) return; await delay(50); }
    throw Error('Timed out: ' + label);
  };
  const click = async selector => {
    const point = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing click target');const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  };
  const key = keyCode => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  };
  const render = async tools => js(`ChatWorkbench.render(document.querySelector('#chat'),${JSON.stringify({
    status: 'streaming', messages: [{ role: 'user', text: '检查页面' }], tools,
  })},[]);void 0`);
  const tool = (command, result, id = 'check') => ({ id, name: 'bash', state: 'done', after: 0, args: { command }, result });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const original = base + '/SoduWork-' + encodeURIComponent('桌面网页演示') + '.html?q=' + encodeURIComponent('方案') + '&path=a%2Fb%3Fc%23d&literal=%25E4%25B8%25AD';
    win = new BrowserWindow({ show: false, width: 1440, height: 900,
      webPreferences: { preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false } });
    win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    await win.loadFile(path.join(__dirname, 'fixtures/output-preview.html'));
    win.showInactive();
    await js('window.previewMarkdown="网页预览回归：研究和验证过程不应自动导航。";configure([]);void 0');
    await render([tool('node browser.mjs text ' + base + '/research', 'Local: ' + base + '/research\nhttps://www.bing.com/news')]);
    await delay(180);
    assert.equal(await js('ChatWorkbench.state().open'), false);
    assert.equal(requests.length, 0);
    await render([tool('pnpm exec tsc --noEmit', 'at fn (file:///C:/AppData/Local/pnpm.mjs:24952:14)\nmain.py:35:5: local variable unused')]);
    assert.equal(await js('ChatWorkbench.state().count'), 0);
    report.cases.push('Browser research/checks and Local/source-coordinate logs create no tabs or network navigation.');

    await render([tool('npm run dev', 'Local: ' + original + '\nDocs https://vite.dev/', 'actual-listener')]);
    await until(() => js(`document.querySelector('[data-wb-address]')?.value.includes('桌面网页演示.html')`), 'Chinese address');
    const native = () => win.contentView.children.map(view => view.webContents).filter(Boolean).find(wc => !wc.isDestroyed() && wc.getURL().startsWith(base));
    await until(() => native()?.getTitle() === '中文网页预览', 'native browser loaded');
    assert.equal(native().getURL(), original);
    assert.equal(await native().executeJavaScript('document.querySelector("h1").textContent'), '中文网页预览');
    const shown = await js('document.querySelector("[data-wb-address]").value');
    assert.ok(shown.includes('桌面网页演示.html?q=方案&path=a%2Fb%3Fc%23d'));
    assert.ok(shown.includes('literal=%25E4%25B8%25AD'));
    assert.equal(await js('document.querySelector("[data-wb-address]").title'), shown);
    report.cases.push('Actual local listener opens the native browser; Chinese URL is readable, delimiters and double encodings stay intact.');

    await click('[data-wb-address]');
    await until(() => js('document.activeElement?.matches("[data-wb-address]")'), 'native input focus');
    key('Enter'); await delay(180);
    assert.equal(native().getURL(), original);
    const manual = base + '/手动查看.html?q=中文&path=x%2Fy';
    await click('[data-wb-address]');
    await until(() => js('document.activeElement?.matches("[data-wb-address]")'), 'edit focus');
    await js('document.querySelector("[data-wb-address]").select()');
    await win.webContents.insertText(manual);
    await until(() => js(`document.querySelector('[data-wb-address]')?.value === ${JSON.stringify(manual)}`), 'text inserted');
    key('Enter');
    await until(() => native()?.getURL() === new URL(manual).href, 'edited URL navigation');
    await until(() => js(`document.querySelector('[data-wb-address]')?.value === ${JSON.stringify(manual)}`), 'edited address presentation');
    assert.ok(requests.includes(new URL(manual).pathname + new URL(manual).search));
    report.cases.push('Native mouse/keyboard Enter retains an unchanged URL; editing Chinese address navigates to the correctly encoded destination.');

    await render([tool('node browser.mjs text ' + base + '/unexpected', 'Local: ' + base + '/unexpected', 'research-next')]);
    await delay(180);
    assert.equal(native().getURL(), new URL(manual).href);
    assert.equal(await js('document.querySelectorAll("[data-wb-tab]").length'), 1);
    assert.ok(!requests.some(url => url.startsWith('/unexpected')));
    await until(() => js(`document.querySelector('[data-wb-address]')?.value === ${JSON.stringify(manual)}`), 'address after background update');
    fs.writeFileSync(path.join(out, 'chinese-address.png'), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(out, 'native-page.png'), (await native().capturePage()).toPNG());
    await click('[data-wb-close]');
    await render([tool('npm run dev', 'Local: ' + base + '/new-service', 'next-listener')]);
    await delay(180);
    assert.equal(await js('ChatWorkbench.state().open'), false);
    assert.ok(!requests.some(url => url.startsWith('/new-service')));
    report.cases.push('Further research does not replace the chosen page; a manually hidden workbench stays closed when another service starts.');
    assert.deepEqual(await js('window.errors'), []);
    assert.deepEqual(errors, []);
    report.ok = true;
    return report;
  } catch (error) {
    report.error = String(error.stack || error);
    if (win && !win.isDestroyed()) report.failure = { requests,
      input: await js('({value:document.querySelector("[data-wb-address]")?.value,focused:document.activeElement?.tagName,state:ChatWorkbench.state()})'),
      urls: win.contentView.children.map(view => view.webContents?.getURL()) };
    throw error;
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  }
}
module.exports = { run };

if (require.main === module || process.versions.electron && path.resolve(process.argv[1] || '') === __filename) {
  const electron = require('electron');
  if (typeof electron === 'string') {
    const env = { ...process.env };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[key];
    const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill(), 45000);
    child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
  } else {
    electron.app.on('window-all-closed', () => {});
    electron.app.whenReady().then(async () => {
      require('../main/work-preview').install(electron);
      console.log(JSON.stringify(await run(electron)));
      electron.app.exit(0);
    }).catch(error => { console.error(error); electron.app.exit(1); });
  }
}
