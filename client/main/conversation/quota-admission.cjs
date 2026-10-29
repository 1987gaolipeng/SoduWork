'use strict';

const { fetchWithDeviceAuthRetry } = require('../device-auth-request');
const { scope } = require('./runtime-segments');

function create({ app, identityOf, onQuotaExceeded, fetchImpl = global.fetch }) {
  return async function authorize(expected, expectedScope = scope(expected)) {
    const identity = await identityOf(app);
    const matches = value => value && value.hub === expected?.hub &&
      value.clientId === expected?.clientId && scope(value) === expectedScope;
    if (!matches(identity)) throw Error('账号或连接环境已变化，请重新发送');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetchWithDeviceAuthRetry(identity,
        identity.hub.replace(/\/+$/, '') + '/api/v1/client-auth/authorize-ai',
        { signal: controller.signal }, fetchImpl);
      const result = await response.json().catch(() => null);
      if (!matches(await identityOf(app))) throw Error('账号或连接环境已变化，请重新发送');
      const quota = result?.quota;
      if (!response.ok || result?.ok !== true || typeof quota?.enabled !== 'boolean' ||
          typeof quota?.exceeded !== 'boolean' || quota.exceeded) {
        const detail = quota?.exceeded ? { code: 'TOKEN_QUOTA_EXCEEDED',
          message: '本月 AI Token 额度已用完，请联系管理员调整额度', quota } : result?.detail;
        if (detail?.code === 'TOKEN_QUOTA_EXCEEDED') onQuotaExceeded?.({
          hub: identity.hub, clientId: identity.clientId, quota: detail.quota });
        throw Error(detail?.message || (response.status === 404
          ? '服务端需要升级后才能校验个人 Token 额度' : '无法确认可用额度，请稍后重试'));
      }
      return result.quota;
    } finally { clearTimeout(timer); }
  };
}

function beforeTurn(authorize, identity, previous) {
  const expectedScope = scope(identity);
  return async (...args) => {
    await authorize(identity, expectedScope);
    return previous?.(...args);
  };
}

module.exports = { create, beforeTurn };
