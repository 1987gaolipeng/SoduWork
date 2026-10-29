'use strict';

/* Enterprise-derived personal drafts retain live source authorization. Pure
   personal plugins stay local and never acquire a network dependency. */
const { fetchWithDeviceAuthRetry } = require('./device-auth-request');

function sourceId(value) {
  const id = String(value || '').trim();
  if (id && !/^[A-Za-z0-9_.:-]{1,64}$/.test(id)) throw Error('企业插件来源标识无效');
  return id;
}

function sourceOf(plugin) {
  if (!plugin) return '';
  const ids = [...new Set([plugin.sourcePluginId,
    ...(plugin.versions || []).map(version => version.body?.sourcePluginId)]
    .map(sourceId).filter(Boolean))];
  if (ids.length > 1) throw Error('本机插件来源不一致，请重新取得企业插件草稿');
  return ids[0] || '';
}

function inheritBody(plugins, body) {
  const existing = (plugins || []).find(plugin => plugin.key === body.key);
  const saved = sourceOf(existing), requested = sourceId(body.sourcePluginId);
  if (saved && requested && saved !== requested) throw Error('不能更换已有插件的企业来源');
  return saved || requested ? { ...body, sourcePluginId: saved || requested } : body;
}

function sourcesForIds(plugins, ids) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
  return [...new Set((plugins || []).filter(plugin => wanted.has(plugin.id)).map(sourceOf).filter(Boolean))];
}

function sameIdentity(before, after) {
  return Boolean(after && before.hub === after.hub && before.clientId === after.clientId &&
    before.secret === after.secret && before.session === after.session);
}

async function check(options) {
  const opts = options || {};
  const sources = [...new Set((opts.sourceIds || []).map(sourceId).filter(Boolean))];
  if (!sources.length) return;
  if (sources.length > 3) throw Error('一次最多校验三个企业插件来源');
  const action = opts.action === 'edit' ? 'canEdit' : 'canUse';
  const identity = typeof opts.identityOf === 'function' ? await opts.identityOf(opts.app) : null;
  if (!identity?.hub || !identity.clientId || (!identity.session && !identity.secret)) {
    throw Error('企业插件需要连接后台校验当前权限，请登录后重试');
  }
  const controller = new AbortController();
  const timeoutMs = Math.max(10, Math.min(10000, Number(opts.timeoutMs) || 10000));
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(); reject(Error('企业插件权限校验超时，请连接后台后重试'));
    }, timeoutMs);
  });
  try {
    await Promise.race([timeout, (async () => {
      for (const id of sources) {
        const url = String(identity.hub).replace(/\/+$/, '') +
          '/api/v1/plugins/' + encodeURIComponent(id) + '/permissions';
        const response = await fetchWithDeviceAuthRetry(identity, url, {
          method: 'GET', signal: controller.signal, redirect: 'error',
          headers: { Accept: 'application/json' },
        }, opts.fetchImpl || global.fetch);
        const length = Number(response.headers?.get?.('content-length') || 0);
        if (length > 65536) throw Error('企业插件权限响应无效');
        const data = await response.json();
        if (!response.ok || data?.[action] !== true) {
          throw Error(action === 'canEdit' ? '你没有源插件的编辑改进权限，或权限已被管理员收回' :
            '你没有源插件的使用权限，或权限已被管理员收回');
        }
      }
    })()]);
    const current = await opts.identityOf(opts.app);
    if (!sameIdentity(identity, current)) throw Error('当前登录账号已变化，请重新操作');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function authorizer({ app, identityOf, fetchImpl, read, normalizeBody }) {
  const checkIds = (ids, action) => check({ app, identityOf, fetchImpl, action,
    sourceIds: sourcesForIds(read(app).plugins, ids) });
  return {
    ids: checkIds,
    async body(raw) {
      const body = inheritBody(read(app).plugins, normalizeBody(raw));
      await check({ app, identityOf, fetchImpl, action: 'edit', sourceIds: [body.sourcePluginId] });
      const latest = inheritBody(read(app).plugins, body);
      if (sourceId(latest.sourcePluginId) !== sourceId(body.sourcePluginId)) {
        throw Error('插件来源已变化，请重新打开草稿后保存');
      }
      return body;
    },
    async key(key) {
      const plugin = read(app).plugins.find(item => item.key === String(key || ''));
      await check({ app, identityOf, fetchImpl, action: 'edit', sourceIds: [sourceOf(plugin)] });
    },
  };
}

module.exports = { check, authorizer, sourceOf, sourcesForIds, inheritBody };
