'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Deliberately separate from the work window preload. The editor can only read
// its own frozen display and request explicit copy/save/cancel actions.
contextBridge.exposeInMainWorld('screenshotAPI', {
  getCapture: () => ipcRenderer.invoke('screenshot-data'),
  ready: () => ipcRenderer.invoke('screenshot-ready'),
  claim: () => ipcRenderer.invoke('screenshot-claim'),
  finish: input => ipcRenderer.invoke('screenshot-finish', { action: input?.action, dataUrl: input?.dataUrl }),
  cancel: () => ipcRenderer.invoke('screenshot-cancel')
});
