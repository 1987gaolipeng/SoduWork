/* One modal owns selection and focus; business modules own data and navigation. */
(function (global) {
  'use strict';
  const core = global.SoduWorkSearchCore, sources = global.SoduWorkSearchSources;
  const labels = sources.categoryLabels, categories = ['all', ...Object.keys(labels)];
  const paths = {
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    chats: '<path d="M4 5h16v12H9l-5 4z"/>', projects: '<path d="M3 6h7l2 2h9v12H3z"/>',
    tasks: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="m8 12 3 3 5-6M9 4V2h6v2"/>',
    library: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"/>',
    apps: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
    plugins: '<path d="M9 3h6v5h5v6h-5v6H9v-6H4V8h5z"/>',
    schedules: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    actions: '<path d="m13 3-8 11h6l-1 7 9-12h-6z"/>',
  };
  const icon = key => '<svg viewBox="0 0 24 24" aria-hidden="true">' + paths[key] + '</svg>';
  const t = value => global.SoduWorkI18n?.translateText(value) || value;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  let dialog, input, resultBox, tabBox, status, service, snapshot, active = 'all', selected = 0, visibleRows = [], limit = 40;
  let timer, restoreFocus, openEpoch = 0, composing = false, opening = false;
  let selectionTouched = false;
  let observedScope = sources.scope();
  let sidebarObserver, observedScroll;
  function alignEntry() {
    const entry = document.getElementById('wsGlobalSearch'), plus = document.getElementById('wsProjectAdd');
    const brand = entry?.closest('.ws-brand'), scroll = document.getElementById('wsSideScroll');
    if (brand && plus?.getClientRects().length && brand.getClientRects().length) {
      brand.style.paddingRight = Math.max(0, brand.getBoundingClientRect().right - plus.getBoundingClientRect().right) + 'px';
    }
    if (scroll && scroll !== observedScroll && global.ResizeObserver) {
      sidebarObserver?.disconnect(); observedScroll = scroll;
      sidebarObserver = new global.ResizeObserver(alignEntry); sidebarObserver.observe(scroll);
    }
  }
  function highlight(value) {
    const words = core.tokens(snapshot?.query), text = String(value || '');
    if (!words.length) return esc(text);
    const pattern = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const regex = new RegExp(pattern, 'giu'); let start = 0, html = '';
    for (const match of text.matchAll(regex)) { html += esc(text.slice(start, match.index)) + '<mark>' + esc(match[0]) + '</mark>'; start = match.index + match[0].length; }
    return html + esc(text.slice(start));
  }
  function available() {
    const states = Object.values(snapshot?.sources || {});
    return categories.filter(type => type === 'all' || states.some(source => source.categories.includes(type) && source.status !== 'denied'));
  }
  function renderTabs() {
    const tabs = available(); if (!tabs.includes(active)) active = 'all';
    tabBox.innerHTML = tabs.map(type => '<button type="button" role="tab" id="search-tab-' + type + '" aria-controls="globalSearchResults" aria-selected="' + (type === active) + '" tabindex="' + (type === active ? 0 : -1) + '" data-search-category="' + type + '">' + esc(t(type === 'all' ? '全部' : labels[type])) + '</button>').join('');
  }
  function date(value) {
    const stamp = core.rank ? (typeof value === 'number' ? value : Date.parse(value)) : 0;
    return stamp ? new Intl.DateTimeFormat(global.SoduWorkI18n?.getLocale?.() || 'en-US', { month: 'short', day: 'numeric' }).format(stamp) : '';
  }
  function renderResults(reset = false) {
    if (!dialog?.open || !snapshot) return;
    const selectedKey = !reset && selectionTouched && visibleRows[selected] ? key(visibleRows[selected]) : '';
    renderTabs();
    const hasQuery = !!snapshot.query;
    const allRows = snapshot.rows.filter(row => active === 'all' || row.type === active);
    const order = !hasQuery && active === 'all' ? ['actions', 'chats', 'library'] : active === 'all' ? Object.keys(labels) : [active];
    visibleRows = []; let html = '', total = 0;
    for (const type of order) {
      const list = allRows.filter(row => row.type === type);
      const max = !hasQuery && active === 'all' ? (type === 'actions' ? 3 : 5) : active === 'all' ? Math.max(4, Math.floor(limit / order.length)) : limit;
      const shown = list.slice(0, max); total += list.length;
      if (!shown.length) continue;
      html += '<section class="global-search-group" role="group" aria-label="' + esc(t(labels[type])) + '"><h3>' + esc(t(!hasQuery && type === 'chats' ? '最近会话' : !hasQuery && type === 'library' ? '最近资料' : labels[type])) + ' <span>' + list.length + '</span></h3>';
      for (const row of shown) {
        const index = visibleRows.length; visibleRows.push(row);
        html += '<div class="global-search-row" id="search-result-' + index + '" role="option" aria-selected="false" data-search-result="' + index + '">' +
          '<span class="global-search-glyph">' + icon(type) + '</span><span class="global-search-copy"><b>' + highlight(row.title) + '</b>' +
          (hasQuery && row.text ? '<small>' + highlight(core.snippet(row.text, snapshot.query)) + '</small>' : '') + '</span>' +
          '<span class="global-search-meta">' + (row.shortcut ? '<kbd>' + esc(row.shortcut) + '</kbd>' : '<span class="global-search-source">' + esc(row.source || t(labels[type])) + '</span>') +
          (row.at ? '<time>' + esc(date(row.at)) + '</time>' : '') + '</span></div>';
      }
      html += '</section>';
    }
    const relevant = Object.values(snapshot.sources).filter(source => active === 'all' || source.categories.includes(active));
    const loading = relevant.some(source => source.status === 'loading');
    const failed = relevant.some(source => source.status === 'error');
    const partial = relevant.some(source => source.status === 'partial');
    if (failed) html += '<div class="global-search-notice">' + esc(t('部分来源加载失败')) + ' <button type="button" data-search-retry>' + esc(t('重试')) + '</button></div>';
    if (partial) html += '<p class="global-search-notice">' + esc(t('部分内容未检索；云端会话仅搜索标题，大型存档可能超出本次检索范围')) + '</p>';
    if (loading) html += '<p class="global-search-notice" role="status">' + esc(t('正在搜索…')) + '</p>';
    if (!visibleRows.length && !loading) html += '<div class="global-search-empty">' + icon('search') + '<b>' + esc(t(failed ? '暂时无法搜索，请重试' : '没有找到相关内容')) + '</b><span>' + esc(t('试试其他关键词或切换分类')) + '</span></div>';
    if ((hasQuery || active !== 'all') && total > visibleRows.length) html += '<button type="button" class="global-search-more" data-search-more>' + esc(t('显示更多')) + '</button>';
    const top = reset ? 0 : resultBox.scrollTop; resultBox.innerHTML = html; resultBox.scrollTop = top;
    selected = selectedKey ? Math.max(0, visibleRows.findIndex(row => key(row) === selectedKey)) : 0;
    setSelection(selected, false);
    input.setAttribute('aria-busy', String(loading));
  }
  function key(row) { return [row.type, row.kind || '', row.id].join(':'); }
  function setSelection(index, scroll = true, touched = false) {
    if (touched) selectionTouched = true;
    selected = Math.max(0, Math.min(index, visibleRows.length - 1));
    resultBox.querySelectorAll('[data-search-result]').forEach((node, i) => node.setAttribute('aria-selected', String(i === selected)));
    if (visibleRows.length) {
      input.setAttribute('aria-activedescendant', 'search-result-' + selected);
      if (scroll) document.getElementById('search-result-' + selected)?.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function changeCategory(type) { active = type; selected = 0; selectionTouched = false; limit = 40; renderResults(true); input.focus(); }
  function syncInput() { dialog.querySelector('[data-search-clear]').hidden = input.value.length === 0; }
  function run() {
    syncInput();
    clearTimeout(timer); limit = 40;
    if (snapshot?.query !== input.value.trim()) { selected = 0; selectionTouched = false; }
    global.soduWorkAPI?.conversationSession?.cancelSearch?.();
    void service.search(input.value);
  }
  function close() {
    openEpoch++; clearTimeout(timer); service?.dispose();
    global.soduWorkAPI?.conversationSession?.cancelSearch?.(true);
    if (dialog?.open) dialog.close();
    snapshot = null; visibleRows = []; opening = false;
    if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
  }
  async function activate() {
    if (!visibleRows[selected] || opening) return;
    const row = visibleRows[selected], ticket = openEpoch, owner = sources.scope();
    opening = true;
    // Release the modal before native pickers or module-owned dialogs open.
    close(); const navigation = openEpoch;
    try {
      if (owner !== sources.scope()) return;
      await sources.open(row);
    } catch (_) {
      if (owner === sources.scope() && navigation === openEpoch) {
        open(); status.textContent = t('无法打开此结果，请刷新后重试');
      }
    } finally { if (ticket === openEpoch) opening = false; }
  }
  function mount() {
    if (dialog) return;
    dialog = document.createElement('dialog'); dialog.className = 'global-search-dialog'; dialog.id = 'globalSearchDialog';
    dialog.setAttribute('aria-label', t('全局搜索')); dialog.setAttribute('data-user-content', '');
    dialog.innerHTML = '<div class="global-search-input">' + icon('search') + '<input type="search" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="globalSearchResults" autocomplete="off" maxlength="200" spellcheck="false"><button type="button" data-search-clear hidden aria-label="' + esc(t('清除搜索')) + '">' + icon('close') + '</button><button type="button" class="global-search-close" data-search-close aria-label="' + esc(t('关闭搜索')) + '">' + icon('close') + '</button></div>' +
      '<div class="global-search-results" id="globalSearchResults" role="listbox" aria-label="' + esc(t('全局搜索')) + '"></div><p class="global-search-status" role="status" aria-live="polite"></p><footer><div class="global-search-tabs" role="tablist" aria-label="' + esc(t('切换分类')) + '"></div></footer>';
    document.body.appendChild(dialog);
    input = dialog.querySelector('input'); resultBox = dialog.querySelector('.global-search-results'); tabBox = dialog.querySelector('.global-search-tabs'); status = dialog.querySelector('.global-search-status');
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('click', event => {
      if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close(); return; }
      const target = event.target.closest('[data-search-category],[data-search-result],[data-search-close],[data-search-clear],[data-search-retry],[data-search-more]');
      if (!target) return;
      if (target.hasAttribute('data-search-close')) close();
      else if (target.hasAttribute('data-search-clear')) { input.value = ''; run(); input.focus(); }
      else if (target.dataset.searchCategory) changeCategory(target.dataset.searchCategory);
      else if (target.hasAttribute('data-search-result')) { setSelection(Number(target.dataset.searchResult), false); void activate(); }
      else if (target.hasAttribute('data-search-retry')) { service.invalidate(); global.soduWorkAPI?.conversationSession?.cancelSearch?.(true); run(); }
      else { limit += 40; renderResults(); }
    });
    input.addEventListener('compositionstart', () => { composing = true; clearTimeout(timer); });
    input.addEventListener('compositionend', () => { composing = false; clearTimeout(timer); timer = setTimeout(run, 100); });
    input.addEventListener('input', () => {
      syncInput();
      service.cancel(); global.soduWorkAPI?.conversationSession?.cancelSearch?.();
      selected = 0; selectionTouched = false;
      service.preview(input.value);
      clearTimeout(timer); if (!composing) timer = setTimeout(run, 100);
    });
    dialog.addEventListener('keydown', event => {
      event.stopPropagation();
      if (composing || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelection(selected + (event.key === 'ArrowDown' ? 1 : -1), true, true); input.focus(); }
      else if (event.key === 'Enter' && event.target === input) { event.preventDefault(); if (input.value.trim() === snapshot?.query) void activate(); }
      else if (event.key === 'Tab' && !event.shiftKey && event.target === input) {
        event.preventDefault(); const tabs = available(), index = tabs.indexOf(active);
        changeCategory(tabs[(index + (event.shiftKey ? tabs.length - 1 : 1)) % tabs.length]);
      } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) && event.target.matches('[role="tab"]')) {
        event.preventDefault(); const tabs = available(), index = tabs.indexOf(active);
        changeCategory(tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? tabs.length - 1 : 1)) % tabs.length]);
      }
    });
  }
  function translate() {
    alignEntry();
    const entry = document.getElementById('wsGlobalSearch');
    if (entry) { entry.title = t('全局搜索') + ' · ' + (global.ShortcutSettings?.getBinding('open-global-search') || 'Ctrl+Shift+F'); entry.setAttribute('aria-label', t('全局搜索')); }
    if (!dialog) return;
    input.placeholder = t('搜索会话、项目、需求、资料或快捷操作'); input.setAttribute('aria-label', input.placeholder);
    dialog.setAttribute('aria-label', t('全局搜索'));
    dialog.querySelector('[data-search-close]').setAttribute('aria-label', t('关闭搜索'));
    dialog.querySelector('[data-search-clear]').setAttribute('aria-label', t('清除搜索'));
    tabBox.setAttribute('aria-label', t('切换分类')); resultBox.setAttribute('aria-label', t('全局搜索'));
  }
  function open() {
    if (dialog?.open) { input.focus(); return; }
    if (document.querySelector('dialog[open]')) return;
    mount(); restoreFocus = document.activeElement; openEpoch++; observedScope = sources.scope(); active = 'all'; selected = 0; input.value = ''; status.textContent = ''; composing = false;
    service = core.create({ sources: sources.createSources(), scope: sources.scope, update(value) { snapshot = value; renderResults(); } });
    dialog.showModal(); translate(); input.focus(); run();
  }
  global.SoduWorkGlobalSearch = { open, close, refreshEntry: translate, isOpen: () => !!dialog?.open };
  global.addEventListener('soduwork-data-scope-changed', () => { observedScope = sources.scope(); close(); });
  global.addEventListener('soduwork-device-auth', () => { if (observedScope !== sources.scope()) { observedScope = sources.scope(); close(); } });
  ['soduwork:plugins-changed', 'soduwork-plugin-policy', 'soduwork-library-changed', 'soduwork-work-task-change'].forEach(name => global.addEventListener(name, () => { if (dialog?.open) { service.invalidate(); global.soduWorkAPI?.conversationSession?.cancelSearch?.(true); snapshot = null; visibleRows = []; resultBox.replaceChildren(); run(); } }));
  global.addEventListener('soduwork-locale-change', () => { translate(); if (dialog?.open) run(); });
  global.addEventListener('soduwork-shortcuts-changed', translate);
})(window);
