'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const prepare = require('./installer-prepare.cjs');
module.exports = async function(context) {
  // A unique root executable isolates the uninstaller's process-name check
  // from any real SoduWork process. The stable launcher still opens a real
  // SoduWork.exe in the fixture payload, and the production verifier hashes it.
  if (context.appOutDir) await fs.copyFile(
    path.join(context.appOutDir, 'SoduWorkMigrationE2E.exe'), path.join(context.appOutDir, 'SoduWork.exe'));
  await prepare(context);
};
