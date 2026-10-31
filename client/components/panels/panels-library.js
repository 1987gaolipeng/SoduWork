/* Independent personal material library panel. */
(function (global) {
  'use strict';
  const TABS = [['recommended', '推荐'], ['favorites', '收藏'], ['folders', '文件夹'], ['images', '图像'], ['all', '全部']];
  // Documents are the library's text-authoring entry point; notes use the same editor,
  // so omit a duplicate creation action and preserve product menu order for other types.
  const CREATE_ITEMS = [['document', '文档'], ['image', '图像'], ['spreadsheet', '电子表格'], ['presentation', '演示文稿'], ['folder', '文件夹'], ['upload', '上传文件']];
  const STORAGE_TABS = [['local', '本地存储'], ['remote', '远程存储']];
  const MAX_BATCH_ITEMS = 100;
  const CREATE_PROMPTS = {
    image: '请帮我创建一张图像。请先询问我想要的主题、风格、尺寸和用途，然后开始创作。完成后提醒我可以将成果保存到资料库。',
    document: '请帮我创建一份文档。请先询问文档主题、结构、语气和格式，然后开始撰写。完成后提醒我可以将成果保存到资料库。',
    spreadsheet: '请帮我创建一份电子表格。请先询问数据字段、计算规则和展示方式，然后开始制作。完成后提醒我可以将成果保存到资料库。',
    presentation: '请帮我创建一份演示文稿。请先询问主题、受众、页数和风格，然后开始制作。完成后提醒我可以将成果保存到资料库。',
  };
  const GLYPHS = {
    note: '<path d="M5 4h14v10l-6 6H5zM13 20v-6h6M8 8h8M8 11h4"/>',
    document: '<path d="M6 3h9l4 4v14H6zM15 3v5h4M9 12h7M9 16h7"/>',
    image: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><circle cx="9" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 5"/>',
    images: '<rect x="8" y="3" width="13" height="13" rx="3" transform="rotate(9 14 9)"/><rect x="3" y="8" width="13" height="13" rx="3" transform="rotate(-9 9 14)"/><path d="m4 17 4-4 4 4M11 11h.01"/>',
    spreadsheet: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 10h17M10 10v10"/>',
    presentation: '<rect x="3" y="6" width="18" height="14" rx="3"/><path d="M6 3h12"/>',
    folder: '<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2zM4 10h16"/>',
    upload: '<path d="M12 17V3M7 8l5-5 5 5M5 21h14"/>',
    filter: '<path d="M4 6h16M7 11h10M10 16h4"/>',
    grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    settings: '<path d="M3 7h9M16 7h5M3 17h5M12 17h9"/><circle cx="14" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    trash: '<path d="M4.5 6.5h15M9 6.5V4h6v2.5M6.5 6.5l.7 12.1a2 2 0 0 0 2 1.9h5.6a2 2 0 0 0 2-1.9l.7-12.1M10 10.5v6M14 10.5v6"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/>',
    download: '<path d="M12 3v13M7 11l5 5 5-5M4 17v4h16v-4"/>',
    hidden: '<path d="M3 3 21 21M10.5 10.5a2.1 2.1 0 0 0 3 3M8 5.5a10 10 0 0 1 4-.8c6 0 9 7.3 9 7.3a15 15 0 0 1-3 4M6 7C4 9 3 12 3 12s3 7.3 9 7.3a10 10 0 0 0 4-.8"/>',
    braces: '<path d="M9 3H7v6l-3 3 3 3v6h2M15 3h2v6l3 3-3 3v6h-2"/>',
    back: '<path d="m10 5-7 7 7 7M3 12h18"/>',
    chat: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.8 4v-4H6.5A2.5 2.5 0 0 1 4 12.5zM8 8h8M8 11h5"/>',
    edit: '<path d="m14.5 5.5 4 4M5 19l3.2-.7L19.2 7.3a1.7 1.7 0 0 0-2.4-2.4L5.8 15.9z"/>',
    restore: '<path d="M4 5v6h6M4.5 10a8 8 0 1 1 .5 6"/>',
    share: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/>',
  };
  const state = { scope: 'recommended', storage: 'local', query: '', folderId: '', folder: null, folders: [], items: [], selected: new Set(), view: 'list', filterKind: 'all', trashCount: 0, showHidden: false, busy: false, error: '', storageStatus: { local: { available: true, configured: true, connected: true }, remote: { backend: '', available: false, configured: false, connected: false } }, storageStatusLoading: false };
  let root, uploadInput, uploadTarget, searchTimer, requestId = 0, storageStatusRequest = 0, previewPane, imageEpoch = 0;
  let lifecycleEpoch = 0, batchBusy = false;
  let loadedFilterKey = '', contentMarkup = '';
  function filterKey() { return JSON.stringify([state.scope, storedBackend(state.folder), state.query, state.folderId]); }
  function hasCurrentSnapshot() { return loadedFilterKey === filterKey(); }
  const imageUrls = new Map();
  const imageLoads = new Map();
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const icon = name => '<svg class="library-icon" viewBox="0 0 24 24" aria-hidden="true">' + (GLYPHS[name] || GLYPHS.document) + '</svg>';
  const errorText = (error, fallback) => String(error && (error.detail || error.message) || fallback);
  const isStorageError = error => ['LIBRARY_STORAGE_NOT_CONFIGURED', 'LIBRARY_STORAGE_UNAVAILABLE'].includes(String(error && error.code || ''));
  const tx = (source, params) => global.SoduWorkI18n?.t('library.copy', source, params) || String(source).replace(/\{(\w+)\}/g, (all, key) => params?.[key] ?? all);
  const notify = message => { if (typeof global.petSay === 'function') global.petSay(tx(message)); };
  const hiddenItem = item => typeof (item.extra || {}).hidden === 'boolean' ? item.extra.hidden : String(item.filename || '').startsWith('.');
  // Keep concrete provider names in requests so a configuration refresh cannot
  // redirect a pending upload/editor/move to a different remote service.
  const storedBackend = row => ['local', 'minio', 'nfs'].includes(row?.backend) ? row.backend : state.storage;
  const isClientLocal = row => String(row?.id || '').startsWith('local-');
  const isServerHistory = () => state.folder?.storageOrigin === 'server-history';
  const storageAvailable = () => state.storage === 'local' ? state.storageStatus.local.available !== false : (!state.storageStatusLoading &&
    state.storageStatus.remote.available && state.storageStatus.remote.backend === state.storage);
  const storageMessage = () => state.storage === 'local' ? (state.storageStatus.local.message || '本地资料库暂时不可用，请确认当前账号') : state.storageStatus.remote.message || (state.storageStatus.remote.configured ? '远程存储暂时不可用' : '请先配置资料库存储环境');
  const providerLabel = backend => backend === 'nfs' ? 'NFS' : backend === 'minio' ? 'MinIO' : '';
  const dialogs = global.SoduWorkLibraryDialogs.create({ state, esc, icon, notify, errorText, load, getEpoch: () => lifecycleEpoch });
  const { openDocumentEditor, openMoveFolderDialog, openConfirmDialog, openNameDialog, openFolderDialog } = dialogs;
  function createMenuMarkup(name) {
    return '<div class="library-menu library-create-menu" data-library-menu="' + name + '" hidden><div class="library-menu-label">创建新内容</div>' + CREATE_ITEMS.map(([kind, label]) => {
      const separator = kind === 'upload' ? ' library-menu-separator' : '';
      return '<button data-library-create-kind="' + kind + '" class="' + separator.trim() + '">' + icon(kind) + '<span>' + label + '</span></button>';
    }).join('') + '</div>';
  }
  function preference(key, value) { try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch (_) {} return ''; }
  function formatSize(size) {
    const n = Math.max(0, Number(size) || 0);
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(1) + ' GB';
  }
  function formatDate(value) {
    const date = new Date(value);
    return value && !isNaN(date.getTime()) ? date.toLocaleDateString(global.SoduWorkI18n?.getLocale() || 'zh-CN', { month: 'short', day: 'numeric' }) : '—';
  }
  function formatGridDate(value) {
    const date = new Date(value);
    if (!value || isNaN(date.getTime())) return '—';
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString(global.SoduWorkI18n?.getLocale() || 'zh-CN', { hour: 'numeric', minute: '2-digit' });
    }
    return date.toLocaleDateString(global.SoduWorkI18n?.getLocale() || 'zh-CN', { month: 'short', day: 'numeric' });
  }
  function ensureRoot() {
    if (root && root.isConnected) return root;
    root = document.getElementById('libraryPanel') || document.createElement('section');
    root.id = 'libraryPanel'; root.className = 'panel library-panel';
    if (!root.isConnected) document.body.appendChild(root);
    state.view = preference('soduwork_work_library_view') === 'grid' ? 'grid' : 'list';
    state.showHidden = preference('soduwork_work_library_show_hidden') === '1';
    root.innerHTML = '<div class="library-page"><header class="library-head ws-page-head"><h1 data-library-title>资料库</h1>' +
      '<div class="library-toolbar">' +
      '<nav class="library-storage-tabs" role="tablist" aria-label="存储位置">' + STORAGE_TABS.map(([key, label]) => '<button role="tab" data-library-storage="' + key + '"><span>' + label + '</span>' + (key === 'remote' ? '<i class="library-storage-status-dot" data-library-storage-status="remote" aria-label="远程存储连接状态"></i>' : '') + '</button>').join('') + '</nav>' +
      '<div class="library-menu-wrap"><button class="library-icon-button" data-library-menu-toggle="filter" aria-label="筛选类型" aria-expanded="false">' + icon('filter') + '</button>' +
      '<div class="library-menu library-filter-menu" data-library-menu="filter" hidden><div class="library-menu-label">文件类型</div>' + [['all', '全部类型'], ...CREATE_ITEMS.slice(0, 5)].map(([kind, label]) => '<button data-library-filter-kind="' + kind + '">' + esc(label) + '</button>').join('') + '</div></div>' +
      '<div class="library-view-toggle" role="group" aria-label="资料视图"><button class="library-icon-button" data-library-view="grid" aria-label="网格视图">' + icon('grid') + '</button><button class="library-icon-button" data-library-view="list" aria-label="列表视图">' + icon('list') + '</button></div>' +
      '<label class="library-search">' + icon('search') + '<input type="search" data-library-search placeholder="搜索资料库" aria-label="搜索资料库" autocomplete="off"></label>' +
      '<div class="library-menu-wrap library-create-wrap"><button class="library-create" data-library-menu-toggle="create" aria-expanded="false">新建 ' + icon('chevron') + '</button>' + createMenuMarkup('create') + '</div>' +
      '<div class="library-menu-wrap"><button class="library-icon-button" data-library-menu-toggle="options" aria-label="资料库设置" aria-expanded="false">' + icon('settings') + '</button><div class="library-menu library-options-menu" data-library-menu="options" hidden>' +
      '<div class="library-menu-label">设置</div><label class="library-setting-row">' + icon('braces') + '<span>显示隐藏文件</span><input type="checkbox" data-library-hidden-files><i aria-hidden="true"></i></label>' +
      '<div class="library-menu-divider"></div><div class="library-menu-label">管理</div><button data-library-trash>' + icon('trash') + '<span>回收站</span></button></div></div></div></header>' +
      '<nav class="library-tabs" role="tablist" aria-label="资料分类">' + TABS.map(([key, label]) => '<button role="tab" data-library-scope="' + key + '">' + label + '</button>').join('') + '</nav>' +
      '<div class="library-trash-nav" hidden><button data-library-root>' + icon('back') + '返回资料库</button><button data-library-empty-trash class="library-danger">清空回收站</button></div>' +
      '<div class="library-breadcrumb" data-library-breadcrumb hidden></div><div class="library-list-head" data-library-list-head hidden><label class="library-row-select library-list-select"><input type="checkbox" data-library-select-all aria-label="选择全部资料"></label><span>名称</span><span class="library-source-heading">&#26469;&#28304;</span><span data-library-date-heading>修改日期</span><span>大小</span><span></span></div>' +
      '<div class="library-state" data-library-state aria-live="polite" hidden></div><div class="library-content" data-library-content></div><input type="file" data-library-upload hidden multiple></div>';
    const batchToolbar = document.createElement('div');
    batchToolbar.className = 'library-batch-toolbar';
    batchToolbar.dataset.libraryBatchToolbar = '';
    batchToolbar.hidden = true;
    batchToolbar.innerHTML = '<span class="library-batch-count" data-library-batch-count></span>' +
      '<button type="button" data-library-batch-chat>围绕内容开启对话</button>' +
      '<button type="button" data-library-batch-migrate>批量存储到远端</button>' +
      '<button type="button" data-library-batch-share>批量分享</button>' +
      '<button type="button" class="library-danger" data-library-batch-delete>批量删除</button>' +
      '<button type="button" data-library-batch-clear>取消选择</button>';
    root.querySelector('[data-library-list-head]').after(batchToolbar);
    uploadInput = root.querySelector('[data-library-upload]');
    root.querySelector('[data-library-hidden-files]').checked = state.showHidden;
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.querySelector('[data-library-hidden-files]').addEventListener('change', event => {
      state.showHidden = event.target.checked; preference('soduwork_work_library_show_hidden', state.showHidden ? '1' : '0'); render();
    });
    root.querySelector('[data-library-search]').addEventListener('input', event => {
      state.query = event.target.value || ''; requestId++; clearTimeout(searchTimer);
      searchTimer = setTimeout(load, 220);
    });
    uploadInput.addEventListener('change', uploadFiles);
    document.addEventListener('pointerdown', event => { if (root.classList.contains('show') && !event.target.closest('#libraryPanel .library-menu-wrap')) closeMenus(); });
    root.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenus(); });
    return root;
  }
  function closeMenus(except) {
    if (!root) return;
    root.querySelectorAll('[data-library-menu]').forEach(menu => { if (menu.dataset.libraryMenu !== except) menu.hidden = true; });
    root.querySelectorAll('[data-library-menu-toggle]').forEach(button => button.setAttribute('aria-expanded', String(button.dataset.libraryMenuToggle === except)));
    root.querySelectorAll('.library-card').forEach(card => card.classList.remove('is-menu-open'));
  }
  function toggleMenu(name, button) {
    const menu = [...root.querySelectorAll('[data-library-menu]')].find(el => el.dataset.libraryMenu === name);
    if (!menu) return;
    const open = menu.hidden; closeMenus(open ? name : ''); menu.hidden = !open;
    if (button) button.setAttribute('aria-expanded', String(open));
    const card = button && button.closest('.library-card'); if (card) card.classList.toggle('is-menu-open', open);
  }
  async function runAction(button, action, fallback, success) {
    const epoch = lifecycleEpoch;
    button.disabled = true; closeMenus();
    try { await action(); if (epoch !== lifecycleEpoch) return; if (success) notify(success); await load(); }
    catch (error) { if (epoch === lifecycleEpoch) await dialogs.showError(error, fallback); }
    finally {
      if (button.isConnected) button.disabled = button.hasAttribute('data-library-empty-trash') ? state.trashCount < 1 || state.busy : false;
    }
  }
  function enterScope(scope) {
    const history = isServerHistory() && (scope === 'trash' || state.scope === 'trash');
    previewPane?.close(); closeMenus(); state.scope = scope;
    state.folderId = history ? 'server-history-root' : '';
    state.folder = history ? { id: state.folderId, name: '历史服务器资料', backend: state.storage, storageOrigin: 'server-history', readOnly: true } : null;
    state.query = ''; state.filterKind = 'all'; state.selected.clear();
    state.view = scope === 'trash' ? 'list' : (preference('soduwork_work_library_view') === 'grid' ? 'grid' : 'list');
    root.querySelector('[data-library-search]').value = ''; load();
  }
  function enterStorage(storage) {
    if (!STORAGE_TABS.some(([key]) => key === storage)) return;
    if (storage === 'remote' && (!state.storageStatus.remote.available || state.storageStatusLoading)) {
      notify(storageMessage());
      return;
    }
    previewPane?.close(); closeMenus(); state.storage = storage === 'remote' ? state.storageStatus.remote.backend : 'local'; state.folderId = ''; state.folder = null; state.selected.clear(); load();
  }
  async function onClick(event) {
    const button = event.target.closest('button'); if (!button || !root.contains(button)) return;
    const d = button.dataset;
    if (d.libraryMenuToggle !== undefined) { toggleMenu(d.libraryMenuToggle, button); return; }
    if (d.libraryCreateKind !== undefined) { closeMenus(); await createKind(d.libraryCreateKind); return; }
    if (d.libraryScope !== undefined) { enterScope(d.libraryScope); return; }
    if (d.libraryStorage !== undefined) { enterStorage(d.libraryStorage); return; }
    if (d.libraryTrash !== undefined) { enterScope('trash'); return; }
    if (d.libraryRoot !== undefined) { enterScope('all'); return; }
    if (d.libraryRetry !== undefined) { loadStorageStatus(); if (state.storage === 'local') load(); return; }
    if (d.libraryView !== undefined) { state.view = d.libraryView === 'list' ? 'list' : 'grid'; if (state.scope !== 'trash') preference('soduwork_work_library_view', state.view); render(); return; }
    if (d.libraryFilterKind !== undefined) {
      state.filterKind = d.libraryFilterKind;
      closeMenus();
      // The folders collection is returned only by collection/tree scopes.
      // Move to the collection view when a folder filter is chosen from a
      // file-only scope, otherwise the filter would appear to do nothing.
      if (state.filterKind === 'folder' && !['all', 'folders', 'favorites'].includes(state.scope)) {
        state.scope = 'all'; state.folderId = ''; state.folder = null; state.selected.clear(); load();
      } else render();
      return;
    }
    if (d.libraryFolder !== undefined) { previewPane?.close(); state.folder = state.folders.find(row => row.id === d.libraryFolder) || null; state.storage = storedBackend(state.folder); state.folderId = d.libraryFolder; state.scope = 'all'; state.selected.clear(); load(); return; }
    if (d.libraryDownload !== undefined) {
      closeMenus(); try { await global.SoduWorkAPI.downloadLibraryItem(d.libraryDownload, d.filename); } catch (error) { notify(errorText(error, '下载失败')); } return;
    }
    if (d.libraryFilePreview !== undefined) {
      closeMenus(); const item = state.items.find(row => row.id === d.libraryFilePreview);
      if (!item || button.disabled) return;
      const previewItem = { ...item, backend: storedBackend(item) };
      if (global.SoduWorkLibraryPreview.kindOf(previewItem) === 'office' && previewItem.backend === 'local') {
        previewPane?.close(); button.disabled = true;
        try { await openWithSystemApp(item.id); } finally { if (button.isConnected) button.disabled = false; }
      } else { previewPane ||= global.SoduWorkLibraryPreview.create({ root, openSource: openSourceConversation }); void previewPane.open(previewItem); }
      return;
    }
    if (d.libraryShare !== undefined) { await shareItem(button, d.libraryShare); return; }
    if (d.libraryOpenSession !== undefined) { openSourceConversation(d.libraryOpenSession); return; }
    if (d.libraryOpenSystem !== undefined) { await openWithSystemApp(d.libraryOpenSystem); return; }
    if (d.libraryReveal !== undefined) { await revealLibraryFile(d.libraryReveal); return; }
    if (d.libraryChat !== undefined) { await discussItem(button, d.libraryChat); return; }
    if (d.libraryFavorite !== undefined) { await runAction(button, () => global.SoduWorkAPI.updateLibraryItem(d.libraryFavorite, { favorite: d.value !== 'true' }), '收藏状态更新失败'); return; }
    if (d.libraryFavoriteFolder !== undefined) { const storage = storedBackend(state.folders.find(row => row.id === d.libraryFavoriteFolder)); await runAction(button, () => global.SoduWorkAPI.updateLibraryFolder(d.libraryFavoriteFolder, { favorite: d.value !== 'true', storage }), '文件夹收藏状态更新失败'); return; }
    if (d.libraryRenameFolder !== undefined) { await renameFolder(button, d.libraryRenameFolder); return; }
    if (d.libraryRename !== undefined) { await renameItem(button, d.libraryRename); return; }
    if (d.libraryMigrate !== undefined) { await migrateItem(button, d.libraryMigrate); return; }
    if (d.libraryMove !== undefined) { await moveItem(button, d.libraryMove); return; }
    if (d.libraryHide !== undefined) {
      const item = state.items.find(row => row.id === d.libraryHide); if (!item) return;
      await runAction(button, () => global.SoduWorkAPI.updateLibraryItem(item.id, { extra: { ...(item.extra || {}), hidden: !hiddenItem(item) } }), '隐藏状态更新失败'); return;
    }
    if (d.libraryDelete !== undefined) {
      const item = state.items.find(row => String(row.id) === String(d.libraryDelete));
      const name = item ? displayName(item) : tx('这份资料');
      if (!await openConfirmDialog({ title: '移入回收站？', description: '“{name}”移入回收站后仍可恢复。', descriptionParams: { name }, confirm: '移入回收站' })) return;
      await runAction(button, () => global.SoduWorkAPI.deleteLibraryItem(d.libraryDelete), '删除失败', '已移入回收站'); return;
    }
    if (d.libraryRestore !== undefined) { await runAction(button, () => global.SoduWorkAPI.restoreLibraryItem(d.libraryRestore), '恢复失败', '资料已恢复'); return; }
    if (d.libraryPurge !== undefined) {
      if (!await openConfirmDialog({ title: '永久删除资料？', description: '删除后将无法恢复，请确认是否继续。', confirm: '永久删除', danger: true })) return;
      await runAction(button, () => global.SoduWorkAPI.purgeLibraryItem(d.libraryPurge), '彻底删除失败'); return;
    }
    if (d.libraryEmptyTrash !== undefined) {
      const storage = state.storage, epoch = lifecycleEpoch, history = isServerHistory();
      if (!await openConfirmDialog({ title: history ? '清空历史服务器资料回收站？' : '清空回收站？', description: '回收站中的资料将被永久删除，无法恢复。', confirm: '清空回收站', danger: true })) return;
      if (epoch !== lifecycleEpoch) return;
      await runAction(button, async () => { const result = await global.SoduWorkAPI.emptyLibraryTrash(storage, history ? { storageOrigin: 'server-history' } : undefined); if (result?.partial) notify('部分资料删除失败，请重试'); }, '清空回收站失败'); return;
    }
    if (d.libraryDeleteFolder !== undefined) {
      const folder = state.folders.find(row => String(row.id) === String(d.libraryDeleteFolder));
      if (folder && (Number(folder.itemCount || 0) > 0 || Number(folder.childCount || 0) > 0)) {
        notify('文件夹不为空，只能删除空文件夹');
        return;
      }
      const name = folder ? String(folder.name || tx('这个文件夹')) : tx('这个空文件夹');
      if (!await openConfirmDialog({ title: '删除空文件夹？', description: '“{name}”为空文件夹，确认删除吗？', descriptionParams: { name }, confirm: '删除文件夹', danger: true })) return;
      await runAction(button, () => global.SoduWorkAPI.deleteLibraryFolder(d.libraryDeleteFolder), '文件夹删除失败');
    }
  }
  function onChange(event) {
    const target = event.target;
    if (!target || !target.matches('input[type="checkbox"]')) return;
    if (target.dataset.librarySelectAll !== undefined) {
      const checked = target.checked;
      root.querySelectorAll('[data-library-select]').forEach(input => {
        input.checked = checked;
        if (checked) state.selected.add(input.dataset.librarySelect);
        else state.selected.delete(input.dataset.librarySelect);
      });
      render();
      return;
    }
    if (target.dataset.librarySelect !== undefined) {
      if (target.checked) state.selected.add(target.dataset.librarySelect);
      else state.selected.delete(target.dataset.librarySelect);
      render();
    }
  }
  function selectedRows() {
    const ids = [...state.selected];
    return ids.map(id => state.items.find(row => String(row.id) === String(id))).filter(Boolean);
  }
  function resultId(value) {
    return String(value?.id || value?.item?.id || value || '').trim();
  }
  async function deleteSelected(button) {
    const rows = selectedRows();
    if (!rows.length || batchBusy || state.scope === 'trash') return;
    if (rows.length > MAX_BATCH_ITEMS) { notify('一次最多批量处理 ' + MAX_BATCH_ITEMS + ' 项资料，请减少选择后重试'); return; }
    const epoch = lifecycleEpoch, ids = rows.map(row => String(row.id));
    const names = rows.slice(0, 3).map(displayName).join('、') + (rows.length > 3 ? ' 等' : '');
    if (!await openConfirmDialog({ title: '批量移入回收站？', description: '选中的 {name} 将移入回收站，仍可恢复。', descriptionParams: { name: names }, confirm: '批量删除' })) return;
    batchBusy = true; button.disabled = true; closeMenus(); render();
    try {
      const result = await global.SoduWorkAPI.deleteLibraryItems(ids);
      if (epoch !== lifecycleEpoch) return;
      const succeeded = (result?.succeeded || []).map(resultId).filter(Boolean);
      const failed = Array.isArray(result?.failed) ? result.failed : [];
      succeeded.forEach(id => state.selected.delete(id));
      if (failed.length) notify('已删除 ' + succeeded.length + ' 项，' + failed.length + ' 项失败，请重试');
      else notify('已将 ' + succeeded.length + ' 项移入回收站');
      await load();
    } catch (error) { if (epoch === lifecycleEpoch) await dialogs.showError(error, '批量删除失败'); }
    finally { if (epoch === lifecycleEpoch) { batchBusy = false; render(); } }
  }
  async function migrateSelected(button) {
    const rows = selectedRows();
    if (!rows.length || batchBusy || state.scope === 'trash') return;
    if (rows.length > MAX_BATCH_ITEMS) { notify('一次最多批量处理 ' + MAX_BATCH_ITEMS + ' 项资料，请减少选择后重试'); return; }
    const copyRows = rows.filter(row => isClientLocal(row) && !row.extra?.soduworkDelivery);
    if (!copyRows.length) { notify('请选择可存储到远端的本机资料'); return; }
    const target = state.storageStatus.remote && state.storageStatus.remote.backend;
    if (state.storageStatusLoading || !target || !state.storageStatus.remote.available) { notify(storageMessage()); return; }
    const epoch = lifecycleEpoch, skipped = rows.filter(row => isClientLocal(row) && row.extra?.soduworkDelivery).length;
    const ids = rows.filter(row => !row.extra?.soduworkDelivery).map(row => String(row.id));
    if (!await openConfirmDialog({
      title: '批量存储到远端？',
      description: '将选中的本机资料保存到远端根目录，同时保留本机文件。',
      confirm: '批量存储到远端',
    })) return;
    if (epoch !== lifecycleEpoch || state.storageStatusLoading || !state.storageStatus.remote.available || state.storageStatus.remote.backend !== target) {
      notify('远程存储状态已变化，请重新选择后重试'); return;
    }
    batchBusy = true; button.disabled = true; closeMenus(); render();
    try {
      const result = await global.SoduWorkAPI.copyLocalLibraryItemsToRemote(ids, {
        storage: target,
        isCurrent: () => epoch === lifecycleEpoch && !state.storageStatusLoading && state.storageStatus.remote.available && state.storageStatus.remote.backend === target,
      });
      if (epoch !== lifecycleEpoch) return;
      const succeeded = (result?.succeeded || []).map(resultId).filter(Boolean);
      const failed = Array.isArray(result?.failed) ? result.failed : [];
      succeeded.forEach(id => state.selected.delete(id));
      const totalFailed = failed.length + skipped;
      if (totalFailed) notify('已存储 ' + succeeded.length + ' 项，' + totalFailed + ' 项未完成，请重试');
      else notify('已将 ' + succeeded.length + ' 项资料存储到远端');
      await load();
    } catch (error) {
      if (epoch !== lifecycleEpoch) return;
      if (error?.code === 'STALE_TASK_SCOPE') notify('账号或存储配置已变化，请重新选择后重试');
      else await dialogs.showError(error, '批量存储到远端失败');
    } finally { if (epoch === lifecycleEpoch) { batchBusy = false; render(); } }
  }
  async function shareSelected(button) {
    const rows = selectedRows();
    if (!rows.length || batchBusy || state.scope === 'trash') return;
    if (rows.length > MAX_BATCH_ITEMS) { notify('一次最多批量处理 ' + MAX_BATCH_ITEMS + ' 项资料，请减少选择后重试'); return; }
    const epoch = lifecycleEpoch, ids = rows.map(row => String(row.id));
    batchBusy = true; button.disabled = true; closeMenus(); render();
    try {
      const directory = await global.SoduWorkAPI.listLibraryShareMembers();
      if (epoch !== lifecycleEpoch) return;
      const meId = String(directory?.meId || '');
      const members = (Array.isArray(directory?.members) ? directory.members : [])
        .filter(member => member.id && !member.isMe && String(member.id) !== meId);
      if (!members.length) { notify('当前组织没有可分享的其他成员'); return; }
      const sent = await dialogs.openShareDialog({
        items: rows.map(row => ({ ...row, displayName: displayName(row), displaySize: formatSize(row.size) })),
        members, localCopy: rows.every(isClientLocal),
        onSubmit: async (recipientIds, note) => {
          const result = await global.SoduWorkAPI.shareLibraryItems(ids, recipientIds, note, { requestId: global.crypto.randomUUID() });
          const failed = Array.isArray(result?.failed) ? result.failed : [];
          if (failed.length) notify('已分享 ' + (result?.succeeded?.length || 0) + ' 项，' + failed.length + ' 项失败');
          else notify('已分享 ' + ids.length + ' 项，成员会收到通知');
          return true;
        },
      });
      if (epoch !== lifecycleEpoch || !sent) return;
    } catch (error) { if (epoch === lifecycleEpoch) notify(errorText(error, '批量分享失败，请重试')); }
    finally { if (epoch === lifecycleEpoch) { batchBusy = false; if (button.isConnected) button.disabled = false; render(); } }
  }
  async function discussSelected(button) {
    const rows = selectedRows();
    if (!rows.length || batchBusy || state.scope === 'trash') return;
    if (rows.length > 20) { notify('一次最多围绕 20 项资料开启对话'); return; }
    const totalSize = rows.reduce((sum, row) => sum + Math.max(0, Number(row.size) || 0), 0);
    if (totalSize > 256 * 1024 * 1024) { notify('选中资料总大小超过 256 MB，请减少选择后重试'); return; }
    const epoch = lifecycleEpoch;
    batchBusy = true; button.disabled = true; closeMenus(); render();
    try {
      const files = [];
      for (const item of rows) {
        const binary = await global.SoduWorkAPI.readLibraryBinary(item.id);
        if (epoch !== lifecycleEpoch) return;
        if (!binary?.blob) throw new Error('读取资料失败：' + displayName(item));
        files.push(new File([binary.blob], String(item.filename || binary.name || displayName(item)), {
          type: binary.type || item.contentType || 'application/octet-stream',
        }));
      }
      if (epoch !== lifecycleEpoch) return;
      const payload = { tab: 'chat', newSession: true, initialFiles: files };
      if (typeof global.WorkspaceHost?.open === 'function') await global.WorkspaceHost.open('create', payload);
      else if (typeof global.openComposePanel === 'function') global.openComposePanel(payload);
      else throw new Error('对话面板暂时不可用');
      state.selected.clear();
    } catch (error) { if (epoch === lifecycleEpoch) notify(errorText(error, '读取资料失败，请重试')); }
    finally { if (epoch === lifecycleEpoch) { batchBusy = false; if (button.isConnected) button.disabled = false; render(); } }
  }
  async function discussItem(button, id) {
    const item = state.items.find(row => row.id === id);
    if (!item || button.disabled) return;
    const epoch = lifecycleEpoch, name = displayName(item);
    button.disabled = true; closeMenus();
    try {
      const binary = await global.SoduWorkAPI.readLibraryBinary(id);
      if (epoch !== lifecycleEpoch) return;
      if (!binary?.blob) throw new Error('读取资料失败，请重试');
      const file = new File([binary.blob], String(item.filename || binary.name || name), { type: binary.type || item.contentType || 'application/octet-stream' });
      const payload = { tab: 'chat', newSession: true, initialFiles: [file],
        prefill: tx('请围绕资料《{name}》展开对话。', { name }),
        contextPrompts: [tx('用户从资料库选择了这份文件，请使用实际可读取的附件回答；如果附件不可读取，请明确说明。')] };
      if (typeof global.WorkspaceHost?.open === 'function') global.WorkspaceHost.open('create', payload);
      else if (typeof global.openComposePanel === 'function') global.openComposePanel(payload);
      else notify('对话面板暂时不可用');
    } catch (error) { if (epoch === lifecycleEpoch) notify(errorText(error, '读取资料失败，请重试')); }
    finally { if (button.isConnected) button.disabled = false; }
  }

  async function renameItem(button, id) {
    const item = state.items.find(row => row.id === id);
    if (!item) return;
    closeMenus();
    const current = displayName(item);
    const name = await openNameDialog({
      title: '重命名文件', description: '修改资料名称，文件内容不会改变。', label: '文件名称',
      value: current, placeholder: '输入文件名称', confirm: '保存', maxLength: 240,
    });
    if (!name || name === current) return;
    await runAction(button, () => global.SoduWorkAPI.updateLibraryItem(id, { title: name }), '重命名失败', '已重命名');
  }
  async function renameFolder(button, id) {
    const folder = state.folders.find(row => String(row.id) === String(id));
    if (!folder) return;
    const storage = storedBackend(folder), epoch = lifecycleEpoch;
    closeMenus();
    const current = String(folder.name || '');
    const name = await openNameDialog({
      title: '重命名文件夹', description: '修改文件夹名称，文件夹中的资料不会改变。', label: '文件夹名称',
      value: current, placeholder: '输入文件夹名称', confirm: '保存', maxLength: 160,
    });
    if (!name || name === current || epoch !== lifecycleEpoch) return;
    await runAction(button, () => global.SoduWorkAPI.updateLibraryFolder(id, { name, storage }), '文件夹重命名失败', '文件夹已重命名');
  }
  async function migrateItem(button, id) {
    const item = state.items.find(row => String(row.id) === String(id));
    const target = state.storageStatus.remote && state.storageStatus.remote.backend;
    if (!item || button.disabled || !isClientLocal(item)) return;
    if (!target || !state.storageStatus.remote.available) { notify(storageMessage()); return; }
    if (item.extra?.soduWorkDelivery) { notify('已保存的成果版本不能迁移'); return; }
    closeMenus();
    const name = displayName(item), epoch = lifecycleEpoch;
    if (!await openConfirmDialog({
      title: '存储到远程？',
      description: '将“{name}”保存到远程存储，同时保留这台电脑上的本地文件。',
      descriptionParams: { name }, confirm: '存储到远程',
    })) return;
    if (epoch !== lifecycleEpoch) return;
    if (state.storageStatusLoading || !state.storageStatus.remote.available || state.storageStatus.remote.backend !== target) {
      notify('远程存储状态已变化，请重新选择后重试'); return;
    }
    await runAction(button,
      () => global.SoduWorkAPI.copyLocalLibraryItemToRemote(id, target),
      '存储到远程失败', '已存储到远程');
  }
  async function listAllLibraryFolders(storage, epoch) {
    const folders = [];
    const queue = [{ id: '', path: [] }];
    const seen = new Set();
    // The folders tab is a tree view, so walk it instead of asking the API for
    // a flat collection.  This keeps the existing browsing contract intact
    // while allowing an item to be moved into a nested folder as well.
    while (queue.length && folders.length < 1000) {
      const current = queue.shift();
      const key = String(current.id || '');
      if (seen.has(key)) continue;
      seen.add(key);
      const result = await global.SoduWorkAPI.listLibrary({ scope: 'folders', storage, folderId: key });
      if (epoch !== lifecycleEpoch) return null;
      const rows = Array.isArray(result && result.folders) ? result.folders : [];
      rows.forEach(folder => {
        const id = String(folder && folder.id || '');
        if (!id || seen.has(id)) return;
        const path = current.path.concat(String(folder.name || ''));
        folders.push({ ...folder, id, path, displayName: path.filter(Boolean).join(' / ') });
        queue.push({ id, path });
      });
    }
    return folders;
  }

  async function moveItem(button, id) {
    const item = state.items.find(row => row.id === id);
    if (!item || button.disabled) return;
    const epoch = lifecycleEpoch, storage = storedBackend(item);
    button.disabled = true; closeMenus();
    try {
      const folders = await listAllLibraryFolders(storage, epoch);
      if (epoch !== lifecycleEpoch || !folders) return;
      const selected = await openMoveFolderDialog(folders);
      if (!selected || epoch !== lifecycleEpoch) return;
      if (selected.kind === 'folder') {
        const message = selected.folderId ? '已添加到文件夹' : '已移到根目录';
        await runAction(button, () => global.SoduWorkAPI.updateLibraryItem(id, { folderId: selected.folderId, storage }), '移动失败', message);
        return;
      }
      const title = await openFolderDialog();
      if (!title || epoch !== lifecycleEpoch) return;
      await runAction(button, async () => {
        const created = await global.SoduWorkAPI.createLibraryFolder(title, '', storage);
        if (epoch !== lifecycleEpoch) return;
        const folder = created && (created.folder || created.data && created.data.folder);
        if (!folder || !folder.id) throw new Error('新建文件夹失败');
        await global.SoduWorkAPI.updateLibraryItem(id, { folderId: folder.id, storage });
      }, '移动失败', '已新建文件夹并添加资料');
    } catch (error) { if (epoch === lifecycleEpoch) notify(errorText(error, '读取文件夹失败')); }
    finally { if (button.isConnected) button.disabled = false; }
  }

  let shareBusy = false;
  async function shareItem(button, id) {
    const item = state.items.find(row => String(row.id) === String(id));
    if (!item || button.disabled || shareBusy) return;
    const epoch = lifecycleEpoch;
    const localCopy = isClientLocal(item);
    shareBusy = true; button.disabled = true; closeMenus();
    try {
      const directory = await global.SoduWorkAPI.listLibraryShareMembers();
      if (epoch !== lifecycleEpoch) return;
      const meId = String(directory?.meId || '');
      const members = (Array.isArray(directory?.members) ? directory.members : [])
        .filter(member => member.id && !member.isMe && String(member.id) !== meId);
      if (!members.length) { notify('当前组织没有可分享的其他成员'); return; }
      const shareOptions = { requestId: global.crypto.randomUUID() };
      const sent = await dialogs.openShareDialog({ item, members, filename: displayName(item), size: formatSize(item.size), localCopy,
        onSubmit: async (ids, note) => {
          if (epoch !== lifecycleEpoch) return;
          return global.SoduWorkAPI.shareLibraryItem(id, ids, note, shareOptions);
        } });
      if (epoch === lifecycleEpoch && sent) notify('文件已分享，成员会收到通知');
    } catch (error) { if (epoch === lifecycleEpoch) notify(errorText(error, '分享失败，请重试')); }
    finally { if (epoch === lifecycleEpoch) shareBusy = false; if (button.isConnected) button.disabled = false; }
  }
  function openCreateConversation(kind) {
    const promptText = CREATE_PROMPTS[kind];
    if (!promptText) return;
    const labels = { image: '图像', document: '文档', spreadsheet: '电子表格', presentation: '演示文稿' };
    const payload = { tab: 'chat', newSession: true, prefill: tx(promptText),
      contextPrompts: [tx('用户从资料库点击了“{kind}”新建入口，请按用户需求完成创作，并提醒用户可将成果保存到资料库。', { kind: tx(labels[kind]) })] };
    if (global.WorkspaceHost && typeof global.WorkspaceHost.open === 'function') {
      global.WorkspaceHost.open('create', payload);
    } else if (typeof global.openComposePanel === 'function') {
      global.openComposePanel(payload);
    } else {
      notify('对话面板暂时不可用');
    }
  }




  async function uploadFiles(event) {
    if (isServerHistory()) { event.target.value = ''; notify('请返回远程根目录保存新资料'); return; }
    const target = uploadTarget || { folderId: state.folderId, storage: storedBackend(state.folder), epoch: lifecycleEpoch }; uploadTarget = null;
    const { folderId, storage, epoch } = target;
    if (epoch !== lifecycleEpoch || !storageAvailable()) { event.target.value = ''; notify(epoch !== lifecycleEpoch ? '存储配置已改变，请重新选择文件' : storageMessage()); return; }
    for (const file of [...(event.target.files || [])]) {
      if (epoch !== lifecycleEpoch) break;
      try { await global.SoduWorkAPI.uploadLibraryFile(file, folderId, storage); }
      catch (error) { if (epoch === lifecycleEpoch) await dialogs.showError(error, '上传失败'); }
    }
    event.target.value = ''; event.target.accept = ''; if (epoch === lifecycleEpoch) load();
  }
  async function createKind(kind) {
    if (isServerHistory()) { notify('请返回远程根目录保存新资料'); return; }
    if (!storageAvailable()) { notify(storageMessage()); return; }
    const folderId = state.folderId, storage = storedBackend(state.folder), epoch = lifecycleEpoch;
    try {
      if (kind === 'upload') { uploadTarget = { folderId, storage, epoch }; uploadInput.accept = ''; uploadInput.click(); return; }
      if (kind === 'folder') {
        const title = await openFolderDialog();
        if (!title || epoch !== lifecycleEpoch) return;
        await global.SoduWorkAPI.createLibraryFolder(title, folderId, storage);
      } else if (kind === 'note') {
        await openDocumentEditor('note', folderId, storage);
        return;
      } else if (kind === 'document') {
        await openDocumentEditor('document', folderId, storage);
        return;
      } else if (CREATE_PROMPTS[kind]) {
        openCreateConversation(kind);
        return;
      }
      if (epoch === lifecycleEpoch) { notify('已创建'); load(); }
    } catch (error) { if (epoch === lifecycleEpoch) await dialogs.showError(error, '创建失败'); }
  }
  function itemActions(item, sourceChip) {
    const id = esc(item.id);
    if (state.scope === 'trash') return '<div class="library-row-actions"><button data-library-restore="' + id + '">' + icon('restore') + '<span>恢复</span></button><button class="library-danger" data-library-purge="' + id + '">彻底删除</button></div>';
    const sessionAction = item.sessionId ? '<button data-library-open-session="' + esc(item.sessionId) + '">' + icon('chat') + '打开原会话</button>' : '';
    const nativeActions = isClientLocal(item) ?
      '<button data-library-open-system="' + id + '" data-filename="' + esc(item.filename || item.title) + '">' + icon('upload') + '用系统应用打开</button>' +
      '<button data-library-reveal="' + id + '">' + icon('folder') + '打开文件位置</button>' : '';
    const migrateAction = isClientLocal(item) && state.storageStatus.remote.available &&
      state.storageStatus.remote.backend && !item.extra?.soduWorkDelivery
      ? '<button data-library-migrate="' + id + '">' + icon('upload') + '存储到远程</button>' : '';
    return '<div class="library-menu-wrap library-card-actions">' + '<button class="library-icon-button" data-library-menu-toggle="item-' + id + '" aria-label="资料操作" aria-expanded="false">' + icon('more') + '</button><div class="library-menu library-item-menu" data-library-menu="item-' + id + '" hidden>' +
      '<button data-library-chat="' + id + '">' + icon('chat') + '围绕此内容展开对话</button>' +
      '<button data-library-favorite="' + id + '" data-value="' + !!item.favorite + '">' + icon('star') + (item.favorite ? '取消收藏' : '添加到收藏夹') + '</button>' +
      '<button data-library-share="' + id + '">' + icon('share') + '分享给成员</button>' +
      '<button data-library-download="' + id + '" data-filename="' + esc(item.filename || item.title) + '">' + icon('download') + '下载</button>' +
      nativeActions +
      migrateAction +
      sessionAction +
      '<button data-library-rename="' + id + '">' + icon('edit') + '重命名</button>' +
      (item.storageOrigin === 'server-history' ? '' : '<button data-library-move="' + id + '">' + icon('folder') + '添加到文件夹</button>') +
      '<button class="library-danger library-menu-separator" data-library-delete="' + id + '">' + icon('trash') + '删除</button></div></div>';
  }
  // Titles are kept separately from the stored filename so that renaming a
  // material does not have to alter its object key.  Cards should still show
  // the real file type, therefore append the filename extension when the
  // title does not already contain it.  The filename remains the fallback
  // for older rows that have no title.
  function displayName(item) {
    const title = String(item && (item.title || item.filename) || global.SoduWorkI18n?.translateText('未命名资料') || '未命名资料');
    const filename = String(item && item.filename || '');
    if (!filename || title === filename) return title;
    const match = filename.match(/(\.[^./\\]+)$/);
    if (!match) return title;
    const extension = match[1];
    return title.toLocaleLowerCase().endsWith(extension.toLocaleLowerCase()) ? title : title + extension;
  }
  function recentTime(row) {
    const value = row && (row.updatedAt || row.createdAt || row.deletedAt);
    const time = value ? Date.parse(value) : 0;
    return Number.isFinite(time) ? time : 0;
  }
  function recentFirst(rows) {
    return [...rows].sort((a, b) => recentTime(b) - recentTime(a));
  }
  function isImageItem(item) {
    return String(item && item.kind || '').toLowerCase() === 'image' || /^image\//i.test(String(item && item.contentType || ''));
  }

  async function imageUrlFor(item) {
    const id = String(item && item.id || '');
    if (!id) return '';
    if (imageUrls.has(id)) return imageUrls.get(id);
    if (imageLoads.has(id)) return imageLoads.get(id);
    const epoch = imageEpoch;
    const request = Promise.resolve().then(async () => {
      if (!global.SoduWorkAPI || typeof global.SoduWorkAPI.readLibraryBinary !== 'function') return '';
      const result = await global.SoduWorkAPI.readLibraryBinary(id);
      const blob = result && result.blob;
      if (!blob) return '';
      const url = URL.createObjectURL(blob);
      if (epoch !== imageEpoch) { try { URL.revokeObjectURL(url); } catch (_) {} return ''; }
      imageUrls.set(id, url);
      return url;
    }).catch(() => '').finally(() => imageLoads.delete(id));
    imageLoads.set(id, request);
    return request;
  }
  function hydrateImageThumbnails() {
    if (!root) return;
    root.querySelectorAll('[data-library-image]').forEach(node => {
      const id = node.dataset.libraryImage;
      const item = state.items.find(row => String(row.id) === String(id));
      if (!item) return;
      imageUrlFor(item).then(url => {
        if (url && node.isConnected) {
          const fallback = node.parentElement?.querySelector('[data-library-image-fallback]');
          node.onload = () => { node.hidden = false; if (fallback) fallback.hidden = true; };
          node.onerror = () => { node.hidden = true; if (fallback) fallback.hidden = false; };
          node.src = url;
        }
      });
    });
  }
  /*
   * Source chips and the original-conversation action share one session ID. Explain
   * inaccessible or missing conversations instead of failing silently.
   */
  async function openSourceConversation(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return;
    closeMenus();
    const epoch = lifecycleEpoch;
    try { await global.WorkspaceShell?.refreshConversationHistory?.(); }
    catch (_) { notify('来源会话不可用'); return; }
    if (epoch !== lifecycleEpoch) return;
    const escapeSelector = typeof global.CSS?.escape === 'function' ? global.CSS.escape : (value) => value.replace(/"/g, '\\"');
    const row = root.ownerDocument.querySelector('.ws-chat[data-chat-id="' + escapeSelector(id) + '"]');
    if (!row || !global.WorkspaceHost?.open) { notify('来源会话不可用'); return; }
    const title = row.querySelector('.ws-chat-title')?.textContent || '';
    global.WorkspaceHost.open('create', { tab: 'chat', chatId: id, chatTitle: title });
  }
  async function openWithSystemApp(id) {
    closeMenus();
    const item = state.items.find(row => row.id === id);
    if (!item) return;
    if (storedBackend(item) !== 'local') { notify('远程文件请下载后查看'); return; }
    if (!global.SoduWorkAPI?.openLibraryExternally) { notify('当前客户端不支持，请下载后使用'); return; }
    try { await global.SoduWorkAPI.openLibraryExternally(id); }
    catch (error) { notify(errorText(error, '打开失败，请下载后使用')); }
  }
  async function revealLibraryFile(id) {
    closeMenus();
    const item = state.items.find(row => row.id === id);
    if (!item) return;
    if (storedBackend(item) !== 'local') { notify('远程文件请下载后查看'); return; }
    if (!global.SoduWorkAPI?.revealLibraryItem) { notify('当前客户端不支持，请下载后使用'); return; }
    try { await global.SoduWorkAPI.revealLibraryItem(id); }
    catch (error) { notify(errorText(error, '打开文件位置失败')); }
 }
  function itemRow(item) {
    const trashed = state.scope === 'trash';
    const name = displayName(item);
    const image = isImageItem(item);
    const delivery = item.extra?.soduWorkDelivery;
    const sourceType = String(item.sourceType || '');
    const sessionId = String(item.sessionId || '');
    const conversationTitle = String(item.conversationTitle || '').trim();
    const conversation = sourceType === 'conversation' || sourceType === 'cloud_conversation';
    const cloud = sourceType === 'cloud_conversation';
    const sourceText = conversation && sessionId
      ? tx('来自会话：{title}', { title: conversationTitle || String(sessionId).slice(0, 12) })
      : tx('上传');
    const sourceChip = !trashed && conversation && sessionId
      ? '<button type="button" class="library-source-chip" data-library-open-session="' + esc(sessionId) + '" title="' + esc(conversationTitle || sessionId) + '">' + esc(sourceText) + '</button>'
      : '<span class="library-source-chip is-static">' + esc(sourceText) + '</span>';
    const deliveryLabel = '';
    const action = trashed ? ' disabled' : ' data-library-file-preview="' + esc(item.id) + '"';
    const iconKind = image ? 'image' : ['document', 'note'].includes(String(item.kind || '').toLowerCase()) ? 'document' : item.kind;
    const preview = (image && !trashed ? '<img class="library-card-image" data-library-image="' + esc(item.id) + '" alt="" hidden>' : '') + '<span class="library-file-glyph" data-library-image-fallback>' + global.SoduWorkLibraryFileIcons.markup(item) + '</span>';
    return '<article class="library-card library-file-card kind-' + esc(iconKind || 'document') + (hiddenItem(item) ? ' is-hidden-item' : '') + '"><label class="library-row-select"><input type="checkbox" data-library-select="' + esc(item.id) + '" data-user-attributes="aria-label" aria-label="' + esc(tx('选择资料：{name}', { name })) + '"' + (state.selected.has(item.id) ? ' checked' : '') + '></label><button class="library-card-main"' + action + '>' +
      '<span class="library-card-name"><span class="library-card-preview kind-' + esc(iconKind) + '">' + preview + '</span><span class="library-card-copy"><b data-user-content>' + esc(name) + '</b><small data-user-content>' + esc(formatSize(item.size) + deliveryLabel) + (item.favorite ? ' · ' + tx('已收藏') : '') + (hiddenItem(item) ? ' · ' + tx('已隐藏') : '') + '</small></span></span>' +
      '<span class="library-card-date">' + esc(formatDate(trashed ? item.deletedAt : item.updatedAt)) + '</span><span class="library-card-size">' + esc(formatSize(item.size)) + '</span><span class="library-card-grid-date">' + tx('已修改') + ' · ' + esc(formatGridDate(trashed ? item.deletedAt : item.updatedAt)) + '</span></button>' + '<div class="library-source-cell">' + sourceChip + '</div>' + itemActions(item) + '</article>';
  }
  function folderRow(folder) {
    const id = esc(folder.id);
    const canDelete = Number(folder.itemCount || 0) === 0 && Number(folder.childCount || 0) === 0;
    const deleteAction = canDelete
      ? '<button class="library-danger" data-library-delete-folder="' + id + '">' + icon('trash') + '删除空文件夹</button>'
      : '<button class="library-danger" type="button" disabled title="请先移除文件夹中的资料和子文件夹">' + icon('trash') + '仅空文件夹可删除</button>';
    return '<article class="library-card library-folder-card"><span class="library-row-select" aria-hidden="true"></span><button class="library-card-main" data-library-folder="' + id + '"><span class="library-card-name"><span class="library-card-preview">' + icon('folder') + '</span><span class="library-card-copy"><b data-user-content>' + esc(folder.name) + '</b><small>' + tx('文件夹') + (folder.favorite ? ' · ' + tx('已收藏') : '') + '</small></span></span><span class="library-card-date">' + esc(formatDate(folder.updatedAt)) + '</span><span class="library-card-size">—</span><span class="library-card-grid-date">' + tx('已修改') + ' · ' + esc(formatGridDate(folder.updatedAt)) + '</span></button>' + (folder.storageOrigin === 'server-history' ? '' : '<div class="library-menu-wrap library-card-actions"><button class="library-icon-button" data-library-menu-toggle="folder-' + id + '" aria-label="文件夹操作" aria-expanded="false">' + icon('more') + '</button><div class="library-menu library-item-menu" data-library-menu="folder-' + id + '" hidden><button data-library-favorite-folder="' + id + '" data-value="' + !!folder.favorite + '">' + icon('star') + (folder.favorite ? '取消收藏' : '添加到收藏夹') + '</button><button data-library-rename-folder="' + id + '">' + icon('edit') + '重命名</button>' + deleteAction + '</div></div>') + '</article>';
  }
  function emptyMarkup() {
    if (state.busy) return '<span class="library-spinner" aria-hidden="true"></span><b>正在加载资料库</b>';
    if (state.error) return icon('error') + '<b>资料库加载失败</b><span>' + esc(state.error) + '</span><button data-library-retry>重试</button>';
    if (state.query || state.filterKind !== 'all') return icon('search') + '<b>没有找到相关资料</b><span>试试其他关键词或文件类型。</span>';
    if (state.scope === 'trash') return icon('trash') + '<b>回收站是空的</b><span>删除的资料会显示在这里，你可以恢复或彻底删除。</span>';
    if (isServerHistory()) return icon('folder') + '<b>没有找到历史资料</b><span>新资料请保存在远程存储根目录。</span>';
    if (state.scope === 'folders') return icon('folder') + '<b>创建你的第一个文件夹</b><span>创建文件夹来整理资料库中的项目。</span><button data-library-create-kind="folder">创建文件夹</button>';
    if (state.scope === 'favorites') return '<b>暂无收藏</b>';
    // Folders browse and manage existing materials; creation remains at the library root
    // rather than exposing misleading restricted actions inside subfolders.
    if (state.folderId) return icon('folder') + '<b>文件夹为空</b><span>返回资料库根目录后可新建内容，再移动到其他文件夹。</span>';
    if (state.scope === 'images') return icon('image') + '<b>创建你的第一张图像</b><span>你使用 SoduWork 创建的图像会显示在这里。</span><button data-library-create-kind="image">创建图像</button>';
    return icon('images') + '<b>创建新内容</b><span>你使用 SoduWork 创建的内容（如图像和文档）会显示在这里。</span><span class="library-menu-wrap library-state-create-wrap"><button data-library-menu-toggle="empty-create" aria-expanded="false">开始创建 ' + icon('chevron') + '</button>' + createMenuMarkup('empty-create') + '</span>';
  }
  function updateCreateAvailability() {
    if (!root) return;
    const disabled = !!state.busy || !storageAvailable() || isServerHistory();
    const createButton = root.querySelector('[data-library-menu-toggle="create"]');
    if (createButton) {
      createButton.disabled = disabled;
      createButton.setAttribute('aria-disabled', String(disabled));
      createButton.removeAttribute('title');
    }
    const emptyCreateButton = root.querySelector('[data-library-menu-toggle="empty-create"]');
    if (emptyCreateButton) {
      emptyCreateButton.disabled = disabled;
      emptyCreateButton.setAttribute('aria-disabled', String(disabled));
      emptyCreateButton.removeAttribute('title');
    }
    root.querySelectorAll('.library-create-menu button[data-library-create-kind]').forEach(button => {
      button.disabled = disabled;
      button.setAttribute('aria-disabled', String(disabled));
      button.removeAttribute('title');
    });
  }
  function render() {
    if (!root) return;
    const trash = state.scope === 'trash'; root.classList.toggle('is-trash', trash);
    root.querySelector('[data-library-title]').textContent = trash ? (isServerHistory() ? '历史服务器资料回收站' : '回收站') : '资料库';
    root.querySelector('.library-tabs').hidden = trash;
    root.querySelector('.library-storage-tabs').hidden = trash;
    root.querySelector('.library-trash-nav').hidden = !trash;
    // Keep the toolbar create entry available inside folders. Only the empty
    // state's center CTA is suppressed for folder views.
    root.querySelector('.library-create-wrap').hidden = trash;
    updateCreateAvailability();
    root.querySelector('[data-library-empty-trash]').disabled = state.trashCount < 1 || state.busy;
    root.querySelector('[data-library-date-heading]').textContent = trash ? '删除日期' : '修改日期';
    root.querySelectorAll('[data-library-scope]').forEach(button => { const selected = button.dataset.libraryScope === state.scope; button.classList.toggle('active', selected); button.setAttribute('aria-selected', String(selected)); });
    root.querySelectorAll('[data-library-storage]').forEach(button => {
      const key = button.dataset.libraryStorage;
      const selected = key === 'remote' ? state.storage !== 'local' : state.storage === 'local';
      const capability = state.storageStatus[key] || {};
      const available = key === 'local' || (!!capability.available && !state.storageStatusLoading);
      button.classList.toggle('active', selected);
      button.classList.toggle('is-unavailable', !available);
      button.disabled = !available;
      button.setAttribute('aria-selected', String(selected));
      button.setAttribute('aria-disabled', String(!available));
      button.title = key === 'local' ? '' : (available && capability.connected ? '远程存储已连接' : capability.message || '远程存储未配置') + (providerLabel(capability.backend) ? ' · ' + providerLabel(capability.backend) : '');
    });
    const remoteDot = root.querySelector('[data-library-storage-status="remote"]');
    if (remoteDot) {
      const capability = state.storageStatus.remote || {};
      remoteDot.classList.toggle('is-connected', !!capability.available && !!capability.connected);
      remoteDot.classList.toggle('is-unavailable', !capability.available);
      remoteDot.title = root.querySelector('[data-library-storage="remote"]').title;
    }
    root.querySelectorAll('[data-library-view]').forEach(button => { const selected = button.dataset.libraryView === state.view; button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); });
    root.querySelectorAll('[data-library-filter-kind]').forEach(button => button.classList.toggle('active', button.dataset.libraryFilterKind === state.filterKind));
    root.querySelector('[data-library-menu-toggle="filter"]').classList.toggle('active', state.filterKind !== 'all');
    const breadcrumb = root.querySelector('[data-library-breadcrumb]');
    breadcrumb.hidden = !state.folder || trash;
    breadcrumb.innerHTML = state.folder ? '<button data-library-root>资料库</button><span>/</span><b data-user-content>' + esc(state.folder.name) + '</b>' : '';
    const query = state.query.toLocaleLowerCase();
    const showFolders = !trash && ['all', 'folder'].includes(state.filterKind) && ['all', 'folders', 'favorites'].includes(state.scope);
    const folders = showFolders ? recentFirst(state.folders.filter(folder => (!query || folder.name.toLocaleLowerCase().includes(query)) && (state.showHidden || !folder.name.startsWith('.')))) : [];
    const items = state.scope === 'folders' || state.filterKind === 'folder' ? [] : recentFirst(state.items.filter(item => {
      if (state.scope === 'images' && !isImageItem(item)) return false;
      if (state.scope === 'favorites' && !item.favorite) return false;
      const kind = String(item.kind || '').toLowerCase();
      const matchesKind = state.filterKind === 'all'
        || (state.filterKind === 'document' && ['document', 'note'].includes(kind))
        || (state.filterKind === 'image' && isImageItem(item))
        || kind === state.filterKind;
      return matchesKind && (trash || state.showHidden || !hiddenItem(item));
    }));
    const visibleIds = items.map(item => item.id);
    if (!state.busy && previewPane?.selectedId() && !visibleIds.includes(previewPane.selectedId())) previewPane.close();
    state.selected.forEach(id => { if (!visibleIds.includes(id)) state.selected.delete(id); });
    const content = root.querySelector('[data-library-content]');
    content.className = 'library-content is-' + state.view;
    const rows = folders.map(folderRow).concat(items.map(itemRow));
    const unavailable = state.busy || (!!state.error && !hasCurrentSnapshot());
    content.hidden = unavailable || !rows.length;
    const markup = unavailable ? '' : rows.join('');
    if (markup !== contentMarkup) { content.innerHTML = markup; contentMarkup = markup; }
    root.querySelector('[data-library-list-head]').hidden = state.view !== 'list' || unavailable || !rows.length;
    const batchToolbar = root.querySelector('[data-library-batch-toolbar]');
    if (batchToolbar) {
      const selectedCount = state.scope === 'trash' ? 0 : visibleIds.filter(id => state.selected.has(id)).length;
      batchToolbar.hidden = selectedCount < 1 || unavailable || state.scope === 'trash';
      const count = batchToolbar.querySelector('[data-library-batch-count]');
      if (count) count.textContent = '已选择 ' + selectedCount + ' 项';
      const migrateButton = batchToolbar.querySelector('[data-library-batch-migrate]');
      if (migrateButton) {
        const hasLocalSelection = items.some(item => state.selected.has(item.id) && isClientLocal(item) && !item.extra?.soduworkDelivery);
        const remoteReady = !state.storageStatusLoading && state.storageStatus.remote.available && !!state.storageStatus.remote.backend;
        migrateButton.hidden = !hasLocalSelection || !remoteReady || state.scope === 'trash';
      }
      batchToolbar.querySelectorAll('button').forEach(button => { button.disabled = batchBusy || state.busy; });
    }
    const selectAll = root.querySelector('[data-library-select-all]');
    if (selectAll) {
      const selectedCount = visibleIds.filter(id => state.selected.has(id)).length;
      selectAll.disabled = !visibleIds.length || unavailable;
      selectAll.checked = visibleIds.length > 0 && selectedCount === visibleIds.length;
      selectAll.indeterminate = selectedCount > 0 && selectedCount < visibleIds.length;
    }
    const empty = root.querySelector('[data-library-state]'); empty.hidden = !state.error && !unavailable && !!rows.length; empty.innerHTML = emptyMarkup();
    // emptyMarkup() recreates the center action each render, so apply the
    // current loading state after inserting that markup as well.
    updateCreateAvailability();
    global.SoduWorkLibraryFileIcons.hydrate(root);
    hydrateImageThumbnails(); previewPane?.refreshSelection();
  }
  async function loadStorageStatus() {
    const request = ++storageStatusRequest;
    state.storageStatusLoading = true;
    render();
    try {
      const result = await global.SoduWorkAPI.getLibraryStorageStatus();
      if (request !== storageStatusRequest) return;
      const reported = result && (result.storage || result) || {};
      const local = reported.local || {};
      // Older Hubs expose only MinIO. New Hubs own the ordered-provider choice;
      // never fall through to a healthy second provider when the first is down.
      const remote = reported.remote || result?.remote || { ...reported.minio, backend: reported.minio?.configured || reported.minio?.available ? 'minio' : '' };
      const backend = ['minio', 'nfs'].includes(remote.backend) ? remote.backend : '';
      state.storageStatus = {
        local: { available: local.available !== false, configured: local.configured !== false, connected: local.connected !== undefined ? !!local.connected : local.available !== false, message: local.message || '' },
        remote: { ...remote, backend, available: !!backend && !!remote.available, configured: !!remote.configured, connected: remote.connected !== undefined ? !!remote.connected : !!remote.available, message: remote.message || '' },
      };
      if (state.storage !== 'local' && backend && state.storage !== backend) {
        lifecycleEpoch++; requestId++; shareBusy = false; batchBusy = false; dialogs.close(); previewPane?.close();
        state.storage = backend; state.folderId = ''; state.folder = null; state.selected.clear();
        state.items = []; state.folders = [];
      }
    } catch (error) {
      if (request !== storageStatusRequest) return;
      state.storageStatus.remote = { ...state.storageStatus.remote, available: false, connected: false,
        message: errorText(error, '无法读取远程存储状态，请重试') };
    } finally {
      if (request === storageStatusRequest) { state.storageStatusLoading = false; if (state.storage !== 'local') load(); else render(); }
    }
  }
  async function load() {
    ensureRoot(); clearTimeout(searchTimer); const request = ++requestId;
    if (state.storage !== 'local' && state.storageStatusLoading) { state.busy = !hasCurrentSnapshot(); state.error = ''; render(); return; }
    if (!storageAvailable()) {
      state.busy = false; state.error = storageMessage();
      if (!hasCurrentSnapshot()) { state.folders = []; state.items = []; previewPane?.close(); }
      render(); return;
    }
    const filters = { scope: state.scope, storage: storedBackend(state.folder), query: state.query, folderId: state.folderId };
    const key = filterKey();
    state.busy = !hasCurrentSnapshot(); state.error = ''; closeMenus(); render();
    try {
      const result = await global.SoduWorkAPI.listLibrary(filters);
      if (request !== requestId) return;
      state.folders = filters.scope === 'trash' ? [] : (result && result.folders || []);
      state.items = result && result.items || []; state.folder = result && result.folder || null;
      state.trashCount = Number(result && result.trashCount || 0);
      loadedFilterKey = key;
    } catch (error) {
      if (request !== requestId) return;
      state.error = isStorageError(error)
        ? errorText(error, '请配置资料库存储环境')
        : Number(error && error.status) === 404
        ? '当前 Hub 尚未部署资料库接口（HTTP 404），请部署资料库后端后重试。'
        : errorText(error, '暂时无法连接资料库，请稍后重试。');
      if (!hasCurrentSnapshot() || [401, 403].includes(Number(error && error.status))) {
        loadedFilterKey = ''; state.folders = []; state.items = [];
      }
    } finally { if (request === requestId) { state.busy = false; render(); } }
  }
  function openLibraryPanel() { ensureRoot().classList.add('show'); loadStorageStatus(); load(); }
  function closeLibraryPanel() {
    requestId++; storageStatusRequest++; lifecycleEpoch++; uploadTarget = null; clearTimeout(searchTimer);
    shareBusy = false;
    batchBusy = false;
    dialogs.close(); previewPane?.close();
    imageEpoch += 1; imageLoads.clear(); imageUrls.forEach(url => { try { URL.revokeObjectURL(url); } catch (_) {} }); imageUrls.clear();
    if (root) { closeMenus(); root.classList.remove('show'); }
  }
  global.addEventListener('soduwork-library-changed', () => { if (root?.matches('.show,.workspace-hosted')) load(); });
  global.addEventListener('soduwork-locale-change', () => { if (root) render(); });
  global.addEventListener('soduwork-data-scope-changed', () => {
    const visible = root?.matches('.show,.workspace-hosted');
    closeLibraryPanel();
    loadedFilterKey = '';
    Object.assign(state, { scope: 'recommended', storage: 'local', query: '', folderId: '', folder: null, folders: [], items: [], trashCount: 0, error: '', busy: false,
      storageStatus: { local: { available: true }, remote: { backend: '', available: false } } });
    state.selected.clear();
    if (root) { root.querySelector('[data-library-search]').value = ''; render(); }
    if (visible) openLibraryPanel();
  });
  global.openLibraryPanel = openLibraryPanel;
  global.closeLibraryPanel = closeLibraryPanel;
})(window);
