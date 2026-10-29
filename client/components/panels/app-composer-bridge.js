/* The application sidebar owns its conversation and draft; the main window receives only history-refresh and management-navigation intents. */
(function (global) {
  'use strict';
  const api = global.soduWorkAPI || global.SoduWorkAPI;
  if (!api || !api.workPreview) return;

  /* Refresh sidebar history after a send receipt; Hub events and polling maintain the current message stream. */
  api.workPreview.onComposerRefresh(() => {
    try {
      if (global.NativeChat && typeof NativeChat.refreshHistory === 'function') NativeChat.refreshHistory();
    } catch (_) {}
  });

  /* Route application settings to the main window's application-management page. */
  if (typeof api.workPreview.onAppsManage === 'function') {
    api.workPreview.onAppsManage(() => {
      try {
        if (global.WorkspaceHost && typeof global.WorkspaceHost.open === 'function') global.WorkspaceHost.open('apps');
      } catch (_) {}
    });
  }
})(window);
