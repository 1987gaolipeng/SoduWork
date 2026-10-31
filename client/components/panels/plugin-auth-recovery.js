/* Build a safe handoff when a selected plugin needs a capability absent from this session. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatPluginAuthRecovery = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const MAX_ITEMS = 20;
  const MAX_PLUGINS = 3;
  const RUNTIME = new Set(['files', 'terminal', 'repository', 'browser', 'office', 'computer']);

  function values(value, limit = MAX_ITEMS) {
    return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim())
      .filter(Boolean).map((item) => item.slice(0, 80)))].slice(0, limit);
  }

  function capabilityIds(value) {
    return values((Array.isArray(value) ? value : []).map((item) =>
      item && typeof item === 'object' ? item.id || item.name : item));
  }

  function authorization(value) {
    const source = value && typeof value === 'object' ? value : {};
    const result = {};
    for (const key of ['missing', 'missingMcp', 'readOnlyConflicts', 'unsupported', 'required']) {
      const items = values(source[key]);
      if (items.length) result[key] = items;
    }
    return result;
  }

  function plugins(value) {
    return (Array.isArray(value) ? value : []).slice(0, MAX_PLUGINS).map((item) => {
      const row = item && typeof item === 'object' ? item : {};
      const result = { pluginId: String(row.pluginId || '').trim() };
      for (const key of ['name', 'version', 'key', 'qualifiedKey', 'scopeLabel']) {
        if (typeof row[key] === 'string' && row[key].trim()) result[key] = row[key].trim().slice(0, 160);
      }
      if (row.inputValues && typeof row.inputValues === 'object') {
        result.inputValues = Object.fromEntries(Object.entries(row.inputValues).slice(0, 40)
          .filter(([, item]) => typeof item === 'string' || typeof item === 'boolean' ||
            typeof item === 'number' && Number.isFinite(item)));
      }
      return result;
    }).filter((item) => item.pluginId);
  }

  function sessionContext(value) {
    const source = value && typeof value === 'object' ? value : {};
    const result = {};
    for (const key of ['cwd', 'workspaceLabel', 'projectId', 'repoId', 'sidebarProjectId', 'sidebarProjectName']) {
      if (typeof source[key] === 'string' && source[key].trim()) result[key] = source[key].trim().slice(0, 1200);
    }
    return result;
  }

  function newSessionPayload(draft, metadata, current) {
    const auth = authorization(metadata);
    const missing = values(auth.missing).filter((item) => RUNTIME.has(item));
    if (!missing.length || !draft || typeof draft !== 'object') return null;
    const source = current && typeof current === 'object' ? current : {};
    const existing = capabilityIds(source.capabilities || source.capabilityIds);
    const files = Array.isArray(draft.files) ? draft.files.slice(0, 20) : [];
    const selectedPlugins = plugins(draft.plugins);
    return {
      newSession: true,
      tab: 'chat',
      prefill: String(draft.text || '').slice(0, 50000),
      initialFiles: files,
      initialPlugins: selectedPlugins,
      capabilities: values([...existing, ...missing]),
      ...sessionContext(source),
    };
  }

  return { authorization, newSessionPayload };
});
