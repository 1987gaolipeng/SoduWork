'use strict';

function createPickFolderHandler({ BrowserWindow, dialog, shareArchive }) {
  return async (event) => {
    try {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(owner, require("../native-locale.cjs").dialogOptions({ title: 'Select a project folder to share', properties: ['openDirectory', 'createDirectory'] }));
      if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true };
      const abort = new AbortController();
      const cancel = () => abort.abort();
      owner?.once?.('closed', cancel);
      let archive;
      try {
        if (owner?.isDestroyed?.()) return { ok: false, canceled: true };
        archive = await shareArchive.createZipAsync(result.filePaths[0], { signal: abort.signal });
      } finally { owner?.removeListener?.('closed', cancel); }
      const website = archive.website;
      return { ok: true, name: archive.name, size: archive.size, files: archive.files, data: archive.base64, website, preview: website ? { status: 'zip_only', reason: 'The complete website is packaged for safe preview in SoduWork' } : null };
    } catch (error) {
      return { ok: false, ...(error?.code === 'ABORT_ERR' ? { canceled: true } : {}), reason: String(error && error.message || 'Folder packaging failed') };
    }
  };
}

module.exports = { createPickFolderHandler };
