'use strict';
// Uses the same per-turn MCP files, cleanup and redaction lease as normal plugin grants.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const processGrants = require('../agent-runtime/process-grants');
const sources = new WeakMap();
const turnBindings = new WeakMap();
function bind(session, sender, pluginId, app, assertActive) {
  const pageOwner = require('../work-preview-app-owner.cjs');
  if (pageOwner.assertSender(sender)) assertActive ||= () => pageOwner.assertSender(sender);
  assertActive?.();
  session.appPluginId = pluginId || session.appPluginId || (sender && app
    ? require('../app-conversation-connection.cjs').association(app, session.snapshot?.().activePlugins) : '') || '';
  sources.set(session, { sender, app, nativePluginId: pluginId || '', assertActive });
}
function nativePluginId(session) { return sources.get(session)?.nativePluginId || ''; }
function forSession(session) {
  if (!session) return null;
  const accepted = turnBindings.get(session);
  const { sender, app, assertActive } = accepted || sources.get(session) || {};
  assertActive?.();
  const pluginId = accepted ? accepted.pluginId : session.appPluginId;
  if (!pluginId) return null;
  return context(sender, pluginId, accepted?.expected, app);
}
function context(sender, expectedPluginId, expectedSettings, app) {
  if (!expectedPluginId) return null;
  const preview = require('../work-preview');
  // A retained native sender must not fall back to another account's global app.
  require('../work-preview-app-owner.cjs').assertSender(sender);
  let current = preview.appContextFor(sender);
  // A native standalone app has a valid identity without any business connection.
  if (app && (!current || current.pluginId !== expectedPluginId || (current.requiresMcp && !current.connection)))
    current = require('../app-conversation-connection.cjs').context(app, expectedPluginId);
  if (!current || current.pluginId !== expectedPluginId) throw Error('应用连接不可用，请重新打开即用同步连接');
  if (expectedSettings && stamp(current) !== expectedSettings) throw Error('应用账号或设置已变化，请重新发送消息');
  return current;
}
function stamp(value) { return value?.connection?.credentialKey ? value.connection.scope + ':' + value.connection.revision : ''; }
function guardSend(session, options) {
  const source = sources.get(session) || {}, { sender, app } = source;
  source.assertActive?.();
  const selected = options.clearPluginSelection ? [] : options.pluginIds?.length
    ? options.pluginIds : session.snapshot?.().activePlugins || [];
  const selectedApp = app ? require('../app-conversation-connection.cjs').association(app, selected) : '';
  const pluginId = selectedApp || source.nativePluginId || '';
  // Capture each accepted turn independently. Selecting another application or
  // moving this conversation cannot change an already-queued turn's authority.
  if (!source.nativePluginId && app) {
    options.pluginIds = selected.slice();
    if (!selected.length) options.clearPluginSelection = true;
  }
  const expected = stamp(context(sender, pluginId, undefined, app)), prior = options.beforeTurn;
  options.beforeTurn = async (...args) => {
    source.assertActive?.();
    context(sender, pluginId, expected, app);
    const result = await prior?.(...args);
    source.assertActive?.();
    context(sender, pluginId, expected, app);
    session.appPluginId = pluginId;
    session.appMcpExpected = expected;
    turnBindings.set(session, { sender, pluginId, app, expected, assertActive: source.assertActive });
    return result;
  };
}
async function extend({ app, ref, connection, base }) {
  const grants = require('./plugin-grant');
  const root = grants._grantRoot(app);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = base?.configFile || path.join(root, 'app-' + crypto.randomBytes(12).toString('hex') + '.json');
  let proxy;
  try {
    proxy = await require('./app-mcp-proxy.cjs').create({ ...connection,
      readCurrent: connection.readCurrent || (() => connection) });
    const config = base?.configFile ? JSON.parse(fs.readFileSync(file, 'utf8')) : { servers: {} };
    config.servers[connection.server] = { type: 'http', appLease: true, url: proxy.url,
      headers: { Authorization: 'Bearer ' + proxy.token }, toolTimeoutSeconds: 300 };
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch (_) {}
    const bridge = grants._bridgePath(app), q = value => JSON.stringify(String(value).replace(/\\/g, '/'));
    const viewer = path.join(path.dirname(bridge), 'app-view.mjs');
    const textWriter=path.join(path.dirname(bridge),'app-settings-text.mjs');
    const viewGuide = connection.inspect && fs.existsSync(viewer) ? [
      '界面：本轮当前即用，复用登录态，不开隔离浏览器。摘要：node ' + q(viewer) + ' --config ' + q(file) + ' ' + q(connection.server) + ' inspect',
      '截图：node ' + q(viewer) + ' --config ' + q(file) + ' ' + q(connection.server) + ' shot；用图片工具读取输出 screenshot 路径。仅绑定页面，只读；不读存储/凭据，不执行任意JS。',
    ] : [];
    const guide = connection.hosted ? [
      '本轮即用 MCP 已授权：' + connection.server + '；工具与页面共用宿主 SQLite。无需独立服务或密钥，不读取数据库文件或授权配置。',
      '列工具：node ' + q(bridge) + ' --config ' + q(file) + ' list ' + q(connection.server),
      '调用：SODUWORK_MCP_ARGS_STDIN=1 node ' + q(bridge) + ' --config ' + q(file) + ' call ' + q(connection.server) + ' TOOL；JSON 从标准输入传入。',
      '先 data_apps 发现同账号即用，需要时传 appId；data_list/data_get 读取，按真实 revision 合并后 data_batch；冲突重新读取。窗口关闭不影响数据；完成后读取确认。',
    ].join('\n') : connection.bindings ? [
      '本轮即用 MCP 已授权：' + connection.server + '；宿主注入已声明参数，秘密不进入提示词；不读取授权配置。',
      '列工具：node ' + q(bridge) + ' --config ' + q(file) + ' list ' + q(connection.server),
      '调用：SODUWORK_MCP_ARGS_STDIN=1 node ' + q(bridge) + ' --config ' + q(file) + ' call ' + q(connection.server) + ' TOOL；参数 JSON 仅走标准输入。',
      '按真实工具 schema 和业务技能操作；先读最新，写入后读取确认；失败如实报告，不猜工具或返回值。', ...viewGuide,
    ].join('\n') : ['本轮应用 MCP 已授权：' + connection.server + '。密钥由宿主管理；无需用户复制ukey；禁止读取/展示/复制授权配置。',
      '目标：' + JSON.stringify(connection.context || {}) + '；仅此空间/系列，服务端校验权限；既有记录缺目标先确认，明确新建按技能执行。',
      '先列出工具：node ' + q(bridge) + ' --config ' + q(file) + ' list ' + q(connection.server),
      '调用（参数仅走标准输入）：SODUWORK_MCP_ARGS_STDIN=1 node ' + q(bridge) + ' --config ' + q(file) + ' call ' + q(connection.server) + " TOOL <<'MCP_ARGS'\n{\"space_id\":\"目标空间\"}\nMCP_ARGS",
      '桥：保留路径引号和同一--config；不要改用技能缓存旧桥/默认配置/自写HTTP。失败报告，不读授权文件或绕过。',
      'JSON：SODUWORK_MCP_ARGS_STDIN=1+标准输入；Node/Python子进程用shell=false传input；heredoc结束标记单独一行。禁止命令行拼JSON/临时JSON+cat/命令替换。',
      '步骤：workbench_info→whoami→verify_space；业务显式space_id；读最新→合并写→check_data→get_record；交付上下文链接。',
      ...(fs.existsSync(textWriter)?['系列长正文免手写JSON：node '+q(textWriter)+' --config '+q(file)+' --server '+q(connection.server)+' --space SPACE --series SERIES；Markdown从stdin传入。可选--style/--ratio/--channel/--channel-name/--cover；仅传本轮需改字段。']:[]), ...viewGuide].join('\n');
    return processGrants.attach({ ...base, configFile: file,
      servers: [...new Set([...(base?.servers || []), connection.server])],
      guide: [base?.guide, guide].filter(Boolean).join('\n\n'),
      cleanup: () => { proxy?.cleanup(); if (base?.cleanup) base.cleanup(); else grants.removeConfig(app, file); },
      redact: value => (base?.redact ? base.redact(value) : String(value || ''))
        .split(connection.token).join('[已隐藏凭据]').split(proxy.token).join('[已隐藏凭据]'),
    }, [...(base?.[processGrants.REDACTIONS] || []), ...[connection.token, proxy.token,...(connection.redactions || [])]
      .map(value => ({ value, replacement: '[已隐藏凭据]' }))]);
  } catch (error) { proxy?.cleanup(); if (base?.cleanup) base.cleanup(); else grants.removeConfig(app, file); throw error; }
}
module.exports = { context, forSession, extend, guardSend, bind, nativePluginId };
