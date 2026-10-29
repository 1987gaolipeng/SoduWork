'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fullAccessConsent', Object.freeze({
  content: () => ipcRenderer.invoke('soduwork-full-access-consent:data'),
  answer: value => ipcRenderer.invoke('soduwork-full-access-consent:answer', {
    requestId: value?.requestId, decision: value?.decision,
    acknowledged: value?.acknowledged === true,
  }),
  size: height => ipcRenderer.invoke('soduwork-full-access-consent:size', height),
  onTheme: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('soduwork-full-access-consent:theme', listener);
    return () => ipcRenderer.removeListener('soduwork-full-access-consent:theme', listener);
  },
}));
