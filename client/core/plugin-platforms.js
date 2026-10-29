/* A dependency declaration selects an existing desktop connection, never credentials. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SoduWorkPluginPlatforms = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const labels = Object.freeze({ feishu: '飞书', wecom: '企业微信', dingtalk: '钉钉' });
  function normalize(value) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > 3 || value.some(key => !Object.hasOwn(labels, key))) {
      throw Error('平台连接只支持飞书、企业微信和钉钉；其他系统请声明连接器或随包 CLI');
    }
    return [...new Set(value)];
  }
  function forItem(item) {
    // A platform connector always resolves to the current desktop user's
    // connection.  This is true for both local personal plugins and an
    // enterprise plugin installed from the catalog: the package is shared,
    // while the account authorization is deliberately device/user scoped.
    if (!item) return [];
    const declared = normalize(item.platforms || item.capabilities?.platforms);
    if (declared.length) return declared;
    // The reserved key fallback is kept only for old personal manifests. A
    // shared enterprise package must explicitly declare its platform.
    return item.personal && Object.hasOwn(labels, item.key) ? [item.key] : [];
  }
  function connectorReady(mcp, runtime, resources, platforms) {
    return mcp.length > 0 || platforms.length > 0 ||
      (runtime.includes('terminal') && resources.some(item => item.kind === 'script'));
  }
  return { labels, normalize, forItem, connectorReady };
});
