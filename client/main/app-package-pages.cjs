'use strict';
// Package bytes are served by Electron's resource protocol, never by a spawned server.
const path = require('node:path');
const crypto = require('node:crypto');
const contract = require('../core/plugin-package-page.cjs');
const resources = require('./plugin-resources');
const configured = new WeakMap();
const MIME = { '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain', '.wasm': 'application/wasm' };
function ownerScope(app, pluginId, origin) {
  try { return require('./app-settings-store.cjs').scope({ pluginId, origin }); }
  catch (error) {
    // Only installed local pages may work without a logged-in Hub account.
    // Remote pages must never share the offline partition during account changes.
    if (!pluginId.startsWith('local:')) throw error;
    return crypto.createHash('sha256').update(app.getPath('userData') + '\0local\0' + pluginId).digest('hex');
  }
}
async function definition(deps, pluginId) {
  if (pluginId.startsWith('local:')) {
    const plugin = require('./personal-plugins').get(deps.app, pluginId);
    if (!plugin.enabled) throw Error('请先安装并启用该应用');
    return { ui: plugin.ui, resources: plugin.localDraft.resources };
  }
  const identity = await deps.identityOf?.(deps.app);
  if (!identity?.hub) throw Error('请先登录 SoduWork');
  const response = await require('./device-auth-request').fetchWithDeviceAuthRetry(identity,
    identity.hub.replace(/\/+$/, '') + '/api/v1/plugins/' + encodeURIComponent(pluginId) + '/ui-package', {
      redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' },
    }, deps.fetchImpl || global.fetch);
  if (!response.ok) throw Error('包内应用资源读取失败，请确认安装与使用权限');
  return response.json();
}
async function prepare(deps, raw) {
  const pluginId = String(raw?.pluginId || ''), contributionId = String(raw?.contributionId || '');
  if (!pluginId || !contributionId) throw Error('包内应用缺少安装与入口标识');
  const origin = contract.origin(pluginId), scope = ownerScope(deps.app, pluginId, origin);
  const read = async () => {
    if (ownerScope(deps.app, pluginId, origin) !== scope) throw Error('应用账号已变化，请重新打开应用');
    const value = await definition(deps, pluginId);
    if (ownerScope(deps.app, pluginId, origin) !== scope) throw Error('应用账号已变化，请重新打开应用');
    const row = value.ui?.contributions?.find(row => row.id === contributionId && row.slot === 'workspace.navigation' && row.source?.type === 'package');
    if (!row) throw Error('已安装应用未声明该包内入口');
    const files = resources.normalize(value.resources, { allowLegacyContent: true });
    contract.validate({ contributions: [row] }, files);
    return { row, files };
  };
  const initial = await read();
  // Keep Windows IndexedDB backing-store paths below legacy path limits.
  const partition = 'persist:sw-app-' + scope.slice(0, 32);
  const session = (deps.session || require('electron').session).fromPartition(partition);
  let pages = configured.get(session);
  if (!pages) {
    pages = new Map(); configured.set(session, pages);
    session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.protocol.handle('https', async request => {
      const target = new URL(request.url), page = pages.get(target.origin);
      // This partition only hosts package resources. Reserved origins never reach DNS.
      if (!page || !['GET', 'HEAD'].includes(request.method)) return new Response('', { status: 403 });
      try {
        const { row, files } = await page();
        const pathname = decodeURIComponent(target.pathname.slice(1));
        const names = [pathname, path.posix.join(path.posix.dirname(row.source.entry), pathname)];
        const file = names.map(name => files.find(file => file.path === name && ['ui', 'asset'].includes(file.kind))).find(Boolean);
        if (!file) return new Response('', { status: 404 });
        const name = resources.resourcePath(file.path);
        const bytes = Buffer.from(file.content, 'base64');
        return new Response(request.method === 'HEAD' ? null : bytes, { headers: {
          'Content-Type': (MIME[path.extname(name).toLowerCase()] || 'application/octet-stream') + (/[.](?:html?|css|m?js|json|txt)$/i.test(name) ? '; charset=utf-8' : ''),
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'",
        } });
      } catch (_) { return new Response('', { status: 403 }); }
    });
  }
  pages.set(origin, read);
  return { url: origin + '/' + initial.row.source.entry, partition,
    assertActive: () => { if (ownerScope(deps.app, pluginId, origin) !== scope) throw Error('Application account changed'); },
    bridge: { appId: 'plugin:' + pluginId, contributionId, origin, version: 1,
      capabilities: initial.row.source.bridge?.capabilities || [] } };
}
module.exports = { prepare };
