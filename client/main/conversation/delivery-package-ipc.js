'use strict';
const fs = require('node:fs/promises');
const packages = require('./delivery-package-worker');
const preferences = require('../access-control/preferences');
function install({ ipcMain, session, BrowserWindow, dialog, resolveSession = async handle => handle }) {
  for (const action of ['inspect', 'prepare', 'save']) ipcMain.handle('conversation-delivery-' + action, async (event, ref, ids, expectedRevision) => {
    try {
      if (!preferences.isTrusted(event)) throw Error('请在 SoduWork 会话中操作成果');
      if (action === 'save' && expectedRevision !== undefined && !/^[a-f0-9]{64}$/.test(expectedRevision)) throw Error('成果版本无效，请重新打开后下载');
      const original = session.get(ref);
      if (!original) return { ok: false, code: 'DELIVERY_LOCAL_UNAVAILABLE', reason: '会话已关闭，请重新打开' };
      const handle = await resolveSession(original);
      const directory = handle.cwd, owner = handle.deliveryOwner;
      const guard = async () => {
        if (!preferences.isTrusted(event) || session.get(ref) !== original) throw Error('会话已变化，请重新打开成果');
        const current = await resolveSession(original);
        if (session.get(ref) !== original || current.cwd !== directory || current.deliveryOwner !== owner) {
          throw Error('账号或会话已变化，请重新打开成果');
        }
      };
      if (action === 'inspect') {
        const captured = await packages.capture(handle, ids);
        const metadata = { ok: true, manifest: captured.manifest, filename: captured.filename, contentType: captured.contentType };
        captured.cancel?.();
        await guard();
        return metadata;
      }
      let result;
      try { result = await packages.prepare(handle, ids); }
      catch (error) {
        const missing = error.code === 'ENOENT' || /^(?:成果文件已经不存在|这份成果已经更新，请刷新后重试|成果依赖缺失：)/.test(error.message || '');
        return { ok: false, ...(missing ? { code: 'DELIVERY_LOCAL_UNAVAILABLE' } : {}), reason: String(error.message || error) };
      }
      await guard();
      if (action === 'prepare') return { ok: true, manifest: result.manifest, filename: result.filename,
        contentType: result.contentType, data: result.bytes.toString('base64') };
      // Verify the complete immutable collection, including website dependencies,
      // before opening a dialog. A later local edit must never replace a saved version.
      if (expectedRevision && result.manifest.revision !== expectedRevision) return {
        ok: false, code: 'DELIVERY_REVISION_CHANGED', reason: '本地成果已更新，将下载此前保存的版本',
      };
      const parent = BrowserWindow.fromWebContents(event.sender);
      const choice = await dialog.showSaveDialog(parent, { title: '下载成果', defaultPath: result.filename });
      if (choice.canceled || !choice.filePath) return { ok: false, canceled: true };
      await guard();
      await fs.writeFile(choice.filePath, result.bytes);
      return { ok: true, filename: result.filename };
    } catch (error) { return { ok: false, reason: String(error.message || error) }; }
  });
}
module.exports = { install };
