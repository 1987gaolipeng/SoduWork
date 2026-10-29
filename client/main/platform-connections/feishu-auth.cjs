// Personal app registration uses the official Node SDK. Device OAuth follows
// larksuite/cli internal/auth/device_flow.go (MIT); credentials stay in the main process.
'use strict';
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const runtime = require('./runtime.cjs');
const SCOPES = Object.freeze(['offline_access', 'docx:document', 'drive:drive',
  'wiki:wiki', 'bitable:app', 'im:chat:read']);
const TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
function failure(code) {
  const messages = {
    abort: '已取消本次飞书授权', expired_token: '飞书授权已过期，请重新扫码',
    access_denied: '未获得飞书授权，请重新连接并在飞书中确认',
    invalid_grant: '飞书登录已失效，请重新扫码授权',
    invalid_client: '飞书应用已失效，请在飞书开放平台检查应用状态',
    brand: '当前插件支持飞书账号，请使用飞书完成扫码',
    response: '飞书授权返回不完整，请重新连接',
    identity: '未能确认飞书个人身份，请重新扫码授权',
    network: '暂时无法连接飞书，请检查网络后重试',
    scope: '飞书未授予所需权限，请重新连接并确认权限',
  };
  return Object.assign(Error(messages[code] || '飞书授权未完成，请检查应用权限或企业审批后重试'), { code });
}
function check(signal) { if (signal?.aborted) throw failure(signal.reason?.code === 'brand' ? 'brand' : signal.reason?.name === 'TimeoutError' ? 'expired_token' : 'abort'); }
function seconds(value, fallback, max = 3600) {
  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
}
function authUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (_) { throw failure('response'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
      !(url.hostname === 'feishu.cn' || url.hostname.endsWith('.feishu.cn')) || url.href.length > 8192 ||
      [...url.searchParams.keys()].some(key => /secret|password|access_token|refresh_token|device_code/i.test(key))) {
    throw failure('response');
  }
  return url.href;
}
function bounded(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { try { check(signal); } catch (error) { reject(error); } };
    signal.addEventListener('abort', abort, { once: true });
    // Observe SDK rejection even when its callback synchronously aborts before
    // this wrapper receives the promise. Never leave a rejected SDK run unhandled.
    Promise.resolve(promise).then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
async function registerApp(app, { signal, progress }) {
  const prefix = runtime.paths(app, 'feishu').prefix;
  const sdk = require(path.join(prefix, 'node_modules/@larksuiteoapi/node-sdk'));
  if (typeof sdk.registerApp !== 'function') throw Error('飞书运行环境需要更新，请重新准备环境');
  const ctl = new AbortController();
  const active = AbortSignal.any([signal || new AbortController().signal, ctl.signal, AbortSignal.timeout(660000)]);
  try {
    check(active);
    const result = await bounded(sdk.registerApp({
      signal: active, source: 'soduwork', createOnly: true,
      appPreset: { name: 'SoduWork 助手 {user}', desc: '通过 SoduWork 使用本人授权的飞书文档、知识库、多维表格和群组信息' },
      addons: { preset: false, scopes: { user: [...SCOPES] } },
      onQRCodeReady({ url, expireIn }) {
        check(active);
        progress({ state: 'awaiting_user', phase: 'app_registration', authUrl: authUrl(url),
          expiresAt: Date.now() + seconds(expireIn, 600) * 1000,
          message: '第一步：打开飞书官方页面，扫码并确认创建 SoduWork 应用。应用配置将自动保存。' });
      },
      onStatusChange({ status }) {
        check(active);
        if (status === 'domain_switched') { ctl.abort(failure('brand')); throw failure('brand'); }
      },
    }), active);
    check(active);
    if (result.user_info?.tenant_brand && result.user_info.tenant_brand !== 'feishu') throw failure('brand');
    if (!/^cli_[a-zA-Z0-9]{5,100}$/.test(result.client_id) || typeof result.client_secret !== 'string' ||
        !result.client_secret || result.client_secret.length > 512) throw failure('response');
    return { appId: result.client_id, appSecret: result.client_secret };
  } catch (error) {
    if (signal?.aborted) check(signal);
    throw failure(error.code || (active.aborted ? 'expired_token' : 'network'));
  } finally { ctl.abort(); }
}
async function json(url, options, signal, fetchImpl = fetch) {
  check(signal);
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'error',
      signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(15000)]) });
    const data = await response.json();
    check(signal);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('response');
    return { response, data };
  } catch (error) {
    check(signal);
    throw failure(error.code === 'response' ? 'response' : 'network');
  }
}
function form(body, headers = {}) {
  return { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body).toString() };
}
function tokens(data, now = Date.now(), before = {}) {
  if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 16384) throw failure('response');
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : before.refreshToken || '';
  if (refreshToken.length > 16384) throw failure('response');
  return { accessToken: data.access_token, refreshToken,
    expiresAt: now + seconds(data.expires_in, 7200, 86400) * 1000,
    refreshExpiresAt: data.refresh_token_expires_in ? now + seconds(data.refresh_token_expires_in, 604800, 31536000) * 1000 :
      before.refreshExpiresAt || (refreshToken ? now + 604800000 : 0),
    grantedScope: typeof data.scope === 'string' ? data.scope : before.grantedScope || '' };
}
async function authorize(value, { signal, progress, fetchImpl = fetch, sleep = delay, now = Date.now } = {}) {
  const started = await json('https://accounts.feishu.cn/oauth/v1/device_authorization',
    form({ client_id: value.appId, scope: SCOPES.join(' ') },
      { Authorization: 'Basic ' + Buffer.from(value.appId + ':' + value.appSecret).toString('base64') }), signal, fetchImpl);
  const data = started.data;
  if (!started.response.ok || data.error) throw failure(data.error || 'response');
  if (typeof data.device_code !== 'string' || !data.device_code || data.device_code.length > 4096) throw failure('response');
  const url = authUrl(data.verification_uri_complete || data.verification_uri);
  const expiresAt = now() + seconds(data.expires_in, 240) * 1000;
  let interval = seconds(data.interval, 5, 60);
  const active = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(Math.ceil(expiresAt - now()))]);
  progress({ state: 'awaiting_user', phase: 'user_authorization', authUrl: url, expiresAt,
    userCode: /^[A-Za-z0-9-]{4,32}$/.test(data.user_code || '') ? data.user_code : '',
    message: '应用已就绪：打开飞书官方页面，扫码授权个人账号；页面要求时输入下方设备码。' });
  while (now() < expiresAt) {
    try { await sleep(Math.min(interval * 1000, expiresAt - now()), undefined, { signal: active }); }
    catch (_) { check(active); }
    check(active);
    if (now() >= expiresAt) break;
    let reply;
    try {
      reply = await json(TOKEN_URL, form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: data.device_code, client_id: value.appId, client_secret: value.appSecret }), active, fetchImpl);
    } catch (error) {
      if (error.code !== 'network') throw error;
      interval = Math.min(interval + 1, 60); continue;
    }
    const result = reply.data;
    if (result.error === 'authorization_pending') continue;
    if (result.error === 'slow_down') { interval = Math.min(interval + 5, 60); continue; }
    if (!reply.response.ok || result.error) throw failure(result.error || 'response');
    return tokens(result, now());
  }
  throw failure('expired_token');
}
async function userInfo(accessToken, signal, fetchImpl = fetch) {
  const { response, data } = await json('https://open.feishu.cn/open-apis/authen/v1/user_info',
    { method: 'GET', headers: { Authorization: 'Bearer ' + accessToken } }, signal, fetchImpl);
  if (!response.ok || data.code !== 0 || typeof data.data?.open_id !== 'string' || !data.data.open_id) throw failure('identity');
  return { openId: data.data.open_id, name: String(data.data.name || '飞书用户').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) };
}
async function refresh(value, signal, fetchImpl = fetch) {
  if (!value.refreshToken || (value.refreshExpiresAt && value.refreshExpiresAt <= Date.now())) throw failure('invalid_grant');
  const { response, data } = await json(TOKEN_URL, form({ grant_type: 'refresh_token',
    refresh_token: value.refreshToken, client_id: value.appId, client_secret: value.appSecret }), signal, fetchImpl);
  if (!response.ok || data.error || (data.code && data.code !== 0)) throw failure(data.error || 'invalid_grant');
  return tokens(data, Date.now(), value);
}
module.exports = { SCOPES, registerApp, authorize, userInfo, refresh, authUrl, failure, check };
