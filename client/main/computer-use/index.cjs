'use strict';
const fs = require('node:fs'), path = require('node:path');
function install({ app, BrowserWindow, screen, ipcMain, globalShortcut, powerMonitor, sessions, runner }) {
  const endpoint = path.join(app.getPath('userData'), 'computer-use', 'endpoint.json');
  // Set synchronously so the managed Runner inherits the same local endpoint.
  process.env.SODUWORK_DESKTOP_CONTROL_ENDPOINT = endpoint;
  let service, identity;
  const ready = app.whenReady().then(async () => {
    const overlay = require('./overlay.cjs').create({ BrowserWindow, screen, ipcMain, globalShortcut,
      onCancel: () => service?.cancel() });
    service = require('./service.cjs').create({ overlay, sessions: () => sessions.list(),
      stopRunner: ref => runner.rpc('job.stop', { ref }, 15000) });
    identity = await service.start();
    fs.mkdirSync(path.dirname(endpoint), { recursive: true });
    const temporary = endpoint + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(identity), { mode: 0o600 });
    try {
      fs.renameSync(temporary, endpoint);
    } catch (error) {
      // Fall back to copy and unlink when filesystem filters report EXDEV for same-directory rename.
      if (error && (error.code === 'EXDEV' || /cross-device/i.test(String(error && error.message)))) {
        fs.copyFileSync(temporary, endpoint);
        fs.unlinkSync(temporary);
      } else { throw error; }
    }
  }).catch(error => { console.error('[computer-use] indicator unavailable:', error.message); });
  function cancel() { service?.cancel(); }
  app.on('will-quit', () => {
    cancel(); service?.dispose().catch(() => {});
    try {
      if (identity && JSON.parse(fs.readFileSync(endpoint, 'utf8')).token === identity.token) fs.unlinkSync(endpoint);
    } catch (_) { /* never remove another app instance's endpoint */ }
    powerMonitor.removeListener('lock-screen', cancel); powerMonitor.removeListener('suspend', cancel);
  });
  return { ready, cancel };
}
module.exports = { install };
