'use strict';
// Real Electron main + renderer IPC + production Runner lifecycle. The only
// identity is a disposable fixture supplied by the loopback Hub orchestrator.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const configPath = process.argv.at(-1);
assert.ok(configPath, 'Explicit isolated fixture configuration required');
const fixture = JSON.parse(fs.readFileSync(configPath, 'utf8'));
assert.match(fixture.hub, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.match(path.basename(fixture.root), /^\.smoke-native-runner-recovery-/);
const profile = path.join(fixture.root, 'electron-profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', path.join(profile, 'session'));
app.setPath('logs', path.join(profile, 'logs'));
app.disableHardwareAcceleration();

const runtime = require('../../main/runner-runtime');
runtime.install({ app, ipcMain, identityOf: () => ({
  hub: fixture.hub, clientId: fixture.clientId, secret: fixture.secret,
}) });
const snapshots = [];
let window;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function invoke(channel, value) {
  return window.webContents.executeJavaScript(
    `require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, ${JSON.stringify(value ?? null)})`);
}
async function waitUntil(check, timeout, label) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(label + ' timed out');
}
async function api(route) {
  const response = await fetch(fixture.hub + route, {
    headers: { 'X-Soduwork-Device': fixture.clientId, Authorization: 'Device ' + fixture.session },
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200, route);
  return response.json();
}

app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, webPreferences: {
    nodeIntegration: true, contextIsolation: false, sandbox: false,
    backgroundThrottling: false, offscreen: true,
  } });
  await window.loadURL('data:text/html,<title>Isolated Runner recovery</title>');
  // Configure exactly once. No test code launches or restarts a Runner.
  const initial = await invoke('runner-configure', {
    hub: fixture.hub, clientId: fixture.clientId,
    workRoot: path.join(fixture.root, 'work'), capabilityGrants: [],
  });
  assert.equal(initial.ok, true);
  assert.ok(initial.pid > 0);
  assert.equal(initial.error, '', 'First configuration must not expose a missing-file error');
  const connected = await waitUntil(async () => {
    const status = await invoke('runner-status');
    if (JSON.stringify(snapshots.at(-1)?.status) !== JSON.stringify(status)) {
      snapshots.push({ afterMs: Date.now() - fixture.startedAt, status });
    }
    return status.connected && status.pid !== initial.pid ? status : null;
  }, 150000, 'Native automatic Runner recovery');
  assert.ok(snapshots.some(row => row.status.state === 'error'), 'Failure must surface before recovery');
  assert.ok(snapshots.some(row => row.status.error.includes('身份')), 'Identity recovery must be observable');
  assert.equal(connected.error, '', 'Only the successful welcome clears the connection error');
  const inventory = await waitUntil(async () => {
    const setup = await api('/api/v1/agent-setup');
    const roster = await api('/api/v1/ai-agents');
    return setup.machines?.length && setup.agents?.length && roster.agents?.some(agent => agent.cli === 'pi')
      ? { setupMachines: setup.machines.length, setupAgents: setup.agents.length,
          rosterAgents: roster.agents.map(agent => agent.cli) } : null;
  }, 90000, 'Recovered Agent inventory');
  const state = await api('/__fixture/state');
  assert.equal(state.legacyOwner, 'fixture-old-device');
  assert.notEqual(state.recoveredId, 'legacy-native-fixture-runner');
  const seed = fs.readFileSync(path.join(profile, 'runner', 'data', 'runner-id'), 'utf8');
  assert.equal(seed, 'legacy-native-fixture-runner');
  fs.writeFileSync(path.join(fixture.root, 'native-result.json'), JSON.stringify({
    ok: true, electron: process.versions.electron, configureCalls: 1,
    initialPid: initial.pid, recoveredPid: connected.pid, connected, snapshots, inventory,
    legacyIdentityPreserved: true,
  }, null, 2));
  console.log('PASS real Electron configure/status IPC and automatic Runner restart');
  console.log('PASS recovered Runner is connected and Agent/automation APIs discover Pi');
  console.log('PASS original device ownership and legacy identity remain unchanged');
  app.quit();
}).catch(error => {
  fs.writeFileSync(path.join(fixture.root, 'native-error.json'), JSON.stringify({
    error: String(error.stack || error), snapshots,
  }, null, 2));
  console.error(error);
  process.exitCode = 1;
  app.quit();
});
