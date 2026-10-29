'use strict';
// Keep authored files compatible with the real importer and portable plugin resources.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const BAD = new Set(['__proto__', 'constructor', 'prototype']);
const SECRET = /(?:sk|pk|pat|ghp|glpat)-[A-Za-z0-9_-]{12,}|(?:token|password|secret|api.?key)\s*[:=]\s*["']?[^\s"']{8,}/i;
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function read(file) {
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > 1024 * 1024) throw Error('输入需要为 1 MB 内的 JSON 文件');
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw Error('JSON 格式不正确'); }
}
function name(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value !== value.normalize('NFC') ||
      value.length > 60 || BAD.has(value) || value.startsWith('.') || /[. ]$/.test(value) ||
      /[\\/<>:"|?*\x00-\x1f\x7f]/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw Error('连接名称不适合导入或随插件保存，请使用简短名称，不能包含路径字符或保留名称');
  }
}
function alias(row, key, alternate, fallback) {
  if (Object.hasOwn(row, key) && Object.hasOwn(row, alternate) && JSON.stringify(row[key]) !== JSON.stringify(row[alternate])) {
    throw Error('同一配置的两种字段名存在冲突，请只保留一种');
  }
  return Object.hasOwn(row, key) ? row[key] : Object.hasOwn(row, alternate) ? row[alternate] : fallback;
}
function policy(row, spec, tools) {
  for (const [key, alternate] of [['enabledTools', 'enabled_tools'], ['disabledTools', 'disabled_tools']]) {
    const list = alias(row, key, alternate, []);
    if (!Array.isArray(list) || list.length > 200 || list.some(x => typeof x !== 'string' || !x.trim() ||
        x !== x.trim() || x.length > 200 || /[*\x00-\x1f\x7f]/.test(x))) throw Error('工具范围必须明确列出有效工具名，不支持通配符');
    if (tools && list.some(x => !tools.some(t => t.name === x))) throw Error('工具范围包含此连接器未公开的工具');
    spec[key] = [...new Set(list)];
  }
  if (spec.enabledTools.some(x => spec.disabledTools.includes(x))) throw Error('同一工具不能同时启用和禁用');
  for (const [key, alternate, fallback, max] of [['startupTimeoutSeconds', 'startup_timeout_sec', 10, 120], ['toolTimeoutSeconds', 'tool_timeout_sec', 60, 300]]) {
    const value = alias(row, key, alternate, fallback);
    if (!Number.isInteger(value) || value < 3 || value > max) throw Error('超时配置超出范围');
    spec[key] = value;
  }
}
function credentials(values, field, fields) {
  if (!object(values) || Object.keys(values).length > (field === 'headers' ? 10 : 20)) throw Error('凭据字段格式不正确或数量过多');
  const result = Object.create(null);
  const seen = new Set();
  for (const [key, value] of Object.entries(values)) {
    if (BAD.has(key) || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key) ||
        field === 'headers' && /^(host|content-length|connection|transfer-encoding|upgrade|proxy-authorization)$/i.test(key)) {
      throw Error('凭据字段名称无效');
    }
    if (field === 'headers' && seen.has(key.toLowerCase())) throw Error('请求头名称重复');
    seen.add(key.toLowerCase());
    if (typeof value !== 'string' || value.length > 16384) throw Error('凭据值需要为容量范围内的文本');
    if (fields && !fields.some(f => f.key === key)) throw Error('内置连接器包含未声明配置字段');
    result[key] = '';
  }
  return result;
}
function candidate(row) {
  if (!object(row)) throw Error('连接配置必须为对象');
  const known = new Set(['type', 'url', 'command', 'args', 'env', 'headers', 'http_headers', 'description', 'enabled',
    'enabledTools', 'enabled_tools', 'disabledTools', 'disabled_tools', 'startupTimeoutSeconds', 'startup_timeout_sec',
    'toolTimeoutSeconds', 'tool_timeout_sec', 'apiDefinition']);
  if (['oauth', 'headersHelper', 'bearer_token_env_var', 'env_http_headers', 'env_vars'].some(k => Object.hasOwn(row, k))) {
    throw Error('鉴权方式需要人工适配');
  }
  if (Object.keys(row).some(k => !known.has(k))) throw Error('连接配置包含不支持的字段，请核对官方接入方式');
  if (row.type !== undefined && !['stdio', 'http', 'streamable-http'].includes(row.type)) throw Error('仅支持 stdio / Streamable HTTP');
  const http = row.type === 'http' || row.type === 'streamable-http' || Object.hasOwn(row, 'url');
  if (http && (row.type === 'stdio' || ['command', 'args', 'env'].some(k => Object.hasOwn(row, k))) ||
      !http && ['headers', 'http_headers'].some(k => Object.hasOwn(row, k))) {
    throw Error('不能混用 HTTP 与本地连接配置');
  }
  if (Object.hasOwn(row, 'env') && !object(row.env) || Object.hasOwn(row, 'args') && !Array.isArray(row.args)) throw Error('本地连接字段格式不正确');
  if (row.apiDefinition !== undefined && row.command !== 'soduwork-api') throw Error('接口定义必须使用接口连接器');
  if (row.enabled !== undefined && typeof row.enabled !== 'boolean') throw Error('enabled 必须为布尔值');
  if (row.description !== undefined && (typeof row.description !== 'string' || row.description.length > 200 || SECRET.test(row.description))) {
    throw Error('说明过长或疑似携带凭据');
  }
}
function url(value) {
  if (typeof value !== 'string' || value.length > 400 || /[\s\\\x00-\x1f\x7f]/.test(value)) throw Error('连接地址格式不正确或过长');
  let parsed;
  try { parsed = new URL(value); } catch { throw Error('需要完整的连接地址'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash ||
      [...parsed.searchParams.keys()].some(k => /token|secret|password|signature|api.?key|authorization|^key$/i.test(k))) {
    throw Error('地址不能包含凭据；使用配置页只写鉴权头');
  }
  return parsed.href;
}
function write(out, servers, report, extra = {}) {
  const content = JSON.stringify({ mcpServers: servers }, null, 2);
  if (Buffer.byteLength(content) > 1024 * 1024) throw Error('输出配置超过导入上限 1 MB，请拆分连接');
  const dest = path.resolve(out);
  if (fs.existsSync(dest)) throw Error('输出目录已存在，不覆盖');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.mkdirSync(dest);
  for (const [file, value] of Object.entries({ 'mcp-config.json': content, ...extra, 'mcp-check.json': JSON.stringify(report, null, 2) })) {
    const target = path.join(dest, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value, { mode: 0o600, flag: 'wx' });
  }
  return report;
}
function plugin(metadata, servers, report) {
  if (!object(metadata) || Object.keys(metadata).some(k => !['key', 'name', 'version', 'description', 'instructions', 'author'].includes(k))) {
    throw Error('插件信息仅接受标识、名称、版本、说明、工作方法和作者');
  }
  if (Object.keys(servers).length > 30) throw Error('每个插件最多声明 30 个连接，请拆分制作');
  if (report.requiresAdminReview?.length) throw Error('自定义本地命令需要管理员审查，不能生成个人连接插件');
  for (const [key, max] of [['name', 120], ['description', 200], ['instructions', 12000]]) {
    if (typeof metadata[key] !== 'string' || !metadata[key].trim() || metadata[key].length > max || SECRET.test(metadata[key])) {
      throw Error('插件名称、说明和工作方法需填写完整，不能包含凭据或超长内容');
    }
  }
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(metadata.key || '') ||
      !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(metadata.version || '')) throw Error('插件标识或版本格式不正确');
  if (metadata.author !== undefined && (typeof metadata.author !== 'string' || metadata.author.length > 120 || SECRET.test(metadata.author))) throw Error('作者信息无效');
  const resources = Object.entries(servers).map(([connection, spec]) => ({
    path: 'references/connections/' + connection + '.mcp.json', kind: 'reference', encoding: 'utf8',
    content: JSON.stringify({ mcpServers: { [connection]: spec } }, null, 2),
  }));
  const draft = { ...metadata, template: 'connector', mcpServers: Object.keys(servers),
    runtimeCapabilities: ['files'], entrypoints: { conversation: true, task: true, automation: false }, resources };
  return { draft, files: Object.fromEntries(resources.map(r => [r.path, r.content])),
    checksums: resources.map(r => ({ path: r.path, sha256: crypto.createHash('sha256').update(r.content).digest('hex') })) };
}
module.exports = { object, read, name, alias, policy, credentials, candidate, url, write, plugin };
