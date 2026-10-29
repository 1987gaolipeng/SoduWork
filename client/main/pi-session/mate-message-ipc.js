'use strict';
const fs = require('fs');

function createPickFolderHandler({ BrowserWindow, dialog, shareArchive }) {
  return async (event) => {
    try {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(owner, require("../native-locale.cjs").dialogOptions({ title: 'Select a project folder to share', properties: ['openDirectory', 'createDirectory'] }));
      if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true };
      const folder = result.filePaths[0]; const archive = shareArchive.createZip(folder);
      const website = Boolean(shareArchive.collect(fs.realpathSync(folder)).result.some(file => /index\.(?:html?|xhtml)$/i.test(file.name)));
      return { ok: true, name: archive.name, size: archive.size, files: archive.files, data: archive.data.toString('base64'), website, preview: website ? { status: 'zip_only', reason: 'The complete website is packaged for safe preview in SoduWork' } : null };
    } catch (error) {
      return { ok: false, reason: String(error && error.message || 'Folder packaging failed') };
    }
  };
}

module.exports = { createPickFolderHandler };
