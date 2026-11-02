'use strict';
const { isTrusted } = require('../access-control/preferences');
// Invalidate discovery, not running sessions or explicit conversation selections.
function create({ session, invalidateModels, contents }) {
  function changed() {
    session.invalidateRuntimes();
    invalidateModels();
    for (const sender of contents()) {
      try {
        if (!isTrusted({ sender, senderFrame: sender.mainFrame })) continue;
        sender.send('agent-runtimes-changed');
        sender.send('models-changed');
      } catch { /* The view may have closed during notification. */ }
    }
  }
  return { changed, receive(event, kind) {
    if (!['models', 'agent-runtimes-changed'].includes(kind) || !isTrusted(event)) return false;
    changed(); return true;
  } };
}
module.exports = { create };
