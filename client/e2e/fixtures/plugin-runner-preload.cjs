const {contextBridge,ipcRenderer}=require('electron');
require('../../preload');
contextBridge.exposeInMainWorld('pluginTest',{
  catalog:()=>ipcRenderer.invoke('plugin-test-catalog'),
  audit:()=>ipcRenderer.invoke('plugin-test-audit'),
  shutdown:()=>ipcRenderer.invoke('plugin-test-shutdown'),
});
