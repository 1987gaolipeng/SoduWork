/* Window-level commands. Business navigation and session state stay with their owners. */
(function (global) {
  'use strict';
  const svg = paths => '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
  const icons = {
    sidebar: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9 4.5v15M6.2 8h.1M6.2 11h.1"/>'),
    new: svg('<path d="M13 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M15 3l6 6M10 14l1-4 8-8 3 3-8 8z"/>'),
    quit: svg('<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M10 12h11m-4-4 4 4-4 4"/>'),
    history: svg('<path d="M4 5v5h5M4.6 9a8 8 0 1 1-.1 6M12 7v5l3 2"/>'),
    website: svg('<circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="3.5" ry="8.5"/><path d="M4 9h16M4 15h16"/>'),
    about: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v6M12 7v.1"/>'),
    close: svg('<path d="m6 6 12 12M6 18 18 6"/>'),
    check: svg('<path d="m5 12 4 4L19 6"/>'),
  };
  const t = value => global.SoduWorkI18n?.t(value, value) || value;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const prefKey = 'soduwork.window-sidebar.v1';
  let bar, popup, dialog, opened = '', opener = null, infoPromise, info, prefs = {};
  let busyQuit = false;
  let chrome = { mode: 'native', nativeMenu: false }, themeFrame = 0, themeSent = '', menuStateSent = '';
  let themeContext, modalOrder = [];
  try { const saved = JSON.parse(localStorage.getItem(prefKey) || '{}'); for (const key of ['conversation', 'settings']) prefs[key] = saved?.[key] === true; } catch (_) {}
  const api = () => global.soduWorkAPI;
  function captionColors() {
    const style = getComputedStyle(bar), bounds = bar.getBoundingClientRect();
    const active = [...document.querySelectorAll('dialog:modal')];
    modalOrder = modalOrder.filter(node => active.includes(node));
    for (const node of active) if (!modalOrder.includes(node)) modalOrder.push(node);
    // Native caption buttons are outside the DOM top layer. Reproduce only
    // backdrops covering their area, in the order dialogs entered that layer.
    const x = (bounds.right + global.innerWidth) / 2, y = bounds.top + bounds.height / 2;
    const inset = (value, size) => value.endsWith('%') ? parseFloat(value) * size / 100 : parseFloat(value) || 0;
    const layers = modalOrder.filter(node => node.checkVisibility()).map(node => getComputedStyle(node, '::backdrop')).filter(layer =>
      layer.display !== 'none' && layer.visibility === 'visible' &&
      x >= inset(layer.left, global.innerWidth) && x < global.innerWidth - inset(layer.right, global.innerWidth) &&
      y >= inset(layer.top, global.innerHeight) && y < global.innerHeight - inset(layer.bottom, global.innerHeight));
    if (!themeContext) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      themeContext = canvas.getContext('2d', { willReadFrequently: true });
    }
    if (!themeContext) return null;
    const composite = color => {
      themeContext.clearRect(0, 0, 1, 1); themeContext.globalAlpha = 1;
      themeContext.fillStyle = color; themeContext.fillRect(0, 0, 1, 1);
      for (const layer of layers) {
        themeContext.globalAlpha = Number(layer.opacity);
        themeContext.fillStyle = layer.backgroundColor; themeContext.fillRect(0, 0, 1, 1);
      }
      return '#' + [...themeContext.getImageData(0, 0, 1, 1).data].slice(0, 3).map(n => n.toString(16).padStart(2, '0')).join('');
    };
    return { backgroundColor: composite(style.backgroundColor), symbolColor: composite(style.color) };
  }
  function syncTheme() {
    if (themeFrame || chrome.mode !== 'overlay') return;
    themeFrame = requestAnimationFrame(() => {
      themeFrame = 0;
      const colors = captionColors();
      if (!colors) return;
      const signature = JSON.stringify(colors);
      if (!colors.backgroundColor || !colors.symbolColor || signature === themeSent) return;
      themeSent = signature;
      api()?.setWindowTitlebarTheme?.(colors).catch(() => { themeSent = ''; });
    });
  }
  async function initTitlebar() {
    try { chrome = await api()?.getWindowTitlebar?.() || chrome; } catch (_) { /* Older clients retain their native frame. */ }
    const integrated = ['overlay', 'hidden-inset'].includes(chrome.mode);
    document.documentElement.dataset.windowTitlebar = integrated ? chrome.mode : 'native';
    document.documentElement.toggleAttribute('data-window-native-menu', !!chrome.nativeMenu);
        bar.querySelector('nav').hidden = !!chrome.nativeMenu;
    if (chrome.nativeMenu) bar.querySelector('.wm-divider').hidden = true;
    syncSidebar(); syncTheme();
    global.dispatchEvent(new Event('resize'));
  }
  function sidebar() {
    const html = document.documentElement, layout = html.dataset.workspaceLayout;
    const node = html.dataset.deskPanel === 'workspace' && ['conversation', 'settings'].includes(layout)
      ? document.querySelector('#workspaceShell .ws-side') : null;
    return { node, layout, hidden: Boolean(node && prefs[layout]) };
  }
  function syncSidebar() {
    if (!bar) return;
    const state = sidebar(), button = bar.querySelector('[data-window-sidebar]');
    document.documentElement.toggleAttribute('data-window-sidebar-hidden', state.hidden);
    if (state.node) { state.node.id ||= 'windowPageSidebar'; state.node.inert = state.hidden; button.setAttribute('aria-controls', state.node.id); }
    else button.removeAttribute('aria-controls');
    button.disabled = !state.node; button.setAttribute('aria-expanded', String(!!state.node && !state.hidden));
    button.title = t(!state.node ? '此页面没有可折叠的侧栏' : state.hidden ? '显示侧栏' : '隐藏侧栏');
    button.setAttribute('aria-label', button.title);
    if (chrome.nativeMenu) {
      const nativeState = { sidebarAvailable: !!state.node, sidebarHidden: state.hidden };
      const signature = JSON.stringify(nativeState);
      if (signature !== menuStateSent) {
        menuStateSent = signature;
        api()?.setWindowMenuState?.(nativeState).catch(() => { menuStateSent = ''; });
      }
    }
    if (opened === 'view') renderPopup();
  }
  function toggleSidebar() {
    const state = sidebar(); if (!state.node) return;
    prefs[state.layout] = !state.hidden;
    try { localStorage.setItem(prefKey, JSON.stringify(prefs)); } catch (_) {}
    syncSidebar();
    // Let native document previews recompute their bounds after CSS has settled.
    global.dispatchEvent(new Event('resize'));
  }
  function notifyOverlay() {
    document.documentElement.toggleAttribute('data-window-menu-overlay', Boolean(opened || dialog?.open));
    global.dispatchEvent(new Event('soduwork-window-menu-visibility'));
  }
  function closeMenu(focus = false) {
    const previous = bar?.querySelector('[data-window-menu="' + opened + '"]');
    opened = ''; if (popup) popup.hidden = true;
    bar?.querySelectorAll('[data-window-menu]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    notifyOverlay(); if (focus) previous?.focus();
  }
  function rows() {
    const state = sidebar();
    if (opened === 'file') return [['new', '新对话', shortcutLabel('new-chat', 'Ctrl+N')], ['quit', '退出 SoduWork', shortcutLabel('', 'Ctrl+Q')]];
    if (opened === 'view') return [['sidebar', state.hidden ? '显示侧栏' : '隐藏侧栏', shortcutLabel('toggle-sidebar', 'Ctrl+B'), !state.node]];
    return [['history', '版本历史'], ['website', '官网', '', !info?.website], ['about', '关于 SoduWork', shortcutLabel('open-about', 'F1')]];
  }
  function shortcutLabel(id, fallback) {
    const current = id ? global.ShortcutSettings?.getBinding?.(id) : undefined;
    const binding = typeof current === 'string' ? current : fallback;
    if (!binding) return '';
    return global.ShortcutBindings?.displayCombo?.(binding, chrome.platform === 'darwin' ? 'mac' : 'windows') || binding;
  }
  function renderPopup() {
    popup.innerHTML = rows().map(([id, label, shortcut, disabled]) => '<button type="button" role="menuitem" data-window-command="' + id + '"' + (disabled ? ' disabled' : '') + '>' + icons[id] + '<span>' + esc(t(label)) + '</span>' + (shortcut ? '<kbd>' + esc(shortcut) + '</kbd>' : '') + '</button>').join('');
    const trigger = bar.querySelector('[data-window-menu="' + opened + '"]');
    if (!trigger) return;
    popup.setAttribute('aria-labelledby', trigger.id);
    popup.style.left = Math.max(8, Math.min(trigger.getBoundingClientRect().left, global.innerWidth - 232)) + 'px';
  }
  function openMenu(name, last = false) {
    if (global.RequirementConfirm?.isOpen?.()) return;
    if (!['file', 'view', 'help'].includes(name) || !bar || !popup) return;
    if (chrome.nativeMenu && api()?.openWindowMenu) {
      closeMenu();
      return api().openWindowMenu(name).catch(() => global.petSay?.(t('菜单暂时无法打开，请重试。')));
    }
    opened = name; popup.hidden = false;
    bar.querySelectorAll('[data-window-menu]').forEach(b => { b.setAttribute('aria-expanded', String(b.dataset.windowMenu === name)); b.tabIndex = b.dataset.windowMenu === name ? 0 : -1; });
    renderPopup(); notifyOverlay();
    const items = popup.querySelectorAll('button:not(:disabled)'); (last ? items[items.length - 1] : items[0])?.focus();
  }
  async function appInfo() {
    if (!infoPromise) infoPromise = Promise.resolve().then(() => api()?.getAppInfo?.()).then(result => {
      if (!result) throw Error('应用信息暂不可用'); info = result; return result;
    }).catch(error => { infoPromise = null; throw error; });
    return infoPromise;
  }
  function closeDialog() { if (dialog?.open) dialog.close(); }
  function helpBody(kind, data) {
    if (kind === 'history') {
      const releases = data.releaseHistory || [];
      return '<p class="wm-description">' + esc(t('已发布版本的更新记录')) + '</p><div class="wm-releases">' + (releases.length ? releases.map(release => '<section><header><b data-user-content>v' + esc(release.version) + '</b><time>' + esc(release.date || '') + '</time>' + (release.status === 'withdrawn' ? '<span class="wm-withdrawn">' + esc(t('已撤回')) + '</span>' : release.version === data.version ? '<span class="wm-current">' + esc(t('当前版本')) + '</span>' : '') + '</header><ul>' + (release.notes || []).map(note => '<li data-user-content>' + esc(note) + '</li>').join('') + '</ul></section>').join('') : '<p>' + esc(t('当前安装包未附带版本记录。')) + '</p>') + '</div>';
    }
    return '<div class="wm-about-brand"><img class="wm-brand-mark" src="icon.png" alt="" draggable="false"><div><b>SoduWork</b><span>' + esc(t('企业 AI 工作平台')) + '</span></div></div><dl class="wm-about-details"><div><dt>' + esc(t('当前版本')) + '</dt><dd data-user-content>' + esc(data.version) + '</dd></div>' + (data.website ? '<div><dt>' + esc(t('官网')) + '</dt><dd><button type="button" data-window-website>' + esc((data.website || '').replace(/^https?:\/\//, '').replace(/\/$/, '')) + '</button></dd></div>' : '') + '</dl>';
  }
  async function openHelp(kind) {
    opener = document.activeElement;
    closeMenu();
    dialog.dataset.helpKind = kind;
    dialog.querySelector('h2').textContent = t(kind === 'history' ? '版本历史' : '关于 SoduWork');
    const body = dialog.querySelector('.wm-dialog-body'); body.innerHTML = '<p role="status">' + esc(t('正在加载…')) + '</p>';
    if (!dialog.open) dialog.showModal(); notifyOverlay();
    dialog.querySelector('[data-window-dialog-close]').focus();
    try {
      const data = await appInfo();
      if (dialog.open && dialog.dataset.helpKind === kind) body.innerHTML = helpBody(kind, data);
    } catch (_) { if (dialog.open && dialog.dataset.helpKind === kind) body.innerHTML = '<p role="alert">' + esc(t('应用信息暂不可用，请重试。')) + '</p><button type="button" class="wm-retry" data-window-help-retry>' + esc(t('重试')) + '</button>'; }
  }
  async function command(id) {
    if (global.RequirementConfirm?.isOpen?.()) return;
    if (!['new', 'sidebar', 'history', 'website', 'about', 'quit'].includes(id)) return;
    if (id === 'history' && window.SoduWorkReleaseNotes) { await window.SoduWorkReleaseNotes.openHistory(); return; }
    if (id === 'history' || id === 'about') { await openHelp(id); return; }
    closeMenu();
    if (id === 'sidebar') { toggleSidebar(); bar.querySelector('[data-window-sidebar]').focus(); return; }
    if (id === 'new') {
      closeDialog();
      const payload = global.WorkspaceShell?.newSessionPayload?.() || { newSession: true };
      if (document.documentElement.dataset.deskPanel === 'workspace') global.WorkspaceHost?.open('create', payload);
      else api()?.openDeskWindow?.({ panel: 'workspace', view: 'create', ...payload });
    } else if (id === 'website') {
      try { const data = await appInfo(); if (data.website) await api()?.openExternal(data.website); }
      catch (_) { global.petSay?.(t('官网暂时无法打开，请重试。')); }
    } else if (id === 'quit' && !busyQuit) {
      busyQuit = true;
      try { await api()?.requestAppQuit?.(); } catch (_) { global.petSay?.(t('退出未完成，请重试。')); }
      finally { busyQuit = false; }
    }
  }
  function keydown(event) {
    if (global.RequirementConfirm?.isOpen?.()) return;
    if (event.isComposing || event.defaultPrevented || global.ShortcutSettings?.isRecording?.()) return;
    if (dialog?.open) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeDialog(); }
      return;
    }
    const menuButton = event.target.closest?.('button[data-window-menu]'), inPopup = popup.contains(event.target);
    const items = [...popup.querySelectorAll('button:not(:disabled)')], headers = [...bar.querySelectorAll('[data-window-menu]')];
    const key = event.key;
    if (opened && key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeMenu(true); return; }
    if ((inPopup || menuButton) && ['ArrowLeft', 'ArrowRight'].includes(key)) {
      event.preventDefault(); const index = headers.findIndex(b => b.dataset.windowMenu === (opened || menuButton.dataset.windowMenu));
      const next = headers[(index + (key === 'ArrowRight' ? 1 : -1) + headers.length) % headers.length];
      if (opened) openMenu(next.dataset.windowMenu); else { headers.forEach(b => b.tabIndex = b === next ? 0 : -1); next.focus(); } return;
    }
    if (menuButton && ['ArrowDown', 'ArrowUp'].includes(key)) { event.preventDefault(); openMenu(menuButton.dataset.windowMenu, key === 'ArrowUp'); return; }
    if (inPopup && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key) && items.length) {
      event.preventDefault(); const index = items.indexOf(document.activeElement);
      items[key === 'Home' ? 0 : key === 'End' ? items.length - 1 : (index + (key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); return;
    }
    if (key === 'Tab') closeMenu();
    if (!global.ShortcutSettings && !chrome.nativeMenu && event.altKey && !event.ctrlKey && !event.metaKey && ['f', 'v', 'h'].includes(key.toLowerCase())) {
      event.preventDefault(); openMenu({ f: 'file', v: 'view', h: 'help' }[key.toLowerCase()]); return;
    }
    if (!chrome.nativeMenu && key === 'F10' && !event.shiftKey) { event.preventDefault(); headers[0].focus(); return; }
    if (!chrome.nativeMenu && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !event.target.closest?.('[contenteditable="true"],[role="dialog"],dialog')) {
      const id = { n: 'new', b: 'sidebar', q: 'quit' }[key.toLowerCase()];
      // Configured actions belong to ShortcutSettings; old default keys must stay inactive after a rebind.
      if (global.ShortcutSettings && id !== 'quit') return;
      if (id) {






        event.preventDefault(); event.stopImmediatePropagation(); void command(id);
      }
    }
  }
  function localize() {
    for (const [key, label] of [['file', '文件'], ['view', '视图'], ['help', '帮助']]) bar.querySelector('[data-window-menu="' + key + '"]').textContent = t(label);
    bar.setAttribute('aria-label', t('窗口菜单')); popup.setAttribute('aria-label', t('窗口菜单'));
    dialog.querySelector('[data-window-dialog-close]').setAttribute('aria-label', t('关闭'));
    syncSidebar(); if (opened) renderPopup();
    if (dialog.open && info) { const kind = dialog.dataset.helpKind; dialog.querySelector('h2').textContent = t(kind === 'history' ? '版本历史' : '关于 SoduWork'); dialog.querySelector('.wm-dialog-body').innerHTML = helpBody(kind, info); }
  }
  function mount() {
    if (bar || !document.documentElement.dataset.deskPanel) return;
    document.documentElement.setAttribute('data-window-menu', '');
    bar = document.createElement('header'); bar.className = 'window-menu'; bar.tabIndex = -1;
    bar.innerHTML = '<button type="button" class="wm-sidebar" data-window-sidebar>' + icons.sidebar + '</button><span class="wm-divider" aria-hidden="true"></span><nav role="menubar">' + ['file', 'view', 'help'].map((key, index) => '<button type="button" id="windowMenu-' + key + '" data-window-menu="' + key + '" role="menuitem" aria-haspopup="menu" aria-expanded="false" aria-controls="windowMenuPopup" tabindex="' + (index ? -1 : 0) + '"></button>').join('') + '</nav>';
    popup = document.createElement('div'); popup.className = 'wm-popup'; popup.id = 'windowMenuPopup'; popup.setAttribute('role', 'menu'); popup.hidden = true;
    dialog = document.createElement('dialog'); dialog.className = 'wm-dialog'; dialog.setAttribute('aria-labelledby', 'windowHelpTitle');
    dialog.innerHTML = '<header><h2 id="windowHelpTitle"></h2><button type="button" data-window-dialog-close>' + icons.close + '</button></header><div class="wm-dialog-body"></div>';
    document.body.prepend(bar); document.body.append(popup, dialog); localize();
    bar.addEventListener('click', event => {
      if (event.target.closest('[data-window-sidebar]')) { closeMenu(); toggleSidebar(); return; }
      const b = event.target.closest('button[data-window-menu]'); if (b) opened === b.dataset.windowMenu ? closeMenu(true) : openMenu(b.dataset.windowMenu);
    });
    bar.addEventListener('mouseover', event => { const b = event.target.closest('button[data-window-menu]'); if (opened && b && b.dataset.windowMenu !== opened) openMenu(b.dataset.windowMenu); });
    popup.addEventListener('click', event => { const b = event.target.closest('[data-window-command]'); if (b && !b.disabled) void command(b.dataset.windowCommand); });
    document.addEventListener('pointerdown', event => { if (opened && !bar.contains(event.target) && !popup.contains(event.target)) closeMenu(); }, true);
    document.addEventListener('keydown', keydown, true);
    dialog.addEventListener('click', event => {
      if (event.target.closest('[data-window-dialog-close]')) closeDialog();
      if (event.target.closest('[data-window-website]')) void command('website');
      if (event.target.closest('[data-window-help-retry]')) void openHelp(dialog.dataset.helpKind);
      if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeDialog(); }
    });
    dialog.addEventListener('close', () => {
      notifyOverlay();
      const fallback = chrome.nativeMenu ? bar.querySelector('[data-window-sidebar]:not(:disabled)') || bar : bar.querySelector('[data-window-menu="help"]');
      const target = opener?.isConnected && !popup.contains(opener) && opener.checkVisibility() ? opener : fallback;
      target?.focus();
    });
    global.addEventListener('blur', () => closeMenu());
    global.addEventListener('resize', () => { if (opened) renderPopup(); syncTheme(); });
    global.addEventListener('soduwork-locale-change', localize);
    global.addEventListener('soduwork-shortcuts-changed', () => { if (opened) renderPopup(); });
    api()?.onWindowMenuCommand?.(id => { if (['new', 'sidebar', 'history', 'website', 'about', 'quit'].includes(id)) void command(id); });
    document.addEventListener('beforetoggle', event => {
      if (event.target.localName !== 'dialog') return;
      modalOrder = modalOrder.filter(node => node !== event.target);
      if (event.newState === 'open') modalOrder.push(event.target);
      syncTheme();
    }, true);
    for (const name of ['toggle', 'close', 'animationend', 'transitionend']) document.addEventListener(name, event => {
      if (event.target.localName === 'dialog') syncTheme();
    }, true);
    const themeObserver = new MutationObserver(records => {
      const relevant = records.some(record => {
        if (record.type === 'childList') return [...record.addedNodes, ...record.removedNodes].some(node =>
          node.nodeType === 1 && (node.localName === 'dialog' || node.querySelector('dialog')));
        const node = record.target;
        return node === document.documentElement || node === document.body || node === bar || node.localName === 'dialog' ||
          modalOrder.some(dialog => node.contains(dialog));
      });
      if (relevant) syncTheme();
    });
    themeObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-skin', 'open', 'hidden', 'data-workspace-view', 'data-desk-panel'] });
    new MutationObserver(syncSidebar).observe(document.documentElement, { attributes: true, attributeFilter: ['data-workspace-view', 'data-workspace-layout', 'data-desk-panel'] });
    void initTitlebar();
    void appInfo().then(() => { if (opened) renderPopup(); }).catch(() => {});
    requestAnimationFrame(syncSidebar);
  }
  global.DesktopWindowMenu = global.WindowMenu = { mount, toggleSidebar, close: closeMenu, openMenu, runCommand: command,
    usesNativeAccelerator: id => chrome.nativeMenu && ['new-chat', 'toggle-sidebar', 'open-about'].includes(id) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})(window);
