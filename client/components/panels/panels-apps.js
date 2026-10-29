/*
 * Application catalog for custom interfaces and external H5 apps. Interface plugins share
 * the package/install channel; opening one launches its work surface rather than a
 * conversation. Personal/favorite sections use installed items, the market uses the remote
 * catalog, and isolated web views receive only manifest-authorized bridge capabilities.
 */

const APPS_GLYPH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.65" stroke-linejoin="round" d="M5 4.75h5.5v5.5H5zM13.5 4.75H19v5.5h-5.5zM5 13.75h5.5v5.5H5zM13.5 13.75H19v5.5h-5.5z"/></svg>';
const APPS_ICONS = {
  gift: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><g stroke="none"><rect x="5" y="12.75" width="14" height="7.5" rx="1.5" fill="#7c5cf0"/><rect x="3.75" y="9.5" width="16.5" height="3.9" rx="1.4" fill="#4f8df7"/><path d="M11.25 13.4v7.4a.75.75 0 0 0 1.5 0v-7.4Z" fill="#ffffff" opacity=".85"/><rect x="5.35" y="4.35" width="3.2" height="3.2" rx=".9" fill="#f59e0b"/><rect x="10.55" y="2.6" width="2.9" height="2.9" rx=".8" fill="#ec4899"/><circle cx="17.35" cy="5.6" r="1.6" fill="#22d3ee"/></g><path d="M12 7.25V5.9" stroke="#7c5cf0" stroke-width="1.5" stroke-linecap="round"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16.2 16.2 4.3 4.3"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.35-5.65"/><path d="M20 3.5V8h-4.5"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.25"/><path d="M3.75 12h16.5M12 3.75c2.4 2.1 3.6 4.9 3.6 8.25s-1.2 6.15-3.6 8.25c-2.4-2.1-3.6-4.9-3.6-8.25s1.2-6.15 3.6-8.25Z"/></svg>',
  monitor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.75" y="5.25" width="16.5" height="10.5" rx="1.75"/><path d="M9.25 19.5h5.5M12 15.75v3.75"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M13.25 3.75 6.5 13.5h4.25l-.75 6.75 6.75-9.75h-4.25Z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5.5 12.5 4.2 4.2 8.8-9.4"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="m12 4 2.35 4.9 5.35.72-3.92 3.75.92 5.3L12 15.9l-4.62 2.05.92-5.3-3.92-3.75 5.35-.72Z"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/></svg>',
};
const APPS_FAV_KEY = 'soduwork-apps-favorites';
let _appsRenderSeq = 0;
let _appsCache = null; /* Cache all local and remote applications; tabs and search filter the cache. */
let _appsSettingsSeq = 0;
const _appsUi = { tab: 'mine', query: '' };

function appKeyOf(item) {
  return String(item && (item.pluginId || item.key || item.id) || '').trim() || 'unknown';
}
function favoriteAppIds() {
  try { return JSON.parse(localStorage.getItem(APPS_FAV_KEY) || '[]') || []; }
  catch (_e) { return []; }
}
function toggleFavoriteApp(key) {
  const ids = favoriteAppIds();
  const at = ids.indexOf(key);
  if (at >= 0) ids.splice(at, 1); else ids.push(key);
  try { localStorage.setItem(APPS_FAV_KEY, JSON.stringify(ids)); } catch (_e) { /* Continue if local preference storage fails. */ }
  return at < 0;
}
function removeFavoriteApp(key) {
  const ids = favoriteAppIds();
  const at = ids.indexOf(key);
  if (at < 0) return;
  ids.splice(at, 1);
  try { localStorage.setItem(APPS_FAV_KEY, JSON.stringify(ids)); } catch (_e) { /* Continue if local preference storage fails. */ }
}

/* App creation still starts with type selection; catalog cards label only local installation sources. */
const APP_KIND_LABELS = { web: '网页应用', desktop: '桌面客户端', lite: '轻应用' };
function appSourceTagHtml(app) {
  return app.item.personal ? '<span class="appsx-source-tag">本机安装</span>' : '';
}
async function appSettingsOf(key) {
  const api = window.soduWorkAPI?.appSettings;
  if (!api) throw Error('应用设置需要更新客户端后使用');
  let result = await api.get(key);
  if (!result?.ok) throw Error(result?.reason || '应用设置读取失败');
  const legacyKey = 'soduwork-app-settings:' + key;
  const legacy = localStorage.getItem(legacyKey);
  if (legacy) {
    const values = Object.fromEntries(Object.entries(JSON.parse(legacy)).filter(([key]) => !result.configuredKeys.includes(key)));
    if (Object.keys(values).length) {
      result = await api.update(key, { values, expectedRevision: result.revision });
      if (!result?.ok) throw Error(result?.reason || '旧设置迁移失败');
    }
    localStorage.removeItem(legacyKey);
  }
  return result;
}
async function saveAppSettings(key, options) {
  const result = await window.soduWorkAPI.appSettings.update(key, options);
  if (!result?.ok) throw Error(result?.reason || '应用设置保存失败');
  window.dispatchEvent(new CustomEvent('soduwork:app-settings-changed', { detail: { appKey: key } }));
}

function openAppsPanel() {
  let p = document.getElementById('appsPanel');
  if (!p) {
    p = document.createElement('div');
    p.id = 'appsPanel';
    p.className = 'sch-panel appsx';
    p.innerHTML = appsPageHtml();
    document.body.appendChild(p);
    bindAppsPage(p);
    if (typeof makeDraggable === 'function') makeDraggable(p, p.querySelector('.appsx-top'));
    /* Refresh an open catalog after installation, removal, or policy changes. */
    window.addEventListener('soduwork:plugins-changed', function () {
      _appsCache = null;
      if (p.classList.contains('show')) renderAppsCatalog(true);
    });
    window.addEventListener('soduwork-plugin-policy', function () {
      ++_appsRenderSeq; _appsCache = null;
      if (p.classList.contains('show')) renderAppsCatalog(true);
      else p.querySelector('#appsBody').textContent = '';
    });
    window.addEventListener('soduwork-locale-change', function () {
      _appsCache = null;
      if (p.classList.contains('show')) renderAppsCatalog(true);
    });
    window.addEventListener('soduwork-data-scope-changed', function () {
      closeAppSettings();
      ++_appsRenderSeq; _appsCache = null; _appsUi.query = '';
      p.querySelector('#appsSearch').value = '';
      if (p.classList.contains('show')) renderAppsCatalog(true);
    });
  }
  p.classList.add('show');
  if (typeof expandForOverlay === 'function') expandForOverlay();
  renderAppsCatalog(true);
}

function closeAppsPanel() {
  const p = document.getElementById('appsPanel');
  if (p && p.classList.contains('show')) {
    p.classList.remove('show');
    if (typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
  }
}

function appsPageHtml() {
  return '<div class="appsx-top">' +
    '<div class="appsx-title-wrap"><h1 class="appsx-title"><span class="appsx-title-gift" aria-hidden="true">' + APPS_ICONS.gift + '</span>应用</h1>' +
    '<p class="appsx-sub">连接应用，让 SoduWork 在你的各类工具中协同工作</p></div>' +
    '<div class="appsx-tools">' +
    '<label class="appsx-search">' + APPS_ICONS.search +
    '<input id="appsSearch" type="text" placeholder="搜索应用" spellcheck="false" autocomplete="off"></label>' +
    '<div class="appsx-tabs" role="tablist" aria-label="应用范围">' +
    '<button class="appsx-tab active" data-tab="mine" role="tab" aria-selected="true" type="button">我的</button>' +
    '<button class="appsx-tab" data-tab="market" role="tab" aria-selected="false" type="button">市场</button></div>' +
    '<button class="appsx-icon-btn" id="appsRefresh" title="刷新" type="button">' + APPS_ICONS.refresh + '</button>' +
    '<button class="appsx-pill" id="appsAdd" type="button">添加' + APPS_ICONS.plus + '</button>' +
    '<button class="appsx-icon-btn" id="appsClose" title="关闭" type="button">' + APPS_ICONS.close + '</button>' +
    '</div></div>' +
    '<div class="appsx-scroll" id="appsBody"></div>';
}

function bindAppsPage(p) {
  p.querySelector('#appsSearch').addEventListener('input', function () {
    _appsUi.query = this.value || '';
    renderAppsCatalog(false); /* Filter and render cached entries without refetching the catalog. */
  });
  p.querySelector('#appsRefresh').addEventListener('click', function () {
    this.classList.remove('is-spinning'); void this.offsetWidth; this.classList.add('is-spinning');
    renderAppsCatalog(true);
  });
  p.querySelector('#appsAdd').addEventListener('click', function () {
    openAppsCreateDialog();
  });
  p.querySelector('#appsClose').addEventListener('click', closeAppsPanel);
  p.querySelectorAll('.appsx-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      if (_appsUi.tab === this.dataset.tab) return;
      _appsUi.tab = this.dataset.tab;
      p.querySelectorAll('.appsx-tab').forEach(function (x) {
        const active = x === tab;
        x.classList.toggle('active', active);
        x.setAttribute('aria-selected', String(active));
      });
      renderAppsCatalog(false);
    });
  });
}

/*
 * Use the shared plugin catalog, including authorized uninstalled remote applications.
 * Filter installed entries for the personal tab; the sidebar's three-item limit does not
 * apply here.
 */
async function loadAppsCatalog() {
  const plugins = await Promise.allSettled([(window.SoduWorkAPI && typeof window.SoduWorkAPI.pluginCatalog === 'function')
    ? window.SoduWorkAPI.pluginCatalog() : Promise.resolve({ items:[] })]).then(results => results[0]);
  const result = plugins.status === 'fulfilled' ? plugins.value : { items:[],remoteError:'插件应用暂时无法加载：' + plugins.reason.message };
  if (plugins.status === 'rejected') throw plugins.reason;
  const items = Array.isArray(result && result.items) ? result.items : [];
  const apps = [];
  items.forEach(function (item) {
    if (!item || item.enabled === false) return;
    if (!item.personal && item.permissions && item.permissions.canUse === false) return;
    const rows = item.ui && Array.isArray(item.ui.contributions) ? item.ui.contributions : [];
    let row = null;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].slot === 'workspace.navigation') { row = rows[i]; break; }
    }
    if (!row) return;
    apps.push({
      item,
      row,
      title: String(item.name || row.title || '应用'),
      desc: String(item.description || row.description || ''),
    });
  });
  /* Sort built-ins first, then names; favorites retain their own order. */
  apps.sort(function (a, b) {
    const ab = a.item.builtIn ? 0 : 1, bb = b.item.builtIn ? 0 : 1;
    if (ab !== bb) return ab - bb;
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });
  apps.remoteError = String(result && result.remoteError || '');
  return apps;
}

function appsForCurrentTab(all) {
  let list = all.filter(function (app) {
    return _appsUi.tab === 'market'
      ? !app.item.personal && app.item.listed !== false
      : Boolean(app.item.personal || app.item.installed);
  });
  const query = _appsUi.query.trim().toLowerCase();
  if (query) {
    list = list.filter(function (app) {
      return (app.title + ' ' + app.desc).toLowerCase().includes(query);
    });
  }
  return list;
}

async function renderAppsCatalog(force) {
  const body = document.getElementById('appsBody');
  if (!body) return;
  if (_appsCache && !force) {
    ++_appsRenderSeq; /* Invalidate pending requests and render the cache immediately. */
    renderAppsInto(body, _appsCache);
    return;
  }
  const ticket = ++_appsRenderSeq;
  if (!_appsCache) body.innerHTML = '<div class="appsx-loading">正在载入应用…</div>';
  let apps;
  try { apps = await loadAppsCatalog(); }
  catch (error) {
    if (ticket !== _appsRenderSeq) return;
    if ([401, 403].includes(Number(error && error.status))) _appsCache = null;
    if (_appsCache) appsRefreshNotice(body, error);
    else renderAppsError(body, error);
    return;
  }
  if (ticket !== _appsRenderSeq) return; /* Discard stale catalog refresh results. */
  if (_appsCache && apps.remoteError) {
    appsRefreshNotice(body, new Error(apps.remoteError));
    return;
  }
  appsRefreshNotice(body);
  const unchanged = _appsCache && JSON.stringify([_appsCache, _appsCache.remoteError]) === JSON.stringify([apps, apps.remoteError]);
  _appsCache = apps;
  if (!unchanged) renderAppsInto(body, apps);
}

function appsRefreshNotice(body, error) {
  body.querySelector('#appsRefreshNotice')?.remove();
  if (!error) return;
  if (_appsCache) _appsCache.remoteError = String(error.message || error);
  const notice = document.createElement('p');
  notice.id = 'appsRefreshNotice'; notice.className = 'appsx-market-error';
  notice.setAttribute('role', 'status');
  notice.textContent = '刷新失败，正在显示上次内容。';
  const retry = document.createElement('button');
  retry.className = 'btn-mini'; retry.type = 'button'; retry.textContent = '重试';
  retry.setAttribute('data-apps-retry', '');
  retry.addEventListener('click', () => renderAppsCatalog(true)); notice.appendChild(retry);
  body.prepend(notice);
}

function appsSectionsFor(list) {
  if (_appsUi.tab === 'market') return [{ key: 'market', label: '市场', items: list }];
  const query = _appsUi.query.trim().toLowerCase();
  const recommendations = (_appsCache || []).filter(app => !app.item.personal && app.item.marketPolicy?.featured && app.item.listed !== false)
    .map(app => {
      const local = list.find(candidate => candidate.item.personal && (
        candidate.item.sourcePluginId === app.item.pluginId ||
        (candidate.item.key && candidate.item.key === app.item.key && /^https?:/.test(candidate.row.source?.url || '') && candidate.row.source.url === app.row.source?.url)));
      return local ? { ...local, item: { ...local.item, coverUrl: app.item.coverUrl || local.item.coverUrl } } : app;
    }).filter(app => !query || (app.title + ' ' + app.desc).toLowerCase().includes(query));
  // Recommendations are independent exposure groups and may include a favorited installed application.
  // Favorites and the remaining personal list are mutually exclusive to avoid duplicates.
  const ids = favoriteAppIds();
  const favorites = list.filter(app => ids.indexOf(appKeyOf(app.item)) >= 0)
    .sort((a, b) => ids.indexOf(appKeyOf(b.item)) - ids.indexOf(appKeyOf(a.item)));
  const remaining = list.filter(app => ids.indexOf(appKeyOf(app.item)) < 0);
  return [{ key: 'recommended', label: '推荐', items: recommendations }, { key: 'favorites', label: '常用', items: favorites }, { key: 'mine', label: '我的', items: remaining }];
}

function appsEmptyHtml(query, section, allInFavorites) {
  if (section === 'recommended') return '<p class="appsx-section-empty">' + (query ? '推荐应用中没有匹配结果。' : '暂无推荐应用。') + '</p>';
  if (section === 'mine' && allInFavorites && !query) {
    return '<p class="appsx-section-empty">已安装的应用可在上方分组中打开。</p>';
  }
  if (section === 'favorites') {
    return '<p class="appsx-section-empty">' + (query ? '常用应用中没有匹配结果。' : '点击应用卡片上的 ★，将常用应用固定在这里。') + '</p>';
  }
  if (query) {
    return '<div class="appsx-empty"><span class="appsx-empty-ico">' + APPS_ICONS.search + '</span>' +
      '<b>没有找到「' + escapeAppsHtml(query) + '」</b>' +
      '<span>换个关键词，或切换到「我的 / 市场」试试。</span></div>';
  }
  if (section === 'mine') {
    return '<div class="appsx-empty"><span class="appsx-empty-ico">' + APPS_GLYPH + '</span>' +
      '<b>还没有我的应用</b>' +
      '<span>从市场添加远端应用，或导入本机的 .soduwork-plugin 应用包。</span>' +
      '<button class="appsx-pill small" id="appsEmptyInstall" type="button">安装应用包</button></div>';
  }
  return '<div class="appsx-empty"><span class="appsx-empty-ico">' + APPS_GLYPH + '</span>' +
    '<b>市场暂无应用</b>' +
    '<span>这里展示远端发布并向你开放的应用。</span></div>';
}

function renderAppsError(body, error) {
  body.innerHTML = '<div class="appsx-empty" role="status"><b>应用目录暂时无法加载</b><span>' +
    escapeAppsHtml(String(error && error.message || error)) + '</span><button class="appsx-pill small" data-apps-retry>重试</button></div>';
  body.querySelector('[data-apps-retry]').addEventListener('click', () => renderAppsCatalog(true));
}

function appsCardHtml(app, index, recommended, conversation) {
  const customIcon = (window.SoduWorkPluginIcon && SoduWorkPluginIcon.imageFor(app.item)) || '';
  const key = appKeyOf(app.item);
  const faved = favoriteAppIds().indexOf(key) >= 0;
  const favorite = '<button class="appsx-act appsx-fav' + (faved ? ' is-fav' : '') + '" type="button" aria-pressed="' + faved + '" title="' +
    (faved ? '取消常用' : '收藏为常用') + '" aria-label="' + (faved ? '取消常用' : '收藏为常用') + '">' + APPS_ICONS.star + '</button>';
  const needsSync = !app.item.personal && (!app.item.installed || app.item.updateAvailable);
  let cover = '';
  try { const url = new URL(app.item.coverUrl || app.item.marketPolicy?.coverUrl || ''); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) cover = url.href; } catch (_) {}
  if (recommended) return '<div class="appsx-card appsx-cover-card" data-app-index="' + index + '" role="button" tabindex="0" aria-label="' + escapeAppsHtml(app.title) + '">' +
    '<div class="appsx-cover">' + (cover ? '<img src="' + escapeAppsHtml(cover) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '<span>' + APPS_GLYPH + '</span>') +
    '</div><div class="appsx-cover-info"><div class="appsx-cover-copy"><div class="appsx-cover-meta"><span class="appsx-app-ico' + (customIcon ? ' has-img' : '') + '">' + (customIcon || APPS_GLYPH) + '</span>' +
    '<span class="appsx-card-txt"><b data-user-content>' + escapeAppsHtml(app.title) + '</b></span></div>' +
    '<p class="appsx-cover-desc" data-user-content>' + escapeAppsHtml(app.desc || '打开应用工作界面') + '</p></div>' +
    '<div class="appsx-cover-actions"><div class="appsx-cover-tools">' + favorite +
    (!needsSync ? '<button class="appsx-act appsx-set" type="button" title="应用设置" aria-label="应用设置">' + APPS_ICONS.gear + '</button>' : '') + '</div>' +
    '<button class="appsx-card-open" type="button" aria-label="打开应用">打开应用</button></div></div></div>';
  return '<div class="appsx-card' + (conversation ? ' nmessage-app-card' : '') + '" ' +
    (conversation ? 'data-chat-app="' + escapeAppsHtml(key) + '"' : 'data-app-index="' + index + '"') + ' role="button" tabindex="0" title="' + (needsSync ? (app.item.updateAvailable ? '升级并打开应用' : '添加并打开应用') : '打开应用') + '">' +
    '<span class="appsx-app-ico' + (customIcon ? ' has-img' : '') + '">' + (customIcon || APPS_GLYPH) + '</span>' +
    '<span class="appsx-card-txt"><span class="appsx-card-headline"><b data-user-content>' + escapeAppsHtml(app.title) + '</b>' + appSourceTagHtml(app) + '</span>' +
    '<small data-user-content>' + (app.desc ? escapeAppsHtml(app.desc) : '打开应用工作界面') + '</small></span>' +
    (needsSync ? '<span class="appsx-card-add" aria-hidden="true">' + APPS_ICONS.plus + '</span>' : '') +
    '<span class="appsx-card-acts">' +
    (!needsSync ? '<button class="appsx-act appsx-set" type="button" title="应用设置" aria-label="应用设置">' + APPS_ICONS.gear + '</button>' : '') +
    favorite + (conversation ? '<button type="button" class="appsx-card-open" data-chat-open-app="' + escapeAppsHtml(key) + '">打开应用</button>' : '') + '</span></div>';
}

function renderAppsInto(body, all) {
  const list = [], visible = appsForCurrentTab(all);
  let html = '';
  if (all.remoteError) {
    html += '<p class="appsx-market-error" role="status">远端市场暂时无法加载：' + escapeAppsHtml(all.remoteError) + '<button class="btn-mini" type="button" data-apps-retry>重试</button></p>';
  }
  html += appsSectionsFor(visible).map(function (section) {
    const cards = section.items.map(app => appsCardHtml(app, list.push(app) - 1, section.key === 'recommended')).join('');
    return '<section class="appsx-section" data-apps-section="' + section.key + '">' +
      '<header class="appsx-sec-head"><h2>' + escapeAppsHtml(section.label) + '</h2></header>' +
      (cards ? '<div class="appsx-grid">' + cards + '</div>' :
        (section.key === 'market' && all.remoteError ? '' : appsEmptyHtml(_appsUi.query.trim(), section.key, visible.length > 0))) + '</section>';
  }).join('');
  body.innerHTML = html;
  body.querySelector('[data-apps-retry]')?.addEventListener('click', () => renderAppsCatalog(true));
  body.querySelectorAll('.appsx-cover img').forEach(img => img.addEventListener('error', () => { img.hidden = true; img.parentElement.classList.add('is-fallback'); }));

  /* Click a card to open the application; favorite/settings controls handle their own events. */
  body.querySelectorAll('.appsx-card').forEach(function (card) {
    const app = list[Number(card.dataset.appIndex)];
    if (!app) return;
    const key = appKeyOf(app.item);
    card.addEventListener('click', function (event) {
      if (event.target.closest('.appsx-act')) return; /* Badge actions must not also open the application. */
      openAppsCard(app, card);
    });
    card.addEventListener('keydown', function (event) {
      if (event.target !== card) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openAppsCard(app, card); }
    });
    const fav = card.querySelector('.appsx-fav');
    if (fav) fav.addEventListener('click', function () {
      toggleFavoriteApp(key);
      renderAppsCatalog(false); /* Update matching favorite indicators across both sections. */
    });
    const set = card.querySelector('.appsx-set');
    if (set) set.addEventListener('click', function () { openAppSettings(app); });
  });
  const emptyInstall = body.querySelector('#appsEmptyInstall');
  if (emptyInstall) emptyInstall.addEventListener('click', installAppPackage);
}

/* Application settings and H5 settings.get/update share main-process secure storage. */
async function openAppSettings(app) {
  if (!app) return;
  const ticket = ++_appsSettingsSeq;
  const key = appKeyOf(app.item);
  let record;
  try { record = await appSettingsOf(key); } catch (error) { sayAppsMessage(error.message); return; }
  if (ticket !== _appsSettingsSeq) return;
  const settings = record.values;
  let mask = document.getElementById('appsSettingsMask');
  if (!mask) {
    mask = document.createElement('div');
    mask.id = 'appsSettingsMask';
    mask.className = 'appsx-mask';
    mask.innerHTML = '<div class="appsx-modal" role="dialog" aria-label="应用设置"></div>';
    document.body.appendChild(mask);
    mask.addEventListener('pointerdown', function (event) { if (event.target === mask) closeAppSettings(); });
    document.addEventListener('keydown', function onKey(event) {
      if (event.key === 'Escape' && mask.classList.contains('show')) { closeAppSettings(); event.stopPropagation(); }
    });
  }
  const modal = mask.querySelector('.appsx-modal');
  const publicParams = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'model'));
  const paramsText = JSON.stringify(publicParams, null, 2);
  const hasUkey = record.secretKeys.includes('ukey');
  const showUkey = hasUkey || app.item.key === 'ops-cloud-console' || app.item.capabilities?.mcpServers?.includes('media-ops-cloud');
  modal.innerHTML =
    '<header class="appsx-modal-head"><b data-user-content>' + escapeAppsHtml(app.title) + ' · 应用设置</b>' +
    '<button class="appsx-icon-btn" id="appsSetClose" type="button">' + APPS_ICONS.close + '</button></header>' +
    '<div class="appsx-modal-body">' +
    (showUkey ? '<div class="appsx-field"><span>ukey</span><div class="appsx-secret-row"><code id="appsSetUkeyMask">' + escapeAppsHtml(hasUkey ? record.secretMasks?.ukey || '****' : '尚未填写') + '</code>' +
    '<button class="appsx-secret-edit" id="appsSetUkeyEdit" type="button">' + (hasUkey ? '重新填写' : '填写 ukey') + '</button></div>' +
    '<input id="appsSetUkey" aria-label="新的 ukey" type="password" autocomplete="new-password" spellcheck="false" placeholder="填写新的 ukey" hidden></div>' : '') +
    '<label class="appsx-field"><span>默认模型</span>' +
    '<input id="appsSetModel" type="text" spellcheck="false" autocomplete="off" placeholder="留空则跟随会话当前模型" value="' + escapeAppsHtml(String(settings.model || '')) + '"></label>' +
    '<label class="appsx-field"><span>应用参数（JSON）</span>' +
    '<textarea id="appsSetParams" rows="5" spellcheck="false" placeholder="{&quot;temperature&quot;: 0.7}">' + escapeAppsHtml(paramsText) + '</textarea></label>' +
    '<p class="appsx-modal-note">这些设置只属于「' + escapeAppsHtml(app.title) + '」，由本机安全存储保存，与页面自动同步。未重新填写时保留原凭据。' + escapeAppsHtml(record.secretKeys.length ? ' 已配置：' + record.secretKeys.join('、') : '') + '</p>' +
    '<p class="appsx-settings-error" id="appsSetError" role="alert" hidden></p>' +
    '</div>' +
    '<footer class="appsx-modal-foot"><button class="appsx-remove" id="appsSetRemove" type="button">移除应用</button><span class="push"></span><button class="appsx-pill small" id="appsSetSave" type="button">保存</button></footer>';
  mask.classList.add('show');
  function showError(message) {
    const target = modal.querySelector('#appsSetError'); target.hidden = false; target.textContent = message;
    target.scrollIntoView({ block: 'nearest' });
  }
  modal.querySelector('#appsSetClose').addEventListener('click', closeAppSettings);
  modal.querySelector('#appsSetRemove').addEventListener('click', async function () {
    if (ticket !== _appsSettingsSeq) return;
    this.disabled = true;
    this.textContent = '正在移除…';
    modal.querySelectorAll('input,textarea,button').forEach(control => { control.disabled = true; });
    try {
      const result = app.item.personal
        ? await SoduWorkAPI.deletePersonalPlugin(key)
        : await SoduWorkAPI.setEnterprisePluginInstalled(app.item.pluginId, false);
      if (result && result.ok === false) throw Error(result.reason || result.error || '应用没有移除成功');
      removeFavoriteApp(key);
      closeAppSettings();
      _appsCache = null;
      await renderAppsCatalog(true);
      sayAppsMessage('应用已移除并卸载');
    } catch (error) {
      this.disabled = false;
      modal.querySelectorAll('input,textarea,button').forEach(control => { control.disabled = false; });
      this.textContent = '移除应用';
      showError(String(error && error.message || error));
    }
  });
  const ukeyInput = modal.querySelector('#appsSetUkey');
  modal.querySelector('#appsSetUkeyEdit')?.addEventListener('click', function () {
    ukeyInput.hidden = !ukeyInput.hidden;
    if (ukeyInput.hidden) { ukeyInput.value = ''; this.textContent = hasUkey ? '重新填写' : '填写 ukey'; }
    else { this.textContent = '取消填写'; ukeyInput.focus(); }
  });
  modal.querySelector('#appsSetSave').addEventListener('click', async function () {
    if (ticket !== _appsSettingsSeq) return;
    const model = String(modal.querySelector('#appsSetModel').value || '').trim();
    const raw = rawParamsValue(modal);
    let params = {};
    if (raw) {
      try { params = JSON.parse(raw); }
      catch (error) { showError('参数不是合法 JSON：' + String(error && error.message || error)); return; }
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) { showError('应用参数必须是 JSON 对象'); return; }
    if (ukeyInput && !ukeyInput.hidden) {
      const value = ukeyInput.value.trim();
      if (!value) { showError('请输入新的 ukey，或取消填写以保留原值'); return; }
      params.ukey = value;
    }
    this.disabled = true;
    modal.querySelectorAll('input,textarea,button').forEach(control => { control.disabled = true; });
    try { await saveAppSettings(key, { values: { ...params, model }, expectedRevision: record.revision,
      remove: Object.keys(publicParams).filter(key => !Object.hasOwn(params, key)) }); }
    catch (error) { showError(error.message); modal.querySelectorAll('input,textarea,button').forEach(control => { control.disabled = false; }); return; }
    if (ukeyInput) ukeyInput.value = '';
    if (ticket === _appsSettingsSeq) closeAppSettings();
  });
}
function rawParamsValue(modal) { return String(modal.querySelector('#appsSetParams').value || '').trim(); }
function closeAppSettings() {
  ++_appsSettingsSeq;
  const box = document.getElementById('appsSettingsMask');
  if (box) { box.classList.remove('show'); const input = box.querySelector('#appsSetUkey'); if (input) input.value = ''; }
}

/* Core app-open chain (shared by apps-page cards and composer-page recommendation rows):
   sync-install first when not installed/pending upgrade, then open the workspace in a
   standalone window. */
async function openAppFromItem(item) {
  if (!item || !window.PluginUIHost || typeof window.PluginUIHost.openContribution !== 'function') {
    throw Error('应用页面暂时不可用，请刷新应用目录后重试');
  }
  const key = appKeyOf(item);
  const navRow = (item.ui && Array.isArray(item.ui.contributions) ? item.ui.contributions : [])
    .find(row => row && row.slot === 'workspace.navigation') || null;
  if (!navRow) throw Error('应用页面不存在，请刷新后重试');
  if (!item.personal && (!item.installed || item.updateAvailable)) {
    if (!window.SoduWorkAPI || typeof window.SoduWorkAPI.setEnterprisePluginInstalled !== 'function') {
      throw Error('应用同步入口暂不可用，请更新客户端');
    }
    const result = await window.SoduWorkAPI.setEnterprisePluginInstalled(item.pluginId, true, item.versionId);
    if (result && result.ok === false) throw Error(result.reason || result.error || '应用同步失败');
    _appsCache = await loadAppsCatalog();
    const body = document.getElementById('appsBody');
    if (body && _appsCache) renderAppsInto(body, _appsCache);
    const latest = (_appsCache || []).find(candidate => appKeyOf(candidate.item) === key && candidate.item.installed);
    await window.PluginUIHost.openContribution(latest ? latest.row : navRow, { item: latest ? latest.item : item, detached: true });
    return;
  }
  await window.PluginUIHost.openContribution(navRow, { item, detached: true });
}

async function openAppsCard(app, card) {
  if (!app || !card || card.classList.contains('is-opening')) return;
  card.classList.add('is-opening');
  card.setAttribute('aria-busy', 'true');
  const action = card.querySelector('.appsx-card-open');
  const needsSync = !app.item.personal && (!app.item.installed || app.item.updateAvailable);
  if (action && needsSync) action.textContent = '加载中…';
  try { await openAppFromItem(app.item); }
  catch (error) { sayAppsMessage('应用没能打开：' + String(error && error.message || error)); }
  finally {
    card.classList.remove('is-opening'); card.removeAttribute('aria-busy');
    if (action) action.textContent = '打开应用';
  }
}

async function conversationApplication(pluginId) {
  const scope = window.SoduWorkAPI?.taskStorageKey?.('plugins');
  const apps = await loadAppsCatalog();
  if (scope !== window.SoduWorkAPI?.taskStorageKey?.('plugins')) throw Error('账号已变化，请重新打开应用');
  const app = apps.find(row => row.item.pluginId === pluginId);
  if (!app) throw Error('应用已停用或不可用，请检查应用列表');
  return app;
}
async function openConversationApplication(pluginId) { return openAppFromItem((await conversationApplication(pluginId)).item); }
async function settingsConversationApplication(pluginId) { return openAppSettings(await conversationApplication(pluginId)); }
function conversationCardHtml(item) {
  return appsCardHtml({ item, title: String(item.name || '应用'), desc: String(item.description || '') }, 0, false, true);
}

/*
 * Route plugin management through workspace navigation to update sidebar selection;
 * standalone windows fall back to the plugin panel.
 */
function openAppsPluginsPage() {
  if (document.documentElement.getAttribute('data-desk-panel') === 'workspace' &&
      window.WorkspaceHost && typeof window.WorkspaceHost.open === 'function') {
    window.WorkspaceHost.open('skills');
    return;
  }
  if (typeof openSkillPanel !== 'function') { sayAppsMessage('插件页暂时不可用，请更新客户端'); return; }
  closeAppsPanel();
  openSkillPanel();
}

/* Local installation uses the personal-plugin package selection, preflight, and save flow. */
async function installAppPackage() {
  if (!window.SoduWorkPluginMakerUtils || typeof window.SoduWorkPluginMakerUtils.choosePackage !== 'function') {
    sayAppsMessage('安装器暂不可用，请更新客户端后重试');
    return;
  }
  await window.SoduWorkPluginMakerUtils.choosePackage(SoduWorkAPI, {
    local: function (body, preview) { confirmAppInstall(body, preview); },
    archive: function (file, preview) {
      const draft = preview && preview.personalDraft;
      if (preview && preview.sourceKind === 'personal' && draft && !(preview.capabilities?.adapterBlockers || []).length) {
        confirmAppInstall(draft, preview);
      } else confirmAppInstall(null, preview, '这个包不是本地应用格式，请从「插件」页安装');
    },
    error: function (error) { sayAppsMessage('应用包预检没有通过：' + String(error && error.message || error)); },
  });
}

/* ---- Create-app dialog: select a web app, desktop client, or lightweight app first.
   Create then opens the existing app-development conversation with a type-specific input prefix. ---- */
const APPS_CREATE_KINDS = [
  { kind: 'lite', icon: 'bolt', desc: '轻应用是在 SoduWork 内自建的轻量应用' },
  { kind: 'web', icon: 'globe', desc: '连接外部网页服务，在应用壳的独立窗口中打开' },
  { kind: 'desktop', icon: 'monitor', desc: '接入本机安装注册的桌面客户端应用' },
];
function appsCreateDialog() {
  let mask = document.getElementById('appsCreateMask');
  if (mask) return mask;
  mask = document.createElement('div');
  mask.id = 'appsCreateMask';
  mask.className = 'appsx-mask';
  mask.innerHTML = '<div class="appsx-modal appsx-create" role="dialog" aria-modal="true" aria-label="创建应用">' +
    '<header class="appsx-modal-head"><b>创建应用</b>' +
    '<button class="appsx-icon-btn" id="appsCreateClose" type="button" title="关闭">' + APPS_ICONS.close + '</button></header>' +
    '<div class="appsx-modal-body appsx-create-body">' +
    '<p class="appsx-modal-note">选择要创建的应用类型，点击「立即创建」后在对话中继续描述你的应用。</p>' +
    '<div class="appsx-create-options" role="radiogroup" aria-label="应用类型">' +
    APPS_CREATE_KINDS.map(function (row) {
      return '<button class="appsx-create-opt" type="button" role="radio" aria-checked="false" data-kind="' + row.kind + '">' +
        (row.kind === 'lite' ? '<span class="appsx-create-easy">简易</span>' : '') +
        '<span class="appsx-create-ico" aria-hidden="true">' + APPS_ICONS[row.icon] + '</span>' +
        '<span class="appsx-create-txt"><b>' + APP_KIND_LABELS[row.kind] + '</b><small>' + row.desc + '</small></span>' +
        '<span class="appsx-create-mark" aria-hidden="true">' + APPS_ICONS.check + '</span></button>';
    }).join('') +
    '</div></div>' +
    '<footer class="appsx-modal-foot appsx-create-foot">' +
    '<button class="appsx-pill small" id="appsCreateInstall" type="button">导入应用包</button>' +
    '<span class="push"></span>' +
    '<button class="btn-mini" id="appsCreateCancel" type="button">取消</button>' +
    '<button class="appsx-pill small" id="appsCreateGo" type="button" disabled>立即创建</button>' +
    '</footer></div>';
  document.body.appendChild(mask);
  mask.addEventListener('pointerdown', function (event) { if (event.target === mask) closeAppsCreateDialog(); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && mask.classList.contains('show')) { closeAppsCreateDialog(); event.stopPropagation(); }
  });
  mask.addEventListener('click', function (event) {
    const opt = event.target.closest('.appsx-create-opt');
    if (opt) {
      mask.querySelectorAll('.appsx-create-opt').forEach(function (row) {
        const selected = row === opt;
        row.classList.toggle('selected', selected);
        row.setAttribute('aria-checked', String(selected));
      });
      mask.querySelector('#appsCreateGo').disabled = false;
      return;
    }
    if (event.target.closest('#appsCreateClose') || event.target.closest('#appsCreateCancel')) closeAppsCreateDialog();
    else if (event.target.closest('#appsCreateInstall')) { closeAppsCreateDialog(); installAppPackage(); }
    else if (event.target.closest('#appsCreateGo')) {
      const kind = mask.querySelector('.appsx-create-opt.selected')?.dataset.kind || '';
      closeAppsCreateDialog();
      try { window.PluginBuilderEntry.openApp('', undefined, kind); }
      catch (error) { sayAppsMessage('应用开发助手暂时不可用：' + String(error && error.message || error)); }
    }
  });
  return mask;
}
function openAppsCreateDialog() {
  const mask = appsCreateDialog();
  mask.querySelectorAll('.appsx-create-opt').forEach(function (row) {
    row.classList.remove('selected');
    row.setAttribute('aria-checked', 'false');
  });
  mask.querySelector('#appsCreateGo').disabled = true;
  mask.classList.add('show');
}
function closeAppsCreateDialog() {
  const mask = document.getElementById('appsCreateMask');
  if (mask) mask.classList.remove('show');
}

function confirmAppInstall(body, preview, blockedReason) {
  const rawManifest = (preview && preview.manifest) || {};
  const manifest = window.SoduWorkPluginLocales?.present(rawManifest, window.SoduWorkI18n?.getLocale?.() || navigator.language) || rawManifest;
  const name = String(manifest.name || (body && body.name) || '未命名应用');
  const version = String(manifest.version || (body && body.version) || '0.0.0');
  const description = String(manifest.description || (body && body.description) || '');
  let layer = document.getElementById('appsModalLayer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'appsModalLayer';
    layer.className = 'apps-modal-layer';
    layer.innerHTML = '<div class="apps-modal" role="dialog" aria-modal="true">' +
      '<header><b id="appsModalTitle"></b><small id="appsModalSub"></small></header>' +
      '<div class="apps-modal-body" id="appsModalBody"></div>' +
      '<footer id="appsModalFoot"></footer></div>';
    document.body.appendChild(layer);
    layer.addEventListener('mousedown', function (event) { if (event.target === layer) closeAppsModal(); });
  }
  layer.hidden = false;
  layer.querySelector('#appsModalTitle').textContent = '安装应用';
  layer.querySelector('#appsModalSub').textContent = '检查已完成 · 仅保存到本机 · 免审核免提交';
  layer.querySelector('#appsModalBody').innerHTML =
    '<div class="apps-install-head"><span class="appsx-app-ico big">' + APPS_GLYPH + '</span>' +
    '<div><b data-user-content>' + escapeAppsHtml(name) + '</b><p data-user-content>' + escapeAppsHtml(description || '没有说明') + '</p>' +
    '<em>v' + escapeAppsHtml(version) + (blockedReason ? '' : ' · 界面应用 · 桥接能力按声明放行') + '</em></div></div>' +
    (blockedReason ? '<p class="apps-modal-error">' + escapeAppsHtml(blockedReason) + '</p>' : '') +
    '<p class="apps-modal-note">应用界面将在隔离承载中打开；需要的对话/通知能力按应用清单声明授权。</p>';
  const foot = layer.querySelector('#appsModalFoot');
  foot.innerHTML = '<button class="btn-mini" id="appsModalCancel">取消</button>' +
    '<span class="push"></span>' +
    (blockedReason ? '' : '<button class="btn-mini primary" id="appsModalInstall">安装到本机</button>');
  foot.querySelector('#appsModalCancel').addEventListener('click', closeAppsModal);
  const installBtn = foot.querySelector('#appsModalInstall');
  if (installBtn) installBtn.addEventListener('click', async function () {
    this.disabled = true;
    this.textContent = '正在安装…';
    try {
      const result = await SoduWorkAPI.createPluginDraft(body);
      if (!result || result.ok === false || !result.plugin) throw Error(result?.reason || result?.error || '应用没有安装成功');
      layer.hidden = true;
      sayAppsMessage('应用「' + result.plugin.name + '」已安装，侧边栏与应用页都可以打开');
      renderAppsCatalog(true);
    } catch (error) {
      this.disabled = false;
      this.textContent = '安装到本机';
      sayAppsMessage('应用没有安装成功：' + String(error && error.message || error));
    }
  });
}

function closeAppsModal() {
  const layer = document.getElementById('appsModalLayer');
  if (layer) layer.hidden = true;
}

function escapeAppsHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

/* Reuse the capability toast when available; otherwise show feedback above the catalog content. */
function sayAppsMessage(text) {
  if (typeof say === 'function') { say(text); return; }
  const body = document.getElementById('appsBody');
  if (body) {
    let note = body.querySelector('.apps-inline-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'apps-inline-note';
      body.prepend(note);
    }
    note.textContent = text;
    setTimeout(function () { note.remove(); }, 6000);
  }
}

/* Reused by composer-page recommendation rows: same catalog cache, same open chain, same favorites state. */
window.SoduWorkApps = {
  open: openAppsPanel, close: closeAppsPanel, render: renderAppsCatalog,
  glyph: APPS_GLYPH, icons: APPS_ICONS,
  appKeyOf, favoriteAppIds, toggleFavoriteApp,
  openAppFromItem,
  openById: openConversationApplication,
  settingsById: settingsConversationApplication, conversationCardHtml,
};
