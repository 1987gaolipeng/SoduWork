'use strict';

// Detached application surfaces share the existing preview owner/session pool.
// Their page, chrome and composer geometry live here; inline navigation cleanup
// remains in work-preview.js and must not dispose these independent windows.
const path = require('node:path');
const appOwner = require('./work-preview-app-owner.cjs');
const windowSizing = require('../core/app-window-sizing');
const COMPOSER_PRELOAD = path.join(__dirname, '..', 'preload.js');
const CHROME_PRELOAD = path.join(__dirname, 'app-chrome-preload.cjs');
const CHROME_HTML = path.join(__dirname, '..', 'app-window-chrome.html');
const COMPOSER_PAGE = path.join(__dirname, '..', 'desk.html');
const COMPOSER_TITLE_H = 30, COMPOSER_APP_MARGIN = 10;
const COMPOSER_RAIL_W = 64, COMPOSER_RAIL_H = 80, COMPOSER_FLOAT_W = 336;

function setViewBounds(view, bounds) {
  const previous = view.getBounds();
  if (['x', 'y', 'width', 'height'].every(key => previous[key] === bounds[key])) return false;
  view.setBounds(bounds);
  return true;
}

function create({ owners: OWNERS, getDeps, ownerFor, ownerSession, safeWebUrl,
  normalizeAppBridge, cleanTabId, createView, destroyTab, liveContents, loadTarget }) {
  function windowDisplay(event) {
    const owner = ownerFor(event), screen = getDeps().screen;
    let display;
    try {
      if (screen && owner?.host?.getBounds) display = screen.getDisplayMatching(owner.host.getBounds());
      if (!display && screen) display = screen.getPrimaryDisplay();
    } catch (_) { try { display = screen?.getPrimaryDisplay(); } catch (_) {} }
    const area = display?.workArea || { x: 0, y: 0, width: 1280, height: 800 };
    return { ok: true, workArea: { x: area.x, y: area.y, width: area.width, height: area.height }, scaleFactor: display?.scaleFactor || 1 };
  }
  /*
   * Handle application composer expansion and content insertion in the main process, which
   * owns the composer view.
   */
  function composerControl(owner, item, request, attachmentOwner = item) {
    appOwner.assertCurrent(item);
    appOwner.assertCurrent(attachmentOwner);
    const composer = item.composer;
    if (!composer || !composer.view || composer.view.webContents.isDestroyed()) {
      return { ok: false, code: 'APP_COMPOSER_GONE', reason: '输入框没有就绪，请稍后重试' };
    }
    const method = request.method;
    try {
      if (method === 'composer.send') {
        composer.expanded = true;
        layoutAllDetached(owner, item);
        composer.view.webContents.send('app-composer-mode', composerModePayload(item));
        return require('./work-preview-app-chat.cjs').send(item, request.params, attachmentOwner);
      }
      if (method === 'composer.expand') {
        /* Expand pins the sidebar and reduces application width; collapse returns to the narrow edge rail. */
        composer.expanded = method === 'composer.expand';
        composer.hover = false;
        layoutAllDetached(owner, item);
        composer.view.webContents.send('app-composer-mode', composerModePayload(item));
        return { ok: true, state: composer.expanded ? 'pinned' : 'rail' };
      }
      if (method === 'composer.collapse') {
        composer.expanded = false;
        composer.hover = false;
        layoutAllDetached(owner, item);
        composer.view.webContents.send('app-composer-mode', composerModePayload(item));
        return { ok: true, state: 'rail' };
      }
      if (method === 'composer.theme') {
        composer.theme = request.params.theme === 'dark' ? 'dark' : 'light';
        composer.view.webContents.send('app-composer-mode', composerModePayload(item));
        return { ok: true };
      }
      if (method === 'composer.insertText') {
        composer.collapsed = false; // Expand before inserting text so the change is visible.
        composer.view.webContents.send('app-composer-mode', composerModePayload(item));
        composer.view.webContents.send('app-composer-put', { text: request.params.text, append: request.params.append === true });
        return { ok: true };
      }
      if (method === 'composer.insertAttachment') {
        composer.collapsed = false;
        layoutComposer(owner, item);
        composer.view.webContents.send('app-composer-mode', composerModePayload(item));
        composer.view.webContents.send('app-composer-put', {
          attachment: { name: request.params.name, path: request.params.path || '', size: request.params.size || 0 },
        });
        return { ok: true };
      }
    } catch (_) {
      return { ok: false, code: 'APP_COMPOSER_GONE', reason: '输入框已关闭' };
    }
    return { ok: false, code: 'APP_REQUEST_INVALID', reason: '未知输入框操作' };
  }

  /*
   * Standalone applications reuse isolated views and bridges in their own BrowserWindow.
   * Workspace navigation cleans embedded previews only; each application window owns its
   * lifecycle.
   */
  async function showDetached(event, raw) {
    const DEPS = getDeps();
    const payload = raw || {};
    const owner = ownerFor(event);
    if (!owner) return { ok: false, reason: '主窗口没有准备好' };
    const packaged = payload.package ? await require('./app-package-pages.cjs').prepare(DEPS, payload.package) : null;
    const target = packaged?.url || safeWebUrl(payload.url);
    if (!target) return { ok: false, reason: '请提供 http 或 https 地址' };
    const rawBridge = packaged?.bridge || payload.appBridge;
    const requestedBridge = rawBridge ? normalizeAppBridge(rawBridge, target) : null;
    if (!packaged && new URL(target).hostname.endsWith('.soduwork-app.invalid')) throw Error('包内页面必须通过已安装的应用入口打开');
    const windowSettings = windowSizing.normalize(payload.windowSettings);
    owner.detachedOpenings = (owner.detachedOpenings || 0) + 1;
    try {
      const pendingLease = ownerSession(owner);
      const lease = pendingLease && typeof pendingLease.then === 'function' ? await pendingLease : pendingLease;
      if (!lease || owner.closed) return { ok: false, reason: '主窗口已关闭，无法打开应用窗口' };
      packaged?.assertActive();
      const label = String(payload.label || '应用').slice(0, 160);
      const id = cleanTabId(payload.tabId) || 'app-' + Date.now().toString(36);
      const existing = owner.views.get(id);
      let sameAccount = true;
      try { if (existing?.appBridge) appOwner.assertCurrent(existing); } catch (_) { sameAccount = false; }
      if (sameAccount && existing?.detachedWin && !existing.detachedWin.isDestroyed() && liveContents(owner, existing) &&
          existing.requested === target && JSON.stringify(existing.appBridge) === JSON.stringify(requestedBridge)) {
        if (existing.detachedWin.isMinimized()) existing.detachedWin.restore();
        existing.detachedWin.show(); existing.detachedWin.focus();
        return { ok: true, tabId: id, reused: true };
      }
      destroyTab(owner, id); // Revalidate and replace the application when its target or bridge declaration changes.
      const initialSize = windowSizing.opening(windowSettings, windowDisplay(event).workArea);
      const item = createView(owner, id, requestedBridge, true, undefined, packaged?.partition);
      item.ref = '';
      item.label = label;
      try { item.icon = require('../core/plugin-icon.js').normalize(payload.icon); } catch (_) { item.icon = ''; }
      item.requested = target;
      const win = new DEPS.BrowserWindow({
        ...initialSize.normalBounds, ...initialSize.limits,
        maximizable: true, fullscreenable: true,
        title: label, backgroundColor: '#f3f4f6', show: false,
        /*
         * Use native titleBarOverlay window controls with a lightweight chrome view for
         * application identity, navigation, and actions.
         */
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#f3f4f6', symbolColor: '#52525b', height: COMPOSER_TITLE_H },
        skipTaskbar: false, alwaysOnTop: false,
        ...(DEPS.appIcon ? { icon: DEPS.appIcon() } : {}),
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      win.setMenuBarVisibility(false);
      // Windows may add border width when creating hidden-titlebar windows at fractional DPI.
      // Reset outer bounds explicitly to stay within the available display.
      win.setBounds(initialSize.normalBounds);
      // Preserve application identity in the native title against document-title changes.
      item.detachedWin = win;
      /*
       * Request Windows 11 rounded corners once; unsupported systems keep the existing layout.
       */
      try {
        const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
        require('child_process').spawn('powershell.exe', ['-NoProfile', '-Command',
          "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class D{[DllImport(\"dwmapi.dll\")]public static extern int DwmSetWindowAttribute(IntPtr h,int a,ref int v,int s);}' ; $v=2 ; [D]::DwmSetWindowAttribute([IntPtr]" + hwnd + ",33,[ref]$v,4) | Out-Null"],
          { windowsHide: true }).unref();
      } catch (_) {}
      /* Order native views as chrome, application content, then composer. */
      try {
        const chrome = new DEPS.WebContentsView({
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: CHROME_PRELOAD },
        });
        chrome.setBackgroundColor('#f3f4f6');
        item.chrome = { view: chrome };
        win.contentView.addChildView(chrome);
        chrome.setVisible(true);
        void chrome.webContents.loadFile(CHROME_HTML);
      } catch (_) { item.chrome = null; /* Chrome enhancements must not block the application window. */ }
      win.contentView.addChildView(item.view);
      /*
       * Use native View corner clipping instead of transparent sibling overlays, which still
       * intercept native hit-testing despite CSS pointer-events.
       */
      item.view.setBorderRadius(12);
      /*
       * Explicitly show standalone views because createView initializes them hidden for
       * workspace visibility management.
       */
      item.view.setVisible(true);
      /*
       * Lay out title chrome, inset application content, and the right composer sidebar from
       * shared bounds calculations.
       */
      const layoutChrome = (size) => {
        if (!item.chrome || !item.chrome.view) return;
        try { setViewBounds(item.chrome.view, { x: 0, y: 0, width: size.width, height: COMPOSER_TITLE_H }); } catch (_) {}
      };
      const layout = () => {
        if (!liveContents(owner, item)) return;
        try {
          const size = win.getContentBounds();
          layoutChrome(size);
          if (item.composer && item.composer.dock === 'bottom') { // Legacy bottom-card mode leaves the application full width.
            setViewBounds(item.view, { x: 0, y: 0, width: size.width, height: size.height });
            return;
          }
          const expanded = !!(item.composer && item.composer.expanded); // Only pinned sidebars reduce application width; rail and floating modes overlay it.
          const side = expanded
            ? ((item.composer.width > 0) ? clampSidebarWidth(item.composer.width, size.width) : composerSidebarWidth(size.width))
            : 0;
          setViewBounds(item.view, {
            x: COMPOSER_APP_MARGIN,
            y: COMPOSER_TITLE_H,
            width: Math.max(120, size.width - side - COMPOSER_APP_MARGIN * (expanded ? 1 : 2)),
            height: Math.max(80, size.height - COMPOSER_TITLE_H - COMPOSER_APP_MARGIN),
          });
        } catch (_) { /* window may already be gone */ }
      };
      win.on('resize', () => { layout(); layoutComposer(owner, item); });
      let firstReveal = true;
      const reveal = () => {
        if (win.isDestroyed()) return;
        if (firstReveal) { firstReveal = false; if (initialSize.startMaximized) win.maximize(); }
        layout(); layoutComposer(owner, item);
        if (!win.isVisible()) win.show();
      };
      win.once('ready-to-show', reveal);
      if (item.view.webContents) item.view.webContents.once('did-finish-load', reveal);
      const revealTimer = setTimeout(reveal, 500);
      win.on('close', event => require('./work-preview-app-chat.cjs').deferClose(item, win, event));
      win.on('closed', () => { clearTimeout(revealTimer); if (owner.views.get(id) === item) destroyTab(owner, id); });
      require('./work-preview-app-tabs.cjs').attach({ owner, item, createView, loadTarget, safeWebUrl,
        openExternal: url => DEPS.shell.openExternal(url), layout });
      layout();
      loadTarget(owner, item, target);
      createComposerView(owner, item); // Place the conversation sidebar beside the application view.
      layout(); // Relayout after composer creation so the application yields its allocated width.
      return { ok: true, tabId: id };
    } finally { owner.detachedOpenings--; }
  }

  /*
   * Application composer views reuse the main conversation send pipeline through
   * main-process forwarding, including permissions, skills, and queuing, without creating a
   * second session state.
   */
  function composerDockBounds(mode, W, H) {
    /*
     * Default to a full-height right sidebar with messages and composer beside the
     * application. Retain dock=bottom for the legacy floating-card layout.
     */
    if (mode.dock === 'bottom') {
      const cardW = Math.min(780, W - 60), band = 36, gap = 20;
      if (mode.pop) {
        const w = Math.min(860, W - 24), h = Math.min(470, H - 30);
        return { x: Math.round((W - w) / 2), y: H - gap - h, width: w, height: h };
      }
      const cardH = 118;
      return { x: Math.round((W - cardW) / 2) - band, y: H - gap - cardH - band, width: cardW + band * 2, height: cardH + band };
    }
    /*
     * Rail occupies no application width; float previews over the application edge; pinned
     * reserves a side-by-side column.
     */
    const state = mode.expanded ? 'pinned' : (mode.hover ? 'float' : 'rail');
    if (state === 'pinned') return composerSidebarBounds(mode, W, H);
    if (state === 'float') {
      return { x: W - COMPOSER_FLOAT_W - COMPOSER_APP_MARGIN, y: COMPOSER_TITLE_H,
        width: COMPOSER_FLOAT_W, height: Math.max(200, H - COMPOSER_TITLE_H - COMPOSER_APP_MARGIN) };
    }
    const available = Math.max(0, H - COMPOSER_TITLE_H - COMPOSER_APP_MARGIN);
    if (mode.railArrival) return { x: W - COMPOSER_RAIL_W, y: COMPOSER_TITLE_H,
      width: COMPOSER_RAIL_W, height: available };
    const height = Math.min(COMPOSER_RAIL_H, available);
    const position = Number.isFinite(mode.railY) ? Math.max(0, Math.min(1, mode.railY)) : .5;
    return { x: W - COMPOSER_RAIL_W, y: COMPOSER_TITLE_H + Math.round((available - height) * position),
      width: COMPOSER_RAIL_W, height };
  }

  /*
   * Default sidebar width is at most 440px; use an explicit resized width when present and share the
   * calculation with application layout.
   */
  function composerSidebarWidth(W) {
    return Math.min(Math.floor(W / 2), Math.max(320, Math.min(440, Math.round(W * 0.36))));
  }
  function clampSidebarWidth(w, W) {
    // Both panes retain the default chat minimum and their outer margins, without a fixed upper cap.
    const min = composerSidebarWidth(W);
    return Math.max(min, Math.min(W - min, Math.round(w)));
  }
  function composerSidebarBounds(mode, W, H) {
    const w = mode && mode.width > 0 ? clampSidebarWidth(mode.width, W) : composerSidebarWidth(W);
    /* Align beneath the title bar and preserve outer and bottom margins. */
    return { x: W - w, y: COMPOSER_TITLE_H, width: Math.max(1, w - COMPOSER_APP_MARGIN), height: Math.max(200, H - COMPOSER_TITLE_H - COMPOSER_APP_MARGIN) };
  }

  function layoutComposer(owner, item, repaint = true) {
    if (!item.composer || !item.detachedWin) return;
    try {
      const size = item.detachedWin.getContentBounds();
      const __b = composerDockBounds(item.composer, size.width, size.height);
      if (process.env.SODUWORK_COMPOSER_DEBUG) console.log('[composer] layout', JSON.stringify(__b));
      const changed = setViewBounds(item.composer.view, __b);
      // Native resize already schedules drawing. Avoid a forced repaint on every drag sample.
      if (changed && repaint) try { item.composer.view.webContents.invalidate(); } catch (_) {}
    } catch (_) { /* window may already be gone */ }
  }

  /*
   * The main process supplies target bounds while renderer animation frames drive
   * transitions through composerStep. Avoid timer-driven interpolation in unfocused windows.
   */
  function composerModePayload(item) {
    let bounds = null;
    try {
      const size = item.detachedWin.getContentBounds();
      bounds = composerDockBounds(item.composer, size.width, size.height);
    } catch (_) { /* window may already be gone */ }
    const state = item.composer.expanded ? 'pinned' : (item.composer.hover ? 'float' : 'rail');
    return { state, expanded: item.composer.expanded, hover: item.composer.hover, bounds,
      widthInset: COMPOSER_APP_MARGIN, theme: item.composer.theme || 'light' };
  }

  function createComposerView(owner, item) {
    const DEPS = getDeps();
    try {
      const view = new DEPS.WebContentsView({
        webPreferences: {
          contextIsolation: true, nodeIntegration: false, sandbox: true,
          preload: COMPOSER_PRELOAD,
          // Like the main chat renderer, keep event-driven transcript paints
          // moving while the native application is occluded or collapsed.
          backgroundThrottling: false,
        },
      });
      view.setBackgroundColor('#00000000'); // Keep the view transparent outside its card surface.
      view.setVisible(true); // Explicitly show the newly created view.
      item.detachedWin.contentView.addChildView(view);
      if (item.appBridge) appOwner.associate(view.webContents, item);
      item.composer = { view, dock: 'right', collapsed: false, expanded: false, hover: false, width: 0, railY: .5, railArrival: true, sessionId: '', theme: 'light' }; // Start collapsed as the right-edge rail.
      layoutComposer(owner, item);
      void view.webContents.loadFile(COMPOSER_PAGE, { query: { panel: 'chatbar', embed: '1' } });
    } catch (_) { /* Composer failure must not block the application window. */ }
  }

  function composerOwnerBySender(sender) {
    if (!sender || sender.isDestroyed()) return null;
    for (const owner of OWNERS.values()) {
      for (const item of owner.views.values()) {
        if (item.composer && item.composer.view.webContents === sender) return { owner, item };
      }
    }
    return null;
  }

  function appContextFor(sender) {
    const found = composerOwnerBySender(sender);
    if (!found || !liveContents(found.owner, found.item) || !found.item.appBridge) return null;
    const item = found.item.appTabs?.active() || found.item;
    appOwner.assertCurrent(item);
    try { if (new URL(item.view.webContents.getURL()).origin !== item.appBridge.origin) return null; } catch (_) { return null; }
    const pluginId = String(item.appBridge.appId || '').replace(/^plugin:/, '');
    if (!pluginId) return null;
    const application = { pluginId,
      pageUrl: require('./application-turn-context.cjs').pageUrl(item.view.webContents.getURL()),
      requiresMcp: item.appBridge.capabilities?.includes('mcp.connect') === true };
    // Native ownership identifies the app; per-turn plugin grants still check
    // installation and use permission for both local and market applications.
    return { ...application, connection: require('./work-preview-app-connection.cjs').resolve(item, getDeps(), () => {
      if ((found.item.appTabs?.active() || found.item) !== item) throw Error('应用标签已切换，请重新发送消息');
    }) };
  }
  function appContextForPlugin(pluginId) {
    for (const owner of OWNERS.values()) for (const item of owner.views.values()) {
      const current = item.appTabs?.active() || item;
      if (String(current.appBridge?.appId || '').replace(/^plugin:/, '') !== pluginId || !item.composer) continue;
      const context = appContextFor(item.composer.view.webContents);
      if (context?.pluginId === pluginId) return context;
    }
    return null;
  }
  function composerTurnSettled(event) {
    const found = composerOwnerBySender(event.sender);
    if (!found || !appContextFor(event.sender)) return { ok: false };
    found.item.view.webContents.send('app-turn-settled', { state: 'settled' });
    return { ok: true };
  }

  async function composerSend(event, raw) {
    const found = composerOwnerBySender(event.sender);
    if (found?.item.appBridge) appOwner.assertCurrent(found.item.appTabs?.active() || found.item);
    if (!found || !found.item.composer) return { ok: false, reason: '对话框没有挂在有效的应用窗口上' };
    const text = String((raw || {}).text || '').trim();
    if (!text) return { ok: false, reason: '请输入内容' };
    const owner = found.owner;
    if (owner.closed || !owner.sender || owner.sender.isDestroyed()) return { ok: false, reason: '主窗口已关闭' };
    owner.sender.send('work-preview-composer-inbox', { tabId: found.item.id, text });
    return { ok: true };
  }

  function composerHello(event) {
    const found = composerOwnerBySender(event.sender);
    if (!found) return { ok: false };
    if (found.item.appBridge) appOwner.assertCurrent(found.item.appTabs?.active() || found.item);
    const owner = found.owner;
    if (owner.closed || !owner.sender || owner.sender.isDestroyed()) return { ok: false };
    owner.sender.send('work-preview-composer-hello', { tabId: found.item.id });
    try { found.item.composer.view.webContents.send('app-composer-mode', composerModePayload(found.item)); } catch (_) {} // Synchronize sidebar width and theme at page startup.
    return { ok: true, application: {
      id: String(found.item.appBridge?.appId || '').replace(/^plugin:/, ''), name: String(found.item.label || '应用'), icon: found.item.icon || '',
    } };
  }

  /*
   * Apply drag widths immediately to both application and sidebar. Keep width in session
   * memory and reset it on reopening.
   */
  function composerWidth(event, raw) {
    const found = composerOwnerBySender(event.sender);
    if (!found || !found.item.composer) return { ok: false };
    const item = found.item;
    if (item.composer.dock === 'bottom') return { ok: false };
    let w = Number((raw || {}).width);
    if (!Number.isFinite(w)) return { ok: false };
    try {
      const size = item.detachedWin.getContentBounds();
      const width = clampSidebarWidth(w, size.width);
      const previous = item.composer.width > 0 ? clampSidebarWidth(item.composer.width, size.width) : composerSidebarWidth(size.width);
      item.composer.width = width;
      if (width !== previous) layoutAllDetached(found.owner, item, true);
    } catch (_) { return { ok: false }; }
    return { ok: true, width: item.composer.width };
  }

  /* Share layout across resizing, state transitions, and window-bound changes. */
  function layoutAllDetached(owner, item, resizing = false) {
    if (!owner || owner.closed || !item || !item.detachedWin || item.detachedWin.isDestroyed()) return;
    try {
      const size = item.detachedWin.getContentBounds();
      if (item.chrome && item.chrome.view) {
        try { setViewBounds(item.chrome.view, { x: 0, y: 0, width: size.width, height: COMPOSER_TITLE_H }); } catch (_) {}
      }
      if (item.composer && item.composer.dock === 'bottom') {
        // Legacy bottom-card mode leaves the application full width.
        setViewBounds(item.view, { x: 0, y: 0, width: size.width, height: size.height });
      } else {
        const expanded = !!(item.composer && item.composer.expanded);
        const side = expanded
          ? ((item.composer.width > 0) ? clampSidebarWidth(item.composer.width, size.width) : composerSidebarWidth(size.width))
          : 0;
        setViewBounds(item.view, {
          x: COMPOSER_APP_MARGIN,
          y: COMPOSER_TITLE_H,
          width: Math.max(120, size.width - side - COMPOSER_APP_MARGIN * (expanded ? 1 : 2)),
          height: Math.max(80, size.height - COMPOSER_TITLE_H - COMPOSER_APP_MARGIN),
        });
      }
    } catch (_) { /* window may already be gone */ }
    layoutComposer(owner, item, !resizing);
  }

  function composerDock(event, raw) {
    const found = composerOwnerBySender(event.sender);
    if (!found || !found.item.composer) return { ok: false };
    const mode = raw || {};
    if (process.env.SODUWORK_COMPOSER_DEBUG) console.log('[composer] dock', JSON.stringify(mode));
    if (mode.dock === 'bottom' || mode.dock === 'right') found.item.composer.dock = mode.dock;
    /* Legacy collapsed and hover reports are retired; pop requests temporary height for an open popup. */
    if (typeof mode.pop === 'boolean') found.item.composer.pop = mode.pop;
    try { found.item.composer.view.webContents.send('app-composer-mode', composerModePayload(found.item)); } catch (_) {} // Send state and target bounds for renderer-driven animation.
    /*
     * Apply target bounds after 400ms only if renderer animation fails to start; immediate
     * competing writes would make the viewport oscillate.
     */
    let target = null;
    try { const s = found.item.detachedWin.getContentBounds(); target = composerDockBounds(found.item.composer, s.width, s.height); } catch (_) {}
    if (target) setTimeout(() => {
      try {
        if (!found.owner.closed && found.item.composer.view && !found.item.composer.view.webContents.isDestroyed()) {
          found.item.composer.view.setBounds(target);
          try { found.item.composer.view.webContents.invalidate(); } catch (_) {}
        }
      } catch (_) {}
    }, 400);
    return { ok: true };
  }

  /* Apply renderer animation-frame bounds for smooth expansion and collapse. */
  function composerStep(event, raw) {
    const found = composerOwnerBySender(event.sender);
    if (!found || !found.item.composer || !found.item.composer.view) return { ok: false };
    const b = raw && raw.bounds;
    if (!b || ![b.x, b.y, b.width, b.height].every(v => Number.isFinite(v) && v > -9999 && v < 99999)) return { ok: false };
    try {
      found.item.composer.view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
      try { found.item.composer.view.webContents.invalidate(); } catch (_) {}
    } catch (_) { return { ok: false }; }
    return { ok: true };
  }

  /*
   * Share rail, floating-preview, and pinned transitions between renderer interaction and
   * application bridge controls.
   */
  function composerModeSet(event, raw) {
    const found = composerOwnerBySender(event.sender);
    if (!found || !found.item.composer || found.item.composer.dock === 'bottom') return { ok: false };
    const c = found.item.composer;
    const p = raw || {};
    // Only the owned sidebar can move its rail. Keep its horizontal edge fixed;
    // remember a vertical fraction so resizing and collapse retain the position.
    if (Object.hasOwn(p, 'railScreenY')) {
      if (!Number.isFinite(p.railScreenY) || c.expanded || c.hover) return { ok: false };
      const area = found.item.detachedWin.getContentBounds();
      const available = Math.max(0, area.height - COMPOSER_TITLE_H - COMPOSER_APP_MARGIN);
      const height = Math.min(COMPOSER_RAIL_H, available);
      const travel = available - height;
      c.railY = travel > 0 ? Math.max(0, Math.min(1, (p.railScreenY - area.y - COMPOSER_TITLE_H - height / 2) / travel)) : .5;
      c.railArrival = false;
    }
    if (p.railArrival === false) c.railArrival = false;
    if (typeof p.expanded === 'boolean') { c.expanded = p.expanded; if (!p.expanded) c.hover = false; } // Clear floating preview before collapsing.
    if (typeof p.hover === 'boolean') c.hover = p.hover && !c.expanded; // Apply hover afterward so unpinning may retain a floating preview.
    try { layoutAllDetached(found.owner, found.item); } catch (_) {}
    try { c.view.webContents.send('app-composer-mode', composerModePayload(found.item)); } catch (_) {}
    return { ok: true, state: c.expanded ? 'pinned' : (c.hover ? 'float' : 'rail') };
  }

  /* Chrome actions toggle maximization or open application management in the workspace. */
  function chromeAction(event, raw) {
    const action = String((raw || {}).action || '');
    for (const owner of OWNERS.values()) {
      for (const item of owner.views.values()) {
        if (!item.chrome || !item.chrome.view || item.chrome.view.webContents !== event.sender) continue;
        const win = item.detachedWin;
        if (['state', 'select', 'close', 'back', 'refresh'].includes(action) && item.appTabs) {
          return item.appTabs.action(action, String(raw.tabId || ''));
        }
        if (action === 'maximize' && win && !win.isDestroyed()) {
          try { if (win.isMaximized()) win.unmaximize(); else win.maximize(); } catch (_) {}
        }
        if (action === 'apps' && owner.sender && !owner.sender.isDestroyed()) {
          try { owner.sender.send('work-preview-apps-manage', { key: item.ref || item.label || '' }); } catch (_) {}
        }
        return { ok: true };
      }
    }
    return { ok: false };
  }

  function composerState(payload) {
    const tabId = cleanTabId((payload || {}).tabId);
    const state = (payload || {}).state || {};
    for (const owner of OWNERS.values()) {
      const item = owner.views.get(tabId);
      if (item && item.composer) {
        /* Publish conversation changes to composer instances only when the active conversation changes. */
        const sessionId = String(state.sessionId || '');
        if (sessionId && sessionId !== item.composer.sessionId) {
          item.composer.sessionId = sessionId;
          try { item.composer.view.webContents.send('app-composer-session', { sessionId }); } catch (_) {}
        }
        return { ok: true };
      }
    }
    return { ok: false };
  }

  function composerSent(event) {
    const found = composerOwnerBySender(event.sender);
    if (!found) return { ok: false };
    const owner = found.owner;
    if (owner.closed || !owner.sender || owner.sender.isDestroyed()) return { ok: false };
    owner.sender.send('work-preview-composer-refresh', { tabId: found.item.id });
    return { ok: true };
  }


  return { showDetached, windowDisplay, appContextFor, appContextForPlugin, isAppComposer: sender => !!composerOwnerBySender(sender), composerTurnSettled, composerControl, composerSend, composerHello, composerWidth, composerModeSet, chromeAction, composerDock, composerStep, composerState, composerSent };
}
module.exports = { create };
