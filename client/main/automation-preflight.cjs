'use strict';
// Automation preflight checks real local plugins and account state without starting sessions, models, or business actions.
const crypto = require('node:crypto');
const platforms = require('../core/plugin-platforms');
const scopeOf = identity => require('./platform-connections/runtime.cjs').connectionScope(identity);
const check = (key, state, label) => ({ key, state, label });
const outcome = (state, message, checks = []) => ({ state, message, checks });

function merge(server, dependencies) {
  if (!dependencies || server.state === 'blocked') return server;
  const base = (server.checks || []).filter(item => !['plugin', 'device-dependencies'].includes(item.key));
  const result = { ...server, checks: [...base, ...(dependencies.checks || [])],
    deviceDependencies: { ...server.deviceDependencies, state: dependencies.state } };
  if (dependencies.state === 'blocked') return { ...result, state: 'blocked', message: dependencies.message };
  if (dependencies.state !== 'ready') return { ...result, state: 'waiting', message: dependencies.message };
  // Local dependency success must not clear server-reported offline or permission failures.
  if (server.executionReady === true) return { ...result, state: 'ready',
    message: '执行条件已检查；运行时会再次验证授权' };
  return result;
}

function create({ app, identityOf, platformConnections, catalog, resolvePlugin, authorize,
  connectorProbe, connectionScope = scopeOf, now = Date.now }) {
  const list = catalog || (() => require('./personal-plugins').catalog(app, true));
  const resolve = resolvePlugin || (id => require('./personal-plugins').resolve(app, [id]));
  const sourceCheck = authorize || (id => {
    const access = require('./plugin-source-access');
    return access.check({ app, identityOf, action: 'use',
      sourceIds: access.sourcesForIds(require('./personal-plugins')._read(app).plugins, [id]) });
  });
  const probeConnections = connectorProbe || require('./automation-connector-probe.cjs').probe;
  const pending = new Map(), cache = new Map();
  const platformRevision = () => platformConnections?.revision?.() ?? 0;

  function select(spec) {
    const plugin = list().find(item => item.key === spec.key);
    if (!plugin || plugin.enabled === false || !plugin.entrypoints?.automation) {
      return { error: outcome('blocked', '个人插件未安装、已停用或不支持自动化，请检查插件设置',
        [check('plugin', 'blocked', '个人插件不可用于自动化')]) };
    }
    if (spec.versionPolicy === 'pinned' &&
        (plugin.version !== spec.version || plugin.checksum !== spec.checksum)) {
      return { error: outcome('blocked', '个人插件版本与计划锁定版本不一致，请重新选择版本',
        [check('plugin', 'blocked', '个人插件版本不一致')]) };
    }
    if (plugin.setupState && plugin.setupState !== 'ready') {
      return { error: outcome('blocked', '个人插件设置尚未完成，请先打开插件设置',
        [check('plugin', 'blocked', '个人插件设置未完成')]) };
    }
    return { plugin, signature: crypto.createHash('sha256').update(JSON.stringify({
      id: plugin.pluginId, checksum: plugin.checksum, version: plugin.version,
      updatedAt: plugin.updatedAt, capabilities: plugin.capabilities,
      setupConfig: plugin.setupConfig, setupState: plugin.setupState,
    })).digest('hex') };
  }

  async function inspect(spec, identity, scope, selected) {
    const checks = [check('plugin', 'ready', '个人插件版本与设置已检查')];
    try { await sourceCheck(selected.plugin.pluginId); }
    catch (_) {
      return outcome('waiting', '个人插件使用权限暂时无法验证，请检查后台连接或插件权限',
        [check('plugin', 'waiting', '个人插件使用权限待验证')]);
    }
    try {
      // Without cwd, validate resource integrity and settings without materializing plugin resources.
      resolve(selected.plugin.pluginId);
    } catch (_) {
      return outcome('blocked', '个人插件无法通过使用权限或资源检查，请在插件页面检查后重试',
        [check('plugin', 'blocked', '个人插件使用权限或资源无效')]);
    }
    for (const key of platforms.forItem(selected.plugin)) {
      if (connectionScope(await identityOf(app)) !== scope) throw Error('账号已变化');
      if (!platformConnections?.refresh) {
        checks.push(check('platform', 'waiting', '平台账号待本机验证：' + platforms.labels[key]));
        continue;
      }
      try {
        const status = await platformConnections.refresh(key);
        if (status.connected === true) {
          checks.push(check('platform', 'ready', '平台账号授权已检查：' + platforms.labels[key]));
        } else {
          const blocked = status.disconnected === true || ['needs_auth', 'needs_setup', 'disconnected'].includes(status.state);
          checks.push(check('platform', blocked ? 'blocked' : 'waiting',
            (blocked ? '请先连接平台账号：' : '平台账号暂时无法验证：') + platforms.labels[key]));
        }
      } catch (_) {
        checks.push(check('platform', 'waiting', '平台账号暂时无法验证：' + platforms.labels[key]));
      }
    }
    if (connectionScope(await identityOf(app)) !== scope) throw Error('账号已变化');
    if (!checks.some(item => item.state === 'blocked')) {
      checks.push(...await probeConnections(identity, selected.plugin.capabilities?.mcpServers || []));
    }
    const after = select(spec);
    if (connectionScope(await identityOf(app)) !== scope) throw Error('账号已变化');
    if (after.error) return after.error;
    if (after.signature !== selected.signature) {
      return outcome('waiting', '插件配置已变化，请重新检查执行条件');
    }
    const failure = checks.find(item => item.state === 'blocked') || checks.find(item => item.state !== 'ready');
    return outcome(failure?.state || 'ready', failure?.label || '插件和连接器已检查', checks);
  }

  async function preflight(input = {}) {
    const server = input.server || {}, dependency = server.deviceDependencies;
    if (!dependency || server.state === 'blocked') return server;
    try {
      const identity = await identityOf(app), scope = connectionScope(identity);
      if (String(identity.clientId || '') !== String(dependency.ownerClientId || '')) {
        return merge(server, outcome('waiting', '请在计划所属电脑检查插件和连接器'));
      }
      if (input.hub && new URL(input.hub).origin !== new URL(identity.hub).origin) {
        return merge(server, outcome('waiting', '服务连接已变化，请重新检查执行条件'));
      }
      const spec = dependency.plugin || {}, selected = select(spec);
      if (selected.error) return merge(server, selected.error);
      const revision = platformRevision();
      const key = scope + ':' + revision + ':' + selected.signature + ':' + JSON.stringify(spec);
      const remembered = cache.get(key);
      if (!input.force && remembered && now() - remembered.at < 10000) return merge(server, remembered.value);
      if (input.force) cache.delete(key);
      let work = pending.get(key);
      if (input.force && work) {
        // Before saving, await any in-flight probe and then revalidate rather than trusting results from form initialization.
        try { await work; } finally { if (pending.get(key) === work) pending.delete(key); }
        return preflight(input);
      }
      if (!work) {
        work = inspect(spec, identity, scope, selected);
        pending.set(key, work);
      }
      let value;
      try { value = await work; }
      finally { if (pending.get(key) === work) pending.delete(key); }
      if (connectionScope(await identityOf(app)) !== scope) throw Error('账号已变化');
      if (platformRevision() !== revision) return merge(server, outcome('waiting', '平台连接已变化，请重新检查执行条件'));
      // Cache successful checks briefly; force validation before save and allow immediate retry after failure.
      if (value.state === 'ready') {
        if (cache.size >= 32) cache.clear();
        cache.set(key, { value, at: now() });
      }
      return merge(server, value);
    } catch (_) {
      return merge(server, outcome('waiting', '本机依赖暂时无法验证，请重新检查执行条件'));
    }
  }
  return { preflight };
}

function install({ app, ipcMain, identityOf, platformConnections }) {
  const service = create({ app, identityOf, platformConnections });
  ipcMain.handle('automation-preflight', async (event, input) => {
    if (!require('./platform-connections/index.cjs').trustedSender(event)) {
      return outcome('blocked', '只允许 SoduWork 客户端检查自动化');
    }
    return service.preflight(input);
  });
  return service;
}
module.exports = { create, merge, install };
