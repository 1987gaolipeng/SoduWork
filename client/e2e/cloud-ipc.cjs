'use strict';
// Real preload -> Electron IPC -> production cloud registration. An isolated,
// signed-out profile proves interface availability without using user secrets.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute output directory required');
const report = { ok: false, boundary: 'Real Electron preload and IPC; isolated signed-out identity', checks: [] };
let win;
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-cloud-ipc-'));
  app.setPath('userData', profile);
  require('../main/conversation/cloud-handoff-ipc').install({ app, ipcMain,
    session: { setExternalHistory() {}, get() { return null; } }, identityOf: async () => null });
  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true,
    nodeIntegration: false, preload: path.resolve(__dirname, '../preload.js') } });
  // Keep the trusted production page origin, with an inert body. No app boot,
  // real account, background task or model request is made by this smoke test.
  win.webContents.session.protocol.handle('file', () => new Response('<!doctype html><meta charset="utf-8"><title>Cloud IPC acceptance</title>'));
  await win.loadFile(path.resolve(__dirname, '../desk.html'));
  for (const agent of ['pi', 'opencode', 'codex-harness', 'dsh', 'qwen', 'codex', 'claude']) {
    const result = await win.webContents.executeJavaScript('soduWorkAPI.conversationSession.cloud.targets(' + JSON.stringify(agent) + ')');
    assert.equal(result.ok, false);
    assert.match(result.reason, /登录|连接/);
    assert.doesNotMatch(result.reason, /No handler|remote method/);
    report.checks.push(agent + ': targets handler returns a structured sign-in result');
  }
  const start = await win.webContents.executeJavaScript('soduWorkAPI.conversationSession.cloud.start({})');
  assert.equal(start.ok, false); assert.ok(start.reason); assert.doesNotMatch(start.reason, /No handler/);
  report.checks.push('start handler registered and input validation is returned to renderer');
  report.ok = true;
}).catch(error => { report.error = error.stack; }).finally(async () => {
  if (win && !win.isDestroyed()) win.destroy();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
});
