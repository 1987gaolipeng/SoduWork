'use strict';
const catalog = require('../agent-runtime/runtime-catalog');

// Local requirement creation already applies system preferences; only backend dispatch without explicit permissions uses the standard fallback.
// Restored sessions retain recorded policy; runtimes without unified permissions keep native authorization.
function withTaskAccessDefault(options) {
  const opts = options || {};
  if (!opts.taskRef || !opts.taskSession || opts.chatId || opts.accessMode) return opts;
  const access = catalog.runtime(opts.adapterId || 'pi')?.accessControl;
  return access?.supported && access.modes.includes('standard')
    ? { ...opts, accessMode: 'standard' } : opts;
}

module.exports = { withTaskAccessDefault };
