'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isTrusted } = require('./access-control/preferences.js');
const { canOpenWithSystem } = require('./attachment-files.js');
const storage = require('./library-local-store.cjs');
const { execute } = require('./library-local-actions.cjs');
const { replaceFile } = require('./verified-file-replace.cjs');

function install(deps) {
  const ownerOf = deps.ownerOf || (() => require('./device-auth.js').localOwner(deps.app));
  function trusted(event) { if (!isTrusted(event)) throw storage.error('LOCAL_LIBRARY_UNTRUSTED', '请在资料库窗口操作本机文件'); }
  deps.ipcMain.handle('library-local-context', async event => {
    trusted(event); const owner = ownerOf();
    return { owner: storage.OWNER.test(owner) ? owner : '' };
  });
  deps.ipcMain.handle('library-local-call', async (event, action, payload = {}) => {
    const owner = String(payload.owner || '');
    const guard = () => {
      trusted(event);
      if (!storage.OWNER.test(owner) || ownerOf() !== owner) throw storage.error('STALE_TASK_SCOPE', '当前账号已变化或尚未登录，请重新打开资料库');
    };
    guard(); const store = storage.create(deps.app, owner, guard);
    return store.run(async index => {
      const result = await execute(store, index, String(action), payload); guard();
      if (!['openExternal', 'reveal', 'exportFile'].includes(action)) return result;
      const win = deps.BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) throw storage.error('LOCAL_LIBRARY_UNTRUSTED', '当前窗口已经关闭');
      const { target, row } = result;
      if (action === 'reveal') { guard(); deps.shell.showItemInFolder(target); return { ok: true, path: target }; }
      if (action === 'openExternal') {
        if (!canOpenWithSystem(row.filename) && !/\.(pdf|txt|md|csv|png|jpe?g|gif|webp|bmp|avif|mp3|mp4|wav|webm|zip)$/i.test(row.filename)) throw storage.error('LOCAL_LIBRARY_FORMAT_UNSUPPORTED', '此格式请先导出后自行打开；应用不会运行程序或脚本');
        guard(); const reason = await deps.shell.openPath(target); guard();
        if (reason) throw storage.error('LOCAL_LIBRARY_OPEN_FAILED', '系统应用打开失败：' + reason);
        return { ok: true, path: target };
      }
      const selected = await deps.dialog.showSaveDialog(win, { title: '导出本机资料', defaultPath: path.join(deps.app.getPath('downloads'), row.filename), properties: ['showOverwriteConfirmation'] });
      guard(); if (selected.canceled || !selected.filePath) return { ok: false, cancelled: true };
      const destination = path.resolve(selected.filePath);
      if (destination === target) return { ok: true, path: target };
      // Only a native dialog can choose an export path. The renderer cannot
      // supply an arbitrary source or destination, or overwrite the index.
      const relative = path.relative(store.libraryRoot, destination);
      if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw storage.error('LOCAL_LIBRARY_UNSAFE_PATH', '请导出到资料库内部目录以外的位置');
      const checkDestination = async () => {
        guard();
        const parts = path.parse(destination), relative = path.relative(parts.root, path.dirname(destination));
        let current = parts.root;
        for (const part of relative.split(path.sep).filter(Boolean)) {
          current = path.join(current, part); const stat = await fs.lstat(current); guard();
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw storage.error('LOCAL_LIBRARY_UNSAFE_PATH', '导出目录包含链接');
        }
        try { const stat = await fs.lstat(destination); guard(); if (stat.isSymbolicLink() || !stat.isFile()) throw storage.error('LOCAL_LIBRARY_UNSAFE_PATH', '导出目标不是普通文件'); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      };
      await checkDestination(); await store.checkedFile(target); guard();
      const temporary = destination + '.' + crypto.randomUUID() + '.tmp';
      try {
        await fs.copyFile(target, temporary, require('node:fs').constants.COPYFILE_EXCL); guard();
        await replaceFile(temporary, destination, { check: guard, checkPath: checkDestination }); guard();
      } finally { await fs.unlink(temporary).catch(() => {}); }
      return { ok: true, path: destination };
    });
  });
}
module.exports = { install };
