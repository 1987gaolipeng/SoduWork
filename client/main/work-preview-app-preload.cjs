'use strict';

/* Minimal preload for a registered SoduWork web app. It intentionally exposes a
   request-only facade; no Electron object, filesystem path, host token or raw IPC
   channel crosses into the hosted page. Unregistered previews use no preload. */
const { contextBridge, ipcRenderer } = require('electron');

let sequence = 0;
// Concurrent app tabs have separate preload worlds; time + sequence alone can
// collide when two pages issue their first request in the same millisecond.
const requestPrefix = 'app-' + Math.random().toString(36).slice(2, 12);
function request(method, params) {
  const id = requestPrefix + '-' + Date.now().toString(36) + '-' + (++sequence).toString(36);
  return ipcRenderer.invoke('work-preview-app-request', {
    version: 1, id, method: String(method || ''), params: params || {},
  });
}

const bridge = Object.freeze({
  version: 1,
  request,
  settings: Object.freeze({ get: params => request('settings.get', params || {}), update: params => request('settings.update', params || {}) }),
  mcp: Object.freeze({ connect: params => request('mcp.connect', params || {}) }),
  events: Object.freeze({ onTurnSettled(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = () => { try { callback({ state: 'settled' }); } catch (_) {} };
    ipcRenderer.on('app-turn-settled', listener);
    return () => ipcRenderer.removeListener('app-turn-settled', listener);
  } }),
  context: Object.freeze({ get: () => request('context.get', {}) }),
  conversation: Object.freeze({
    open: (params) => request('conversation.open', params || {}),
    send: (params) => request('conversation.send', params || {}),
  }),
  requirements: Object.freeze({
    propose: (params) => request('requirements.propose', params || {}),
  }),
  notifications: Object.freeze({
    send: (params) => request('notifications.send', params || {}),
  }),
  /* Expose composer controls only when the application manifest declares composer.control. */
  composer: Object.freeze({
    expand: () => request('composer.expand', {}),
    collapse: () => request('composer.collapse', {}),
    insertText: (params) => request('composer.insertText', params || {}),
    send: params => request('composer.send', params || {}),
    insertAttachment: (params) => request('composer.insertAttachment', params || {}),
    setTheme: (params) => request('composer.theme', params || {}),
  }),
});

contextBridge.exposeInMainWorld('soduWorkAppBridge', bridge);
contextBridge.exposeInMainWorld('soduWorkAppBridge', bridge); // Existing installed web apps.
// Public plugin API names remain stable across a product-name change. Both
// facades use the same restricted request channel and its current authorization.
contextBridge.exposeInMainWorld('soduworkAppBridge', bridge);
