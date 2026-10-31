/* Search projections reuse the existing authenticated business facades. */
(function (global) {
  'use strict';
  const categoryLabels = { chats: '会话', projects: '项目', tasks: '需求', library: '资料库', apps: '即用', plugins: '插件', schedules: '自动化', actions: '快捷操作' };
  const scope = () => String(global.SoduWorkAPI?.taskStorageKey?.('ops') || '');
  const t = value => global.SoduWorkI18n?.translateText(value) || value;
  const row = (type, value, options = {}) => ({ type, id: String(value.id || value.pluginId || value.name || ''),
    title: String(value.title || value.name || value.filename || ''), text: String(value.description || value.summary || value.note || value.content || ''),
    at: value.updatedAt || value.updated_at || value.at || value.createdAt || '', ...options });
  const actionIds = new Set(['new-chat', 'new-requirement', 'open-library', 'open-task-pool', 'open-plugins', 'open-schedules', 'open-settings', 'open-shortcuts']);
  function actions() {
    const rows = global.ShortcutSettings?.getRows?.() || global.ShortcutBindings?.DEFAULT_SHORTCUTS || [];
    return rows.filter(item => actionIds.has(item.id)).map(item => row('actions', item, {
      title: t(item.title), text: t(item.description || ''), order: [...actionIds].indexOf(item.id), shortcut: global.ShortcutBindings?.displayCombo?.(item.binding) || item.binding || '',
    }));
  }
  const contentKey = (storage, item) => ['content', storage, item.id, item.updatedAt || item.updated_at || '', item.size || 0].join(':');
  function libraryRows(cache, storage, query, items) {
    return items.map(item => {
      const metadata = [item.note, item.description, item.extra?.previewText, item.filename].filter(Boolean).join(' ');
      const content = cache.peek(contentKey(storage, item))?.content;
      const full = content == null ? metadata : metadata + ' ' + content;
      const result = row('library', item, { storage, source: t(storage === 'local' ? '本地资料库' : '远程资料库'), text: metadata });
      if (query && content != null && global.SoduWorkSearchCore.match({ ...result, text: full }, query) >= 0) {
        result.text = global.SoduWorkSearchCore.snippet(full, query, 360); result.serverMatched = true;
      }
      return result;
    });
  }
  async function library(cache, storage, query, current = () => true, progress = () => {}) {
    const api = global.SoduWorkAPI, owner = scope();
    // The recommended scope spans folders; the all scope is folder-local.
    const result = await cache.load('library:' + storage, () => api.listLibrary({ scope: 'recommended', storage, query: '' }));
    if (owner !== scope()) throw Error('STALE_SEARCH_SCOPE');
    const initial = result.items || [];
    const word = global.SoduWorkSearchCore.tokens(query)[0] || '';
    const matched = query && storage !== 'local' && initial.length >= 500
      ? (await cache.load('library-match:' + storage + ':' + word, () => api.listLibrary({ scope: 'recommended', storage, query: word }))).items || [] : [];
    if (owner !== scope()) throw Error('STALE_SEARCH_SCOPE');
    const items = [...new Map([...initial, ...matched].filter(item => !item.isDeleted && !item.deletedAt).map(item => [item.id, item])).values()];
    const rows = libraryRows(cache, storage, query, items);
    progress({ rows });
    let partial = storage !== 'local' && (initial.length >= 500 || matched.length >= 500), cursor = 0;
    if (query) await Promise.all([0, 1, 2].map(async () => {
      while (cursor < items.length) {
        if (!current()) return;
        const index = cursor++, item = items[index];
        if (global.SoduWorkSearchCore.match(rows[index], query) >= 0) continue;
        if (!/^text\//i.test(item.contentType || '') && !/\.(txt|md|markdown|csv)$/i.test(item.filename || '')) continue;
        if (index >= 200 || Number(item.size) > 512 * 1024) { partial = true; continue; }
        if (owner !== scope()) throw Error('STALE_SEARCH_SCOPE');
        try {
          const content = await cache.load(contentKey(storage, item), () => api.readLibraryContent(item.id, { preview: true }));
          if (owner !== scope()) throw Error('STALE_SEARCH_SCOPE');
          const text = String(content.content || '').slice(0, 512 * 1024);
          const full = rows[index].text + ' ' + text;
          if (global.SoduWorkSearchCore.match({ ...rows[index], text: full }, query) >= 0) {
            rows[index].text = global.SoduWorkSearchCore.snippet(full, query, 360); rows[index].serverMatched = true;
            progress({ rows });
          }
          if (content.preview?.truncated) partial = true;
        } catch (_) { if (owner !== scope()) throw Error('STALE_SEARCH_SCOPE'); partial = true; }
      }
    }));
    return { rows, partial };
  }
  function createSources() {
    const api = global.SoduWorkAPI, native = global.soduWorkAPI?.conversationSession;
    const core = global.SoduWorkSearchCore, cache = core.createCache({ scope });
    const sources = [{ id: 'actions', categories: ['actions'], peek: () => ({ rows: actions() }), load: async () => ({ rows: actions() }) }];
    const chatRows = (items, query) => items.map(item => row('chats', item, {
        text: String(item.text || item.summary || ''), messageIndex: item.messageIndex, searchQuery: query, serverMatched: item.serverMatched === true,
        source: global.WorkspaceShell?.projectForChat?.(item.id)?.name || t('会话'),
      }));
    const historyRows = () => {
      const cached = cache.peek('chats');
      return [...new Map([...(cached?.items || cached?.chats || []), ...(global.WorkspaceShell?.searchChats?.() || [])].map(item => [item.id, item])).values()];
    };
    if (native?.history) sources.push({ id: 'chats', categories: ['chats'], peek: query => ({ rows: chatRows(historyRows(), query) }), load: async (query, current = () => true, progress = () => {}) => {
      let metadata = chatRows(historyRows(), query), body = [], partial = false, successful = false;
      const publish = () => { if (current()) progress({ rows: [...new Map([...metadata, ...body].map(item => [item.id, item])).values()] }); };
      publish();
      await Promise.all([
        cache.load('chats', async () => {
          const result = await (native.searchHistory ? native.searchHistory() : native.history());
          if (result?.ok === false) throw Error('SEARCH_HISTORY_UNAVAILABLE');
          return result;
        }).then(result => {
          successful = true; metadata = chatRows(result.items || result.chats || [], query);
          partial ||= result.nextOffset != null || result.partial === true || (!!query && (result.items || result.chats || []).some(item => item.cloud || (item.adapterId && item.adapterId !== 'pi'))); publish();
        }).catch(() => { partial = true; }),
        query && native.search ? native.search(query).then(result => {
          if (result?.ok === false) throw Error('SEARCH_HISTORY_UNAVAILABLE');
          successful = true; body = chatRows(result.chats || [], query); partial ||= !!result.partial; publish();
        }).catch(() => { partial = true; }) : Promise.resolve(),
      ]);
      if (!successful && !metadata.length) throw Error('SEARCH_HISTORY_UNAVAILABLE');
      return { rows: [...new Map([...metadata, ...body].map(item => [item.id, item])).values()], partial };
    } });
    const projectRows = () => ({ rows: global.WorkspaceShell.searchProjects().map(item => row('projects', item, { title: item.name, text: (item.folders || []).join(' '), source: t('项目') })) });
    if (global.WorkspaceShell?.searchProjects) sources.push({ id: 'projects', categories: ['projects'], peek: projectRows, load: async () => projectRows() });
    function metadataSource(id, categories, loader, project) {
      return { id, categories, peek: () => project(cache.peek(id)), load: async () => project(await cache.load(id, loader)) };
    }
    if (api?.getTasksSnapshot) sources.push(metadataSource('tasks', ['tasks'], async () => {
      const result = await api.getTasksSnapshot();
      if (!result.online || result.stale) throw Error('SEARCH_TASKS_UNAVAILABLE');
      return result;
    }, result => ({ rows: (result?.items || []).map(item => row('tasks', item, { source: item.projectName || t('需求') })) })));
    const libraryPeek = (storage, query) => ({ rows: libraryRows(cache, storage, query, (cache.peek('library:' + storage)?.items || []).filter(item => !item.isDeleted && !item.deletedAt)) });
    if (api?.listLibrary) {
      sources.push({ id: 'library-local', categories: ['library'], peek: query => libraryPeek('local', query), load: async (query, current, progress) => {
        return library(cache, 'local', query, current, progress);
      } });
      sources.push({ id: 'library-remote', categories: ['library'], peek: query => libraryPeek(cache.peek('storage')?.storage?.remote?.backend, query), load: async (query, current, progress) => {
        const status = await cache.load('storage', () => api.getLibraryStorageStatus());
        const remote = status.storage?.remote || status.remote;
        if (remote?.state === 'unavailable') throw Error('SEARCH_REMOTE_LIBRARY_UNAVAILABLE');
        if (!remote?.configured && !remote?.available) return { rows: [] };
        if (!remote.available) throw Error('SEARCH_REMOTE_LIBRARY_UNAVAILABLE');
        const storage = remote.backend;
        if (!['nfs', 'minio'].includes(storage)) return { rows: [] };
        return library(cache, storage, query, current, progress);
      } });
    }
    if (api?.pluginCatalog) sources.push(metadataSource('catalog', ['apps', 'plugins'], () => api.pluginCatalog(), result => {
      const rows = [];
      for (const item of result?.items || []) {
        if (item.enabled === false || (!item.personal && item.permissions?.canUse === false)) continue;
        const isApp = global.SoduWorkPluginPresentation?.isWorkspaceApp(item) || item.ui?.contributions?.some(contribution => contribution.slot === 'workspace.navigation');
        if (!isApp) rows.push(row('plugins', item, { source: t('插件') }));
        if ((item.personal || item.installed) && item.ui?.contributions?.some(contribution => contribution.slot === 'workspace.navigation')) {
          rows.push(row('apps', item, { source: t('即用') }));
        }
      }
      return { rows, partial: !!result?.remoteError };
    }));
    if (api?.capabilityCatalog) sources.push(metadataSource('skills', ['plugins'], () => api.capabilityCatalog(), result => ({
      rows: (result?.skills || []).map(item => row('plugins', item, { kind: 'skill', source: t('技能') })),
    })));
    if (api?.myMcpServers) sources.push(metadataSource('connectors', ['plugins'], () => api.myMcpServers(), result => ({
      rows: [...(result?.company || []), ...(result?.personal || [])].map(item => row('plugins', item, { kind: 'connector', source: t('连接器') })),
    })));
    if (api?.listSchedules) sources.push(metadataSource('schedules', ['schedules'], () => api.listSchedules(), result => ({
      rows: (result || []).map(item => row('schedules', item, { text: item.description || item.prompt || '', source: t('自动化') })),
    })));
    sources.forEach(source => { source.invalidate = () => cache.clear(); });
    return sources;
  }
  async function open(result) {
    const owner = scope(), route = (...args) => global.WorkspaceHost.open(...args);
    if (result.type === 'chats') {
      await route('create', { tab: 'chat', chatId: result.id, chatTitle: result.title });
      if (Number.isSafeInteger(result.messageIndex) && owner === scope()) {
        await global.NativeChat?.revealSearchMatch?.(result.searchQuery,
          () => owner === scope() && global.WorkspaceShell?.activeChatId === result.id);
      }
    } else if (result.type === 'projects') global.WorkspaceShell.openSearchProject(result.id);
    else if (result.type === 'tasks') await route('history', { requirementId: result.id });
    else if (result.type === 'library') await route('library', { itemId: result.id, storage: result.storage, query: result.title });
    else if (result.type === 'apps') await global.SoduWorkApps.openById(result.id);
    else if (result.type === 'plugins') {
      route('skills');
      if (result.kind) await global.openCapabilitySearchResult(result.kind, result.id, result.title);
      else await global.openCapabilityPlugin(result.id);
    } else if (result.type === 'schedules') await route('schedules', { scheduleId: result.id });
    else if (result.type === 'actions' && actionIds.has(result.id)) {
      if (global.ShortcutSettings?.execute) global.ShortcutSettings.execute(result.id);
    }
  }
  global.SoduWorkSearchSources = { createSources, open, scope, categoryLabels };
})(window);
