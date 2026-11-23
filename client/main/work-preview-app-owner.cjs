'use strict';
// Only main-process view creation can bind a page to its trusted account scope.
const crypto = require('node:crypto');
const bindings = new WeakMap();
const senders = new WeakMap();
const denied = () => Object.assign(Error('Application account changed; reopen the application'), { code: 'APP_ACCOUNT_CHANGED' });
function identity(item) {
  const pluginId = String(item.appBridge?.appId || '').replace(/^plugin:/, '');
  // Installed pages can be opened by Safari/Firefox with a transient or
  // malformed origin while the view is being restored.  Treat that state as
  // an ownership refusal instead of leaking URL/Reference errors to the UI.
  let origin = '';
  try { origin = new URL(item.appBridge?.origin || '').origin; } catch (_) { throw denied(); }
  if (!pluginId || !/^https?:/.test(origin)) throw denied();
  return { pluginId, origin };
}
function scope(binding, deps) {
  try { return require('./app-settings-store.cjs').scope(binding); }
  catch (error) {
    // Installed local pages may open offline; logging in creates a new scope.
    if (!binding.pluginId.startsWith('local:') || !deps.app) throw denied();
    return 'offline:' + crypto.createHash('sha256').update(
      deps.app.getPath('userData') + '\0' + binding.pluginId + '\0' + binding.origin).digest('hex');
  }
}
function capture(item, deps) {
  if (bindings.has(item)) throw denied();
  const binding = identity(item);
  bindings.set(item, { ...binding, deps, scope: scope(binding, deps) });
  if (item.view?.webContents) senders.set(item.view.webContents, item);
}
function assertCurrent(item) {
  const bound = bindings.get(item);
  if (!bound || item.view?.webContents?.isDestroyed()) throw denied();
  const current = identity(item);
  if (current.pluginId !== bound.pluginId || current.origin !== bound.origin ||
      scope(current, bound.deps) !== bound.scope) throw denied();
}
function inherit(item, parent) {
  assertCurrent(parent);
  if (bindings.has(item)) throw denied();
  bindings.set(item, bindings.get(parent));
  if (item.view?.webContents) senders.set(item.view.webContents, item);
}
function associate(sender, item) {
  assertCurrent(item);
  senders.set(sender, item);
}
function assertSender(sender) {
  const item = sender && senders.get(sender);
  if (!item) return false;
  if (sender.isDestroyed()) throw denied();
  assertCurrent(item);
  return true;
}
module.exports = { capture, inherit, associate, assertCurrent, assertSender };
