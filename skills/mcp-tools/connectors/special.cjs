'use strict';
const crypto = require('node:crypto');
const { input, settings, plain } = require('./validation.cjs');
const { tencentSignature, klingToken, signS3, encode } = require('./special-signing.cjs');
const { fetchBounded, redactData, MAX_BYTES } = require('./special-transport.cjs');

const OFFICIAL_HOSTS = {
  'tencent-meeting': new Set(['api.meeting.qq.com']),
  kling: new Set(['api-singapore.klingai.com']),
};

function endpoint(def, cfg) {
  const s3 = def.runtimeKind === 's3';
  if (s3 && def.baseUrl !== '{S3_ENDPOINT}') throw Error('S3 仅使用用户明确配置的端点');
  const raw = String(s3 ? cfg.S3_ENDPOINT || '' : def.baseUrl || '');
  // Reject backslashes, whitespace, paths, and disguised userinfo that URL parsing could normalize silently.
  if (/[\\\s\x00-\x1f\x7f]/.test(raw) || !/^https?:\/\/[^/?#]+\/?$/.test(raw)) throw Error('连接器地址格式无效');
  let url; try { url = new URL(raw); } catch { throw Error('连接器地址格式无效'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('连接器地址不得包含账号、路径或查询参数');
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/.test(raw.replace(/^https?:\/\//, '').replace(/\/$/, ''));
  if (url.protocol !== 'https:' && !(s3 && url.protocol === 'http:' && local)) throw Error('连接器必须使用 HTTPS，本机对象存储可使用 HTTP');
  if (!s3 && (!OFFICIAL_HOSTS[def.runtimeKind]?.has(url.hostname) || url.port)) throw Error('连接器目标不是已核实的官方地址');
  return url;
}

function required(cfg, keys) {
  for (const key of keys) if (!cfg[key]) throw Error('连接器配置缺少必要字段：' + key);
}
function bodyValue(value, args) {
  if (Array.isArray(value)) return value.map(item => bodyValue(item, args));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bodyValue(item, args)]).filter(([, item]) => item !== undefined));
  if (typeof value === 'string' && /^\$[A-Za-z][A-Za-z0-9_]*$/.test(value)) return args[value.slice(1)];
  return value;
}
function resourcePath(def, tool, args) {
  const template = String(tool.path || '');
  if (!template.startsWith('/') || template.startsWith('//') || /[\\?#\x00-\x20]/.test(template)) throw Error('连接器资源路径无效');
  const result = template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, key) => {
    if (!Object.hasOwn(args, key) || args[key] === '') throw Error('缺少资源参数：' + key);
    const value = String(args[key]);
    if (def.runtimeKind === 's3' && key === 'key') {
      if (value.split('/').some(segment => segment === '.' || segment === '..')) throw Error('对象键含无法安全传输的相对路径段');
      return value.split('/').map(encode).join('/');
    }
    if (value === '.' || value === '..') throw Error('资源路径不可包含相对路径段');
    if (def.runtimeKind === 's3' && key === 'bucket' && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value)) throw Error('桶名格式不正确');
    return encode(value);
  });
  if (/[{}]/.test(result) || result.split('/').some(segment => segment === '.' || segment === '..')) throw Error('连接器资源路径无效');
  return result;
}

function request(def, values, tool, suppliedArgs = {}, context = {}) {
  if (!['tencent-meeting', 'kling', 's3'].includes(def.runtimeKind)) throw Error('此专用连接器尚未实现');
  const args = { ...Object.fromEntries(Object.entries(tool.inputSchema?.properties || {})
    .filter(([, value]) => Object.hasOwn(value, 'default')).map(([key, value]) => [key, value.default])), ...suppliedArgs };
  input(args, tool.inputSchema);
  const cfg = settings(def, values);
  const method = tool.method || 'GET';
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw Error('连接器请求方式无效');
  // A readOnly label must not bypass authorization for a write method.
  if (tool.readOnly !== true || !['GET', 'HEAD'].includes(method)) {
    if (cfg.ALLOW_WRITES !== 'true') throw Error('该连接器尚未授权写入，请在连接设置中开启写入权限');
  }
  const base = endpoint(def, cfg), path = resourcePath(def, tool, args);
  const url = new URL(base.origin + path);
  if (url.origin !== base.origin || url.pathname !== path) throw Error('连接器资源路径发生变化');
  for (const [key, argument] of Object.entries(tool.query || {})) if (args[argument] !== undefined) url.searchParams.set(key, String(args[argument]));
  for (const [key, value] of Object.entries(tool.fixedQuery || {})) url.searchParams.set(key, String(value));
  const headers = { Accept: def.runtimeKind === 's3' ? 'application/xml, application/octet-stream' : 'application/json' };
  for (const [key, value] of Object.entries(def.headers || {})) {
    if (!/^(accept|content-type)$/i.test(key) || /[\r\n\x00]/.test(String(value))) throw Error('专用连接器包含未许可的请求头');
    headers[key] = String(value);
  }
  let body;
  if (tool.body !== undefined) {
    const value = bodyValue(tool.body, args);
    if (def.runtimeKind === 's3') {
      if (typeof value !== 'string') throw Error('当前对象写入仅支持文本内容');
      body = value;
      headers['Content-Type'] = 'text/plain; charset=utf-8';
    } else {
      body = JSON.stringify(value);
      headers['Content-Type'] = 'application/json';
    }
  }
  if (body !== undefined && (method === 'GET' || method === 'HEAD')) throw Error('读取请求不得携带写入内容');
  if (Buffer.byteLength(body || '') > MAX_BYTES) throw Error('请求内容超过 2 MB');
  const now = context.now ?? Date.now();
  if (def.runtimeKind === 'tencent-meeting') {
    required(cfg, ['TENCENT_APP_ID', 'TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY']);
    if (!path.startsWith('/v1/')) throw Error('腾讯会议 API 路径无效');
    const timestamp = String(Math.floor(now / 1000)), nonce = String(context.nonce ?? crypto.randomInt(1, 2147483647));
    Object.assign(headers, { AppId: cfg.TENCENT_APP_ID, 'X-TC-Key': cfg.TENCENT_SECRET_ID,
      'X-TC-Timestamp': timestamp, 'X-TC-Nonce': nonce, 'X-TC-Registered': '1' });
    if (cfg.TENCENT_SDK_ID) headers.SdkId = cfg.TENCENT_SDK_ID;
    headers['X-TC-Signature'] = tencentSignature({ secretId: cfg.TENCENT_SECRET_ID, secretKey: cfg.TENCENT_SECRET_KEY,
      method, uri: url.pathname + url.search, body: body || '', timestamp, nonce });
  } else if (def.runtimeKind === 'kling') {
    required(cfg, ['KLING_ACCESS_KEY', 'KLING_SECRET_KEY']);
    if (!path.startsWith('/v1/videos/')) throw Error('此可灵签名运行器仅支持已核实的视频 API');
    headers.Authorization = 'Bearer ' + klingToken(cfg.KLING_ACCESS_KEY, cfg.KLING_SECRET_KEY, now);
  } else {
    required(cfg, ['S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']);
    if (!/^[a-z0-9-]{2,63}$/.test(cfg.S3_REGION)) throw Error('S3 区域格式无效');
    // Sign only headers actually sent, including the session token for temporary credentials.
    const signed = signS3({ url, method, body: body || '', headers,
      accessKey: cfg.S3_ACCESS_KEY_ID, secretKey: cfg.S3_SECRET_ACCESS_KEY,
      sessionToken: cfg.S3_SESSION_TOKEN, region: cfg.S3_REGION, now });
    return { url, method, body, headers: signed, cfg };
  }
  return { url, method, body, headers, cfg };
}

function decodeXmlText(text) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&([^;]{1,32});/g, (_, value) => {
    if (Object.hasOwn(entities, value)) return entities[value];
    const code = /^#x[0-9a-f]+$/i.test(value) ? parseInt(value.slice(2), 16) : /^#[0-9]+$/.test(value) ? Number(value.slice(1)) : NaN;
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) throw Error('对象存储 XML 包含不支持的实体');
    return String.fromCodePoint(code);
  });
}
function s3Result(response, tool) {
  if (tool.method === 'PUT') return { ok: true, etag: response.headers?.get('etag') || null };
  if (tool.name === 'get_object') {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(response.bytes); } catch {}
    const type = response.headers?.get('content-type') || 'application/octet-stream';
    const binary = text === undefined || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text);
    return { contentType: type, encoding: binary ? 'base64' : 'utf8', content: binary ? response.bytes.toString('base64') : text };
  }
  let xml; try { xml = new TextDecoder('utf-8', { fatal: true }).decode(response.bytes); } catch { throw Error('对象存储 XML 编码无效'); }
  // Reject DTD and entity declarations; return bounded raw XML without a general XML evaluator.
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml)) throw Error('对象存储 XML 包含禁止的 DTD 或实体声明');
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#[0-9]+;|#x[0-9a-f]+;)/i.test(xml)) throw Error('对象存储 XML 包含不支持的实体');
  const root = xml.replace(/^\s*<\?xml[^?]*\?>\s*/i, '').match(/^\s*<([A-Za-z_:][\w:.-]*)(?=[\s/>])/)?.[1]?.split(':').pop();
  if (root === 'Error') throw Error('对象存储拒绝了请求，请检查权限、区域和签名配置');
  if (!['ListBucketResult', 'ListAllMyBucketsResult'].includes(root)) throw Error('对象存储未返回预期的列表 XML');
  // ListObjectsV2 echoes the current ContinuationToken; only NextContinuationToken advances pagination.
  // ListBuckets uses ContinuationToken for the next page and needs separate handling.
  const tokenName = root === 'ListBucketResult' ? 'NextContinuationToken' : 'ContinuationToken';
  const tokenPattern = new RegExp('<(?:[A-Za-z_][\\w.-]*:)?' + tokenName + '>([^<]{0,16384})<\\/(?:[A-Za-z_][\\w.-]*:)?' + tokenName + '>');
  const token = xml.match(tokenPattern)?.[1];
  return { format: 'xml', xml, ...(token ? { pagination: { continuationToken: decodeXmlText(token) } } : {}) };
}

async function execute(def, values, tool, args, options = {}) {
  const req = request(def, values, tool, args);
  const response = await fetchBounded(req, options);
  let data;
  if (def.runtimeKind === 's3') data = s3Result(response, tool);
  else {
    try { data = JSON.parse(response.bytes.toString('utf8') || '{}'); } catch { throw Error('平台未返回有效 JSON'); }
    if (!plain(data) || data.error || Array.isArray(data.errors) && data.errors.length
      || data.error_info?.error_code && String(data.error_info.error_code) !== '0'
      || def.runtimeKind === 'kling' && data.code !== undefined && String(data.code) !== '0') {
      throw Error('平台拒绝了请求，请检查账号权限、授权范围和参数');
    }
  }
  return { content: [{ type: 'text', text: JSON.stringify(redactData(data, def, req.cfg, req.headers)) }], isError: false };
}
module.exports = { execute, request };
