'use strict';
/*
 * Persist the last explicitly selected conversation directory as a device preference.
 * Trusted main-frame callers may read and write it; validate existence on read and fall
 * back to the default workspace when invalid.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const file = app => path.join(app.getPath('userData'), 'recent-workspace.json');
const pages = new Set(['desk.html', 'index.html'].map(name => pathToFileURL(path.join(__dirname, '../..', name)).pathname));
function isTrusted(event) {
  try {
    const sender = event?.sender, url = new URL(sender.getURL());
    return !sender.isDestroyed() && Boolean(sender.mainFrame) && event.senderFrame === sender.mainFrame &&
      url.protocol === 'file:' && pages.has(url.pathname);
  } catch { return false; }
}
function normalizeDir(dir) {
  const value = String(dir || '').trim();
  if (!value) return '';
  try { return fs.statSync(value).isDirectory() ? value : ''; }
  catch { return ''; }
}
function snapshot(app) {
  try {
    const value = JSON.parse(fs.readFileSync(file(app), 'utf8'));
    const dir = value.schema === 1 ? normalizeDir(value.dir) : '';
    return { ok: true, dir, name: dir ? (String(value.name || '').trim() || path.basename(dir) || '所选文件夹') : '' };
  } catch { return { ok: true, dir: '', name: '' }; }
}
function save(app, dir, name) {
  const value = { schema: 1, dir, name: String(name || '').trim(), updatedAt: Date.now() };
  const destination = file(app), temporary = destination + '.' + randomUUID() + '.tmp';
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
  return { ok: true, dir, name: value.name || path.basename(dir) || '所选文件夹' };
}
function clear(app) {
  try { fs.unlinkSync(file(app)); } catch { /* A missing preference file is already cleared. */ }
  return { ok: true };
}
function install({ app, ipcMain }) {
  ipcMain.handle('recent-workspace-get', event => isTrusted(event)
    ? snapshot(app) : { ok: false, dir: '', name: '' });
  ipcMain.handle('recent-workspace-set', (event, input) => {
    if (!isTrusted(event)) return { ok: false, reason: '请在 SoduWork 工作区中选择工作位置' };
    const dir = normalizeDir(input && input.dir);
    if (!dir) return { ok: false, reason: '目录不存在或不可用' };
    return save(app, dir, input && input.name);
  });
  ipcMain.handle('recent-workspace-clear', event => isTrusted(event)
    ? clear(app) : { ok: false });
}
module.exports = { snapshot, install, isTrusted };
