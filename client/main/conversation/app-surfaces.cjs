'use strict';
// A native composer is a WebContentsView, not a BrowserWindow. Publish full
// conversation events to its exact WebContents, with the same attach/detach
// lifetime contract used by ordinary windows. Native dialog parents stay intact.
const { EventEmitter } = require('node:events');
const byContents = new WeakMap(), live = new Set();
function forSender(BrowserWindow, sender) {
  if (!require('../work-preview').isAppComposer(sender)) return BrowserWindow.fromWebContents(sender);
  let surface = byContents.get(sender);
  if (surface) return surface;
  surface = new EventEmitter();
  surface.id = 'app-composer-' + sender.id;
  surface.webContents = sender;
  surface.isDestroyed = () => sender.isDestroyed();
  byContents.set(sender, surface); live.add(surface);
  sender.once('destroyed', () => { live.delete(surface); surface.emit('closed'); surface.removeAllListeners(); });
  return surface;
}
function all(windows) { return [...windows, ...[...live].filter(surface => !surface.isDestroyed())]; }
module.exports = { forSender, all };
