'use strict';
const fs = require('node:fs'), path = require('node:path');
const checks = require('./authoring-checks.cjs');
function apiCompiler() { return require(fs.existsSync(path.join(__dirname, 'api-definition.cjs')) ? './api-definition.cjs' : '../../mcp-tools/connectors/api-definition.cjs'); }
function catalog() { return JSON.parse(fs.readFileSync(path.join(__dirname, '../references/connectors.json'), 'utf8')); }
function portableName(label, fallback) {
  try { checks.name(label); return label; } catch { checks.name(fallback); return fallback; }
}
function normalize(doc) {
  if (!checks.object(doc) || Object.keys(doc).some(k => !['mcpServers', 'servers'].includes(k))) throw Error('需要 mcpServers 对象，不能包含其他宿主配置');
  const source = checks.alias(doc, 'mcpServers', 'servers', null);
  if (!checks.object(source) || !Object.keys(source).length || Object.keys(source).length > 100) throw Error('需要包含 1 到 100 个连接的对象');
  const servers = Object.create(null), needs = [], seen = new Set(), review = [];
  for (const [name, row] of Object.entries(source)) {
    checks.name(name);
    if (seen.has(name.toLowerCase())) throw Error('连接名称重复');
    seen.add(name.toLowerCase());
    checks.candidate(row);
    const type = row.type || (row.url ? 'http' : 'stdio');
    const spec = { type: type === 'streamable-http' ? 'http' : type, enabled: false };
    let fields, tools;
    if (type !== 'stdio') {
      spec.url = checks.url(row.url);
      spec.headers = checks.credentials(checks.alias(row, 'headers', 'http_headers', {}), 'headers');
    } else if (row.command === 'soduwork-api') {
      if (row.args !== undefined && (!Array.isArray(row.args) || row.args.length)) throw Error('接口连接器不能包含启动参数');
      const api = apiCompiler().compile(row.apiDefinition);
      fields = api.fields; tools = api.tools;
      checks.credentials(row.env ?? {}, 'env', fields);
      Object.assign(spec, { command: 'soduwork-api', args: [], apiDefinition: api, env: Object.fromEntries(fields.map(f => [f.key, ''])) });
    } else {
      if (typeof row.command !== 'string' || !row.command.trim() || row.command.length > 200 || /[\x00-\x1f\x7f]/.test(row.command)) throw Error('本地命令不能为空或过长');
      const args = row.args ?? [];
      if (!Array.isArray(args) || args.length > 30 || args.some(x => typeof x !== 'string' || x.length > 400 || /token|secret|password|api.?key|[\x00-\x1f\x7f]/i.test(x))) throw Error('参数疑似含凭据或格式无效，请人工检查；不复制');
      if (row.command === 'soduwork-connector') {
        const entry = args.length === 1 && catalog().find(x => x.id === args[0]);
        if (!entry) throw Error('没有此内置连接器或启动参数不正确');
        fields = entry.fields; tools = entry.tools;
      } else review.push(name);
      Object.assign(spec, { command: row.command, args, env: checks.credentials(row.env ?? {}, 'env', fields) });
      // Include every declared field so the real editor can request missing configuration.
      if (fields) for (const field of fields) spec.env[field.key] = '';
    }
    if (row.description) spec.description = row.description;
    checks.policy(row, spec, tools);
    const field = spec.type === 'http' ? 'headers' : 'env';
    for (const key of Object.keys(spec[field])) if (!fields || fields.find(f => f.key === key)?.required) needs.push({ server: name, field: field + '.' + key });
    servers[name] = spec;
  }
  return { servers, report: { staticValid: true, connectionTested: false, connections: Object.keys(servers),
    requiredCredentials: needs, requiresAdminReview: review,
    nextSteps: ['导入后保持停用', '在连接配置页填写授权与目标', '在实际执行机测试连接与一项只读工具后启用'] } };
}
function prepare(input, out) {
  const { servers, report } = normalize(checks.read(input));
  return checks.write(out, servers, report);
}
function fromApi(input, out) {
  const api = apiCompiler().compile(checks.read(input));
  const name = portableName(api.name, 'api-' + api.id.slice(0, 20));
  const { servers, report } = normalize({ mcpServers: { [name]: { command: 'soduwork-api', args: [], apiDefinition: api } } });
  Object.assign(report, { target: api.baseUrl, tools: api.tools.map(t => ({ name: t.name, readOnly: t.readOnly })),
    auth: Object.values(api.securitySchemes).map(x => x.flow || x.type) });
  return checks.write(out, servers, report);
}
function fromTemplate(id, out) {
  const entry = catalog().find(x => x.id === id);
  if (!entry) throw Error('没有此内置连接器');
  const name = portableName(entry.name, entry.id);
  const { servers, report } = normalize({ mcpServers: { [name]: { command: 'soduwork-connector', args: [id] } } });
  report.limitations = entry.limitations;
  return checks.write(out, servers, report);
}
function bundle(input, metadata, out) {
  const { servers, report } = normalize(checks.read(input));
  const result = checks.plugin(checks.read(metadata), servers, report);
  Object.assign(report, { pluginDraft: 'soduwork-plugin-draft.json', resourceCount: result.draft.resources.length, resources: result.checksums,
    pluginInstalled: false });
  return checks.write(out, servers, report, { ...result.files, 'soduwork-plugin-draft.json': JSON.stringify(result.draft, null, 2) });
}
module.exports = { prepare, catalog, fromTemplate, fromApi, bundle };
if (require.main === module) {
  try {
    const [action, a, b, c, ...extra] = process.argv.slice(2);
    let result;
    if (action === 'catalog' && !a) result = catalog();
    else if (action === 'template' && a && b && !c) result = fromTemplate(a, b);
    else if (action === 'api' && a && b && !c) result = fromApi(a, b);
    else if (action === 'prepare' && a && b && !c) result = prepare(a, b);
    else if (action === 'bundle' && a && b && c && !extra.length) result = bundle(a, b, c);
    else throw Error('用法: catalog | template <平台ID> <新目录> | api <接口清单.json> <新目录> | prepare <候选.json> <新目录> | bundle <候选.json> <插件信息.json> <新目录>');
    console.log(JSON.stringify(result));
  } catch (error) {
    // Never print parser excerpts or operating-system paths from untrusted input.
    console.error(error instanceof SyntaxError ? 'JSON 格式不正确' : error.code ? '文件操作失败，请检查输入文件和新输出目录' : error.message);
    process.exitCode = 1;
  }
}
