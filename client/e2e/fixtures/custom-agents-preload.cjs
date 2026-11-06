'use strict';
// Thin, isolated preload: same production channels, without desktop startup side effects.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('soduWorkAPI', { conversationSession: {
  customAgents: Object.fromEntries(['list', 'add', 'activate', 'pick'].map(action =>
    [action, input => ipcRenderer.invoke('custom-agents-' + action, input)])),
  runtimes: options => ipcRenderer.invoke('custom-fixture-runtimes', options),
  probe: id => ipcRenderer.invoke('custom-fixture-probe', id),
  onRuntimesChanged(callback) {
    const listener = () => callback();
    ipcRenderer.on('agent-runtimes-changed', listener);
    return () => ipcRenderer.removeListener('agent-runtimes-changed', listener);
  },
} });
