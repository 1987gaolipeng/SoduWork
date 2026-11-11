/* Reuse add-menu icons for message plugin badges; do not add image or catalog data to model input. */
(function (global) {
  'use strict';
  function create(ctx, refresh) {
    let owner = '', generation = 0, catalog = new Map(), applications = new Map();
    const scope = () => JSON.stringify([ctx._ref || '', global.SoduWorkAPI?.taskStorageKey?.('plugins') || '']);
    function reset() { generation++; owner = ''; catalog = new Map(); applications = new Map(); }
    function html(items) {
      const rows = (items || []).filter(Boolean);
      if (!rows.length) return '';
      const currentScope = scope();
      if (owner !== currentScope) {
        reset(); owner = currentScope;
        const token = generation;
        // Catalog metadata is presentation-only; preserve historical names, versions, and per-turn authorization. Use a readable fallback icon on failure.
        if (global.SoduWorkAPI?.pluginCatalog) Promise.resolve().then(() => global.SoduWorkAPI.pluginCatalog())
          .then(result => {
            if (generation !== token || scope() !== currentScope) return;
            const normalize = global.ChatPluginMention?.normalizeCatalog || global.ChatPluginMentionModel?.normalizeCatalog;
            const items = normalize ? normalize(result) : result?.items || [];
            catalog = new Map(items.filter(item => item?.pluginId).map(item => [item.pluginId, item]));
            applications = new Map((result?.items || []).filter(item => item?.pluginId).map(item => [item.pluginId, item]));
            refresh();
          }).catch(() => {});
      }
      return rows.map(item => {
        const title = [item.name || item.key || 'Plugin', item.scopeLabel, item.version ? 'v' + item.version : ''].filter(Boolean).join(' · ');
        const icon = global.SoduWorkPluginIcon?.markup(catalog.get(item.pluginId) || item) || '';
        return '<span class="nmessage-plugin" title="' + ctx.esc(title) + '">' +
          '<i class="wc-plugin-icon" aria-hidden="true">' + icon + '</i>' +
          '<span class="nmessage-plugin-label">' + ctx.esc(item.name || item.key || 'Plugin') + '</span></span>';
      }).join('');
    }
    function cards(items) {
      const rows = (items || []).map(item => typeof item === 'string' ? { pluginId: item } : item).filter(Boolean);
      html(rows); // Share the same account-scoped presentation catalog as badges.
      // Only the native app sidebar suppresses its own app; chat selections and
      // project grouping do not describe the surface currently hosting the chat.
      const hostAppId = global.__deskPanel === 'chatbar' ? global.SoduWorkAppConversations?.applicationId?.() : '';
      return rows.map(item => {
        if (hostAppId && item.pluginId === hostAppId) return '';
        const app = applications.get(item.pluginId);
        if (!app?.ui?.contributions?.some(row => row.slot === 'workspace.navigation')) return '';
        return global.SoduWorkApps?.conversationCardHtml(app) || '';
      }).join('');
    }
    return { html, cards, reset };
  }
  global.ChatMessagePlugins = { create };
})(window);
