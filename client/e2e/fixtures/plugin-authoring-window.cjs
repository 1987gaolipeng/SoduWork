'use strict';
// Production preload + production install/draft IPC, with isolated disk state.
// Only native file selection and external platform login replies are fixtures.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const personal = require('../../main/personal-plugins');
const drafts = require('../../main/pi-session/plugin-draft');
const outputs = require('../../main/pi-session/outputs');
const artifacts = require('../../main/conversation/artifact-runtime');
const [profile, controlFile] = process.argv.slice(2);
if (!profile || !controlFile || !path.resolve(controlFile).startsWith(path.dirname(path.resolve(profile)) + path.sep)) {
  throw Error('Explicit isolated profile and fixture control file required');
}
app.setPath('userData', profile);
const control = () => JSON.parse(fs.readFileSync(controlFile, 'utf8'));
const eventsFile = path.join(path.dirname(profile), 'ipc-events.json');
const events = [], connected = new Set();
function record(channel, detail = {}) {
  events.push({ channel, ...detail });
  fs.writeFileSync(eventsFile, JSON.stringify(events));
}
const productionIpc = { handle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    record(channel);
    return handler(event, ...args);
  });
} };
// This fixture has no native preview view; acknowledge synchronous modal occlusion requests to avoid blocking the renderer.
ipcMain.on('work-preview-suppress', event => { event.returnValue = true; });
personal.install({ app, ipcMain: productionIpc, dialog: {
  showOpenDialog: async () => ({ canceled: false, filePaths: [control().selectedPackage] }),
} });
const session = { sessionId: 'authoring', get cwd() { return control().cwd; },
  inFlight: () => Boolean(control().inFlight),
  outputSnapshot: () => ({ ...outputs.scan(control().cwd, control().since || 0, control().history ? Date.now() : control().startedAt),
    ...(control().pluginSince == null ? {} : { pluginSince: control().pluginSince }) }),
};
drafts.installIpc(productionIpc, { get: ref => ref === session.sessionId ? session : null, list: () => [session] });
ipcMain.handle('pi-session-outputs', (_event, ref) => {
  if (ref !== session.sessionId) throw Error('Unknown fixture conversation');
  const { got, delivery, items } = artifacts.snapshot(session);
  return { ok: true, files: got.files, delivery, deliverables: delivery.items,
    artifacts: artifacts.decorate(ref, { items }) };
});
function state(key) { return { ok: true, provider: key, installed: true,
  connected: connected.has(key), state: connected.has(key) ? 'connected' : 'needs_auth' }; }
for (const action of ['status', 'refresh', 'connect']) {
  ipcMain.handle('platform-connection-' + action, (_event, key) => {
    if (action === 'connect') { connected.add(key); record('platform-connect', { key }); }
    return state(key);
  });
}
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1280, height: 940, show: false,
    webPreferences: { preload: path.resolve(__dirname, '../../preload.js'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false } });
  await window.loadFile(path.join(__dirname, 'plugin-authoring.html'));
});
app.on('window-all-closed', () => app.quit());
