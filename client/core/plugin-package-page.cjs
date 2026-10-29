'use strict';
const crypto = require('node:crypto');
function entry(value) {
  if (typeof value !== 'string' || value.length > 240 || !/^ui\/(?:[A-Za-z0-9_\-]+\/)*[A-Za-z0-9_\-.]+\.html?$/i.test(value) ||
      value.split('/').some(part => part === '.' || part === '..' || part.startsWith('.'))) {
    throw Error('包内页面入口必须是 ui 目录下的 HTML 相对路径');
  }
  return value;
}
function origin(pluginId) {
  return 'https://' + crypto.createHash('sha256').update(String(pluginId)).digest('hex').slice(0, 32) + '.soduwork-app.invalid';
}
function validate(ui, resources) {
  for (const row of ui?.contributions || []) {
    if (row.source?.type !== 'package') continue;
    const file = entry(row.source.entry);
    if (!(resources || []).some(resource => resource.path === file && resource.kind === 'ui'))
      throw Error('包内页面入口未包含在 ui 资源中：' + file);
  }
}
module.exports = { entry, origin, validate };
