'use strict';

const fileOpen = require('./file-open.cjs');
const firstChat = require('./first-chat-links.cjs');

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
  let setupLink = '';
  // Cleanup may re-enter before-quit several times. Schedule once at the final
  // boundary, so later launches during cleanup can still contribute their files.
  app.once('will-quit', () => {
    if (requested) {
      const args = fileOpen.relaunchArgs(argv, [...pending]).filter(arg => !firstChat.view(arg));
      if (setupLink) args.push(setupLink);
      app.relaunch({ args });
    }
  });
  return {
    markQuitting() { quitting = true; },
    get quitting() { return quitting; },
    // Returns true when the launch was deferred until this process exits.
    deferLaunch(files = [], link = '') {
      if (!quitting) return false;
      requested = true;
      if (firstChat.view(link)) setupLink = link;
      for (const file of fileOpen.normalizeFiles(files)) {
        if (pending.size < 20) pending.add(file);
      }
      return true;
    },
  };
}

module.exports = { create };
