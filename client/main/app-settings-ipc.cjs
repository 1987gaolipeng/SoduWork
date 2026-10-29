'use strict';
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const store = require('./app-settings-store.cjs');
function install({ app, ipcMain, safeStorage, ownerOf, identityOf, fetchImpl }) {
  store.configure({ app, safeStorage, ownerOf });
  function binding(event, pluginId) {
    const frame = event.senderFrame;
    const url = frame?.url || event.sender.getURL();
    if ((frame && frame !== event.sender.mainFrame) || !url.startsWith('file:') || path.resolve(fileURLToPath(new URL(url))) !== path.resolve(__dirname, '../desk.html')) throw Error('应用设置只允许主工作台管理');
    if (!String(pluginId || '').startsWith('local:')) return remoteBinding(String(pluginId || ''));
    const plugin = require('./personal-plugins').get(app, String(pluginId || ''));
    const source = plugin.ui?.contributions?.find(row => row.slot === 'workspace.navigation')?.source;
    if (!plugin.enabled || !['external', 'package'].includes(source?.type)) throw Error('请先安装并启用该应用');
    return { pluginId: plugin.pluginId, origin: source.type === 'package' ? require('../core/plugin-package-page.cjs').origin(plugin.pluginId) : new URL(source.url).origin };
  }
  async function remoteBinding(pluginId) {
    const owner = ownerOf();
    if (!owner) throw Error('请先登录 SoduWork');
    const plugin = await require('./app-installed-remote.cjs').get({ app, identityOf, fetchImpl }, pluginId, () => {
      if (ownerOf() !== owner) throw Error('登录账号已变化，请重新打开应用设置');
    });
    const source = plugin?.ui?.contributions?.find(row => row.slot === 'workspace.navigation')?.source;
    if (!['external', 'package'].includes(source?.type)) throw Error('请先安装并启用该应用');
    const origin = source.type === 'package' ? require('../core/plugin-package-page.cjs').origin(pluginId) : new URL(source.url).origin;
    if (!/^https?:/.test(origin)) throw Error('应用地址无效');
    return { pluginId, origin };
  }
  for (const action of ['get', 'update']) ipcMain.handle('app-settings-' + action, (event, pluginId, input) => {
    try {
      const owner = ownerOf(), bound = binding(event, pluginId), options = { ...input, includeSecrets: false };
      return bound?.then ? bound.then(value => {
        if (ownerOf() !== owner) throw Error('登录账号已变化，请重新打开应用设置');
        return store[action](value, options);
      }).catch(error => ({ ok: false, reason: error.message })) : store[action](bound, options);
    }
    catch (error) { return { ok: false, reason: error.message }; }
  });
}
module.exports = { install };
