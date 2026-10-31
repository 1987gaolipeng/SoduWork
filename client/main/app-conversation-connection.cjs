'use strict';
// Continue an installed application conversation independently of its visible window.
const store = require('./app-settings-store.cjs');
const personal = require('./personal-plugins');
function contribution(app, pluginId) {
  if (!String(pluginId || '').startsWith('local:')) return null;
  const installed = personal.get(app, pluginId);
  if (!installed.enabled) throw Error('即用已停用或卸载');
  const choices = (installed.ui?.contributions || []).filter(row => row.slot === 'workspace.navigation' &&
    row.source?.type === 'external' && row.source.bridge?.capabilities?.includes('mcp.connect'));
  return choices.length === 1 ? { installed, entry: choices[0] } : null;
}
function association(app, ids) {
  if (!app || !Array.isArray(ids) || ids.length !== 1) return '';
  try { if (require('./jiyong-hosted-connection.cjs').context(app,ids[0])) return ids[0]; } catch (_) { /* Existing H5 path below. */ }
  try { return contribution(app, ids[0]) ? ids[0] : ''; } catch (_) { return ''; }
}
function required(installed, detail) {
  return Error('应用“' + installed.name + '”' + detail + '，请打开即用完成登录或配置 ukey 后重试');
}
function context(app, pluginId) {
  const hosted = require('./jiyong-hosted-connection.cjs').context(app,pluginId);
  if (hosted) return hosted;
  const selected = contribution(app, pluginId);
  if (!selected) return null;
  const { entry } = selected, origin = new URL(entry.source.url).origin;
  const binding = { pluginId, origin }, expectedScope = store.scope(binding);
  let live = null;
  try { live = require('./work-preview').appContextForPlugin?.(pluginId); }
  catch (_) { /* A stale window cannot block the current account's stored connection. */ }
  const initial = store.read(binding);
  let saved = initial.connections?.[entry.id];
  if (!saved && live?.connection?.credentialKey && live.connection.scope === expectedScope && new URL(live.pageUrl).origin === origin) {
    store.saveConnection(binding, entry.id, live.connection);
    saved = store.read(binding).connections?.[entry.id];
  }
  const application = { pluginId, pageUrl: entry.source.url, requiresMcp: true };
  // Existing hosted applications use the owned /mcp + ukey contract. Restore
  // that exact legacy configuration without discovering other credential keys.
  if (!saved && typeof initial.values.ukey === 'string' && initial.values.ukey.trim() &&
      selected.installed.capabilities?.mcpServers?.length === 1) {
    store.saveConnection(binding, entry.id, { server: selected.installed.capabilities.mcpServers[0],
      url: origin + '/mcp', credentialKey: 'ukey' });
    saved = store.read(binding).connections?.[entry.id];
  }
  if (!saved) throw required(selected.installed, '尚未配置连接');
  const endpoint = new URL(saved.url);
  if (endpoint.origin !== origin || endpoint.pathname !== '/mcp' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password)
    throw Error('应用连接来源已变化，请重新打开即用同步连接');
  const readCurrent = () => {
    if (store.scope(binding) !== expectedScope) throw Error('应用账号已变化，请重新发送消息');
    const latest = contribution(app, pluginId);
    if (!latest || latest.entry.id !== entry.id || new URL(latest.entry.source.url).origin !== origin ||
        !latest.installed.capabilities?.mcpServers?.includes(saved.server)) throw Error('应用连接器或安装来源已变化');
    const row = store.read(binding), current = row.connections?.[entry.id];
    if (!current || JSON.stringify(current) !== JSON.stringify(saved)) throw Error('应用连接已变化，请重新发送消息');
    const token = row.values[saved.credentialKey];
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token) || token.length > 4096)
      throw required(latest.installed, '未配置有效的接入凭据');
    return { token, revision: row.revision };
  };
  const current = readCurrent();
  const connection = { pluginId, server: saved.server, url: endpoint.href,
    credentialKey: saved.credentialKey, scope: expectedScope, expiresAt: Number.MAX_SAFE_INTEGER,
    ...current, readCurrent, context: {},
    ...(live?.connection?.scope === expectedScope && live.connection.server === saved.server && live.connection.inspect
      ? { inspect: live.connection.inspect } : {}) };
  return {...application,connection:require('./jiyong-mcp-bindings.cjs').extend(connection,selected.installed,binding)};
}
module.exports = { association, context };
