'use strict';

// Electron keeps named Session instances for the process lifetime, even after
// every WebContents has closed. Recycle an exclusive, fully cleared partition
// instead of creating one for every historical owner window.
const { randomBytes } = require('node:crypto');

function create({ session, onError = () => {}, cleanupTimeoutMs = 5000, onDownload = null }) {
  const prefix = 'soduwork-work-preview-' + randomBytes(8).toString('hex') + '-';
  const slots = [];
  function claim(slot) {
    slot.state = 'leased';
    let released = false;
    return Object.freeze({ partition: slot.partition, session: slot.session,
      release() {
        if (released) return slot.cleaning;
        released = true;
        slot.state = 'cleaning';
        const clear = Promise.resolve().then(async () => {
          // All owned WebContents must already be destroyed. Stop old requests,
          // clear storage/workers/caches and HTTP credentials, then drain again.
          await slot.session.closeAllConnections();
          await slot.session.clearData();
          await slot.session.clearAuthCache();
          await slot.session.closeAllConnections();
        });
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('Preview session cleanup timed out')), cleanupTimeoutMs);
        });
        slot.cleaning = Promise.race([clear, timeout]).then(() => {
          slot.state = 'free';
          return true;
        }, error => {
          slot.state = 'quarantined';
          try { onError(error); } catch (_) {}
          return false; // Failed cleanup can never hand old user data to a new owner.
        }).finally(() => clearTimeout(timer));
        return slot.cleaning;
      },
    });
  }
  function acquire(isActive = () => true) {
    // An owner may close while awaiting cleanup. Do not allocate a native
    // Session for an abandoned request when all waiters wake up together.
    if (!isActive()) return null;
    const idle = slots.find(slot => slot.state === 'free');
    if (idle) return claim(idle);
    const clearing = slots.filter(slot => slot.state === 'cleaning');
    // Rapid close/reopen must wait for cleanup rather than allocate unbounded
    // replacement sessions. Truly concurrent live owners still remain isolated.
    if (clearing.length) return Promise.race(clearing.map(slot => slot.cleaning)).then(() => acquire(isActive));
    const partition = prefix + slots.length;
    const slot = { partition, session: session.fromPartition(partition), state: 'free', cleaning: null };
    if (typeof onDownload === 'function') {
      // Allow ordinary webpage downloads but intercept Hub attachment URLs that should render as previews.
      // Let the caller explain those intercepted downloads rather than silently opening Save As.
      slot.session.on('will-download', (event, item) => {
        let blocked = false;
        try { blocked = onDownload(slot, item) === true; } catch (_) { blocked = false; }
        if (blocked) event.preventDefault();
      });
    }
    slots.push(slot);
    return claim(slot);
  }
  return { acquire };
}

module.exports = { create };
