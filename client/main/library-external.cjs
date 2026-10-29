'use strict';

/*
 * Open Hub library files through the main-process trust boundary. Validate item IDs, cache
 * authenticated bytes in item-specific directories, and open or reveal them without
 * automatically executing programs or scripts.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canOpenWithSystem, safeFilename } = require('./attachment-files.js');

let DEPS = null;
const ITEM_ID = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_BASE64 = Math.ceil(MAX_BYTES / 3) * 4 + 8;

function targetRoot(itemId, digest) {
  return path.join(DEPS.app.getPath('userData'), 'library-files', String(itemId), digest);
}

/*
 * Cache originals by item ID and content hash. Preserve existing copies that users may
 * have edited in external applications.
 */
function materialize(payload) {
  const itemId = String((payload && payload.itemId) || '');
  if (!ITEM_ID.test(itemId)) throw new Error('资料条目标识无效，请刷新资料库后重试');
  const data = String((payload && payload.data) || '');
  if (!data) throw new Error('文件内容为空，请重新打开或重新入库');
  if (data.length > MAX_BASE64) throw new Error('文件超过 64MB，请下载后使用');
  let bytes;
  try { bytes = Buffer.from(data, 'base64'); } catch (_) { throw new Error('文件内容解码失败，请重新打开'); }
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('文件超过 64MB，请下载后使用');
  const filename = safeFilename((payload && payload.filename) || '', 'library-file');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const dir = targetRoot(itemId, digest);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, filename);
  try {
    fs.writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!fs.statSync(target).isFile()) throw new Error('本地副本位置不是文件，请下载后使用');
  }
  return target;
}

function parentWindow(event) {
  const win = DEPS.BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) throw new Error('当前窗口已经关闭');
  return win;
}

async function openExternal(event, payload) {
  parentWindow(event);
  const target = materialize(payload);
  if (!canOpenWithSystem(path.basename(target)) && !/\.(?:pdf|txt|md|csv|png|jpe?g|gif|webp|bmp|avif|mp3|mp4|wav|webm|zip)$/i.test(target)) {
    throw new Error('这类文件没有关联的系统应用，请下载后自行打开；应用不会自动运行程序或脚本');
  }
  const error = await DEPS.shell.openPath(target);
  if (error) throw new Error('系统没有可打开这个文件的应用：' + error);
  return { ok: true, path: target };
}

async function reveal(event, payload) {
  parentWindow(event);
  const target = materialize(payload);
  DEPS.shell.showItemInFolder(target);
  return { ok: true, path: target };
}

function install(deps) {
  DEPS = deps;
  deps.ipcMain.handle('library-open-external', openExternal);
  deps.ipcMain.handle('library-reveal', reveal);
}

module.exports = { install };
