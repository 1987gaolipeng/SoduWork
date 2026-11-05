'use strict';
// Production composer/renderer/workbench + real preload/IPC. Only isolated tool receipts are synthetic.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const output = path.resolve(__dirname, '../../outputs/performance-20261016/tool-details');
  const report = { ok: false, productionPreload: true, productionIpc: true, productionRenderer: true,
    productionComposer: true, productionWorkbench: true, liveAccount: false, cases: [] };
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-tool-details-')));
  app.disableHardwareAcceleration();
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let win;
  app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive: true });
    const calls = [], receipts = new Map(), delayIds = new Set(); let fail = true;
    const body = Array.from({ length: 1100 }, (_, i) => '// ' + i + ' ' + 'file body '.repeat(10)).join('\n') + '\nconst FINAL_MARKER = 42;\n';
    const tools = [
      { id: 'write', name: 'write', args: { path: 'complete.js', content: body }, result: 'done' },
      { id: 'edit', name: 'edit', args: { path: 'changed.js', oldText: body, newText: body.replace('FINAL_MARKER = 42', 'FINAL_MARKER = 43') }, result: 'done' },
      { id: 'read', name: 'read', args: { path: 'readonly.js' }, result: body },
      { id: 'generic', name: 'inspect_data', args: { query: 'q' }, result: 'details\n'.repeat(2000) + 'ORIGINAL COMPLETE RESULT' },
      { id: 'retry', name: 'inspect_data', args: {}, result: 'retry detail\n'.repeat(2000) },
      { id: 'slow', name: 'read', args: { path: 'slow.js' }, result: body },
    ].map((tool, i) => ({ ...tool, state: 'done', after: 75 + i }));
    tools.forEach(tool => receipts.set(tool.id, tool));
    receipts.set('ipc-large', { id: 'ipc-large', name: 'write', args: { path: 'large.js', content: 'x'.repeat(512 * 1024) }, state: 'done' });
    const handle = { attachedWindow: null, async toolDetail(id) {
      calls.push(id);
      if (delayIds.has(id)) await pause(250);
      if (id === 'retry' && fail) throw Error('isolated detail read failure');
      return receipts.get(id);
    } };
    require('../main/pi-session/tool-detail-ipc').install({ ipcMain, BrowserWindow,
      session: { get: ref => ref === 'detail-fixture' ? handle : null } });
    win = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: {
      preload: path.join(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    handle.attachedWindow = win;
    await win.loadFile(path.join(__dirname, 'fixtures/tool-details-lazy.html'));
    const js = code => win.webContents.executeJavaScript(code);
    async function until(code) { for (let i = 0; i < 100; i++) { if (await js(code)) return; await pause(40); } throw Error('Timed out: ' + code); }
    async function click(selector) {
      // Browsing an older row must express real user scroll intent. A plain
      // scrollIntoView does not pause follow-latest, so an asynchronous
      // workbench resize can legitimately move that row out of the viewport.
      const browse = await js('(()=>{const el=document.querySelector(' + JSON.stringify(selector) + '),box=el?.closest("#nchatScroll");' +
        'if(!box)return null;const r=el.getBoundingClientRect(),b=box.getBoundingClientRect();' +
        'return r.top<b.top?{x:Math.round(b.left+Math.min(60,b.width/4)),y:Math.round(b.top+Math.min(120,b.height/4))}:null;})()');
      if (browse) {
        win.webContents.focus();
        if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseWheel', ...browse, deltaY: -120, deltaX: 0,
        });
        await until('document.querySelector("#nchatScroll").getAttribute("data-scroll-follow")==="paused"');
      }
      await js('document.querySelector(' + JSON.stringify(selector) + ')?.scrollIntoView({block:"center",behavior:"instant"})');
      // Native mouse input uses the composed frame, which can lag DOM geometry in a hidden window.
      await pause(100);
      let point;
      for (let attempt = 0; attempt < 100; attempt++) {
        point = await js('(()=>{const el=document.querySelector(' + JSON.stringify(selector) + ');if(!el)throw Error("missing click target");' +
          'const r=el.getBoundingClientRect();' +
          'const p={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};' +
          'return r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&' +
          'el.contains(document.elementFromPoint(p.x,p.y))?p:null;})()');
        if (point) break;
        await pause(20);
      }
      assert.ok(point, 'Click target must be visible and hit-testable: ' + selector);
      win.webContents.focus();
      win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(35);
    }
    const project = require('../main/pi-session/tool-detail').project;
    const snapshot = { status: 'streaming', tools: tools.map(project), messages: Array.from({ length: 82 }, (_, i) => i % 2 ?
      { role: 'assistant', blocks: [{ index: 0, kind: 'text', text: 'Stable paragraph ' + i }] } : { role: 'user', text: 'Question ' + i }) };
    await js('showSnapshot(' + JSON.stringify(snapshot) + ')');
    assert.deepEqual(await js('({highlight:metrics.highlight,diff:metrics.diff})'), { highlight: 0, diff: 0 });
    assert.equal(calls.length, 0);
    report.cases.push('80-message history and folded recent file cards do not request receipts or compute highlight/Diff');
    const ipcBytes = await js('(async()=>{const reply=await soduWorkAPI.conversationSession.toolDetail("detail-fixture","ipc-large");return reply.tool.args.content.length})()');
    assert.equal(ipcBytes, 512 * 1024); report.ipcReceiptBytes = ipcBytes;
    await click('[data-tool="write"]');
    await until('document.querySelector(".CodeMirror")?.CodeMirror.getValue().endsWith("const FINAL_MARKER = 42;\\n")');
    assert.equal(await js('document.querySelector(".CodeMirror").CodeMirror.getValue().length'), body.length);
    assert.equal(await js('Boolean(document.querySelector(".ntool-drawer"))'), false);
    assert.equal(calls.filter(id => id === 'write').length, 1);
    await click('[data-tool="write"]'); assert.equal(calls.filter(id => id === 'write').length, 1);
    report.cases.push('real file click fetches the complete receipt once and opens complete 120KB code in the right CodeMirror workbench');
    await click('[data-tool="edit"]');
    await until('document.querySelector(".ncw-diff-body")?.textContent.includes("FINAL_MARKER = 43")');
    assert.equal(await js('Boolean(document.querySelector(".ncw-diff-body .d2h-ins"))'), true);
    report.cases.push('edit file click opens the production right-side Diff with additions and deletions');
    await click('[data-tool="read"]');
    await until('document.querySelector(".CodeMirror")?.CodeMirror.getValue().length===' + body.length);
    assert.equal(await js('Boolean(document.querySelector("[data-read-snapshot]"))'), true);
    report.cases.push('read file opens the complete readonly recorded content in the same right-side workbench');
    await click('[data-tool="generic"]');
    await until('document.querySelector("[data-tool-node=generic] .ntool-body")?.textContent.includes("details")');
    assert.equal(calls.filter(id => id === 'generic').length, 1);
    const complete = { ...receipts.get('generic'), state: 'done', result: 'FINAL GENERIC RECEIPT\n' + 'x'.repeat(12000) };
    receipts.set('generic', complete); snapshot.tools = snapshot.tools.map(tool => tool.id === 'generic' ? project(complete) : tool);
    await js('showSnapshot(' + JSON.stringify(snapshot) + ')');
    await until('document.querySelector("[data-tool-node=generic] .ntool-body")?.textContent.includes("FINAL GENERIC RECEIPT")');
    assert.equal(calls.filter(id => id === 'generic').length, 2);
    report.cases.push('expanded generic detail refreshes on a new completion version without overwriting the summary');
    await click('[data-tool="retry"]'); await until('document.querySelector("[data-tool-detail-retry=retry]")');
    fail = false; await click('[data-tool-detail-retry="retry"]');
    await until('document.querySelector("[data-tool-node=retry] .ntool-body")?.textContent.includes("retry detail")');
    assert.equal(calls.filter(id => id === 'retry').length, 2);
    report.cases.push('failed IPC shows retry; explicit retry fetches and reveals the original detail');
    await js('renderer._render();document.querySelector("#nchatInput").focus()'); await win.webContents.insertText('Unsent draft stays focused');
    const stable = await js('window.keptHead=document.querySelector("[data-tool=write]");window.keptScroll=document.querySelector("#nchatScroll").scrollTop;window.baseRebuilds=metrics.rebuilds;({scroll:keptScroll,focus:document.activeElement.id})');
    for (let i = 0; i < 20; i++) await js('ctx._snap.messages.at(-1).blocks[0].text+=" streamed";renderer._render()');
    assert.equal(await js('document.activeElement.id'), 'nchatInput');
    assert.equal(await js('document.querySelector("#nchatInput").value'), 'Unsent draft stays focused');
    assert.equal(await js('document.querySelector("[data-tool=write]")===keptHead'), true);
    report.streaming = await js('({rebuilds:metrics.rebuilds-baseRebuilds,scrollShift:Math.abs(document.querySelector("#nchatScroll").scrollTop-keptScroll)})');
    assert.equal(report.streaming.rebuilds, 0); assert.ok(report.streaming.scrollShift < 2);
    report.cases.push('20 streaming updates retain input focus, draft, file button identity and paused reading position');
    delayIds.add('slow');
    const inProgress = { ...receipts.get('slow'), state: 'running', partial: body, result: '' };
    receipts.set('slow', inProgress); snapshot.tools = snapshot.tools.map(tool => tool.id === 'slow' ? project(inProgress) : tool);
    await js('showSnapshot(' + JSON.stringify(snapshot) + ');window.oldSlow=document.querySelector("[data-tool-node=slow]")');
    await click('[data-tool="slow"]');
    const finished = { ...inProgress, state: 'done', after: 79, partial: '', result: '//LATEST_COMPLETION\n' + body };
    receipts.set('slow', finished); snapshot.tools = snapshot.tools.map(tool => tool.id === 'slow' ? project(finished) : tool);
    await js('showSnapshot(' + JSON.stringify(snapshot) + ')');
    assert.equal(await js('document.querySelector("[data-tool-node=slow]")===oldSlow'), false);
    await until('document.querySelector(".CodeMirror")?.CodeMirror.getValue().startsWith("//LATEST_COMPLETION")');
    report.cases.push('running-to-complete regrouping replaces the card while pending; the original click opens the newest receipt');
    const nextSlow = label => {
      const tool = { ...finished, after: 80, args: { path: label + '.js' }, result: '// ' + label + '\n' + body };
      receipts.set('slow', tool); snapshot.tools = snapshot.tools.map(row => row.id === 'slow' ? project(tool) : row);
      return js('showSnapshot(' + JSON.stringify(snapshot) + ')');
    };
    await nextSlow('closed'); await click('[data-tool="slow"]'); await click('[data-wb-close]'); await pause(350);
    assert.equal(await js('ChatWorkbench.state().open'), false);
    report.cases.push('closing the right workbench cancels a pending file-open intent');
    await nextSlow('switched'); await click('[data-tool="slow"]'); await click('[data-tool="write"]'); await pause(350);
    assert.equal(await js('document.querySelector(".ncw-dochead b")?.textContent'), 'complete.js');
    assert.equal(await js('Boolean(document.querySelector("[data-tool-detail-status]"))'), false);
    report.cases.push('a newer file click wins over an older delayed result and removes its loading indicator');
    await nextSlow('other-context'); await click('[data-tool="slow"]');
    await js('ctx._ref="other-session";ctx._viewEpoch++;renderer.reset();ctx._snap={status:"idle",tools:[],messages:[{role:"user",text:"Other session"}]};renderer._render()');
    await pause(350);
    assert.equal(await js('Boolean(document.querySelector(".ncw-dochead b")?.textContent.includes("slow.js"))'), false);
    assert.equal(await js('Boolean(document.querySelector("[data-tool-detail-status]"))'), false);
    report.cases.push('a delayed file result cannot reopen a workbench tab after switching sessions');
    assert.deepEqual(await js('errors'), []);
    report.calls = calls; report.bodyChars = body.length;
    fs.writeFileSync(path.join(output, 'final.png'), (await win.webContents.capturePage()).toPNG());
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); }).finally(() => {
    if (win && !win.isDestroyed()) win.destroy();
    fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  });
}
