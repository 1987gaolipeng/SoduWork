'use strict';
// Real Chromium CSS and hit testing, isolated from the user's running client.
// This verifies DOM geometry/cursor semantics; it is not a native mouse test.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: 'inherit',
  }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict');
  const baseline = process.argv.includes('--baseline');
  const report = { ok: false, baseline, isolated: true, nativeMouseVerified: false, geometry: [] };
  const output = path.resolve(__dirname, '../../outputs/client-freeze-20261013/pointer-' + (baseline ? 'baseline' : 'fixed') + '.json');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-pointer-')));
  let win;
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1000, height: 700, skipTaskbar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await win.loadFile(path.join(__dirname, 'fixtures/pointer-stability.html'));
    const js = source => win.webContents.executeJavaScript(source);
    if (baseline) {
      const css = require('node:child_process').execFileSync('git', ['show', 'HEAD:client/components/workspace/workspace-shell.css'], {
        cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', windowsHide: true,
      });
      await js(`document.querySelector('link[href*="workspace-shell.css"]').disabled=true;
        {const s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s)};void 0;`);
    }
    win.webContents.debugger.attach('1.3');
    const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
    await cdp('DOM.enable'); await cdp('CSS.enable');
    const { root } = await cdp('DOM.getDocument');
    for (const id of ['rail-button', 'rail-update', 'rail-account', 'send']) {
      const selector = '#' + id;
      const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector });
      const measure = () => js(`(() => {const el=document.querySelector(${JSON.stringify(selector)});
        const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
      const before = await measure();
      await cdp('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
      await new Promise(resolve => setTimeout(resolve, 220));
      const hover = await measure();
      report.geometry.push({ id, before, hover, stable: JSON.stringify(before) === JSON.stringify(hover) });
      await cdp('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
      await new Promise(resolve => setTimeout(resolve, 220));
    }
    report.cursor = await js(`(() => {
      const result={};
      for(const id of ['rail-button','rail-update','rail-account','send','text','draft']) {
        const el=document.getElementById(id),r=el.getBoundingClientRect();
        const samples=[];
        for(let x=r.left+4;x<r.right-4;x+=2) {
          const hit=document.elementFromPoint(x,r.top+r.height/2);
          samples.push({cursor:getComputedStyle(hit).cursor,within:hit===el||el.contains(hit)});
        }
        result[id]={samples:samples.length,cursors:[...new Set(samples.map(p=>p.cursor))],within:samples.every(p=>p.within),
          descendants:[...el.querySelectorAll('*')].map(child=>getComputedStyle(child).cursor)};
      }
      const input=document.getElementById('draft');input.focus();input.setSelectionRange(2,7);
      result.input={focused:document.activeElement===input,value:input.value,start:input.selectionStart,end:input.selectionEnd};
      input.blur();
      const range=document.createRange();range.selectNodeContents(document.getElementById('text'));
      window.getSelection().removeAllRanges();window.getSelection().addRange(range);
      result.selectedText=window.getSelection().toString();return result;
    })()`);
    if (!baseline) for (const item of report.geometry) assert.equal(item.stable, true, item.id + ' hover preserves hit region');
    for (const id of ['rail-button', 'rail-update', 'rail-account', 'send', 'text', 'draft']) {
      const expected = id === 'text' || id === 'draft' ? 'text' : 'pointer';
      const row = report.cursor[id];
      assert.ok(row.samples > 0); assert.equal(row.within, true, id + ' has no hit-test holes');
      assert.deepEqual(row.cursors, [expected], id + ' horizontal cursor semantics');
      assert.ok(row.descendants.every(cursor => cursor === expected), id + ' child cursor inheritance');
    }
    assert.deepEqual(report.cursor.input, { focused: true, value: 'Unsent draft', start: 2, end: 7 });
    assert.match(report.cursor.selectedText, /Selectable answer.*inline code/);
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); }).finally(() => {
    if (win && !win.isDestroyed()) win.destroy();
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  });
}
