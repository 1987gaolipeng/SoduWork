'use strict';

// Installed only by the dedicated runtime entrypoint. Desktop imports remain
// inert, so execution modules can share their existing Node-only tests.
let context = null;
function current() { return context; }
function install(value) {
  if (context) throw Error('Runtime process context is already installed');
  context = Object.freeze(value);
  return context;
}
module.exports = { current, install };
