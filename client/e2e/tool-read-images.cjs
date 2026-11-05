'use strict';
// Real preload, tool-detail IPC, composer and workbench; synthetic recorded images, no live client.
// node client/e2e/tool-read-images.cjs [output-directory]
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)],
    {env, windowsHide: true, stdio: 'inherit'});
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => {clearTimeout(timer); process.exitCode = code ?? 1;});
} else {
  const {app, BrowserWindow, ipcMain, nativeImage, shell} = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const output = path.resolve(process.argv[2] || path.join(__dirname, '../../outputs/tool-read-images'));
  const report = {ok: false, productionPreload: true, productionIpc: true, productionRenderer: true,
    liveAccount: false, cases: [], screenshots: []};
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-tool-read-images-')));
  app.disableHardwareAcceleration();
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let win, js;
  async function until(code) {
    for (let attempt = 0; attempt < 100; attempt++) {if (await js(code)) return; await pause(30);}
    throw Error('Timed out: ' + code);
  }
  async function click(selector) {
    await js('document.querySelector(' + JSON.stringify(selector) + ')?.scrollIntoView({block:"center",behavior:"instant"})');
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
    const point = await js(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});
      if(!node)throw Error('Missing click target');node.scrollIntoView({block:'center',behavior:'instant'});
      const r=node.getBoundingClientRect(),point={x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
      if(!node.contains(document.elementFromPoint(point.x,point.y)))throw Error('Click target is obscured');return point;})()`);
    win.webContents.focus();
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type, ...point, button: 'left', clickCount: 1});
    await pause(35);
  }
  async function screenshot(name) {
    const file = path.join(output, name + '.png');
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
    const capture = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {format: 'png'});
    fs.writeFileSync(file, Buffer.from(capture.data, 'base64'));report.screenshots.push(file);
  }
  function image(seed) {
    const width = 480, height = 270, bitmap = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4, stripe = Math.floor(x / 60) % 2;
      bitmap[at] = (seed + x / 3) % 256;
      bitmap[at + 1] = (40 + y / 2) % 256;
      bitmap[at + 2] = stripe ? 230 : 50;
      bitmap[at + 3] = 255;
    }
    return {mimeType: 'image/png', data: nativeImage.createFromBitmap(bitmap, {width, height}).toPNG().toString('base64')};
  }
  app.whenReady().then(async () => {
    fs.mkdirSync(output, {recursive: true});
    const first = image(80), delayed = image(140), latest = image(220);
    const text = Array.from({length: 600}, (_, index) => 'Recorded text line ' + index).join('\n') + '\nTEXT_SNAPSHOT_END';
    const makeImageTool = (id, value, name) => ({id, name: 'read', args: {path: name}, state: 'done', after: 1,
      result: 'Read image file [image/png]', readImages: [value]});
    const tools = [makeImageTool('image', first, 'captured-image.png'),
      {id: 'text', name: 'read', args: {path: 'recorded-text.txt'}, state: 'done', after: 1, result: text},
      makeImageTool('image-race', delayed, 'previous-session.png')];
    const other = makeImageTool('image-race', latest, 'current-session.png');
    const calls = [], actionCalls = [], downloadCalls = [];
    Object.assign(report, {calls, actionCalls, downloadCalls});
    let releaseDelayed;
    const pending = new Promise(resolve => {releaseDelayed = resolve;});
    const handles = new Map([
      ['detail-fixture', {attachedWindow: null, async toolDetail(id) {
        calls.push({ref: 'detail-fixture', id});
        if (id === 'image-race') await pending;
        return tools.find(tool => tool.id === id);
      }}],
      ['other-session', {attachedWindow: null, async toolDetail(id) {calls.push({ref: 'other-session', id});return id === other.id ? other : null;}}],
    ]);
    require('../main/pi-session/tool-detail-ipc').install({ipcMain, BrowserWindow, session: {get: ref => handles.get(ref)}});
    for (const channel of ['pi-session-read-output', 'pi-session-open-output', 'pi-session-reveal-output',
      'pi-session-artifact-action', 'attachment-download', 'library-open-external', 'open-external']) {
      ipcMain.handle(channel, (_event, ...args) => {actionCalls.push({channel, args});return {ok: false, reason: 'Unexpected file action in snapshot test'};});
    }
    for (const method of ['openPath', 'openExternal', 'showItemInFolder']) shell[method] = (...args) => {
      actionCalls.push({channel: 'shell.' + method, args});return Promise.resolve('');
    };
    win = new BrowserWindow({show: false, width: 1440, height: 900, webPreferences: {
      preload: path.join(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false}});
    win.webContents.debugger.attach('1.3');
    for (const handle of handles.values()) handle.attachedWindow = win;
    win.webContents.session.on('will-download', (event, item) => {event.preventDefault();downloadCalls.push(item.getURL());});
    win.webContents.setWindowOpenHandler(details => {actionCalls.push({channel: 'new-window', url: details.url});return {action: 'deny'};});
    win.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (_details, callback) => callback({cancel: true}));
    await win.loadFile(path.join(__dirname, 'fixtures/tool-details-lazy.html'));
    js = code => win.webContents.executeJavaScript(code, true).catch(error => {throw Error(error.message + '\nRenderer script: ' + code);});
    const project = require('../main/pi-session/tool-detail').project;
    const summary = project(tools[0]);
    assert.equal(summary.readImageCount, 1);assert.equal(summary.detailsDeferred, true);
    assert.equal(JSON.stringify(summary).includes(first.data), false);
    assert.equal(Array.isArray(summary.readImages) && summary.readImages.some(item => item.data), false);
    const snapshot = {status: 'idle', tools: tools.map(project), messages: [
      {role: 'user', text: 'Read the recorded image and text.'},
      {role: 'assistant', blocks: [{index: 0, kind: 'text', text: 'Select a read operation to inspect the exact recorded content.'}]}]};
    await js('showSnapshot(' + JSON.stringify(snapshot) + ')');
    assert.equal(calls.length, 0);
    assert.equal(await js('document.querySelectorAll(".ncw-body img").length'), 0);
    report.cases.push('Collapsed image receipt carries only count and deferred marker, with no image bytes or eager detail request');
    await click('[data-tool-group]');
    await click('[data-tool="image"]');
    await until('document.querySelector(".ncw-body img")?.naturalWidth>0');
    const decoded = await js('(()=>{const img=document.querySelector(".ncw-body img");return {width:img.naturalWidth,height:img.naturalHeight,src:img.src,visible:img.getBoundingClientRect().width>0}})()');
    assert.deepEqual({width: decoded.width, height: decoded.height, visible: decoded.visible}, {width: 480, height: 270, visible: true});
    assert.ok(await js('(()=>{const r=document.querySelector(".ncw-body img").getBoundingClientRect();return Math.abs(r.width/r.height-480/270)<0.01})()'));
    assert.equal(decoded.src, 'data:image/png;base64,' + first.data);
    assert.equal(await js('ChatWorkbench.state().open'), true);
    assert.equal(calls.filter(call => call.id === 'image').length, 1);
    await screenshot('read-image-right-workbench');
    await click('[data-tool="image"]');assert.equal(calls.filter(call => call.id === 'image').length, 1);
    report.cases.push('Image read opens a decoded 480 x 270 recorded PNG in the right workbench and repeated click uses the bounded detail cache');
    await js('window.keptReadImage=document.querySelector(".ncw-body img");window.keptReadImageSource=keptReadImage.src');
    for (let revision = 1; revision <= 3; revision++) {
      const unrelated = {id: 'unrelated', name: 'inspect_data', args: {}, state: revision < 3 ? 'running' : 'done',
        after: 1, result: 'Unrelated tool state ' + revision};
      const update = {...snapshot, tools: [...snapshot.tools, project(unrelated)]};
      const files = [{artifactId: 'unrelated-output', name: 'unrelated.txt', relative: 'unrelated.txt', kind: 'file',
        primary: false, size: revision, at: revision}];
      await js('ctx._outs=' + JSON.stringify(files) + ';showSnapshot(' + JSON.stringify(update) + ')');
      assert.equal(await js('document.querySelector(".ncw-body img")===keptReadImage&&keptReadImage.isConnected&&' +
        'keptReadImage.complete&&keptReadImage.naturalWidth===480&&keptReadImage.src===keptReadImageSource'), true);
    }
    assert.equal(calls.filter(call => call.id === 'image').length, 1);
    report.cases.push('Three unrelated file-index and tool-state updates retain the same decoded image DOM node and source without another receipt request');
    await click('[data-tool="text"]');
    await until('document.querySelector(".CodeMirror")?.CodeMirror.getValue().endsWith("TEXT_SNAPSHOT_END")');
    assert.equal(await js('document.querySelector(".CodeMirror").CodeMirror.getValue()'), text);
    assert.equal(await js('document.querySelectorAll(".ncw-body img").length'), 0);
    assert.equal(await js('Boolean(document.querySelector("[data-read-snapshot]"))'), true);
    report.cases.push('Text read still opens the complete readonly recorded text and does not inherit the prior image');
    await click('[data-tool="image-race"]');
    assert.equal(calls.filter(call => call.ref === 'detail-fixture' && call.id === 'image-race').length, 1);
    const otherSnapshot = {...snapshot, tools: [project(other)], messages: [{role: 'user', text: 'Other session'},
      {role: 'assistant', blocks: [{index: 0, kind: 'text', text: 'Current session image'}]}]};
    await js('ctx._ref="other-session";ctx._viewEpoch++;renderer.reset();showSnapshot(' + JSON.stringify(otherSnapshot) + ')');
    await click('[data-tool="image-race"]');
    await until('document.querySelector(".ncw-body img")?.naturalWidth>0');
    assert.equal(await js('document.querySelector(".ncw-body img").src'), 'data:image/png;base64,' + latest.data);
    releaseDelayed();await pause(200);
    assert.equal(await js('document.querySelector(".ncw-body img").src'), 'data:image/png;base64,' + latest.data);
    assert.equal(await js('document.querySelector("[data-wb-tab][aria-selected=true] [data-wb-tab-label]")?.textContent'), 'current-session.png');
    assert.equal(await js('Boolean(document.querySelector("[data-tool-detail-status]"))'), false);
    report.cases.push('A delayed receipt from the previous session cannot replace the current image even with the same tool ID');
    assert.deepEqual(actionCalls, []);assert.deepEqual(downloadCalls, []);
    report.cases.push('Opening recorded images performs no filesystem reread, download, external application launch or new window');
    assert.deepEqual(await js('errors'), []);
    await screenshot('read-image-session-isolation');
    report.calls = calls;report.actionCalls = actionCalls;report.downloadCalls = downloadCalls;report.ok = true;
  }).catch(error => {report.error = error.stack || String(error);}).finally(async () => {
    fs.mkdirSync(output, {recursive: true});
    if (!report.ok && win && !win.isDestroyed()) await screenshot('failure').catch(() => {});
    if (win && !win.isDestroyed()) win.destroy();
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));app.exit(report.ok ? 0 : 1);
  });
}
