(function(root,factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SoduWorkJiyongSchedules = api;
})(typeof window === 'object' ? window : globalThis,function() {
  'use strict';
  function remote(item) {
    if (!item || item.personal || !item.installed || item.enabled === false || item.permissions?.canUse !== true || item.installedVersionAvailable === false) return null;
    const definition = item.conversationJiyong || item.jiyong;
    const entrypoints = item.conversationEntrypoints || item.entrypoints;
    if (!definition || definition.mcp?.server !== 'soduwork-jiyong' || !entrypoints?.automation) return null;
    // Use an explicit, non-colliding catalog identity in the existing pinned
    // schedule envelope. No plugin code, data or credentials enter the Hub row.
    if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(item.pluginId)) return null;
    return {...item,key:'jiyong-'+item.pluginId,sourceKey:item.key,
      version:item.conversationVersion || item.version,checksum:item.conversationChecksum || item.checksum,
      versionId:item.conversationVersionId || item.versionId,
      jiyong:definition,entrypoints,capabilities:item.conversationCapabilities || item.capabilities};
  }
  return {remote,isRemoteKey:key => /^jiyong-[a-z0-9][a-z0-9-]{1,48}$/.test(String(key || ''))};
});
