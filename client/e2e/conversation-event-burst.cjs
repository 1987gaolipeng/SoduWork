'use strict';
// Real production IPC publisher, Electron transport and contextBridge. Isolated
// synthetic session; no native/model session, account or external service.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: 'inherit',
  }).on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
  const assert = require('node:assert/strict'), { createRequire } = require('node:module');
  const baseline = process.argv.includes('--baseline');
  const report = { ok: false, baseline, isolated: true, realModel: false, cases: [] };
  const output = path.resolve(__dirname, '../../outputs/client-freeze-20261013/ipc-burst-' + (baseline ? 'baseline' : 'fixed') + '.json');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-ipc-burst-')));
  let win;
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, skipTaskbar: true, webPreferences: {
      preload: path.resolve(__dirname, '../preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
    } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    await win.loadURL('data:text/html,<html><body><textarea>draft</textarea></body></html>');
    const run = source => win.webContents.executeJavaScript(source);
    await run(`window.batches = []; window.legacy = []; window.shared = []; window.presence = [];
      window.offPresence = soduWorkAPI.conversationSession.onEventBatch(payload => presence.push({kind:payload.kind, hasSnapshot:!!payload.snapshot}), {presenceOnly:true});
      window.offBatch = soduWorkAPI.conversationSession.onEventBatch(payload => {
        batches.push({kind: payload.kind, count: payload.events?.length || 1});
        const events = payload.events || [payload];
        for(const event of events) shared.push({kind:event.kind, snapshot:payload.snapshot, retrySafe:event.retrySafe, submissionId:event.submissionId});
      }); void 0;`);
    const filename = path.resolve(__dirname, '../main/pi-session/ipc.js');
    const source = baseline ? require('node:child_process').execFileSync('git', ['show', 'HEAD:client/main/pi-session/ipc.js'], {
      cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', windowsHide: true,
    }) : fs.readFileSync(filename, 'utf8');
    const sandbox = { module: { exports: {} }, require: createRequire(filename), console, setTimeout, clearTimeout, queueMicrotask, process, Buffer };
    // Expose only the internal wiring in this test VM, without changing the
    // production API or installing real session/network/identity handlers.
    vm.runInNewContext(source + '\nmodule.exports.testWire = _wire; module.exports.testAttach = _attach;', sandbox, { filename });
    const listeners = new Set(); let builds = 0, sends = 0, bytes = 0, sendMs = 0;
    const snapshot = { status: 'streaming', messages: Array.from({length: 80}, (_, i) => ({ role: 'assistant',
      blocks: [{ kind: 'text', text: 'Synthetic transcript '.repeat(1500) + i }] })), tools: [] };
    const handle = { ref: 'synthetic', sessionId: 'synthetic-id', attachedWindow: win, detached: false,
      on(fn) { listeners.add(fn); }, uiSnapshot() { builds++; return snapshot; }, historyRow() { return { id: 'synthetic-id', title: 'Synthetic session', state: 'running' }; } };
    const originalSend = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, payload) => {
      if (channel === 'pi-session-event') { sends++; bytes += Buffer.byteLength(JSON.stringify(payload)); }
      const start = performance.now(); originalSend(channel, payload); sendMs += performance.now() - start;
    };
    sandbox.module.exports.testWire(BrowserWindow, handle);
    const emitter = require('../main/pi-session/snapshot-emitter').create(() => snapshot, listeners, 5);
    for (let i = 0; i < 30; i++) emitter.emit({ kind: 'tool' });
    emitter.emit({ kind: 'error', reason: 'Synthetic failure', retrySafe: true, submissionId: 'draft-1' });
    emitter.emit({ kind: 'settled' });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && await run('shared.length') < 32) await new Promise(resolve => setTimeout(resolve, 20));
    const received = await run(`({batches:batches.length, events:shared.length,
      ordered: shared.slice(-2).map(x=>x.kind), sharedSnapshot: shared.every(x=>x.snapshot === shared[0].snapshot),
      error: shared.find(x=>x.kind==='error') && {retrySafe:shared.find(x=>x.kind==='error').retrySafe, submissionId:shared.find(x=>x.kind==='error').submissionId},
      presenceHasSnapshot: presence.some(x=>x.hasSnapshot)})`);
    report.results = { snapshotBuilds: builds, ipcSends: sends, serializedBytes: bytes, sendMs, received };
    assert.equal(received.events, 32); assert.deepEqual(received.ordered, ['error', 'settled']);
    assert.equal(received.presenceHasSnapshot, false);
    if (!baseline) {
      assert.equal(builds, 1); assert.equal(sends, 1); assert.equal(received.batches, 1); assert.equal(received.sharedSnapshot, true);
      assert.deepEqual(received.error, { retrySafe: true, submissionId: 'draft-1' });
    }
    // Use the production publisher with mutable handle state. Deferring an
    // earlier event must not replace its snapshot or move it to the next owner.
    const boundaries = [], boundaryListeners = new Set(); let visibleState = { marker: 'waiting' }, boundaryBuilds = 0;
    const makeOwner = owner => ({ isDestroyed: () => false, once() {}, removeListener() {}, webContents: {
      send(_channel, payload) { if (payload.snapshot) boundaries.push({ owner, kind: payload.kind, marker: payload.snapshot.marker }); },
    } });
    const firstOwner = makeOwner('first'), nextOwner = makeOwner('next');
    const boundaryHandle = { ref: 'boundaries', sessionId: 'boundaries-id', attachedWindow: firstOwner, detached: false,
      on(fn) { boundaryListeners.add(fn); }, uiSnapshot() { boundaryBuilds++; return visibleState; } };
    sandbox.module.exports.testWire({ getAllWindows: () => [firstOwner, nextOwner] }, boundaryHandle);
    const emitBoundary = kind => { for (const listener of boundaryListeners) listener({ kind }, visibleState); };
    emitBoundary('ui'); visibleState = { marker: 'done' }; emitBoundary('settled');
    await Promise.resolve();
    visibleState = { marker: 'before-transfer' }; emitBoundary('tool');
    sandbox.module.exports.testAttach(boundaryHandle, nextOwner);
    visibleState = { marker: 'after-transfer' }; emitBoundary('settled');
    await Promise.resolve();
    assert.deepEqual(boundaries, [
      { owner: 'first', kind: 'ui', marker: 'waiting' }, { owner: 'first', kind: 'settled', marker: 'done' },
      { owner: 'first', kind: 'tool', marker: 'before-transfer' }, { owner: 'next', kind: 'settled', marker: 'after-transfer' },
    ]);
    assert.equal(boundaryBuilds, 4); report.boundaries = boundaries;
    await run(`offBatch(); offPresence(); window.offLegacy=soduWorkAPI.conversationSession.onEvent(payload => {
      legacy.push(payload.kind); if(payload.kind==='error') throw Error('synthetic subscriber failure');
    }); void 0;`);
    originalSend('pi-session-event', { ref: 'compat', snapshot: {}, events: [{kind:'error'}, {kind:'settled'}] });
    while (Date.now() < deadline && await run('legacy.length') < 2) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(await run('legacy'), ['error', 'settled']);
    await run('offLegacy();'); originalSend('pi-session-event', { kind: 'ignored-after-unsubscribe' });
    await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(await run('legacy.length'), 2);
    emitter.dispose();
    report.cases.push('32 ordered structural events measured through production publisher and preload; error/draft metadata, legacy subscriber errors and unsubscribe checked');
    report.cases.push('distinct snapshots preserve original state; ownership changes flush to the original recipient');
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); }).finally(() => {
    if (win && !win.isDestroyed()) win.destroy();
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
  });
}
