'use strict';

const fileOpen = require('./file-open.cjs');

/*
 * A confirmed quit can take several seconds while running conversations stop.
 * A launch during that window cannot take the single-instance lock, so it hands
 * off to this process and exits; this process then exits too and nothing is
 * left running. Remember the request and start a fresh instance after exit.
 */
function create(app, { argv = process.argv } = {}) {
  let quitting = false;
  let requested = false;
  const pending = new Set();
  // Cleanup may re-enter before-quit several times. Schedule once at the final
  // boundary, so later launches during cleanup can still contribute their files.
  app.once('will-quit', () => {
    if (requested) app.relaunch({ args: fileOpen.relaunchArgs(argv, [...pending]) });
  });
  return {
    markQuitting() { quitting = true; },
    get quitting() { return quitting; },
    // Returns true when the launch was deferred until this process exits.
    deferLaunch(files = []) {
      if (!quitting) return false;
      requested = true;
      for (const file of fileOpen.normalizeFiles(files)) {
        if (pending.size < 20) pending.add(file);
      }
      return true;
    },
  };
}

module.exports = { create };
