'use strict';

// A user initiated, short lived desktop capture. Pixels stay inside this main
// process and its isolated editor windows until the user copies or saves them.
const path = require('node:path');
const defaultFs = require('node:fs');
const { fileURLToPath } = require('node:url');
const nativeTheme = require('./native-theme.cjs');
const { writeImage } = require('./conversation/image-clipboard.js');

const MAX_PIXELS = 64 * 1024 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_DIMENSION = 32768;
const CHANNELS = ['screenshot-start', 'screenshot-data', 'screenshot-claim', 'screenshot-finish', 'screenshot-cancel', 'screenshot-ready'];
const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const failure = error => ({ ok: false, error: String(error?.message || error || '截图失败，请重试。') });

function captureSize(displays) {
  if (!Array.isArray(displays) || !displays.length || displays.length > 16) throw new Error('未找到可用显示器，请检查显示设置。');
  let width = 0, height = 0, total = 0;
  for (const display of displays) {
    const bounds = display?.bounds, scale = Number(display?.scaleFactor || 1);
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height, scale].every(Number.isFinite) ||
        bounds.width <= 0 || bounds.height <= 0 || scale <= 0) throw new Error('显示器尺寸不可用，请重试截图。');
    const w = Math.ceil(bounds.width * scale), h = Math.ceil(bounds.height * scale);
    if (w > MAX_DIMENSION || h > MAX_DIMENSION || w * h > MAX_PIXELS) throw new Error('显示器分辨率超出截图支持范围。');
    width = Math.max(width, w); height = Math.max(height, h); total += w * h;
  }
  if (total > MAX_PIXELS * 2) throw new Error('显示器总分辨率过大，请减少连接的显示器后重试。');
  return { width, height };
}

function pngPayload(dataUrl, nativeImage) {
  const prefix = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix) || dataUrl.length > MAX_BYTES * 4 / 3 + prefix.length + 4) {
    throw new Error('截图必须是有效的 PNG 图片，且不能超过 64 MB。');
  }
  const encoded = dataUrl.slice(prefix.length);
  if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('PNG 截图内容无效。');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 33 || bytes.length > MAX_BYTES ||
      !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG 截图内容无效。');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new Error('截图尺寸超出支持范围。');
  }
  const image = nativeImage.createFromBuffer(bytes);
  if (!image || image.isEmpty()) throw new Error('PNG 截图无法读取，请重新截图。');
  const size = image.getSize();
  if (size.width !== width || size.height !== height) throw new Error('PNG 截图尺寸校验失败。');
  return { bytes, image, width, height };
}

function create({ app, ipcMain, BrowserWindow, screen, desktopCapturer, nativeImage, clipboard, ClipboardItem, dialog,
  fs = defaultFs, getRendererRoot = () => app.getAppPath(), getTheme = nativeTheme.snapshot, timeoutMs = 20000, hideDelayMs = 180 }) {
  let active = null;
  const editorFile = () => path.join(getRendererRoot(), 'components', 'screenshot', 'screenshot.html');
  function trustedFrame(event, window, file) {
    try {
      const wc = event.sender;
      if (!window || window.isDestroyed() || wc !== window.webContents || wc.isDestroyed() || event.senderFrame !== wc.mainFrame) return false;
      const url = new URL(wc.getURL());
      return event.senderFrame.url === wc.getURL() && url.protocol === 'file:' && canonical(fileURLToPath(url)) === canonical(file);
    } catch (_) { return false; }
  }
  function ownerFor(event) {
    const window = BrowserWindow.fromWebContents(event.sender);
    return trustedFrame(event, window, path.join(getRendererRoot(), 'desk.html')) ? window : null;
  }
  function editorFor(event) {
    if (!active || active.done) return null;
    const row = active.editors.find(item => item.window.webContents === event.sender);
    return row && trustedFrame(event, row.window, active.file) ? row : null;
  }
  function listen(session, emitter, name, handler) {
    emitter.on(name, handler);
    session.listeners.push(() => emitter.removeListener(name, handler));
  }
  function complete(session, result) {
    if (!session || session.done) return;
    session.done = true;
    clearTimeout(session.timer);
    for (const remove of session.listeners.splice(0)) remove();
    for (const row of session.editors.splice(0)) {
      row.dataUrl = '';
      row.resolveReady(false);
      try { if (!row.window.isDestroyed()) row.window.destroy(); } catch (_) {}
    }
    if (active === session) active = null;
    if (session.ownerWasVisible && !session.owner.isDestroyed()) {
      try { session.owner.show(); session.owner.focus(); } catch (_) {}
    }
    session.resolve(result);
  }
  async function prepare(session) {
    if (session.hideOwner && session.ownerWasVisible) {
      session.owner.hide();
      if (session.owner.isVisible()) throw new Error('无法隐藏当前窗口，请重试截图。');
      // Allow the desktop compositor to replace the hidden window before freezing pixels.
      if (hideDelayMs > 0) await new Promise(resolve => setTimeout(resolve, hideDelayMs));
      if (active !== session || session.done) return;
    }
    const displays = screen.getAllDisplays();
    captureSize(displays);
    const groups = new Map();
    for (const display of displays) {
      const size = captureSize([display]), key = size.width + 'x' + size.height;
      if (!groups.has(key)) groups.set(key, { size, displays: [] });
      groups.get(key).displays.push(display);
    }
    // Take every snapshot before creating any editor, otherwise a second screen
    // could capture the first screen's overlay. Never pair monitors by index.
    // Electron may upscale thumbnails to the requested size. A single maximum
    // target would enlarge smaller monitors, so acquire each physical-size group
    // separately and only retain that group's precisely matched display sources.
    const frames = [];
    for (const group of groups.values()) {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: group.size });
      if (active !== session || session.done) return;
      for (const display of group.displays) {
        const source = sources.find(item => String(item.display_id) === String(display.id));
        if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
          throw new Error('无法读取显示器画面，请检查系统录屏权限并重试。');
        }
        const size = source.thumbnail.getSize();
        if (!size.width || !size.height || size.width * size.height > MAX_PIXELS) throw new Error('显示器画面尺寸不可用。');
        const bytes = source.thumbnail.toPNG();
        if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('显示器截图过大，请降低分辨率后重试。');
        frames.push({ display, width: size.width, height: size.height, dataUrl: 'data:image/png;base64,' + bytes.toString('base64') });
      }
    }
    const snapshot = getTheme(session.owner) || {}, theme = { ...snapshot, accent: snapshot.tokens?.['--accent'] };
    const loads = frames.map(async frame => {
      if (session.done) return;
      const window = new BrowserWindow({ ...frame.display.bounds, show: false, frame: false, transparent: false,
        thickFrame: false, roundedCorners: false, useContentSize: true,
        backgroundColor: '#000000', title: 'SoduWork 截图', alwaysOnTop: true, skipTaskbar: true,
        resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
        hasShadow: false, autoHideMenuBar: true, enableLargerThanScreen: true,
        webPreferences: { preload: path.join(__dirname, 'screenshot-preload.cjs'), contextIsolation: true,
          nodeIntegration: false, sandbox: true, webSecurity: true, devTools: !app.isPackaged, zoomFactor: 1,
          backgroundThrottling: false, spellcheck: false }
      });
      const row = { ...frame, window, theme, ready: false };
      row.readyPromise = new Promise(resolve => { row.resolveReady = resolve; });
      session.editors.push(row);
      // On Windows the constructor clamps to workArea, excluding the taskbar.
      // Remove WS_THICKFRAME and restore full display bounds after HWND creation.
      // This keeps the screenshot's pixels aligned with the entire monitor.
      window.setBounds(frame.display.bounds);
      window.setMenu(null);
      window.setAlwaysOnTop(true, 'screen-saver');
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      window.webContents.setIgnoreMenuShortcuts(true);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      listen(session, window.webContents, 'will-navigate', event => event.preventDefault());
      listen(session, window.webContents, 'will-attach-webview', event => event.preventDefault());
      listen(session, window.webContents, 'render-process-gone', () => complete(session, failure('截图编辑器已关闭，请重新截图。')));
      listen(session, window.webContents, 'did-fail-load', (_event, code) => {
        if (code !== -3) complete(session, failure('无法打开截图编辑器，请重新截图。'));
      });
      listen(session, window, 'closed', () => complete(session, { ok: true, cancelled: true }));
      await window.loadFile(session.file);
    });
    await Promise.all(loads);
    if (active !== session || session.done) return;
    await Promise.all(session.editors.map(row => row.readyPromise));
    if (active !== session || session.done) return;
    clearTimeout(session.timer);
    for (const row of session.editors) row.window.showInactive();
    const nearest = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const focus = session.editors.find(row => String(row.display.id) === String(nearest.id)) || session.editors[0];
    focus.window.focus();
  }
  function start(event, input) {
    const owner = ownerFor(event);
    if (!owner) return Promise.resolve(failure('只能从 SoduWork 工作窗口开始截图。'));
    if (!app.isReady()) return Promise.resolve(failure('应用尚未准备就绪，请稍后重试。'));
    if (active) return Promise.resolve(failure('截图正在进行，请完成或按 Esc 取消后重试。'));
    const session = { owner, ownerWasVisible: owner.isVisible(), hideOwner: input?.hideOwner === true,
      file: editorFile(), editors: [], listeners: [], done: false, claimed: null, finishing: false };
    session.promise = new Promise(resolve => { session.resolve = resolve; });
    active = session;
    listen(session, owner, 'closed', () => complete(session, { ok: true, cancelled: true }));
    listen(session, owner.webContents, 'render-process-gone', () => complete(session, { ok: true, cancelled: true }));
    listen(session, owner.webContents, 'did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) complete(session, { ok: true, cancelled: true });
    });
    for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) {
      listen(session, screen, name, () => complete(session, failure('显示器设置已变化，请重新截图。')));
    }
    session.timer = setTimeout(() => complete(session, failure('读取屏幕超时，请检查录屏权限后重试。')), timeoutMs);
    session.timer.unref?.();
    void prepare(session).catch(error => complete(session, failure(error)));
    return session.promise;
  }
  function getCapture(event) {
    const row = editorFor(event);
    if (!row) return failure('截图窗口已失效，请重新截图。');
    let physicalBounds = null;
    try { physicalBounds = screen.dipToScreenRect?.(null, row.display.bounds) || null; } catch (_) {}
    return { dataUrl: row.dataUrl, width: row.width, height: row.height, displayId: String(row.display.id),
      displayName: row.display.label || '显示器', bounds: { ...row.display.bounds }, scaleFactor: row.display.scaleFactor || 1,
      nativeOrigin: row.display.nativeOrigin ? { ...row.display.nativeOrigin } : null,
      physicalBounds, theme: row.theme };
  }
  function claim(event) {
    const row = editorFor(event);
    if (!row || (active.claimed && active.claimed !== row)) return failure('请在已选择的显示器中完成截图。');
    active.claimed = row;
    for (const other of active.editors) if (other !== row) other.window.hide();
    return { ok: true };
  }
  function ready(event) {
    const row = editorFor(event);
    if (!row) return failure('截图窗口已失效，请重新截图。');
    row.ready = true;
    row.resolveReady(true);
    return { ok: true };
  }
  async function finish(event, input) {
    const row = editorFor(event), session = active;
    if (!row || session.claimed !== row) return failure('请先选择要截取的区域。');
    if (session.finishing) return failure('正在处理截图，请稍候。');
    if (!input || !['copy', 'save'].includes(input.action)) return failure('不支持的截图操作。');
    session.finishing = true;
    try {
      const capture = pngPayload(input.dataUrl, nativeImage);
      if (capture.width > row.width || capture.height > row.height) throw new Error('截图区域超出当前显示器范围。');
      if (input.action === 'copy') {
        await writeImage(capture.image, { clipboard, ClipboardItem });
        if (session.done || active !== session) return { ok: false, cancelled: true };
      }
      else {
        // A native save dialog must be above the capture editor; temporarily
        // leave the screen-saver level and restore it on cancel or write error.
        row.window.setAlwaysOnTop(false);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const answer = await dialog.showSaveDialog(row.window, { title: '保存截图',
          defaultPath: 'SoduWork-截图-' + stamp + '.png', filters: [{ name: 'PNG 图片', extensions: ['png'] }],
          properties: ['createDirectory', 'showOverwriteConfirmation'] });
        if (session.done || active !== session) return { ok: false, cancelled: true };
        if (answer.canceled || !answer.filePath) return { ok: false, cancelled: true };
        await fs.promises.writeFile(answer.filePath, capture.bytes);
        if (session.done || active !== session) return { ok: false, cancelled: true };
      }
      complete(session, { ok: true, action: input.action });
      return { ok: true };
    } catch (error) {
      return failure(error);
    } finally {
      session.finishing = false;
      if (!session.done && !row.window.isDestroyed()) {
        row.window.setAlwaysOnTop(true, 'screen-saver'); row.window.show(); row.window.focus();
      }
    }
  }
  function cancel(event) {
    if (!editorFor(event)) return failure('截图窗口已失效。');
    complete(active, { ok: true, cancelled: true });
    return { ok: true };
  }
  const handlers = [start, getCapture, claim, finish, cancel, ready];
  CHANNELS.forEach((channel, index) => ipcMain.handle(channel, handlers[index]));
  return { dispose() {
    complete(active, { ok: true, cancelled: true });
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  } };
}

function install(options) { return create({ ...require('electron'), ...options }); }
module.exports = { create, install, captureSize, pngPayload };
