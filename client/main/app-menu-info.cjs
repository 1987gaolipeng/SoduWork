'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { parseVersion, newer } = require('./client-update-contract');
const nativeLocale = require('./native-locale.cjs');
const packageInfo = require('../package.json');
const bundledHistory = require('./release-history.json');

const distribution = require('./distribution.cjs');
const hubEndpoint = require('./hub-endpoint.cjs');
const canonical = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const hubWebsite = app => hubEndpoint.current(app)?.hub || distribution.current().hubOrigin;

function appInfo(app) {
  const version = app.getVersion();
  // This is the installed package's published history, not the working tree's
  // pending changes or the administrator-only release catalogue.
  const releaseHistory = parseVersion(version) ? bundledHistory.releases
    .filter(row => parseVersion(row.version) && !newer(row.version, version))
    .sort((a, b) => newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0)
    .map(({ version, date, status, title, notes }) => ({ version, date, status, title, notes: [...notes] })) : [];
  return { name: distribution.current().productName, version, description: packageInfo.description || '',
    // The help entry follows this installation's active Hub, including isolated source profiles.
    license: packageInfo.license || '', website: hubWebsite(app), releaseHistory };
}

function createTrustedWindow({ app, BrowserWindow, getRendererRoot }) {
  const sources = new Set(['desk.html', 'index.html'].map(file => canonical(path.join(app.getAppPath(), file))));
  function trustedSource(file) {
    if (sources.has(file)) return true;
    // Query the active renderer root for every check. Retired update roots must
    // lose this capability, including while an exit confirmation is open.
    const root = typeof getRendererRoot === 'function' ? getRendererRoot() : null;
    return typeof root === 'string' && path.isAbsolute(root) &&
      ['desk.html', 'index.html'].some(name => canonical(path.join(root, name)) === file);
  }
  return function trustedWindow(event) {
    try {
      const wc = event.sender, parent = BrowserWindow.fromWebContents(wc);
      if (!parent || parent.isDestroyed() || wc.isDestroyed() || parent.webContents !== wc || event.senderFrame !== wc.mainFrame) return null;
      const url = new URL(wc.getURL());
      if (event.senderFrame.url !== wc.getURL() || url.protocol !== 'file:' || !trustedSource(canonical(fileURLToPath(url)))) return null;
      return parent;
    } catch (_) { return null; }
  };
}

function install({ app, ipcMain, BrowserWindow, dialog, quit, getRendererRoot, shell, openNewConversation, releaseNotes }) {
  const trustedWindow = createTrustedWindow({ app, BrowserWindow, getRendererRoot });
  let pending = null, quitting = false;
  function requireWindow(event) {
    const parent = trustedWindow(event);
    if (!parent) throw new Error('Application menu is only available in the SoduWork window');
    return parent;
  }
  async function withHistory(info) {
    if (!releaseNotes) return info;
    const data = await releaseNotes.list(nativeLocale.getLocale());
    return { ...info, releaseHistory: data.releases.map(row => ({ version: row.version, date: '',
      title: row.summary, notes: [row.summary, ...row.sections.flatMap(s => [s.title, ...s.items.map(i => i.text)])] })) };
  }
  ipcMain.handle('app-info', event => {
    requireWindow(event);
    if (!releaseNotes) return appInfo(app);
    return withHistory(appInfo(app)).then(info => {
      requireWindow(event);
      // Release history may finish after the user selects a different Hub.
      return { ...info, website: hubWebsite(app) };
    });
  });
  async function requestQuit(event) {
    const parent = requireWindow(event);
    if (quitting) return { ok: true, canceled: false };
    if (pending) return pending;
    const job = Promise.resolve().then(async () => {
      const answer = await dialog.showMessageBox(parent, nativeLocale.dialogOptions({
        type: 'warning', title: 'SoduWork', message: '退出 SoduWork？',
        detail: '退出后，本机正在运行的对话和后台工作会停止。',
        buttons: ['继续使用', '确认退出'], defaultId: 0, cancelId: 0, noLink: true,
      }));
      // A closed or navigated-away requester cannot finish a privileged action.
      if (answer.response !== 1 || trustedWindow(event) !== parent) return { ok: true, canceled: true };
      quitting = true;
      try { quit('app-menu'); } catch (error) { quitting = false; throw error; }
      return { ok: true, canceled: false };
    });
    pending = job;
    try { return await job; } finally { if (pending === job) pending = null; }
  }
  ipcMain.handle('app-request-quit', requestQuit);
  async function nativeCommand(command, win) {
    const event = { sender: win?.webContents, senderFrame: win?.webContents?.mainFrame };
    requireWindow(event);
    if (command === 'quit') return requestQuit(event);
    if (command === 'new' && openNewConversation) { openNewConversation(); return true; }
    const info = appInfo(app);
    if (command === 'website' && shell && info.website) { await shell.openExternal(info.website); return true; }
    if (!['history', 'about'].includes(command)) return false;
    const detail = command === 'history' ? info.releaseHistory.map(row =>
      `v${row.version} · ${row.date}${row.status === 'withdrawn' ? ' · ' + nativeLocale.translate('已撤回') : ''}\n` +
      row.notes.map(nativeLocale.translate).join('\n')).join('\n\n') || nativeLocale.translate('当前安装包未附带版本记录。')
      : `SoduWork ${info.version}\n${info.description}\n${info.website}`;
    await dialog.showMessageBox(win, nativeLocale.dialogOptions({ type: 'info', title: 'SoduWork',
      message: command === 'history' ? '版本历史' : '关于 SoduWork', detail, buttons: ['关闭'], noLink: true }));
    return true;
  }
  return { nativeCommand };
}

module.exports = { appInfo, install, createTrustedWindow };
