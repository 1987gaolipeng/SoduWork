'use strict';
// Map recognized structured provider errors to fixed messages without exposing paths, URLs, credentials, or raw diagnostics.
const MESSAGES = {
 permission: '企业微信授权文件被本机安全策略拦截，请检查客户端数据目录权限后重试',
 network: '无法连接企业微信授权服务，请检查网络或代理后重试',
 timeout: '企业微信授权等待超时，请重新连接并完成扫码确认',
 auth: '企业微信授权未通过，请重新连接并在手机上确认',
 crypto: '企业微信凭据无法安全保存，请检查本机系统密钥服务后重试',
 protocol: '企业微信授权服务返回异常，请稍后重试',
 runtime: '企业微信运行环境无法启动或版本不兼容，请重新准备运行环境',
 unknown: '企业微信连接未完成，请重试；若仍失败，请检查本机运行环境',
};
const CODES = { 893006: 'permission', 893101: 'network', 893102: 'network', 893103: 'protocol',
 893201: 'auth', 893202: 'timeout', 893203: 'crypto' };
const TYPES = { PermissionError: 'permission', NetworkError: 'network', HttpError: 'network',
 ParseError: 'protocol', AuthError: 'auth', QrTimeout: 'timeout', CryptoError: 'crypto' };
function structured(raw) {
 const text = typeof raw === 'string' ? raw.slice(-65536) : '';
 const start = text.search(/\{\s*"error"\s*:\s*\{/), end = text.lastIndexOf('}');
 if (start < 0 || end < start) return null;
 try { const value = JSON.parse(text.slice(start, end + 1)); return value && value.error; }
 catch (_) { return null; }
}
function message(result) {
 const data = structured(result?.output) || structured(result?.error);
 if (data && typeof data === 'object') {
  const kind = Number.isSafeInteger(data.code) && Object.hasOwn(CODES, data.code) ? CODES[data.code]
   : typeof data.type === 'string' && Object.hasOwn(TYPES, data.type) ? TYPES[data.type] : '';
  if (kind) return MESSAGES[kind];
 }
 if (result instanceof Error) {
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(result.code) || /^平台程序响应超时/.test(result.message)) return MESSAGES.timeout;
  if (['EACCES', 'EPERM'].includes(result.code)) return MESSAGES.permission;
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(result.code)) return MESSAGES.network;
  if (['ENOENT', 'ENOEXEC'].includes(result.code) || /^无法启动平台程序/.test(result.message)) return MESSAGES.runtime;
 }
 return result?.code === 2 ? MESSAGES.runtime : MESSAGES.unknown;
}
module.exports = { message };
