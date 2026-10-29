'use strict';

/*
 * Minimal application-chrome preload exposes window actions only, without files, paths, or
 * conversation data.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soduWorkWindowChrome', Object.freeze({
  platform: process.platform,
  action: (name, tabId) => ipcRenderer.invoke('work-preview-chrome-action', {
    action: String(name || ''), tabId: String(tabId || ''),
  }),
  onTabs: (cb) => {
    const listener = (_event, state) => { if (typeof cb === 'function') cb(state); };
    ipcRenderer.on('app-window-tabs', listener);
    return () => ipcRenderer.removeListener('app-window-tabs', listener);
  },
  /* Track application-content bounds for rounded-corner masking. */
  onAppBounds: (cb) => ipcRenderer.on('app-window-corner-bounds', (_e, msg) => { try { cb(msg || {}); } catch (_) {} }),
}));
