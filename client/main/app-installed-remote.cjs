'use strict';
// Resolve Hub installations through the current account's authorized catalog.
// A market app ID is not a personal/local plugin ID.
async function get(deps, pluginId, assertCurrent = () => {}) {
  const identity = await deps.identityOf?.(deps.app);
  if (!identity?.hub) throw Error('请先登录 SoduWork');
  const { fetchWithDeviceAuthRetry } = require('./device-auth-request');
  const response = await fetchWithDeviceAuthRetry(identity, identity.hub.replace(/\/+$/, '') + '/api/v1/plugins/catalog', {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' },
  }, deps.fetchImpl || global.fetch);
  if (!response.ok) throw Error('应用目录读取失败，请重试');
  const catalog = await response.json();
  assertCurrent();
  const plugin = catalog.items?.find(item => item.pluginId === pluginId);
  if (!plugin?.installed || plugin.enabled === false || plugin.permissions?.canUse !== true || plugin.installedVersionAvailable === false) {
    throw Error('请先安装并启用该应用');
  }
  return plugin;
}
module.exports = { get };
