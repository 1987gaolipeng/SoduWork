'use strict';
// Resolve Hub installations through the current account's authorized catalog.
// A market app ID is not a personal/local plugin ID.
async function catalog(deps, assertCurrent = () => {}) {
  // Remote Hub production disables the legacy device-secret compatibility path.
  // Keep synchronous identity lookups for view ownership; renew a device session
  // specifically for the authorized catalog request.
  const identity = await (deps.authenticatedIdentityOf || deps.identityOf)?.(deps.app);
  if (!identity?.hub) throw Error('请先登录 SoduWork');
  const { fetchWithDeviceAuthRetry } = require('./device-auth-request');
  const response = await fetchWithDeviceAuthRetry(identity, identity.hub.replace(/\/+$/, '') + '/api/v1/plugins/catalog', {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' },
  }, deps.fetchImpl || global.fetch);
  if (!response.ok) {
    const status = Number(response.status);
    const detail = Number.isInteger(status) && status >= 100 && status <= 599 ? '（HTTP ' + status + '）' : '';
    throw Error('应用授权校验失败' + detail + '，请重试');
  }
  const catalog = await response.json();
  assertCurrent();
  return catalog.items || [];
}
function accepted(plugin) {
  if (!plugin?.installed || plugin.enabled === false || plugin.permissions?.canUse !== true || plugin.installedVersionAvailable === false) {
    throw Error('请先安装并启用该应用');
  }
  // Window bridges must authorize the accepted installation, not a newer
  // catalog release which the employee has not installed yet.
  return plugin.conversationVersionId ? { ...plugin,
    versionId: plugin.conversationVersionId, version: plugin.conversationVersion,
    checksum:plugin.conversationChecksum || plugin.checksum,
    entrypoints:plugin.conversationEntrypoints || plugin.entrypoints,
    capabilities: plugin.conversationCapabilities, ui: plugin.conversationUi,
    jiyong: plugin.conversationJiyong, extensions:plugin.conversationExtensions,
    appCategory:plugin.conversationAppCategory || 'other', authorName:plugin.conversationAuthorName || plugin.authorName,
  } : plugin;
}
async function get(deps,pluginId,assertCurrent = () => {}) {
  return accepted((await catalog(deps,assertCurrent)).find(item => item.pluginId === pluginId));
}
module.exports = { get, catalog };
