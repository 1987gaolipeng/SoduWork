




















let _mdData = null;                 /* {providers, usable, myModels} */
let _mdKeyEdits = {};               /* New provider keys remain in memory until saved. */
let _mdMyModels = [];               /* Current custom-model edits. */
let _mdOpen = '';                   /* Expand one provider at a time. */
let _mdQuery = '';
let _mdDirty = false;
let _mdLocalDirty = false;
let _mdManagedDirty = false;
let _mdLocalKeyIds = new Set();
let _mdManagedNeedsReload = false;
let _mdSaveFlight = null;
let _mdAddingModel = '';
let _mdDeleteFlight = null;          /* Reopening waits for an admitted deletion to settle. */
let _mdTest = {};                   /* providerId -> {state:'ing'|'ok'|'bad', detail} */
let _mdEditor = '';                 /* A native child window edits one provider; empty selection indicates the overview. */
let _mdNew = null;                  /* New-provider draft. */
let _mdNewScope = null;
let _mdValidation = null;
let _mdDeletePending = '';
let _mdLoadId = 0;
let _mdLoadState = 'idle';
let _mdCatalogScope;
let _mdRefreshFlight = null;

const _MD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"/>' +
  '<rect x="14" y="14" width="7" height="7" rx="2"/><path d="M14 6h2a2 2 0 0 1 2 2v2M6 14v2a2 2 0 0 0 2 2h2"/></svg>';
const _MD_TYPES = { chat: '对话模型', image: '图片生成', video: '视频生成' };
function _mdType(value) { return _MD_TYPES[value] ? value : 'chat'; }
function _mdCanEdit(provider) { return provider?.personal === true; }
function _mdTypeOptions(value) {
  const current = _mdType(value);
  return Object.keys(_MD_TYPES).map((key) => '<option value="' + key + '"' +
    (key === current ? ' selected' : '') + '>' + _MD_TYPES[key] + '</option>').join('');
}

const _MD_THINKING_MODES = { auto: '\u81ea\u52a8\u8bc6\u522b', controllable: '\u53ef\u5173\u95ed\uff08\u9ed8\u8ba4\u5173\u95ed\uff09', always: '\u4e0d\u53ef\u5173\u95ed\uff08\u9ed8\u8ba4\u5f00\u542f\uff09', none: '\u65e0\u601d\u8003\u6a21\u5f0f' };
function _mdThinkingOptions(value) {
  const current = Object.prototype.hasOwnProperty.call(_MD_THINKING_MODES, value) ? value : 'auto';
  return Object.keys(_MD_THINKING_MODES).map((key) => '<option value=\"' + key + '\"' +
    (key === current ? ' selected' : '') + '>' + _MD_THINKING_MODES[key] + '</option>').join('');
}

function openModelsPanel(options) {
  const opts = options || {};
  _mdEditor = opts.editor ? String(opts.providerId || '') : '';
  if (_mdEditor.indexOf('__new__:') === 0 || _mdEditor === '__new__') {
    const rawId = _mdEditor.startsWith('__new__:') ? _mdEditor.slice('__new__:'.length) : '';
    const id = rawId.startsWith('device:') ? rawId : 'device:' + (rawId || ('custom-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 7)));
    _mdNew = { id, name: '', kind: 'openai-compat', baseUrl: '', defaultBaseUrl: '',
      personal: true, localOnly: true, authMode: 'key', modelNames: [], note: '', myKeySet: false, keySet: false };
    _mdNewScope = SoduWorkAPI.taskStorageKey?.('ops');
  }
  let p = document.getElementById('mdPanel');
  if (!p) {
    p = document.createElement('div');
    p.id = 'mdPanel'; p.className = 'sch-panel cfg-panel';
    p.innerHTML =
      '<div class="sch-head ws-page-head">' +
      '<span class="sch-h-ico">' + _MD_ICON + '</span>' +
      '<div class="sch-h-txt"><span class="sch-h-kicker" data-i18n="eyebrow.model_routing">MODEL ROUTING</span><b class="sch-h-title">我的模型</b>' +
      '<i class="sch-h-sub">管理个人额度、可用模型与自定义服务</i></div>' +
      '<div class="sch-h-acts">' +
      '<button class="btn-mini primary" id="mdSave" disabled>保存</button>' +
      '<button class="np-close" id="mdClose">✕</button></div></div>' +
      '<div class="sch-body" id="mdBody"></div>';
    document.body.appendChild(p);
    document.getElementById('mdClose').addEventListener('click', closeModelsPanel);
    document.getElementById('mdSave').addEventListener('click', () => _mdSave(false));
    if (typeof makeDraggable === 'function') makeDraggable(p, p.querySelector('.sch-head'));
  }
  p.classList.add('md-master-panel');
  const title = p.querySelector('.sch-h-title');
  const kicker = p.querySelector('.sch-h-kicker');
  const sub = p.querySelector('.sch-h-sub');
  if (title) title.textContent = '我的模型';
  if (kicker) kicker.textContent = 'MODEL CONNECTIONS';
  if (sub) sub.textContent = '管理服务连接、个人凭据与可选模型';
  const save = document.getElementById('mdSave');
  if (save) save.hidden = false;
  p.classList.add('show');
  if (typeof expandForOverlay === 'function') expandForOverlay();
  _mdLoad();
}

function closeModelsPanel() {
  _mdStopModelChecks();
  ++_mdLoadId;
  if (typeof _mdCloseDeleteDialog === 'function') _mdCloseDeleteDialog();
  _mdLoadState = 'idle';
  const p = document.getElementById('mdPanel');
  if (p) p.classList.remove('show');
  if (typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
}

async function _mdLoad(options) {
  const box = document.getElementById('mdBody');
  if (!box) return;
  if (!options?.saved) _mdStopModelChecks();
  const loadId = ++_mdLoadId;
  const scope = _mdCatalogScope = SoduWorkAPI.taskStorageKey?.('ops');
  const current = () => loadId === _mdLoadId && scope === SoduWorkAPI.taskStorageKey?.('ops') &&
    document.getElementById('mdBody') === box;
  const previous = { data: _mdData, keys: _mdKeyEdits, models: _mdMyModels,
    dirty: _mdDirty, localDirty: _mdLocalDirty, managedDirty: _mdManagedDirty,
    localKeyIds: _mdLocalKeyIds, managedNeedsReload: _mdManagedNeedsReload,
    editor: _mdEditor, draft: _mdNew, validation: _mdValidation };
  let timer, rendering = false;
  _mdLoadState = 'loading';
  box.setAttribute('aria-busy', 'true');
  _mdMark();
  if (!_mdData) box.innerHTML = '<div class="md-load"><i></i><i></i><i></i><span>正在看有哪些模型能用…</span></div>';
  try {
    const r = await Promise.race([
      // The ordinary save calls this loader itself. Only its external reloads wait for it.
      Promise.resolve(options?.saved ? _mdDeleteFlight : _mdSaveFlight).catch(() => {})
        .then(() => current() ? SoduWorkAPI.myModels({ fresh: options?.saved === true || options?.fresh === true }) : null),
      new Promise((_, reject) => { timer = setTimeout(() => {
        const error = new Error('Model catalog load timed out');
        error.code = 'MODEL_LOAD_TIMEOUT'; reject(error);
      }, 20000); })
    ]);
    if (!current()) return false;
    if (!r || !['providers', 'usable', 'myModels'].every(key => Array.isArray(r[key])) ||
        r.providers.some(p => !p || typeof p.id !== 'string') ||
        r.myModels.some(m => !m || typeof m.name !== 'string')) {
      const error = new Error('Invalid model catalog'); error.code = 'MODEL_CATALOG_INVALID'; throw error;
    }
    rendering = true;
    _mdData = r;
    _mdReconcileChecks(r);
    if (_mdNew) {
      const saved = r.providers.find((p) => p.id === _mdNew.id);
      if (saved || _mdNewScope !== SoduWorkAPI.taskStorageKey?.('ops')) {
        _mdDrafts.delete(_mdNew.id);
        if (_mdEditor.indexOf('__new__') === 0) _mdEditor = saved?.id || '';
        _mdNew = null; _mdValidation = null;
      }
    }
    if (!_mdNew || _mdValidation?.providerId !== _mdNew.id) _mdValidation = null;
    // A retained new service is still a draft, including its credentials/models.
    _mdKeyEdits = Object.fromEntries(Object.entries(previous.keys).filter(([id]) => id === _mdNew?.id));
    _mdMyModels = r.myModels.concat(previous.models.filter(row => row.providerId === _mdNew?.id));
    _mdDirty = _mdLocalDirty = !!_mdNew; _mdManagedDirty = false;
    _mdLocalKeyIds = new Set(_mdNew ? [_mdNew.id] : []); _mdManagedNeedsReload = false;
    _mdRender();
    // An unavailable Hub catalog cannot prove that a service was removed elsewhere.
    if (!r.managedCatalogUnavailable)
      for (const id of _mdDrafts.keys()) if (!_mdProvider(id)) _mdDrafts.delete(id);
    _mdLoadState = 'ready';
    return true;
  } catch (error) {
    if (!current()) return false;
    _mdData = previous.data; _mdKeyEdits = previous.keys; _mdMyModels = previous.models;
    _mdDirty = previous.dirty; _mdLocalDirty = previous.localDirty; _mdManagedDirty = previous.managedDirty;
    _mdLocalKeyIds = previous.localKeyIds; _mdManagedNeedsReload = previous.managedNeedsReload;
    _mdEditor = previous.editor; _mdNew = previous.draft; _mdValidation = previous.validation;
    if (options?.saved) {
      if (_mdData) _mdData = { ..._mdData, catalogRefreshFailed: true };
      _mdLoadState = 'ready';
      _mdRender();
      return false;
    }
    _mdLoadState = 'error';
    const message = rendering ? '页面显示遇到问题，请重试。已有模型配置未被修改。' :
      error?.code === 'MODEL_CATALOG_INVALID' ? '模型清单格式异常，请重试。已有模型配置未被修改。' :
      error?.status === 401 ? '登录状态已失效，请重新登录后重试。' :
      error?.status === 403 ? '暂时无法访问模型清单，请检查账号权限后重试。' :
      ['MODEL_LOAD_TIMEOUT', 'DEVICE_AUTH_INIT_TIMEOUT'].includes(error?.code) || error?.name === 'TimeoutError' || error?.name === 'AbortError' ?
        '加载超时，请检查服务连接后重试。' : '暂时无法获取模型清单，请检查服务连接后重试。';
    box.innerHTML = '<div class="md-blank" role="alert" data-md-load-error>' + _MD_ICON +
      '<b>模型页面未能加载</b><span>' + message + '</span>' +
      '<button class="md-addbtn" id="mdRetry">重新加载</button></div>';
    document.getElementById('mdRetry')?.addEventListener('click', () => _mdLoad({ fresh: true }));
    return false;
  } finally {
    clearTimeout(timer);
    if (current()) { box.removeAttribute('aria-busy'); _mdMark(); }
    else if (loadId === _mdLoadId && scope !== SoduWorkAPI.taskStorageKey?.('ops')) _mdScopeChanged();
  }
}

/* Provider status precedence: personal credentials, company credentials, missing key, missing endpoint. */
function _mdState(p) {
  if (_mdNew?.id === p.id) return 'draft';
  if (!_mdCanEdit(p)) return p.baseUrl && p.keySet ? 'org' : 'managed';
  if (!p.baseUrl) return 'noaddr';
  if (p.authMode === 'none' && p.baseUrl) return 'local';
  if (p.myKeySet || _mdKeyEdits[p.id]) return p.localOnly ? 'local' : 'mine';
  if (p.keySet) return p.localOnly ? 'local' : 'org';
  return p.baseUrl ? 'open' : 'noaddr';
}
function _mdUsesLocalDiscovery(p) { return p?.localOnly === true || p?.authMode === 'none'; }
const _MD_ST = {
  local: { t: '本地可用', o: 0 },
  mine: { t: '个人额度', o: 0 },
  org: { t: '公司可用', o: 1 },
  managed: { t: '服务端同步，只读', o: 2 },
  open: { t: '填写 Key', o: 2 },
  noaddr: { t: '需补地址', o: 3 },
  draft: { t: '未保存', o: 4 },
};

/* Keep viewport state separate from catalog/save state. Only the contents of
 * the stable scroll containers change when an operation refreshes the page. */
function _mdRenderView(box, html, providerId) {
  const master = box.querySelector?.('.cfg-master');
  const detail = box.querySelector?.('.cfg-detail');
  if (!master || !detail) {
    box.innerHTML = html;
    box._mdRenderedProvider = providerId;
    box._mdScrollViews = new Map();
    return;
  }
  const capture = (node, attribute) => {
    if (!node) return null;
    const top = node.getBoundingClientRect().top;
    return { top: node.scrollTop, left: node.scrollLeft,
      anchors: [...node.querySelectorAll('[' + attribute + ']')].map(row => ({
        key: row.getAttribute(attribute), offset: row.getBoundingClientRect().top - top,
        bottom: row.getBoundingClientRect().bottom - top,
      })).filter(row => row.bottom > 0 && row.offset < node.clientHeight) };
  };
  const restore = (node, state, attribute) => {
    if (!node) return;
    node.scrollTop = state?.top || 0;
    node.scrollLeft = state?.left || 0;
    if (!state?.top) return; // An unscrolled service stays at the top across layout changes.
    const rows = [...node.querySelectorAll('[' + attribute + ']')];
    for (const anchor of state?.anchors || []) {
      const row = rows.find(item => item.getAttribute(attribute) === anchor.key);
      if (!row) continue;
      node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.offset;
      break;
    }
  };
  const nav = master.querySelector('.cfg-master-scroll');
  const scroll = detail.querySelector('.cfg-detail-scroll');
  // Stacked layouts let the detail grow and scroll the outer panel instead.
  const viewport = node => node && (getComputedStyle(node).overflowY === 'visible' ? box : node);
  const navState = capture(nav, 'data-mdselect');
  const views = box._mdScrollViews || (box._mdScrollViews = new Map());
  if (scroll) views.set(box._mdRenderedProvider, capture(viewport(scroll), 'data-md-model'));
  const next = document.createElement('div');
  next.innerHTML = html;
  for (const selector of ['.cfg-master-head', '.cfg-master-actions', '.cfg-master-scroll'])
    master.querySelector(selector).innerHTML = next.querySelector(selector).innerHTML;
  const nextScroll = next.querySelector('.cfg-detail-scroll');
  if (scroll && nextScroll) {
    for (const selector of ['.cfg-detail-head', '.cfg-detail-facts', '.cfg-detail-scroll'])
      detail.querySelector(selector).innerHTML = next.querySelector(selector).innerHTML;
  } else detail.innerHTML = next.querySelector('.cfg-detail').innerHTML;
  box._mdRenderedProvider = providerId;
  // Binding restores expanded editor fields and can change content height.
  return () => {
    restore(nav, navState, 'data-mdselect');
    restore(viewport(detail.querySelector('.cfg-detail-scroll')), views.get(providerId), 'data-md-model');
  };
}

function _mdRender() {
  const box = document.getElementById('mdBody');
  if (!box || !_mdData) return;
  const chatUsable = _mdData.usable || [];
  const mediaUsable = _mdData.mediaUsable || {};
  const usable = chatUsable.concat(mediaUsable.image || [], mediaUsable.video || []);
  const all = (_mdData.providers || []).slice();
  if (_mdNew && !all.some((p) => p.id === _mdNew.id)) all.unshift(_mdNew);
  const q = _mdQuery.trim().toLowerCase();
  const visible = all.filter((p) => !q ||
    String(p.name || '').toLowerCase().includes(q) ||
    String(p.id || '').toLowerCase().includes(q) ||
    (p.modelNames || []).some((n) => String(n).toLowerCase().includes(q)));
  const sorted = all.slice().sort((a, b) => (_MD_ST[_mdState(a)].o - _MD_ST[_mdState(b)].o) ||
    String(a.name || '').localeCompare(String(b.name || '')));
  const requested = _mdOpen || (_mdEditor.indexOf('__new__:') === 0 ? _mdEditor.slice('__new__:'.length) : _mdEditor);
  let target = all.find((p) => String(p.id) === String(requested || '')) || sorted[0] || null;
  if (target) _mdOpen = target.id;

  const active = visible.filter((p) => ['local', 'mine', 'org'].includes(_mdState(p)));
  const available = visible.filter((p) => _mdState(p) === 'open');
  const advanced = visible.filter((p) => _mdState(p) === 'noaddr');

  const html = '<div class="cfg-master-detail md-master-detail">' +
    '<aside class="cfg-master md-master" aria-label="模型服务">' +
      '<div class="cfg-master-head"><div class="md-master-toolbar"><span>模型服务</span>' +
        '<button type="button" class="cfg-master-add" id="mdAddInline" aria-label="添加服务" title="添加服务"><span aria-hidden="true">＋</span> <span>添加</span></button></div>' +
        (_mdData.managedCatalogUnavailable ? '<div class="md-hub-retry"><small>' +
          _mdMessage('models.pi.hubOffline', 'Hub 模型清单暂时无法读取', {}) + '</small> ' +
          '<button type="button" class="md-model-add" data-mdretrycatalog>' +
          _mdMessage('models.pi.retry', '重新读取模型清单', {}) + '</button></div>' : '') +
        '<strong>' + _mdMessage('models.available', '{count} 个可选模型', { count: usable.length }) + '</strong></div>' +
      '<div class="cfg-master-actions">' +
        '<label class="cfg-master-search"><span>搜索模型服务</span>' +
          '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m16 16 4.5 4.5"></path></svg>' +
          '<input id="mdQ" class="md-q" value="' + esc(_mdQuery) + '" placeholder="服务或模型"></label></div>' +
      '<div class="cfg-master-scroll">' + (visible.length
        ? _mdNavGroupHtml('未保存', visible.filter(p => _mdState(p) === 'draft')) +
          _mdNavGroupHtml('正在使用', active) +
          _mdNavGroupHtml('组织管理', visible.filter(p => _mdState(p) === 'managed')) +
          _mdNavGroupHtml('可配置服务', available) +
          _mdNavGroupHtml('高级与自定义', advanced)
        : '<div class="cfg-master-empty">' + _mdMessage('models.noResults', '没有匹配“{query}”的服务或模型', { query: _mdQuery }) + '</div>') +
      '</div>' +
    '</aside>' +
    '<main class="cfg-detail md-detail" aria-live="polite">' +
      (target ? _mdDetailHtml(target) : '<div class="cfg-detail-empty">' + _MD_ICON +
        '<b>还没有模型服务</b><span>从左侧添加一个 OpenAI 兼容或 Anthropic 服务。</span>' +
        '<button type="button" class="cfg-master-add" id="mdEmptyAdd">添加服务</button></div>') +
    '</main></div>';

  const restoreView = _mdRenderView(box, html, target?.id || '');
  _mdBind(box);
  const emptyAdd = document.getElementById('mdEmptyAdd');
  if (emptyAdd) emptyAdd.addEventListener('click', _mdAddService);
  _mdMark();
  restoreView?.();
}

function _mdNavGroupHtml(title, rows) {
  if (!rows.length) return '';
  return '<section class="cfg-nav-group"><header><span>' + title + '</span><em>' + rows.length +
    '</em></header><div>' + rows.map(_mdNavItemHtml).join('') + '</div></section>';
}

function _mdCatalogModels(p) {
  // Local catalog definitions mirror the editable myModels snapshot. They are
  // not organization-owned rows and must not outlive a local edit or removal.
  if (_mdCanEdit(p) && p.localOnly === true) return [];
  return p?.modelDefs?.length ? p.modelDefs :
    (p?.modelNames || []).map(name => ({ name, label: name, modality: 'chat', config: {} }));
}

const _MD_BUILTIN_PROVIDER_NAMES = Object.freeze({
  volcengine: '字节跳动 · 火山引擎方舟',
  aliyun: '阿里云百炼（通义）',
  zhipu: '智谱 GLM',
  moonshot: '月之暗面 Kimi',
});
function _mdProviderNameAttrs(p) {
  const source = _MD_BUILTIN_PROVIDER_NAMES[String(p?.id || '')];
  if (p?.builtin === true && source && String(p.name || '') === source) {
    return ' data-i18n="' + esc(source) + '" data-i18n-source="' + esc(source) + '"';
  }
  return p?.name ? ' data-user-content' : '';
}

function _mdNavItemHtml(p) {
  const state = _mdState(p);
  const own = _mdCanEdit(p) ? _mdMyModels.filter((m) => m.providerId === p.id) : [];
  const count = _mdCatalogModels(p).length + own.length;
  const selected = String(_mdOpen) === String(p.id);
  return '<button type="button" class="cfg-nav-item md-nav-item st-' + state +
    (selected ? ' is-selected' : '') + '" data-mdselect="' + esc(p.id) + '" aria-pressed="' +
    (selected ? 'true' : 'false') + '">' +
      '<span class="md-provider-icon">' + _MD_ICON + '<i class="cfg-nav-dot"></i></span><span class="cfg-nav-copy"><b' + _mdProviderNameAttrs(p) + '>' + esc(p.name || p.id) + '</b>' +
        '<small>' + esc(_mdHost(p.baseUrl) || '未填写服务地址') + '</small></span>' +
      '<span class="cfg-nav-meta"><em>' + _mdMessage('models.count', '{count} 模型', { count }) + '</em><small>' + _MD_ST[state].t + '</small></span>' +
    '</button>';
}

async function _mdRetryCatalog() {
  const previous = _mdData, loadId = _mdLoadId, scope = SoduWorkAPI.taskStorageKey?.('ops');
  const revision = previous.localRevision;
  try {
    const catalog = await SoduWorkAPI.myModels({ fresh: true });
    if (previous !== _mdData || loadId !== _mdLoadId || scope !== SoduWorkAPI.taskStorageKey?.('ops') ||
        revision !== _mdData.localRevision || _mdSaveFlight ||
        !['usable', 'myModels', 'providers'].every(key => Array.isArray(catalog?.[key]))) return;
    if (!_mdDirty) {
      _mdData = catalog; _mdMyModels = catalog.myModels.slice(); _mdManagedNeedsReload = false;
      _mdReconcileChecks(catalog); _mdRender();
      return;
    }
    // Recover a previously missing Hub snapshot without submitting or replacing local drafts.
    if (previous.managedCatalogUnavailable && !catalog.managedCatalogUnavailable && !_mdManagedDirty) {
      const combine = (localRows, hubRows) => (localRows || []).filter(row => row.localOnly)
        .concat((hubRows || []).filter(row => !row.localOnly));
      _mdMyModels = combine(_mdMyModels, catalog.myModels);
      _mdData = { ...previous, providers: combine(previous.providers, catalog.providers),
        myModels: combine(previous.myModels, catalog.myModels), revision: catalog.revision };
    }
    _mdData = { ..._mdData, usable: catalog.usable, mediaUsable: catalog.mediaUsable,
      managedCatalogUnavailable: catalog.managedCatalogUnavailable, catalogRefreshFailed: false };
    _mdRender();
  } catch { /* Keep the retry action and all current drafts. */ }
}

// Count the persisted chat catalog for this provider. Model definitions and
// media choices can exist even when Pi cannot select a text model.
function _mdPiGuidance(p) {
  if (_mdNew?.id === p.id) return '';
  const msg = (id, source, params = {}) => _mdMessage('models.pi.' + id, source, params);
  const button = (attr, text) => '<button type="button" class="md-model-add" ' + attr +
    '="' + esc(p.id) + '">' + text + '</button>';
  let title, hint = '', action = '';
  if (_mdData.catalogRefreshFailed || (!p.localOnly && _mdData.managedCatalogUnavailable)) {
    title = msg('unknown', '暂时无法确认可选的对话模型');
    action = button('data-mdretrycatalog', msg('retry', '重新读取模型清单'));
  } else {
    const compatible = !p.kind || p.kind === 'openai-compat';
    const names = new Set((_mdData.usable || []).filter(row => compatible && row?.providerId === p.id &&
      row.name && row.available !== false && row.unavailable !== true && row.enabled !== false &&
      (!row.modality || row.modality === 'chat') && !/^(?:unavailable:|local:unavailable$)/.test(row.name))
      .map(row => row.name));
    title = msg('count', '本地 Pi 可选的对话模型：{count} 个', { count: names.size });
    if (names.size) hint = msg('ready', '在本地 Pi 新对话的模型选择器中选择此服务的模型。');
    else if (!compatible) hint = msg('protocol', '请使用支持此协议的 Agent，或为 Pi 配置 OpenAI 兼容服务。');
    else if (!_mdCanEdit(p)) hint = msg('managed', '请联系管理员检查此服务的凭据并启用对话模型。');
    else if (!p.baseUrl || !(p.keySet || p.myKeySet || p.authMode === 'none'))
      hint = msg('credentials', '请先保存服务地址和凭据，或确认本机服务无需密钥。');
    else if ((_mdData.myModels || []).some(row => row.providerId === p.id && _mdType(row.modality) === 'chat')) {
      hint = msg('review', '已有对话模型尚未出现在选择器中，请检查模型配置。');
      action = button('data-mdreviewchat', msg('reviewAction', '查看已有对话模型'));
    } else {
      hint = msg('empty', '服务已保存。添加一个对话模型后，即可在本地 Pi 对话中选择。');
      action = button('data-mdaddchat', msg('add', '添加对话模型'));
    }
  }
  return '<section class="md-pi-guidance"><div><b>' + title + '</b>' +
    (hint ? '<p class="md-model-help">' + hint + '</p>' : '') + '</div>' + action + '</section>';
}

function _mdDetailHtml(p) {
  const state = _mdState(p);
  const models = _mdCatalogModels(p);
  const own = _mdCanEdit(p) ? _mdMyModels.filter((m) => m.providerId === p.id) : [];
  const test = _mdTest[p.id];
  const count = models.length + own.length;
  const host = _mdHost(p.baseUrl) || '尚未连接';
  const route = state === 'mine' ? '使用你的个人额度' : state === 'org' ? '使用公司统一额度' :
    state === 'managed' ? '凭据由管理员维护' :
    state === 'local' ? (p.authMode === 'none' ? '本机免密服务' : '本机保存的访问凭据') : '完成配置后可用';
  return '<header class="cfg-detail-head">' +
      '<span class="cfg-detail-icon">' + _MD_ICON + '</span>' +
      '<div class="cfg-detail-title"><span>模型服务</span><h2' + _mdProviderNameAttrs(p) + '>' + esc(p.name || '添加模型服务') + '</h2>' +
        '<p><span' + (_mdHost(p.baseUrl) ? ' data-user-content' : '') + '>' + esc(host) + '</span> · <span>' + esc(route) + '</span></p></div>' +
      '<span class="cfg-state is-' + state + '">' + _MD_ST[state].t + '</span></header>' +
    '<div class="cfg-detail-facts"><span><small>接口协议</small><b>' +
      (p.kind === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容') + '</b></span>' +
      '<span><small>模型数量</small><b>' + _mdMessage('models.itemCount', '{count} 个', { count }) + '</b></span>' +
      '<span><small>凭据来源</small><b>' + esc(route) + '</b></span>' +
      '<span><small>连接状态</small><b>' + (test ? (test.state === 'ing' ? '正在验证' : test.state === 'ok' ? '连接通过' : '验证未通过') : '待验证') + '</b></span></div>' +
    '<div class="cfg-detail-scroll">' + _mdPiGuidance(p) +
      '<div class="md-editor-form st-' + state + '">' + _mdBodyHtml(p, state, models, own, test) + '</div>' +
    '</div>';
}

function _mdReadOnlyBodyHtml(p, models) {
  return '<div class="md-row-b" id="md-body-' + esc(p.id) + '" role="region">' +
    '<section class="md-settings-section"><header class="md-section-heading"><b>连接设置</b><small>服务端同步，只读</small></header>' +
      '<p class="md-model-help" role="note">此服务由管理员维护。如需使用自己的配置，请添加个人服务。</p>' +
      '<label class="md-field md-field-wide"><span>API 地址</span><input class="md-in" readonly aria-readonly="true" data-user-content value="' +
        esc(p.baseUrl || '') + '"></label></section>' +
    '<section class="md-settings-section md-credentials"><header class="md-section-heading"><b>访问凭据</b></header>' +
      '<div class="md-key-fallback"><b>凭据由管理员维护</b><span>' +
        (p.keySet ? '使用公司统一额度' : '还没有可用凭据') + '</span></div></section>' +
    '<section class="cfg-subsection"><div class="cfg-subsection-h"><b>模型清单</b><span>' +
      _mdMessage('models.itemCount', '{count} 个', { count: models.length }) + '</span></div>' +
      _mdModelListHtml(p, models, []) + '</section></div>';
}

function _mdBodyHtml(p, s, ms, own, t) {
  if (!_mdCanEdit(p)) return _mdReadOnlyBodyHtml(p, ms);
  const validation = _mdValidation?.providerId === p.id ? _mdValidation : null;
  const invalid = field => validation?.field === field ? ' aria-invalid="true"' : '';
  const error = field => '<small id="md-' + field + '-error" class="md-field-error" role="alert"' +
    (validation?.field === field ? '' : ' hidden') + '>' + esc(validation?.field === field ? validation.detail : '') + '</small>';
  const clearKeyLabel = p.localOnly ? '移除本地密钥' : '停止使用个人额度';
  return '<div class="md-row-b" id="md-body-' + esc(p.id) + '" role="region">' +
    '<section class="md-settings-section"><header class="md-section-heading"><b>连接设置</b><small>填写服务提供的 API 地址</small></header>' +
    '<div class="md-connect-fields">' +
      (p.personal ? '<label class="md-field"><span>服务名称</span><input class="md-in" data-pname="' +
        esc(p.id) + '"' + (p.localOnly ? ' maxlength="64"' : '') + invalid('name') + ' value="' + esc(p.name || '') +
        '" placeholder="例如：本机 Ollama" aria-describedby="md-name-error">' + error('name') + '</label>' : '') +
      '<label class="md-field md-field-wide"><span>API 地址</span><input class="md-in" data-purl="' +
        esc(p.id) + '"' + (p.localOnly ? ' maxlength="400"' : '') + invalid('url') + ' value="' + esc(p.baseUrl || '') +
        '" placeholder="https://…/v1" aria-describedby="md-url-error">' + error('url') + '</label>' +
      (p.personal ? '<label class="md-field"><span>接口协议</span><select class="md-in" data-pkind="' +
        esc(p.id) + '"><option value="openai-compat"' + (p.localOnly || p.kind !== 'anthropic' ? ' selected' : '') +
        '>OpenAI 兼容</option>' +
        (p.localOnly ? '' : '<option value="anthropic"' + (p.kind === 'anthropic' ? ' selected' : '') +
        '>Anthropic</option>') + '</select></label>' +
        '<label class="md-auth-toggle"><input type="checkbox" data-pnoauth="' + esc(p.id) + '"' +
          (p.authMode === 'none' ? ' checked' : '') + '><span>本地服务无需密钥</span></label>' : '') +
    '</div>' + (p.kind === 'anthropic'
      ? '<p class="md-model-help" role="note">Anthropic 协议：连接测试通过也不能用于当前企业模型对话通道。请为该通道配置供应商的 OpenAI 兼容地址与对应密钥；此配置可保留给支持 Anthropic 的 Agent。</p>' : '') +
    '</section><section class="md-settings-section md-credentials">' +
    '<header class="md-section-heading"><b>访问凭据</b><small>密钥保存后只显示配置状态，不回显明文</small></header>' +
    '<p class="md-model-help">连接测试优先读取模型列表；列表可访问不代表聊天生成、余额或当前 Agent 的协议兼容性已验证。列表接口不可用时会尝试一个最小聊天请求，可能产生用量。</p>' +
    (p.authMode !== 'none'
      ? '<label class="md-key-label" for="md-key-input">' + (p.localOnly ? '本地 API Key' : '个人 API Key') + '</label>' +
        '<div class="md-keyrow">' +
          '<input type="password" class="md-in" id="md-key-input" data-pkey="' + esc(p.id) + '" ' +
            'autocomplete="new-password" placeholder="' +
            (p.myKeySet ? '输入新的以替换，留空则不改' : '粘贴你自己的 API Key') + '">' +
          '<button class="md-eye" data-peye="' + esc(p.id) + '" aria-pressed="false" title="只显示本次输入的内容">显示</button>' +
          '<button class="md-test primary" data-ptest="' + esc(p.id) + '"' + (t && t.state === 'ing' ? ' disabled' : '') + '>' + (t && t.state === 'ing' ? '测试中…' : '保存并测试连接') + '</button>' +
        '</div>' +
        '<div class="md-meta">' +
          (p.myKeySet ? '<div class="md-personal-key-card"><div class="md-personal-key-copy">' +
                          (p.localOnly ? '<b>本地访问密钥已配置</b><span>密钥仅保存在当前设备，本地模型不使用 Hub 模型额度</span>'
                            : '<b>当前使用这个模型的个人 Key</b><span>' + _mdMessage('models.keyLength', '个人 Key 已配置 · {count} 位，请求会优先使用你的个人额度', { count: p.myKeyLen }) + '</span>') +
                        '</div><button type="button" class="md-clear-key" data-pclear="' + esc(p.id) + '" aria-label="' + clearKeyLabel + '" title="' + clearKeyLabel + '"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.25"></circle><path d="M6.5 10h7"></path></svg><span>' + clearKeyLabel + '</span></button></div>'
                      : '<div class="md-key-fallback"><b>还没有可用凭据</b><span>' + (p.localOnly
                          ? '请填写本地服务的 API Key，或确认该服务无需密钥' : '粘贴你自己的 API Key') + '</span></div>') +
          (t ? '<span role="status" class="md-test-r is-' + t.state + '">' +
                 (t.state === 'ing' ? '正在测…' : esc(t.detail || '')) + '</span>' : '') +
        '</div>'
      : '<div class="md-keyrow md-noauth"><span>免密连接</span><small>适用于本机 Ollama、vLLM 等可信服务</small>' +
          '<button class="md-test primary" data-ptest="' + esc(p.id) + '"' + (t && t.state === 'ing' ? ' disabled' : '') + '>保存并测试连接</button></div>' +
          (t ? '<span role="status" class="md-test-r is-' + t.state + '">' + esc(t.detail || '正在测试…') + '</span>' : '')) +
    '</section>' +
    '<section class="cfg-subsection"><div class="cfg-subsection-h"><b>模型清单</b><span>' +
      _mdMessage('models.itemCount', '{count} 个', { count: ms.length + own.length }) + '</span></div>' +
      '<p class="md-model-help">对话模型可单独支持图片输入；图片生成和视频生成用于创作成果。</p>' +
      _mdModelListHtml(p, ms, own) + _mdModelEditorHtml(p) + '</section>' +
    (p.personal ? '<div class="md-editor-danger"><div><b>删除模型服务</b><p>删除此服务及其下的模型配置</p></div>' +
      '<button type="button" class="md-delete-service" data-pdelete="' + esc(p.id) + '">删除模型服务</button></div>' : '') +
  '</div>';
}

function _mdHost(raw) {
  try { return new URL(String(raw || '')).host; } catch (e) { return ''; }
}

function _mdAddService() {
  if (_mdSaveFlight) return;
  const id = 'device:custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  _mdNew = { id, name: '', kind: 'openai-compat', baseUrl: '', defaultBaseUrl: '',
    personal: true, localOnly: true, authMode: 'key', modelNames: [], note: '', myKeySet: false, keySet: false };
  _mdNewScope = SoduWorkAPI.taskStorageKey?.('ops'); _mdValidation = null;
  _mdEditor = '__new__:' + id;
  _mdOpen = id;
  _mdMarkOwnedDirty(_mdNew);
  _mdRender();
}

function _mdProvider(pid) {
  if (String(pid || '').indexOf('__new__') === 0) return _mdNew;
  if (_mdNew && _mdNew.id === pid) return _mdNew;
  return (_mdData.providers || []).find((p) => p.id === pid);
}

function _mdTouchProvider(pid, patch) {
  if (_mdSaveFlight) return;
  const p = _mdProvider(pid);
  if (!_mdCanEdit(p)) return;
  Object.assign(p, patch || {});
  const field = _mdValidation?.field;
  if (_mdValidation?.providerId === pid && Object.prototype.hasOwnProperty.call(patch || {}, field === 'url' ? 'baseUrl' : 'name')) {
    _mdValidation = null;
    document.getElementById('mdBody')?.querySelector('[aria-invalid="true"]')?.removeAttribute('aria-invalid');
    const error = document.getElementById('md-' + field + '-error');
    if (error) { error.hidden = true; error.textContent = ''; }
  }
  p._capStale = true;
  _mdClearProviderChecks(pid);
  _mdMarkOwnedDirty(p);
}

/* Track ownership so a local edit never becomes an implicit Hub replacement. */
function _mdMarkOwnedDirty(providerOrId) {
  const provider = typeof providerOrId === 'string' ? _mdProvider(providerOrId) : providerOrId;
  if (!_mdCanEdit(provider)) return;
  if (provider?.localOnly === true) { _mdLocalDirty = true; _mdLocalKeyIds.add(provider.id); }
  else _mdManagedDirty = true;
  _mdDirty = true; _mdMark();
}

function _mdBind(box) {
  box.querySelectorAll('[data-mdretrycatalog]').forEach(button => button.addEventListener('click', () => {
    if (button.isConnected && !_mdSaveFlight) void _mdRetryCatalog();
  }));
  box.querySelectorAll('[data-mdreviewchat]').forEach(button => button.addEventListener('click', () => {
    const pid = button.dataset.mdreviewchat;
    const index = _mdMyModels.filter(row => row.providerId === pid).findIndex(row => _mdType(row.modality) === 'chat');
    if (button.isConnected && index >= 0)
      box.querySelector('[data-mdedit="' + CSS.escape(pid + '|' + index) + '"]')?.focus();
  }));
  box.querySelectorAll('[data-mdaddchat]').forEach(button => button.addEventListener('click', () => {
    const pid = button.dataset.mdaddchat;
    const editor = box.querySelector('[data-mdeditor]');
    if (!button.isConnected || editor?.dataset.mdeditor !== pid || !_mdCanEdit(_mdProvider(pid))) return;
    editor.open = true;
    const draft = _mdDrafts.get(pid), type = editor.querySelector('[data-paddtype]');
    // Keep an in-progress edit intact if the user returns via the shortcut.
    if (draft?.original || (draft?.changed && type.value !== 'chat')) {
      const source = '请先完成或取消当前模型编辑，再添加对话模型。';
      petSay(globalThis.SoduWorkI18n?.t?.('models.pi.finishEdit', source) || source);
    } else if (type.value !== 'chat') {
      type.value = 'chat'; type.dispatchEvent(new Event('change', { bubbles: true }));
    }
    editor.querySelector('[data-padd]').focus();
  }));
  // Re-rendering after search or service switching must not hide an unsaved key.
  box.querySelectorAll('[data-pkey]').forEach(el => { el.value = _mdKeyEdits[el.getAttribute('data-pkey')] || ''; });
  const addInline = document.getElementById('mdAddInline');
  if (addInline) addInline.addEventListener('click', _mdAddService);
  const q = document.getElementById('mdQ');
  if (q) {
    q.addEventListener('input', () => {
      _mdQuery = q.value;
      const at = q.selectionStart;
      _mdRender();
      const q2 = document.getElementById('mdQ');
      if (q2) { q2.focus({ preventScroll: true }); try { q2.setSelectionRange(at, at); } catch (e) { /* Keep focus if selection restoration is unsupported. */ } }
    });
  }
  box.querySelectorAll('[data-mdselect]').forEach((el) => el.addEventListener('click', () => {
    _mdOpen = el.getAttribute('data-mdselect');
    _mdEditor = '';
    _mdDeletePending = '';
    _mdRender();
  }));

  box.querySelectorAll('[data-pkey]').forEach(el => el.addEventListener('input', () => {
    if (_mdSaveFlight || el.isConnected === false) return;
    const pid = el.getAttribute('data-pkey');
    const provider = _mdProvider(pid); if (!_mdCanEdit(provider)) return;
    provider._capStale = true;
    _mdClearProviderChecks(pid);
    if (el.value.trim()) _mdKeyEdits[pid] = el.value.trim();
    else delete _mdKeyEdits[pid];
    _mdMarkOwnedDirty(provider || pid);
  }));
  box.querySelectorAll('[data-pname]').forEach(el => el.addEventListener('input', () =>
    _mdTouchProvider(el.getAttribute('data-pname'), { name: el.value })));
  box.querySelectorAll('[data-purl]').forEach(el => el.addEventListener('input', () =>
    _mdTouchProvider(el.getAttribute('data-purl'), { baseUrl: el.value.trim() })));
  box.querySelectorAll('[data-pkind]').forEach(el => el.addEventListener('change', () => {
    _mdTouchProvider(el.getAttribute('data-pkind'), { kind: el.value });
    _mdRender();
  }));
  box.querySelectorAll('[data-pnoauth]').forEach(el => el.addEventListener('change', () => {
    _mdTouchProvider(el.getAttribute('data-pnoauth'), { authMode: el.checked ? 'none' : 'key' });
    _mdRender();
  }));
  box.querySelectorAll('[data-preset]').forEach(el => el.addEventListener('click', () => {
    const p = _mdProvider(el.getAttribute('data-preset'));
    if (!p) return;
    _mdTouchProvider(p.id, { baseUrl: p.defaultBaseUrl || '', addressOverridden: false });
    _mdRender();
  }));
  box.querySelectorAll('[data-pdelete]').forEach(el => el.addEventListener('click', () => {
    if (_mdSaveFlight || el.isConnected === false) return;
    _mdConfirmServiceDelete(el.getAttribute('data-pdelete'));
  }));
  box.querySelectorAll('[data-peye]').forEach(el => el.addEventListener('click', () => {
    const inp = box.querySelector('[data-pkey="' + el.getAttribute('data-peye') + '"]');
    if (!inp) return;
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    el.textContent = show ? '隐藏' : '显示';
    el.setAttribute('aria-pressed', String(show));
  }));
  box.querySelectorAll('[data-pclear]').forEach(el => el.addEventListener('click', async () => {
    if (_mdSaveFlight || el.isConnected === false) return;
    const pid = el.getAttribute('data-pclear');
    const p = _mdProvider(pid);
    if (!_mdCanEdit(p)) return;
    _mdClearProviderChecks(pid);
    _mdKeyEdits[pid] = null;    /* null explicitly removes the personal key. */
    _mdMarkOwnedDirty(p || pid);
    el.textContent = '（保存后此地址将没有凭据）';
    el.disabled = true;
    // Persist key removal immediately so the personal service leaves the usable list.
    const saved = await _mdSave(false);
    if (!saved) _mdRender();
  }));
  box.querySelectorAll('[data-ptest]').forEach(el => el.addEventListener('click', () => _mdDoTest(el)));
  box.querySelectorAll('[data-mdel]').forEach(el => el.addEventListener('click', async () => {
    if (_mdSaveFlight || el.isConnected === false) return;
    const [pid, i] = el.getAttribute('data-mdel').split('|');
    if (!_mdCanEdit(_mdProvider(pid))) return;
    const own = _mdMyModels.filter(m => m.providerId === pid);
    const target = own[+i];
    const at = _mdMyModels.indexOf(target);
    if (at < 0) return;
    _mdMyModels.splice(at, 1);
    if (_mdDrafts.get(pid)?.original === target.name) _mdDrafts.delete(pid);
    _mdClearCheck(_mdCheckKey(pid, target.name));
    _mdMarkOwnedDirty(_mdProvider(pid) || pid); _mdRender();
    // Removing a personal model is an explicit destructive action. Persist it
    // immediately so it does not reappear when the panel is reopened, and so a
    // stale model cannot remain selected in the conversation picker.
    const saved = await _mdSave(false);
    if (!saved) _mdRender();
  }));
  _mdBindModels(box);
}

function _mdFocusValidation() {
  const input = document.getElementById('mdBody')?.querySelector('[aria-invalid="true"]');
  input?.focus({ preventScroll: true });
  input?.closest('.md-field')?.scrollIntoView({ block: 'nearest' });
}

/*
 * Save pending keys before the real connection test so the result applies to the new
 * credential.
 */
async function _mdDoTest(el) {
  if (_mdSaveFlight) return;
  const pid = el.getAttribute('data-ptest');
  if (_mdTest[pid]?.state === 'ing') return;
  const p = _mdProvider(pid);
  if (!_mdCanEdit(p)) return;
  const error = _mdProviderError(p);
  if (error) {
    _mdValidation = error; delete _mdTest[pid];
    _mdRender(); _mdFocusValidation(); return;
  }
  if (!_mdUsesLocalDiscovery(p) && !(_mdMyModels || []).some((m) => m.providerId === pid) &&
      !(p.modelDefs || p.modelNames || []).length) {
    _mdTest[pid] = { state: 'bad', detail: '请先添加一个模型 ID' }; _mdRender(); return;
  }
  const pending = { state: 'ing' }, scope = SoduWorkAPI.taskStorageKey?.('ops');
  _mdTest[pid] = pending;
  let probeLoad;
  const current = () => _mdTest[pid] === pending && scope === SoduWorkAPI.taskStorageKey?.('ops') &&
    (probeLoad === undefined || probeLoad === _mdLoadId);
  _mdRender();
  try {
    if (_mdNeedsSave(pid)) {
      if (!await _mdSave(false)) throw Error('请先保存模型配置，再检测能力');
    }
    if (!current()) return;
    probeLoad = _mdLoadId;
    const r = await SoduWorkAPI.testMyModel(p.id, { localOnly: p.localOnly === true });
    if (!current()) return;
    const outcome = { state: r?.ok ? 'ok' : 'bad', detail: r?.detail || '没测出结果' };
    if (r?.ok && _mdUsesLocalDiscovery(p) && Array.isArray(r.models)) {
      // The main-process probe persists discovered IDs atomically. Reload the
      // merged catalog instead of saving again with a stale local revision.
      const before = _mdData, snapshot = JSON.stringify(before);
      let latest;
      try { latest = await SoduWorkAPI.myModels({ fresh: true }); } catch { /* Offer a catalog retry below. */ }
      if (!current()) return;
      if (!Array.isArray(latest?.usable) || !Array.isArray(latest?.myModels) || !Array.isArray(latest?.providers)) {
        _mdData = { ..._mdData, catalogRefreshFailed: true };
      } else if (before === _mdData && snapshot === JSON.stringify(_mdData) && !_mdSaveFlight) {
        if (!_mdDirty) {
          _mdData = latest; _mdMyModels = latest.myModels.slice(); _mdReconcileChecks(latest);
        } else {
          // Only the persisted choice list is safe to replace while forms have unsaved changes.
          _mdData = { ..._mdData, usable: latest.usable, mediaUsable: latest.mediaUsable };
        }
        await _mdRefreshSavedModels();
      }
    }
    if (current()) _mdTest[pid] = outcome;
  } catch (e) {
    if (!current()) return;
    _mdTest[pid] = { state: 'bad', detail: _humanErr(e, '没测成') };
  } finally {
    if (_mdTest[pid] === pending) delete _mdTest[pid];
  }
  _mdRender();
}

/* Enable saving only when unsaved changes exist. */
function _mdMark() {
  document.getElementById('mdBody')?.querySelectorAll?.('input,select,textarea,button').forEach(control => {
    if (_mdSaveFlight && !control.disabled) { control.disabled = true; control._mdSaveDisabled = true; }
    else if (!_mdSaveFlight && control._mdSaveDisabled) { control.disabled = false; delete control._mdSaveDisabled; }
    if (_mdAddingModel && control.dataset?.madd === _mdAddingModel) control.textContent = '添加中…';
  });
  const btn = document.getElementById('mdSave');
  if (!btn) return;
  const dirty = _mdDirty || _mdLocalDirty || _mdManagedDirty || Object.keys(_mdKeyEdits).length > 0;
  btn.disabled = !!_mdSaveFlight || !dirty || _mdLoadState !== 'ready';
  btn.textContent = _mdSaveFlight && !_mdAddingModel ? '保存中…' : dirty || _mdLoadState !== 'ready' ? '保存' : '已保存';
}

function _mdPayload(excludeDraft = false) {
  const skippedId = excludeDraft ? _mdNew?.id : null;
  const all = (_mdData && _mdData.providers ? _mdData.providers : []).filter(p => p.id !== skippedId && _mdCanEdit(p));
  if (_mdNew && !excludeDraft && !all.some((p) => p.id === _mdNew.id)) {
    all.push(_mdNew);
  }
  const providers = all.map((p) => ({ id: p.id, name: p.name, kind: p.kind || 'openai-compat',
    baseUrl: p.baseUrl || '', defaultBaseUrl: p.defaultBaseUrl || '', personal: !!p.personal,
    authMode: p.authMode || 'key', note: p.note || '', localOnly: p.localOnly === true }));
  const localProviders = all.filter(p => p.localOnly === true);
  const localIds = new Set([...localProviders.map(p => p.id), ..._mdLocalKeyIds]);
  const managedIds = new Set(all.filter(p => p.localOnly !== true).map(p => p.id));
  const payload = {};
  if (_mdManagedDirty) {
    payload.providers = providers.filter(p => p.localOnly !== true);
    payload.models = _mdMyModels.filter(m => m.localOnly !== true && managedIds.has(m.providerId));
    payload.keys = Object.fromEntries(Object.entries(_mdKeyEdits).filter(([id]) => managedIds.has(id)));
    payload.expectedRevision = _mdData && _mdData.revision;
  }
  if (_mdLocalDirty && (!excludeDraft || [..._mdLocalKeyIds].some(id => id !== skippedId))) {
    payload.localProviders = localProviders;
    payload.localModels = _mdMyModels.filter(m => m.providerId !== skippedId && localIds.has(m.providerId));
    payload.localKeys = Object.fromEntries(Object.entries(_mdKeyEdits).filter(([id]) => id !== skippedId && localIds.has(id)));
    payload.localRevision = _mdData && _mdData.localRevision;
  }
  return payload;
}

function _mdNeedsSave(pid) {
  const skip = !!(_mdNew && _mdNew.id !== pid && _mdProviderError(_mdNew));
  return Object.keys(_mdPayload(skip)).length > 0;
}

function _mdProviderError(p) {
  if (!p) return null;
  const address = String(p.baseUrl || '').trim();
  let field = 'url', detail = '';
  if (!address) detail = '请填写 API 地址';
  else if (p.localOnly && address.length > 400) detail = 'API 地址不能超过 400 个字符';
  else if (!/^https?:\/\//i.test(address)) detail = 'API 地址要以 http:// 或 https:// 开头';
  else {
    try {
      const url = new URL(address);
      if (!url.hostname || (p.localOnly && (url.username || url.password || url.search || url.hash))) throw Error();
    } catch (_) { detail = '请填写有效的 API 地址'; }
  }
  if (!detail && p.personal && !String(p.name || '').trim()) { field = 'name'; detail = '请填写服务名称'; }
  if (!detail && p.localOnly && String(p.name || '').trim().length > 64) { field = 'name'; detail = '服务名称不能超过 64 个字符'; }
  return detail ? Object.assign(new Error(detail), { detail, field, providerId: p.id }) : null;
}

function _mdSave(closeAfter) {
  if (_mdSaveFlight) return _mdSaveFlight;
  const loadId = _mdLoadId, scope = SoduWorkAPI.taskStorageKey?.('ops');
  const newId = _mdNew?.id;
  _mdSaveFlight = Promise.resolve().then(() => _mdSaveChanges(closeAfter, loadId, scope)).finally(() => {
    _mdSaveFlight = null; _mdMark();
    if (_mdValidation) _mdFocusValidation();
  }).then(saved => {
    if (saved && newId && !_mdNew && _mdOpen === newId && !closeAfter &&
        scope === SoduWorkAPI.taskStorageKey?.('ops') && _mdLoadState === 'ready') {
      const next = document.getElementById('mdBody')?.querySelector?.('[data-mdaddchat]');
      if (next?.dataset.mdaddchat === newId) next.focus();
    }
    return saved;
  });
  _mdMark();
  return _mdSaveFlight;
}

async function _mdSaveChanges(closeAfter, loadId, scope) {
  const current = () => loadId === _mdLoadId && scope === SoduWorkAPI.taskStorageKey?.('ops');
  if (!current()) return false;
  let localSaved = false, skippedDraft = false;
  try {
    const p = _mdProvider(_mdOpen || _mdEditor);
    skippedDraft = !!(_mdNew && p?.id !== _mdNew.id && _mdProviderError(_mdNew));
    // Keep the two ownership domains independent, including partial failures.
    const body = structuredClone(_mdPayload(skippedDraft));
    const checked = (body.localProviders || []).concat(body.providers?.some(row => row.id === p?.id) ? [p] : []);
    for (const provider of checked) { const error = _mdProviderError(provider); if (error) throw error; }
    if (!body.localProviders && !body.providers) throw _mdProviderError(_mdNew) || Error('请先选择要保存的服务');
    _mdValidation = null;
    if (Array.isArray(body.localProviders)) {
      const result = await SoduWorkAPI.saveMyModels({ localProviders: body.localProviders,
        localModels: body.localModels, localKeys: body.localKeys, localRevision: body.localRevision });
      if (!current()) return false;
      localSaved = true; _mdLocalDirty = skippedDraft; _mdLocalKeyIds = new Set(skippedDraft ? [_mdNew.id] : []);
      for (const id of Object.keys(body.localKeys)) delete _mdKeyEdits[id];
      if (result && Array.isArray(result.providers) && Array.isArray(result.myModels)) {
        const localIds = new Set([...body.localProviders.map(provider => provider.id), ...Object.keys(body.localKeys)]);
        const managed = rows => (rows || []).filter(row => !row.localOnly && !localIds.has(row.providerId));
        const pending = skippedDraft ? _mdMyModels.filter(row => row.providerId === _mdNew.id) : [];
        _mdMyModels = result.myModels.concat(managed(_mdMyModels).filter(row => row.providerId !== _mdNew?.id), pending);
        _mdData = { ..._mdData, localRevision: result.revision,
          providers: result.providers.concat(_mdData.providers.filter(provider => !provider.localOnly)),
          myModels: _mdMyModels, usable: (result.usable || []).concat(managed(_mdData.usable)),
          mediaUsable: Object.fromEntries(['image', 'video'].map(type =>
            [type, (result.mediaUsable?.[type] || []).concat(managed(_mdData.mediaUsable?.[type]))])) };
        if (_mdNew && result.providers.some(provider => provider.id === _mdNew.id)) {
          _mdEditor = _mdNew.id; _mdNew = null;
        }
      }
    }
    if (Array.isArray(body.providers)) {
      if (_mdManagedNeedsReload) throw Error('请重新打开模型页面，刷新服务配置后再保存。');
      await SoduWorkAPI.saveMyModels({ providers: body.providers, models: body.models,
        keys: body.keys, expectedRevision: body.expectedRevision });
      if (!current()) return false;
      _mdManagedDirty = false; _mdManagedNeedsReload = true;
      for (const id of Object.keys(body.keys)) delete _mdKeyEdits[id];
    }
    _mdDirty = _mdLocalDirty || _mdManagedDirty || Object.keys(_mdKeyEdits).length > 0;
  } catch (e) {
    if (!current()) return false;
    if (e.providerId) { _mdValidation = e; _mdOpen = e.providerId; }
    _mdDirty = _mdLocalDirty || _mdManagedDirty || Object.keys(_mdKeyEdits).length > 0;
    if (typeof petSay === 'function' && (localSaved || !e.providerId)) petSay(localSaved
      ? '本地模型配置已保存，Hub 模型配置未保存，请重试。' : _humanErr(e, '没存上'));
    try { _mdRender(); } catch (_) { /* Preserve the remaining draft after a display failure. */ }
    if (localSaved) await _mdRefreshSavedModels();
    return false;
  }
  if (typeof petSay === 'function') petSay(skippedDraft
    ? '其他模型配置已保存，新增服务尚未保存，请补全后保存。' : '服务信息已保存');
  let reloaded = false;
  try { reloaded = await _mdLoad({ saved: true }); } catch (_) { /* The write has already committed. */ }
  if (!reloaded && typeof petSay === 'function')
    petSay('模型配置已保存，但模型清单刷新失败，请重新打开模型页面。');
  await _mdRefreshSavedModels();
  try {
    if (closeAfter && window.soduWorkAPI && soduWorkAPI.closeDeskWindow) soduWorkAPI.closeDeskWindow();
  } catch (_) { /* The workspace must remain usable after a provider save. */ }
  return true;
}

async function _mdRefreshSavedModels() {
  try {
    if (globalThis.ComposeModelPicker && typeof ComposeModelPicker.refresh === 'function') {
      await ComposeModelPicker.refresh(true);
    }
  } catch (_) {
    if (typeof petSay === 'function') petSay('模型配置已保存，但模型选择器刷新失败，请重新打开对话。');
  }
  try {
    if (window.soduWorkAPI && soduWorkAPI.broadcast) {
      soduWorkAPI.broadcast('models', { providerId: _mdEditor || '' });
    }
  } catch (_) { /* Do not turn a persisted change into a false failure. */ }
}

// Source-owned messages keep count updates and language changes independent.
function _mdMessage(key, fallback, params) {
  if (globalThis.SoduWorkI18n?.html) return SoduWorkI18n.html(key, fallback, params);
  return esc(fallback.replace(/\{(\w+)\}/g, (all, name) => params[name] ?? all));
}

// A background hint must not replace the editor's loading/error state or drafts.
function _mdBackgroundRefresh() {
  if (_mdRefreshFlight) return _mdRefreshFlight;
  const panel = document.getElementById('mdPanel'), box = document.getElementById('mdBody');
  const editable = () => panel?.classList.contains('show') && document.getElementById('mdBody') === box &&
    !_mdSaveFlight && _mdLoadState === 'ready' && _mdData && !_mdDirty && !Object.keys(_mdKeyEdits).length &&
    !_mdNew && !_mdDeletePending && !_mdDrafts.size &&
    !Object.values(_mdTest).some(test => test.state === 'ing') && ![..._mdChecks.values()].some(check => check.pending);
  if (!box || !editable()) return Promise.resolve(false);
  const scope = SoduWorkAPI.taskStorageKey?.('ops'), loadId = _mdLoadId;
  const previous = { data: _mdData, models: _mdMyModels, editor: _mdEditor, open: _mdOpen, query: _mdQuery };
  const snapshot = JSON.stringify(_mdData);
  const current = () => editable() && loadId === _mdLoadId && scope === SoduWorkAPI.taskStorageKey?.('ops') &&
    previous.data === _mdData && snapshot === JSON.stringify(_mdData) && previous.editor === _mdEditor &&
    previous.open === _mdOpen && previous.query === _mdQuery;
  let timer, rendering = false;
  const flight = Promise.race([
    Promise.resolve().then(() => SoduWorkAPI.myModels()),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Model catalog refresh timed out')), 20000); })
  ]).then(result => {
    if (!current() || !result || !['providers', 'usable', 'myModels'].every(key => Array.isArray(result[key])) ||
        result.providers.some(provider => !provider || typeof provider.id !== 'string') ||
        result.myModels.some(model => !model || typeof model.name !== 'string') || snapshot === JSON.stringify(result)) return false;
    rendering = true;
    _mdData = result; _mdMyModels = result.myModels.slice();
    _mdReconcileChecks(result); _mdRender();
    return true;
  }).catch(() => {
    if (rendering) { _mdData = previous.data; _mdMyModels = previous.models; }
    return false;
  }).finally(() => { clearTimeout(timer); if (_mdRefreshFlight === flight) _mdRefreshFlight = null; });
  _mdRefreshFlight = flight;
  return flight;
}

function _mdScopeChanged() {
  _mdStopModelChecks();
  if (_mdCatalogScope === SoduWorkAPI.taskStorageKey?.('ops')) return;
  ++_mdLoadId;
  _mdCatalogScope = SoduWorkAPI.taskStorageKey?.('ops');
  _mdData = null; _mdMyModels = []; _mdKeyEdits = {}; _mdTest = {};
  _mdNew = null; _mdValidation = null; _mdOpen = ''; _mdEditor = ''; _mdQuery = '';
  _mdDeletePending = ''; _mdDrafts.clear(); _mdChecks.clear(); _mdLocalKeyIds.clear();
  _mdDirty = _mdLocalDirty = _mdManagedDirty = _mdManagedNeedsReload = false;
  if (document.getElementById('mdPanel')?.classList.contains('show')) void _mdLoad({ fresh: true });
}
window.addEventListener?.('soduwork-data-scope-changed', _mdScopeChanged);
window.addEventListener?.('pagehide', _mdStopModelChecks);
window.addEventListener?.('soduwork-domain-changed', event => {
  if (event.detail?.domain === 'models') void _mdBackgroundRefresh();
});
