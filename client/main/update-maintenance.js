'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function launch(executable = process.execPath, start = spawn) {
  if (process.platform !== 'win32') return false;
  const payload = path.dirname(executable), versions = path.dirname(payload), root = path.dirname(versions);
  if (path.basename(versions) !== '.soduwork-versions' || !/^ns[a-z0-9]+\.tmp$/i.test(path.basename(payload))) return false;
  const helper = path.join(payload, '.soduwork-prune.cjs');
  if (!fs.existsSync(helper) || !fs.existsSync(path.join(root, '.soduwork-launcher'))) return false;
  const child = start(executable, [helper, '--schedule'], {
      windowsHide: true, detached: true, stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
  child.on('error', () => {}); // housekeeping must never break startup
  child.unref();
  return true;
}
function schedule(app, idle = () => true) {
  if (!app.isPackaged || process.platform !== 'win32') return;
  let attempts = 0;
  const tick = () => {
    attempts++;
    try { if (idle()) { launch(); return; } } catch (_) {}
    if (attempts < 20) setTimeout(tick, 30000).unref();
  };
  setTimeout(tick, 30000).unref();
}
module.exports = { launch, schedule };
