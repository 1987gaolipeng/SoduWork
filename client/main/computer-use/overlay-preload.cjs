'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('soduWorkComputerOverlay', {
  onState(callback) { ipcRenderer.on('computer-overlay-state', (_event, state) => callback(state)); },
  ready() { ipcRenderer.send('computer-overlay-ready'); },
});
