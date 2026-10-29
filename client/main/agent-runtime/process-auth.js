'use strict';

// Only this main-process capability may attach a long-lived device secret to
// worker requests. The worker receives short-lived sessions and proxy tickets.
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const ID = '[A-Za-z0-9][A-Za-z0-9._:-]{0,159}';
const RULES = [
  ['GET', /^\/api\/v1\/ai-proxy\/config$/, ['agent', 'model']],
  ['GET', /^\/api\/v1\/ai-proxy\/media\/config$/, []],
  ['POST', /^\/api\/v1\/ai-proxy\/vision\/analyze$/, []],
  ['POST', new RegExp('^/api/v1/conversations/' + ID + '/images$'), []],
  ['GET', new RegExp('^/api/v1/conversations/' + ID + '/media$'), []],
  ['POST', new RegExp('^/api/v1/attachments/' + ID + '/access$'), []],
  ['GET', new RegExp('^/api/v1/tasks/' + ID + '$'), []],
  ['GET', new RegExp('^/api/v1/tasks/' + ID + '/(?:attachments|acceptance-context)$'), []],
  ['POST', new RegExp('^/api/v1/tasks/' + ID + '/(?:conversation-turn|conversation-delivery|auto-review|ai-dispatch|plugin-runs)$'), []],
  ['GET', new RegExp('^/api/v1/tasks/' + ID + '/ai-session$'), ['ref', 'since']],
  ['GET', new RegExp('^/api/v1/plugin-runs/' + ID + '$'), []],
  ['POST', new RegExp('^/api/v1/plugin-runs/' + ID + '/cancel$'), []],
  ['GET', /^\/api\/v1\/repos$/, []],
];

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function changed() { return failure('RUNTIME_IDENTITY_CHANGED', '账号或服务已变化，请重新打开这条对话'); }
function owner(identity) {
  // These tokens come from trusted deviceAuth, not from the worker. Parsing
  // only compares account provenance; Hub still verifies the signature.
  try {
    const claims = JSON.parse(Buffer.from(String(identity.session || '').split('.')[0], 'base64url'));
    return claims.typ === 'device' && claims.cid === identity.clientId && typeof claims.uid === 'string'
      ? claims.uid : '';
  } catch { return ''; }
}
function originOf(value) {
  const url = new URL(String(value || ''));
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/') throw failure('INVALID_RUNTIME_HUB', '执行服务地址无效');
  return url.origin;
}
function approvedUrl(hub, value, method) {
  const raw = String(value || '');
  // URL normalizes dot segments and backslashes. Reject them before parsing,
  // and disallow encoded path components so no downstream decoder can widen
  // the allowlist. Query values may still use ordinary percent encoding.
  if (!raw || /[\s\\\u0000-\u001f\u007f]/.test(raw))
    throw failure('RUNTIME_AUTH_ROUTE_DENIED', '执行请求地址不受信任');
  const rawPath = raw.split(/[?#]/, 1)[0];
  if (/%/.test(rawPath) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath))
    throw failure('RUNTIME_AUTH_ROUTE_DENIED', '执行请求路径不受信任');
  let url;
  try { url = new URL(raw); } catch { throw failure('RUNTIME_AUTH_ROUTE_DENIED', '执行请求地址无效'); }
  if (url.origin !== hub || url.username || url.password || url.hash)
    throw failure('RUNTIME_AUTH_ROUTE_DENIED', '执行请求不能访问其他服务');
  const rule = RULES.find(row => row[0] === method && row[1].test(url.pathname));
  if (!rule || [...url.searchParams.keys()].some(key => !rule[2].includes(key)) ||
      [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1))
    throw failure('RUNTIME_AUTH_ROUTE_DENIED', '执行请求超出已授权的接口');
  return url;
}
function safeHeaders(value) {
  const result = new Headers(value || {});
  for (const key of [...result.keys()]) {
    if (/^(?:authorization|proxy-authorization|cookie|host|origin|referer|x-soduwork-device|x-soduwork-secret|x-device-key)$/i.test(key))
      result.delete(key);
  }
  return result;
}
function redactBody(value, secret) {
  const body = Buffer.from(value);
  if (!secret || !body.includes(secret)) return value;
  const marker = Buffer.from('[hidden]'), needle = Buffer.from(secret), parts = [];
  let from = 0, at;
  while ((at = body.indexOf(needle, from)) !== -1) {
    parts.push(body.subarray(from, at), marker);
    from = at + needle.length;
  }
  parts.push(body.subarray(from));
  return new Uint8Array(Buffer.concat(parts));
}
async function responseBody(response) {
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel?.().catch(() => {});
    throw failure('RUNTIME_AUTH_RESPONSE_TOO_LARGE', '执行接口响应超过大小限制');
  }
  if (!response.body?.getReader) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_RESPONSE_BYTES)
      throw failure('RUNTIME_AUTH_RESPONSE_TOO_LARGE', '执行接口响应超过大小限制');
    return body;
  }
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES)
        throw failure('RUNTIME_AUTH_RESPONSE_TOO_LARGE', '执行接口响应超过大小限制');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

function createHostAuth({ app, identity, identityOf, deviceAuth, fetchImpl = global.fetch } = {}) {
  const auth = deviceAuth || require('../device-auth');
  const trusted = { hub: originOf(identity?.hub), clientId: String(identity?.clientId || ''),
    secret: String(identity?.secret || ''), session: String(identity?.session || '') };
  if (!trusted.clientId || (!trusted.secret && !trusted.session))
    throw failure('INVALID_RUNTIME_IDENTITY', '执行会话没有可信身份');
  const account = owner(trusted);
  let closed = false, latestSession = trusted.session;
  const controllers = new Set();
  const resolveIdentity = identityOf || (async () => typeof auth.authenticatedIdentity === 'function'
    ? auth.authenticatedIdentity(app) : auth.identity(app));
  function assertSame(current) {
    if (closed || !current || current.hub !== trusted.hub || current.clientId !== trusted.clientId ||
        current.secret && trusted.secret && current.secret !== trusted.secret ||
        account && owner({ ...current, session: current.session || latestSession }) !== account)
      throw changed();
    return { hub: trusted.hub, clientId: trusted.clientId, secret: trusted.secret,
      session: String(current.session || latestSession || '') };
  }
  async function current() { return assertSame(await resolveIdentity(app)); }
  function publicIdentity() {
    if (closed) throw changed();
    return { hub: trusted.hub, clientId: trusted.clientId, ...(latestSession ? { session: latestSession } : {}) };
  }
  async function ensureSession() {
    const before = await current();
    const token = await auth.ensureSession(app, before);
    if (typeof token !== 'string' || !token) throw failure('RUNTIME_SESSION_UNAVAILABLE', '执行会话凭据不可用');
    assertSame({ ...before, session: token });
    await current();
    latestSession = token;
    return token;
  }
  async function request(value, init = {}) {
    const method = String(init.method || 'GET').toUpperCase();
    const url = approvedUrl(trusted.hub, value, method);
    const active = await current();
    const controller = new AbortController();
    controllers.add(controller);
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const send = () => {
      const headers = safeHeaders(init.headers);
      if (active.session) headers.set('Authorization', 'Device ' + active.session);
      else { headers.set('X-Soduwork-Device', active.clientId); headers.set('X-Soduwork-Secret', active.secret); }
      return fetchImpl(url.href, { method, headers, ...(init.body !== undefined ? { body: init.body } : {}),
        signal, redirect: 'error', credentials: 'omit' });
    };
    try {
      signal.throwIfAborted();
      let response = await send();
      await current();
      if (response.status === 401 && active.session) {
        const refreshed = await require('../device-auth-request').refreshAccountIdentity(active, signal, async previous => {
          const session = await auth.ensureSession(app, { ...previous, staleSession: previous.session });
          const next = assertSame({ ...previous, session });
          await current();
          latestSession = session;
          return next;
        });
        await current();
        if (refreshed) {
          await response.body?.cancel?.().catch(() => {});
          active.session = refreshed.session;
          signal.throwIfAborted();
          response = await send();
        }
        await current();
      }
      if (response.redirected || response.status >= 300 && response.status < 400 ||
          response.url && response.url !== url.href) {
        await response.body?.cancel?.().catch(() => {});
        throw failure('RUNTIME_AUTH_REDIRECT_DENIED', '执行接口重定向已拒绝');
      }
      const body = redactBody(await responseBody(response), trusted.secret);
      await current();
      const headers = [...new Headers(response.headers).entries()].filter(([key]) =>
        !/^(?:set-cookie|set-cookie2|authorization|x-soduwork-secret|x-device-key)$/i.test(key));
      // fetch transparently decompresses payloads; these headers describe the
      // network bytes and must not be reused to reconstruct a local Response.
      const decodedHeaders = headers.filter(([key]) => !/^(?:content-encoding|content-length|transfer-encoding)$/i.test(key))
        .map(([key, text]) => [key, trusted.secret ? text.split(trusted.secret).join('[hidden]') : text]);
      const statusText = trusted.secret ? String(response.statusText || '').split(trusted.secret).join('[hidden]')
        : String(response.statusText || '');
      return { status: response.status, statusText, headers: decodedHeaders, body };
    } finally { controller.abort(); controllers.delete(controller); }
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const controller of controllers) controller.abort(changed());
    controllers.clear();
    latestSession = '';
  }
  return Object.freeze({ ensureSession, request, publicIdentity, close });
}

module.exports = { createHostAuth, MAX_RESPONSE_BYTES };
