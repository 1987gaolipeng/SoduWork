'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

// Call before Electron becomes ready, including for renderer-only fixtures.
// Chromium storage must never fall back to an existing desktop profile.
function isolateProfile(app, name) {
  if (!/^[a-z0-9-]+$/.test(name || '')) throw new Error('An explicit E2E profile name is required');
  if (app.isReady()) throw new Error('Isolate the E2E profile before Electron is ready');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-e2e-' + name + '-'));
  const userData = path.join(root, 'profile'), sessionData = path.join(root, 'session');
  fs.mkdirSync(userData); fs.mkdirSync(sessionData);
  app.setPath('userData', userData);
  app.setPath('sessionData', sessionData);
  return { root, userData, sessionData };
}
module.exports = { isolateProfile };
