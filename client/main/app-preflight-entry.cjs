'use strict';

// Packaged Electron always loads main.js, even when given a script path.
// Dispatch before normal startup touches profiles, services or the instance lock.
const SWITCH = '--soduwork-app-preflight';
function launchArgs(packaged, appPath) {
  return packaged ? [SWITCH] : [appPath, SWITCH];
}
function dispatch(argv = process.argv, env = process.env, load = require) {
  if (!argv.includes(SWITCH)) return false;
  if (!env.APP_CANDIDATE_PREFLIGHT_FOLDER) throw Error('Missing app preflight directory');
  load('./app-candidate-preflight-worker.cjs');
  return true;
}
module.exports = { SWITCH, launchArgs, dispatch };
