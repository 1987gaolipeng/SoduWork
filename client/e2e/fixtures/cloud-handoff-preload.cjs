'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('soduWorkAPI', { conversationSession: {
  cloud: Object.fromEntries(['preview', 'confirm', 'recover', 'abort'].map(action =>
    [action, (ref, input) => ipcRenderer.invoke('cloud-fixture-' + action, ref, input)])),
}, onCloud: callback => ipcRenderer.on('cloud-fixture-state', (_event, state) => callback(state)) });
