'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('soduWorkAPI', {
  conversationSession: { outputs: () => Promise.resolve({ ok: true, files: [] }) },
  previewAttachment: payload => ipcRenderer.invoke('attachment-preview', payload),
});
contextBridge.exposeInMainWorld('cloudFixture', {
  attachments: taskId => ipcRenderer.invoke('handoff-e2e-attachments', taskId),
});
