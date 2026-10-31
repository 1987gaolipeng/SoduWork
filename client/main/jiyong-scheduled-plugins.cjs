'use strict';
const ids = require('../core/jiyong-schedules.js');
async function catalog(app,identityOf,spec) {
  const local = require('./personal-plugins').catalog(app,true);
  if (!ids.isRemoteKey(spec?.key) || local.some(p => p.key === spec.key)) return local;
  const rows = await require('./app-installed-remote.cjs').catalog({app,identityOf});
  return [...local,...rows.map(ids.remote).filter(Boolean)];
}
async function check(app,identityOf,plugin) {
  if (plugin.pluginId.startsWith('local:')) return null;
  const latest = await require('./app-installed-remote.cjs').get({app,identityOf},plugin.pluginId);
  if (!latest.jiyong || latest.checksum !== plugin.checksum || !latest.entrypoints?.automation) throw Error('即用后台执行版本或权限已变化');
  const context = require('./jiyong-hosted-connection.cjs').context(app,plugin.pluginId);
  if (!context) throw Error('请先打开即用以登记宿主数据连接');
  await context.connection.authorize();
  return context;
}
module.exports = {catalog,check};
