'use strict';
const path = require('node:path');
const fs = require('node:fs');

// Use the dedicated SoduWork data directory across upgrades without reading or moving other brands' data.
function initializeUserData(app, env = process.env, profile = require('./distribution.cjs').current()) {
  const directory = env.SODUWORK_USER_DATA || env.SODUWORK_USER_DATA || path.join(app.getPath('appData'), profile.userDataName);
  fs.mkdirSync(directory, { recursive: true });
  app.setPath('userData', directory);
  return directory;
}
module.exports = { initializeUserData };
