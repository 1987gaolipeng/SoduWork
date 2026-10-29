'use strict';
const choice = require('../../core/model-choice');
const { fetchWithDeviceAuthRetry } = require('../device-auth-request');

async function resolve(identity, key, fetchImpl = global.fetch) {
  const selected = choice.imageChoice(key);
  if (!selected) return { ok: false, reason: '图片模型选择无效' };
  try {
    const hub = String(identity.hub || '').replace(/\/+$/, '');
    const response = await fetchWithDeviceAuthRetry(identity,
      hub + '/api/v1/ai-proxy/media/config', {
        redirect: 'error', signal: AbortSignal.timeout(10000),
      }, fetchImpl);
    if (!response.ok) return { ok: false, reason: '图片模型目录暂不可用，请检查服务端版本和连接' };
    const data = await response.json();
    const row = (data.models?.image || []).find(row => row.providerId === selected.providerId && row.name === selected.name);
    if (!row || !data.key) return { ok: false, reason: '所选图片模型已不可用，请重新选择' };
    return { ok: true, model: { id: row.name, providerId: row.providerId, label: '生成图片 · ' + (row.label || row.name),
      modality: 'image', baseUrl: hub + '/api/v1/ai-proxy/v1', key: data.key,
      contextWindow: 128000, contextWindowKnown: true, contextWindowEstimated: true, contextWindowSource: 'safe-default', input: ['text'] } };
  } catch (_) { return { ok: false, reason: '无法加载图片模型，请检查后台连接' }; }
}
module.exports = { ...choice, resolve };
