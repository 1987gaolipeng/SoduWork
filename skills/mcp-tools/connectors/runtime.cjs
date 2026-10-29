'use strict';
// Run reviewed, bundled definitions only; imported settings and model arguments cannot supply executable definitions.
const { provider, input, settings, plain, readOnly } = require('./validation.cjs');
const { fetchBounded, redactData, MAX_BYTES } = require('./special-transport.cjs');
function replace(text, values, encode = true) {
  return String(text).replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_match, key) => {
    if (!Object.hasOwn(values, key) || values[key] === '') throw Error('缺少参数：' + key);
    return encode ? encodeURIComponent(String(values[key])) : String(values[key]);
  });
}
function bodyValue(value, args) {
  if (Array.isArray(value)) return value.map(item => {
    const resolved = bodyValue(item, args);
    if (resolved === undefined) throw Error('请求数组缺少必要参数');
    return resolved;
  });
  if (plain(value)) {
    const result = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw Error('连接器请求字段无效');
      const resolved = bodyValue(item, args);
      if (resolved !== undefined) result[key] = resolved;
    }
    return result;
  }
  if (typeof value === 'string' && /^\$[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    return Object.hasOwn(args, value.slice(1)) ? args[value.slice(1)] : undefined;
  }
  return value;
}
function configurationValue(def, cfg, key) {
  if (!def.fields.some(field => field.key === key) || !Object.hasOwn(cfg, key) || !cfg[key]) throw Error('连接器鉴权字段缺失');
  return cfg[key];
}
function safeHeaders(headers) {
  for (const [key, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_~0-9A-Za-z-]+$/.test(key)
      || /^(host|content-length|connection|transfer-encoding|upgrade|proxy-authorization)$/i.test(key)
      || /[\x00-\x1f\x7f]/.test(String(value))) throw Error('连接器请求头无效');
  }
}
function request(def, values, tool, suppliedArgs = {}) {
  if (!plain(suppliedArgs)) throw Error('参数应为对象');
  const args = { ...Object.fromEntries(Object.entries(tool.inputSchema?.properties || {})
    .filter(([, value]) => Object.hasOwn(value, 'default')).map(([key, value]) => [key, value.default])), ...suppliedArgs };
  input(args, tool.inputSchema);
  const cfg = settings(def, values), auth = def.auth || {}, method = tool.method || 'GET';
  if (!['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) throw Error('连接器请求方式无效');
  if (!readOnly(tool) && cfg.ALLOW_WRITES !== 'true') throw Error('该连接器尚未授权写入，请在连接设置中开启写入权限');
  for (const key of Object.keys(args)) if (Object.hasOwn(cfg, key)) throw Error('工具参数不能覆盖连接配置');
  // Keep read-only GraphQL queries fixed and pass variables as JSON data only.
  if (/\/graphql(?:\.json)?$/.test(tool.path || '')) {
    const query = tool.body?.query;
    if (typeof query !== 'string' || /^\$[A-Za-z]/.test(query)) throw Error('GraphQL 查询必须由连接器固定定义');
    if (readOnly(tool) && !/^(?:\{|query(?:\s|\())/.test(query.replace(/#[^\r\n]*/g, '').trim())) throw Error('只读工具不得执行 GraphQL 写入');
  }
  // Validate configurable host syntax and exclude secrets from host selection.
  for (const key of String(def.baseUrl || '').match(/\{[^}]+\}/g) || []) {
    const field = def.fields.find(item => item.key === key.slice(1, -1));
    if (!field?.pattern || field.secret) throw Error('连接器目标字段必须有固定格式约束');
  }
  const rawBase = replace(def.baseUrl, cfg, false);
  if (/[\s\\\x00-\x1f\x7f]/.test(rawBase) || !rawBase.startsWith('https://')) throw Error('连接器目标必须是官方 HTTPS 地址');
  let base;
  try { base = new URL(rawBase); } catch { throw Error('连接器目标地址无效'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw Error('连接器目标必须是官方 HTTPS 地址');
  // Telegram requires the bot token in a fixed path; other connectors must keep secrets out of resource paths.
  for (const match of String(tool.path || '').matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)) {
    const field = def.fields.find(item => item.key === match[1]);
    if (field?.secret && !(auth.type === 'path' && auth.tokenKey === field.key)) throw Error('连接器密钥不得用于资源路径');
  }
  const resource = replace(tool.path, { ...cfg, ...args });
  if (!resource.startsWith('/') || resource.startsWith('//') || resource.split('/').some(part => part === '.' || part === '..')
    || /[\\\x00-\x20?#]/.test(resource)) throw Error('连接器资源路径无效');
  const joinedPath = base.pathname.replace(/\/$/, '') + resource;
  const url = new URL(base.origin + joinedPath);
  if (url.origin !== base.origin || url.pathname !== joinedPath) throw Error('连接器资源路径发生变化');
  const headers = { Accept: 'application/json', ...Object.fromEntries(Object.entries(def.headers || {})
    .map(([key, value]) => [key, replace(value, cfg, false)])) };
  const authQuery = new Set();
  if (auth.type === 'bearer') headers.Authorization = 'Bearer ' + configurationValue(def, cfg, auth.tokenKey || 'TOKEN');
  else if (auth.type === 'header') headers[auth.header] = String(auth.prefix || '') + configurationValue(def, cfg, auth.tokenKey || 'TOKEN');
  else if (auth.type === 'basic') {
    const username = configurationValue(def, cfg, auth.usernameKey), password = configurationValue(def, cfg, auth.passwordKey);
    headers.Authorization = 'Basic ' + Buffer.from(username + String(auth.usernameSuffix || '') + ':' + password).toString('base64');
  } else if (auth.type === 'query') {
    for (const [key, field] of Object.entries(auth.query || {})) {
      url.searchParams.set(key, configurationValue(def, cfg, field)); authQuery.add(key);
    }
  } else if (auth.type === 'path') configurationValue(def, cfg, auth.tokenKey);
  else if (auth.type !== 'none') throw Error('此连接器的授权方式尚未适配');
  for (const [key, parameter] of Object.entries(tool.query || {})) {
    if (authQuery.has(key)) throw Error('工具参数不能覆盖鉴权字段');
    const value = Object.hasOwn(args, parameter) ? args[parameter] : undefined;
    if (value !== undefined && value !== null) {
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
      else url.searchParams.set(key, String(value));
    }
  }
  for (const [key, value] of Object.entries(tool.fixedQuery || {})) {
    if (authQuery.has(key)) throw Error('工具参数不能覆盖鉴权字段');
    url.searchParams.set(key, String(value));
  }
  const payload = bodyValue(tool.body, args);
  if (tool.body !== undefined && payload === undefined) throw Error('请求内容缺少必要参数');
  const encoded = tool.body === undefined ? {} : require('./encoding.cjs').encode(tool.bodyEncoding, payload);
  const body = encoded.body;
  if (body !== undefined) {
    if (method === 'GET' || method === 'HEAD') throw Error('读取请求不得携带写入内容');
    if (Buffer.byteLength(body) > MAX_BYTES) throw Error('请求内容超过 2 MB');
    headers['Content-Type'] = encoded.contentType;
  }
  safeHeaders(headers);
  return { url, method, headers, body, cfg };
}
function failed(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.ok === false || data.error || Array.isArray(data.errors) && data.errors.length) return true;
  // GraphQL HTTP 200 responses can contain mutation errors; preserve failure status.
  if (plain(data.data)) return Object.values(data.data).some(value => plain(value)
    && (value.success === false || Array.isArray(value.userErrors) && value.userErrors.length > 0));
  return false;
}
function redactionDefinition(def) {
  const secretFields = new Set([def.auth?.tokenKey, def.auth?.passwordKey,
    ...Object.values(def.auth?.query || {})].filter(Boolean));
  return { ...def, fields: def.fields.map(field => secretFields.has(field.key) ? { ...field, secret: true } : field) };
}
async function execute(def, values, tool, args, options = {}) {
  if (def.runtimeKind) {
    if (['postgres', 'mysql', 'sqlite', 'redis', 'mongodb', 'clickhouse', 'elasticsearch'].includes(def.runtimeKind)) throw Error('数据库连接器请通过 SoduWork Runner 调用');
    if (require('./cloud-connectors.cjs').KINDS.has(def.runtimeKind))
      return require('./cloud-connectors.cjs').execute(def, values, tool, args, options);
    return require('./special.cjs').execute(def, values, tool, args, options);
  }
  const req = request(def, values, tool, args);
  const response = await fetchBounded(req, options);
  let data;
  try { data = JSON.parse(response.bytes.toString('utf8') || '{}'); }
  catch { throw Error('平台未返回 JSON，请检查连接器配置'); }
  if (failed(data)) throw Object.assign(Error('平台拒绝了请求，请检查账号权限、授权范围和参数'), {
    code: /invalid_auth|token_revoked|token_expired|not_authed|invalid_token|unauthorized/i.test(String(data.error?.code || data.error || '')) ? 'AUTH_REQUIRED' : 'BUSINESS_DENIED',
  });
  const pagination = {}, link = response.headers?.get('link') || '';
  const next = link.match(/<([^>]+)>;\s*rel="next"/);
  if (next) try {
    const url = new URL(next[1]);
    if (url.origin === req.url.origin && !url.username && !url.password) {
      for (const key of ['page', 'page_info', 'cursor', 'after', 'offset']) if (url.searchParams.has(key)) pagination[key] = url.searchParams.get(key);
    }
  } catch {}
  const nextPage = response.headers?.get('x-next-page');
  if (nextPage) pagination.page = nextPage;
  const result = Object.keys(pagination).length ? { data, pagination } : data;
  const redaction = redactionDefinition(def), redactionValues = { ...req.cfg };
  if (/^Basic /i.test(req.headers.Authorization || '')) {
    redaction.fields.push({ key: 'RUNTIME_BASIC_TOKEN', secret: true });
    redactionValues.RUNTIME_BASIC_TOKEN = req.headers.Authorization.slice(6);
  }
  // Redact structured values before serialization so quotes, backslashes, and numeric secrets cannot corrupt JSON.
  return { content: [{ type: 'text', text: JSON.stringify(redactData(result, redaction, redactionValues, req.headers)) }], isError: false };
}
async function session(spec, fn, options = {}) {
  if (spec.command !== 'soduwork-connector' || !Array.isArray(spec.args) || spec.args.length !== 1) throw Error('连接器启动配置无效');
  const def = provider(spec.args[0]), values = settings(def, spec.env || {});
  return fn(async (method, params = {}) => {
    if (method === 'tools/list') return { tools: def.tools.filter(tool => readOnly(tool) || values.ALLOW_WRITES === 'true').map(tool => ({
      name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: readOnly(tool), destructiveHint: !readOnly(tool), openWorldHint: true },
    })) };
    if (method !== 'tools/call') throw Error('连接器方法不支持');
    const tool = def.tools.find(item => item.name === params.name);
    if (!tool) throw Error('没有此连接器工具');
    return execute(def, values, tool, params.arguments ?? {}, { timeoutMs: Number(spec.toolTimeoutSeconds || 60) * 1000, ...options });
  });
}
module.exports = { request, execute, session };
