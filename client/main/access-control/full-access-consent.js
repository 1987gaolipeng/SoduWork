'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const locale = require('../native-locale.cjs');
const placement = require('./consent-position.cjs');
const PAGE = path.join(__dirname, 'full-access-consent.html');
const PAGE_URL = pathToFileURL(PAGE).href;
const DATA = 'soduwork-full-access-consent:data';
const ANSWER = 'soduwork-full-access-consent:answer';
const SIZE = 'soduwork-full-access-consent:size';
const THEME = 'soduwork-full-access-consent:theme';

function content(scope) {
  const t = locale.translate;
  const value = {
    lang: locale.getLocale(), title: t('允许完全访问？'),
    description: t('仅对此会话生效，可随时调整'),
    category: t('权限调整'), scope: t('访问范围'), scopeValue: t('仅此会话'), full: t('完全访问'),
    impact: t('可读写文件、运行命令并访问网络。'),
    detailShow: t('查看权限明细'), detailHide: t('收起权限明细'),
    adjustment: t('可随时在对话中调整。'),
    files: t('文件'), filesDetail: t('读写工作区内外文件'),
    terminal: t('命令'), terminalDetail: t('执行命令、安装软件'),
    network: t('网络'), networkDetail: t('访问网站与连接器'),
    acknowledge: t('我已了解这些权限的影响'), allow: t('允许完全访问'),
    cancel: t('取消'), close: t('关闭'),
  };
  if (scope === 'default') Object.assign(value, {
    title: t('默认使用完全访问？'), description: t('此设备上新建的对话将默认拥有完全访问权限'),
    category: t('默认授权模式'), scopeValue: t('此设备的新建对话'),
    adjustment: t('持续生效，直到在设置中更改；已有会话不受影响。'),
    allow: t('设为默认完全访问'),
  });
  return value;
}

// The confirmation renderer is a dedicated sandbox, never a workspace preview
// or a normal chat renderer. There is no renderer-supplied "consent" flag.
function create({ BrowserWindow, ipcMain, screen, timeoutMs = 180000, themeSource = require('../native-theme.cjs') }) {
  const pending = new Map(), owners = new Map();
  const validOwner = parent => parent && !parent.isDestroyed() &&
    parent.webContents && !parent.webContents.isDestroyed();
  function entry(event) {
    const item = pending.get(event?.sender?.id);
    if (!item || item.window.isDestroyed() || event.sender !== item.window.webContents ||
      event.senderFrame !== item.window.webContents.mainFrame ||
      event.senderFrame?.url !== PAGE_URL || event.sender.getURL() !== PAGE_URL) return null;
    return item;
  }
  ipcMain.handle(DATA, event => {
    const item = entry(event);
    if (!item || !item.ownerValid()) return null;
    item.presented = true;
    return { requestId: item.id, ...content(item.scope), appearance: themeSource.snapshot(item.parent) };
  });
  ipcMain.handle(ANSWER, (event, value) => {
    const item = entry(event);
    if (!item) return { ok: false };
    const approved = item.presented && item.ownerValid() && value?.requestId === item.id &&
      value?.decision === 'allow' && value?.acknowledged === true;
    item.finish(approved);
    return { ok: true };
  });
  // The renderer reports its natural content height so the window hugs the
  // content instead of floating a fixed oversized panel.
  ipcMain.handle(SIZE, (event, value) => {
    const item = entry(event);
    const natural = Math.round(Number(value));
    if (!item || item.window.isDestroyed() || !Number.isFinite(natural) || natural <= 0) return { ok: false };
    try {
      item.naturalHeight = natural;
      item.window.setBounds(item.position(natural));
    } catch (_) { /* A closing window simply keeps its last size. */ }
    return { ok: true };
  });

  return function confirmFullAccess(parent, options = {}) {
    if (!validOwner(parent)) return Promise.resolve(false);
    // A second request cannot reuse a consent being shown for another opening.
    // Cancel both to avoid an ambiguous authorization target.
    if (owners.has(parent.webContents.id)) {
      owners.get(parent.webContents.id).finish(false);
      return Promise.resolve(false);
    }
    return new Promise(resolve => {
      const ownerContents = parent.webContents, ownerURL = ownerContents.getURL();
      const source = options.source, sourceURL = source?.getURL();
      const disposers = [];
      let window, timer, done = false;
      const item = { id: randomUUID(), presented: false, window: null, parent, scope: options.scope === 'default' ? 'default' : 'session',
        ownerValid: () => validOwner(parent) && parent.webContents === ownerContents && ownerContents.getURL() === ownerURL &&
          (!source || (!source.isDestroyed() && source.getURL() === sourceURL && !!placement.sourceBounds(parent, source))),
        finish(approved) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          owners.delete(ownerContents.id);
          if (item.contentsId != null) pending.delete(item.contentsId);
          for (const dispose of disposers.splice(0)) dispose();
          try { if (window && !window.isDestroyed()) window.destroy(); } catch (_) {}
          resolve(approved === true);
        } };
      const on = (target, name, listener) => {
        target.on(name, listener);
        disposers.push(() => target.removeListener(name, listener));
      };
      const cancel = () => item.finish(false);
      try {
        item.position = placement.create(parent, options, screen); item.naturalHeight = 360;
        window = new BrowserWindow({
          parent, modal: true, ...item.position(item.naturalHeight),
          show: false, frame: false, transparent: true, backgroundColor: '#00000000',
          title: locale.translate('允许完全访问？'), resizable: false, minimizable: false,
          maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: true,
          autoHideMenuBar: true,
          webPreferences: { preload: path.join(__dirname, 'full-access-consent-preload.cjs'),
            contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
            webviewTag: false, spellcheck: false, devTools: false,
            partition: 'soduwork-full-access-consent-' + item.id },
        });
        item.window = window;
        item.contentsId = window.webContents.id;
        owners.set(ownerContents.id, item);
        pending.set(window.webContents.id, item);
        const wc = window.webContents;
        disposers.push(themeSource.subscribe(parent, appearance => {
          if (!done && item.ownerValid() && item.presented) wc.send(THEME, { requestId: item.id, appearance });
        }));
        wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
        wc.session.setPermissionCheckHandler(() => false);
        wc.session.on('will-download', event => event.preventDefault());
        // Even the isolated page has no network or arbitrary file access.
        const resources = new Set([PAGE_URL, ...['full-access-consent.css', 'full-access-consent-view.js'].map(file =>
          pathToFileURL(path.join(__dirname, file)).href), pathToFileURL(path.join(__dirname, '../../theme/variables.css')).href]);
        wc.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !resources.has(details.url) }));
        wc.setWindowOpenHandler(() => { cancel(); return { action: 'deny' }; });
        on(wc, 'will-navigate', event => { event.preventDefault(); cancel(); });
        on(wc, 'will-redirect', event => { event.preventDefault(); cancel(); });
        on(wc, 'will-attach-webview', event => { event.preventDefault(); cancel(); });
        on(wc, 'did-start-navigation', (_event, url, inPlace, isMainFrame) => {
          if (isMainFrame && (url !== PAGE_URL || inPlace || item.presented)) cancel();
        });
        on(wc, 'did-fail-load', cancel);
        on(wc, 'render-process-gone', cancel);
        on(wc, 'destroyed', cancel);
        on(window, 'closed', cancel);
        on(parent, 'closed', cancel);
        const reposition = () => { try { window.setBounds(item.position(item.naturalHeight)); } catch (_) { cancel(); } };
        on(parent, 'move', reposition); on(parent, 'resize', reposition);
        if (source && source !== ownerContents) {
          on(source, 'destroyed', cancel); on(source, 'render-process-gone', cancel);
          on(source, 'did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) cancel(); });
        }
        on(ownerContents, 'destroyed', cancel);
        on(ownerContents, 'did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) cancel(); });
        on(wc, 'before-input-event', (event, input) => { if (input.key === 'Escape') { event.preventDefault(); cancel(); } });
        on(window, 'ready-to-show', () => { if (!done && item.ownerValid()) { window.show(); window.focus(); } else cancel(); });
        timer = setTimeout(cancel, timeoutMs);
        Promise.resolve(window.loadFile(PAGE)).catch(cancel);
      } catch (_) { cancel(); }
    });
  };
}

let production;
function confirm(parent, options) {
  if (!production) production = create(require('electron'));
  return production(parent, options);
}
module.exports = { create, confirm, content };
