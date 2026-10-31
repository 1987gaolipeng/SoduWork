/* Resolve one @plugin turn again inside Electron's main process and materialize
   a short-lived, least-privilege MCP config. Renderer-provided instructions are
   never trusted as authorization input. */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const modelConfig = require('./model-config');
const { authHeaders, fetchWithDeviceAuthRetry } = require('../device-auth-request');
const personalPlugins = require('../personal-plugins');
const pluginResources = require('../plugin-resources');

const MAX_PLUGINS = 3;
const SERVER_NAME = 'soduwork-plugin';

function headers(identity) {
  return { ...authHeaders(identity), 'Content-Type': 'application/json' };
}

function unique(value, limit = MAX_PLUGINS) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim())
    .filter(Boolean))].slice(0, limit);
}

async function request(identity, body, timeoutMs = 10000, fetchImpl = global.fetch) {
  if (!identity || !identity.hub || !identity.clientId || (!identity.session && !identity.secret)) {
    throw new Error('这台电脑还没连上 SoduWork 后台');
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const url = String(identity.hub).replace(/\/+$/, '') + '/api/v1/plugins/conversation-grant';
    const response = await fetchWithDeviceAuthRetry(identity, url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify(body || {}),
    }, fetchImpl);
    let data = {};
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok || !data.ok) {
      throw new Error(String(data.detail || data.reason || ('后台没应答（HTTP ' + response.status + '）')));
    }
    return data;
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('插件授权超时，请检查后台连接后重试');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// A conversation-only plugin may not carry executable package resources.  A
// stale Hub package path should not make the otherwise valid context mention
// hang or poison the local turn queue.  The context endpoint is deliberately
// used only as a no-MCP fallback; plugins that need resources or connectors
// still fail closed with the original actionable error.
async function requestContext(identity, body, timeoutMs = 10000, fetchImpl = global.fetch) {
  if (!identity || !identity.hub || !identity.clientId || (!identity.session && !identity.secret)) {
    throw new Error('SoduWork backend is not connected');
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const url = String(identity.hub).replace(/\/+$/, '') + '/api/v1/plugins/conversation-context';
    const response = await fetchWithDeviceAuthRetry(identity, url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify(body || {}),
    }, fetchImpl);
    let data = {};
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok || !data.ok) {
      throw new Error(String(data.detail || data.reason || ('Backend did not respond (HTTP ' + response.status + ')')));
    }
    return data;
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('Plugin context request timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function grantRoot(app) {
  return path.join(modelConfig.agentDir(app), 'mcp', 'grants');
}

function safeRef(value) {
  return String(value || 'conversation').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'conversation';
}

function writeConfig(app, identity, ref, ticket) {
  const root = grantRoot(app);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, safeRef(ref) + '-' + crypto.randomBytes(6).toString('hex') + '.json');
  const payload = {
    servers: {
      [SERVER_NAME]: {
        type: 'http',
        url: String(identity.hub).replace(/\/+$/, '') + '/api/v1/mcp',
        headers: { Authorization: 'Bearer ' + String(ticket || '') },
        // The Hub ticket remains the authority for the actual deadline.  The
        // local bridge must allow long-running video generation to reach it.
        toolTimeoutSeconds: 300,
        description: '仅限当前 @插件 轮次的企业 MCP 代理',
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows ACL follows the user profile. */ }
  return file;
}

function removeConfig(app, file) {
  if (!file) return;
  const root = path.resolve(grantRoot(app));
  const target = path.resolve(String(file));
  if (target === root || !target.startsWith(root + path.sep)) return;
  try { fs.unlinkSync(target); } catch (_) { /* Already removed or locked at shutdown. */ }
}

function bridgePath(app) {
  const resourceRoot = require('../agent-runtime/process-context').current()?.resourcesPath || process.resourcesPath;
  const candidates = [
    ...(app && app.isPackaged && resourceRoot
      ? [path.join(resourceRoot, 'skills', 'mcp-tools', 'scripts', 'mcp.mjs')]
      : []),
    path.resolve(__dirname, '..', '..', '..', 'skills', 'mcp-tools', 'scripts', 'mcp.mjs'),
    path.resolve(__dirname, '..', '..', 'runner', '_internal', 'skills',
      'mcp-tools', 'scripts', 'mcp.mjs'),
    path.join(modelConfig.agentDir(app), 'skills', 'mcp-tools', 'scripts', 'mcp.mjs'),
  ];
  const found = candidates.find((item) => fs.existsSync(item));
  if (!found) throw new Error('SoduWork 缺少连接器调用组件，请重新安装或升级客户端');
  return found;
}

function guide(app, configFile, serverNames, bridgeFile) {
  if (!configFile || !(serverNames || []).length) return '';
  const bridge = bridgeFile || bridgePath(app);
  const q = (value) => JSON.stringify(String(value || ''));
  return [
    '本轮 @插件 的 MCP 已由 SoduWork 按最小权限临时授权：' + serverNames.join('、') + '。',
    '凭据、地址和授权文件都不能读取、展示或写入成果；只能通过下面的桥调用。',
    '先查看代理工具：node ' + q(bridge) + ' --config ' + q(configFile) + ' list ' + SERVER_NAME,
    '每个连接只需调用一次 plugin_mcp_list 查看真实工具；记住并复用返回的工具定义，不要为同一连接重复列清单。确认参数后再调用 plugin_mcp_call。',
    '每次命令都必须保留同一个 --config 参数；不要改用默认 MCP 配置，也不要尝试其他连接。',
  ].join('\n');
}

async function resolve(options) {
  const opts = options || {};
  const ids = unique(opts.pluginIds);
  if (!ids.length) return { items: [], grant: null };
  const localIds = ids.filter((id) => id.startsWith('local:'));
  const remoteIds = ids.filter((id) => !id.startsWith('local:'));
  const sourceAccess = require('../plugin-source-access');
  if (localIds.length) await sourceAccess.check({ app: opts.app, identityOf: opts.identityOf,
    fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs, action: 'use',
    sourceIds: sourceAccess.sourcesForIds(personalPlugins._read(opts.app).plugins, localIds) });
  const local = localIds.length ? personalPlugins.resolve(opts.app, localIds, { cwd: opts.cwd }) : { items: [] };
  const readRoots = [...(local.readRoots || [])], resourceBundles = [...(local.resourceBundles || [])];
  // Restore the account/MCP before asking the Hub for a grant. Otherwise a
  // fresh Feishu installation can request a ticket before its connection exists.
  // Resolve local platform accounts before requesting any Hub grant. Enterprise
  // packages are shared definitions, but credentials remain on this desktop.
  for (const item of local.items || []) {
    for (const key of require('../../core/plugin-platforms').forItem(item)) {
      const platformGuide = await require('../platform-connections/index.cjs').guidance(key);
      if (platformGuide) item.context = platformGuide + '\n\n' + String(item.context || '');
    }
  }
  let localMcp = unique((local.items || []).flatMap(
    (item) => (item.capabilities && item.capabilities.mcpServers) || []), 20);
  if (Array.isArray(opts.personalMcpServers)) {
    const requested = unique(opts.personalMcpServers, 20);
    if (requested.some(name => !localMcp.includes(name))) throw new Error('调试节点请求了插件未声明的连接器');
    localMcp = requested;
  }
  const direct = opts.appContext?.connection;
  const application = require('../application-turn-context.cjs');
  const conversationFallback = (items) => {
    if (!opts.allowUnavailableApp || direct || ids.length !== 1 || ids[0] !== opts.appContext?.pluginId) return null;
    const current = items.find(item => item.pluginId === ids[0]);
    if (!current?.capabilities?.mcpServers?.length) return null;
    const description = application.describe(opts.appContext, items, [], { allowUnavailable: true });
    // This is only the context projection for this turn. The installed
    // declaration and every executable grant remain unchanged.
    return { items: items.map(item => ({ ...item, capabilities: { ...item.capabilities, mcpServers: [] } })),
      applicationUnavailable: true, applicationGuide: application.guide(description),
      grant: null, readRoots, resourceBundles };
  };
  if (direct && (direct.pluginId !== opts.appContext.pluginId || !ids.includes(direct.pluginId) ||
      (localIds.includes(direct.pluginId) && !localMcp.includes(direct.server)) || direct.expiresAt <= Date.now())) throw Error('应用连接授权已失效');
  if (opts.appContext && localMcp.length && !direct) {
    const fallback = conversationFallback(local.items || []);
    if (fallback) return fallback;
    throw Error('请先从应用壳刷新云端页面并登录，再发送消息');
  }
  if (direct) localMcp = localMcp.filter(name => name !== direct.server);
  if (direct && remoteIds.includes(direct.pluginId) &&
      [direct.versionId, direct.contributionId, direct.origin].some(value => typeof value !== 'string' || !value))
    throw Error('应用连接缺少安装版本绑定，请重新打开应用');
  await direct?.authorize?.();
  let remote = { ok: true, items: [], mcpGrant: null };
  let identity = null;
  if (remoteIds.length || localMcp.length) {
    identity = await opts.identityOf(opts.app);
    const grantBody = {
      pluginIds: remoteIds,
      resourceProtocol: 1,
      personalMcpServers: localMcp,
      projectId: String(opts.projectId || '').slice(0, 36),
      conversationId: String(opts.ref || '').slice(0, 120),
      ...(direct && remoteIds.includes(direct.pluginId) ? { applicationConnection: {
        pluginId: direct.pluginId, versionId: direct.versionId, contributionId: direct.contributionId,
        origin: direct.origin, server: direct.server,
      } } : {}),
    };
    try {
      remote = await request(identity, grantBody, opts.timeoutMs, opts.fetchImpl || global.fetch);
    } catch (error) {
      const message = String(error && error.message || error);
      if (!/鍘熷鍖呯己澶?|原始包缺失|package/i.test(message)) throw error;
      const context = await requestContext(identity, {
        pluginIds: remoteIds,
        projectId: grantBody.projectId,
        conversationId: grantBody.conversationId,
      }, opts.timeoutMs, opts.fetchImpl || global.fetch);
      const contextItems = Array.isArray(context.items) ? context.items : [];
      const unsafe = contextItems.some(item =>
        Boolean(item && item.resourceRequired) ||
        (((item && item.resourceBundle) || {}).resources || []).length ||
        ((item && item.capabilities && item.capabilities.mcpServers) || []).length);
      if (unsafe || contextItems.length !== remoteIds.length) throw error;
      remote = { ...context, mcpGrant: null };
    }
  }
  // Resolve platform accounts for remote items as well. The package is shared,
  // while every employee's Feishu/WeCom/DingTalk authorization stays scoped to
  // that employee's SoduWork client.
  for (const item of remote.items || []) {
    for (const key of require('../../core/plugin-platforms').forItem(item)) {
      const platformGuide = await require('../platform-connections/index.cjs').guidance(key);
      if (platformGuide) item.context = platformGuide + '\n\n' + String(item.context || '');
    }
  }
  for (const item of remote.items || []) {
    if (!item.resourceBundle) continue;
    const incoming = item.resourceBundle;
    const files = pluginResources.normalize(incoming.resources);
    if (pluginResources.digest(files) !== incoming.digest) throw new Error('插件资源清单校验失败');
    if (files.length) {
      if (!opts.cwd) throw new Error('当前会话没有可用的插件资源目录');
      const bundle = pluginResources.materialize(files, opts.cwd, item.key);
      readRoots.push(bundle.directory);
      resourceBundles.push({ pluginId: item.pluginId, key: item.key, digest: bundle.digest, resources: files });
      item.context = pluginResources.guidance(bundle) + '\n\n' + String(item.context || '');
    }
    // Never retain base64 resources in renderer state, transcript or turn badges.
    delete item.resourceBundle;
  }
  const byId = new Map([...(local.items || []), ...(remote.items || [])]
    .map((item) => [String(item.pluginId || ''), item]));
  const items = ids.map((id) => byId.get(id)).filter(Boolean);
  if (items.length !== ids.length) throw new Error('有插件在发送前已失效，请重新选择');
  if (direct && !items.find(item => item.pluginId === direct.pluginId)?.capabilities?.mcpServers?.includes(direct.server))
    throw Error('应用未声明该连接器，请更新应用');
  await direct?.authorize?.();
  const value = remote.mcpGrant;
  if (!value?.ticket) {
    const fallback = conversationFallback(items);
    if (fallback) return fallback;
  }
  const applicationGuide = application.guide(application.describe(opts.appContext, items,
    [...(value?.ticket ? value.servers || [] : []), ...(direct ? [direct.server] : [])]));
  if (!value || !value.ticket || !(value.servers || []).length) {
    return { items, applicationGuide, grant: direct ? await require('./app-mcp-grant.cjs').extend({ app: opts.app, ref: opts.ref, connection: direct }) : null, readRoots, resourceBundles };
  }
  const bridge = bridgePath(opts.app);
  const configFile = writeConfig(opts.app, identity, opts.ref, value.ticket);
  const result = {
    items,
    readRoots,
    resourceBundles,
    applicationGuide,
    grant: require('../agent-runtime/process-grants').attach({
      servers: unique(value.servers, 20),
      guide: guide(opts.app, configFile, unique(value.servers, 20), bridge),
      configFile,
      cleanup: () => removeConfig(opts.app, configFile),
      redact: text => String(text || '').split(value.ticket).join('[已隐藏凭据]'),
    }, [{ value: value.ticket, replacement: '[已隐藏凭据]' }]),
  };
  if (direct) result.grant = await require('./app-mcp-grant.cjs').extend({ app: opts.app, ref: opts.ref, connection: direct, base: result.grant });
  return result;
}

module.exports = {
  resolve, request, writeConfig, removeConfig, guide, headers,
  SERVER_NAME, _unique: unique, _grantRoot: grantRoot, _bridgePath: bridgePath,
};
