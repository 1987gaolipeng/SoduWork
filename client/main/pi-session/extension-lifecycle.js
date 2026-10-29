'use strict';

const background = require('./background-process');
const initialized = new WeakMap();

// createAgentSession constructs the extension runner but does not emit its
// initial session_start. Use the public host binding API once per SDK session;
// keep Pi's headless UI (hasUI=false, confirmations denied) unchanged.
function initialize(session, options = {}) {
  require('./tool-lifecycle').install(session);
  if (initialized.has(session)) return initialized.get(session);
  const promise = Promise.resolve().then(async () => {
    if (typeof session?.bindExtensions !== 'function') throw Error('Pi extension lifecycle binding is unavailable');
    const errors = [];
    let starting = true, timer;
    const timeoutMs = Math.max(250, Math.min(Number(options.timeoutMs) || 5000, 60000));
    try {
      await Promise.race([
        background.run(() => session.bindExtensions({ onError(error) {
          if (starting && ['session_start', 'resources_discover'].includes(error?.event)) errors.push(error);
        } })),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(Error('Pi extension session initialization timed out'),
            { code: 'EXTENSION_START_TIMEOUT' })), timeoutMs);
        }),
      ]);
      if (errors.length) throw Error('Pi extension session initialization failed: ' +
        errors.map(error => String(error.error || error.message || error.event)).join('; '));
    } finally { starting = false; clearTimeout(timer); }
  });
  // Keep failed attempts too. Rebinding a partially initialized session could
  // replay extension side effects; the caller must dispose that session.
  initialized.set(session, promise);
  return promise;
}

module.exports = { initialize };
