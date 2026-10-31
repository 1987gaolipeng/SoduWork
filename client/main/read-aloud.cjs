'use strict';
function install({ app, ipcMain, BrowserWindow, getRendererRoot }) {
  const trusted = require('./app-menu-info.cjs').createTrustedWindow({ app, BrowserWindow, getRendererRoot });
  ipcMain.handle('read-aloud-claim', event => {
    if (!trusted(event)) throw Error('Read aloud requires a trusted application window');
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && window.webContents.id !== event.sender.id) {
        window.webContents.send('read-aloud-stop');
      }
    }
    return true;
  });
}
module.exports = { install };
