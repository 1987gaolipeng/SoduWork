'use strict';
// Expose isolated library test channels only; this is not the production preload.
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('requirementsFixtureLibrary',{
 context:payload=>ipcRenderer.invoke('requirements-fixture-library','context',payload),
 call:(action,payload)=>ipcRenderer.invoke('requirements-fixture-library',action,payload),
});
