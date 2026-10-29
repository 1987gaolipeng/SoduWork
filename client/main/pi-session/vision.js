'use strict';

/* The Hub vision endpoint intentionally accepts four images per request.  A
   conversation can contain more than one request, so the client batches the
   full attachment set instead of rejecting the turn at the first boundary. */
const MAX_IMAGES = 20;
const MAX_BATCH_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_ALL_BYTES = 100 * 1024 * 1024;
const SUPPORTED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const { fetchWithDeviceAuthRetry } = require('../device-auth-request');

function compact(images) {
  const source = Array.isArray(images) ? images : [];
  if (source.length > MAX_BATCH_IMAGES) {
    return { ok: false, reason: '单次视觉请求最多识别 ' + MAX_BATCH_IMAGES + ' 张图片' };
  }
  let total = 0;
  const output = [];
  for (let index = 0; index < source.length; index++) {
    const item = source[index] || {};
    const mimeType = String(item.mimeType || item.type || '').toLowerCase();
    if (!SUPPORTED.has(mimeType)) {
      return { ok: false, reason: '第 ' + (index + 1) + ' 张图片格式暂不支持' };
    }
    const data = String(item.data || '');
    const bytes = Math.floor(data.length * 3 / 4);
    if (!data || bytes > MAX_IMAGE_BYTES) {
      return { ok: false, reason: '第 ' + (index + 1) + ' 张图片为空或超过 8 MB' };
    }
    total += bytes;
    if (total > MAX_TOTAL_BYTES) return { ok: false, reason: '本次图片总大小超过 20 MB' };
    output.push({ mimeType, data });
  }
  return { ok: true, images: output };
}

async function analyze(identity, images, context, timeoutMs = 120000, fetchImpl = global.fetch, options = {}) {
  if (!identity || !identity.hub || !identity.clientId || (!identity.session && !identity.secret)) {
    return { ok: false, reason: '这台电脑还没有有效的 SoduWork 设备会话，无法调用视觉模型' };
  }
  const source = Array.isArray(images) ? images : [];
  if (source.length > MAX_IMAGES) {
    return { ok: false, reason: '一次最多识别 ' + MAX_IMAGES + ' 张图片' };
  }
  if (!source.length) return { ok: true, skipped: true };

  const batches = [];
  let estimatedTotal = 0;
  for (let offset = 0; offset < source.length; offset += MAX_BATCH_IMAGES) {
    const checked = compact(source.slice(offset, offset + MAX_BATCH_IMAGES));
    if (!checked.ok) return checked;
    estimatedTotal += checked.images.reduce((sum, item) =>
      sum + Math.floor(String(item.data || '').length * 3 / 4), 0);
    if (estimatedTotal > MAX_ALL_BYTES) {
      return { ok: false, reason: '本次图片总大小超过 100 MB' };
    }
    batches.push(checked.images);
  }

  const results = [];
  for (const batch of batches) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const hub = String(identity.hub).replace(/\/+$/, '');
      const payload = JSON.stringify({
        images: batch, context: String(context || '').slice(0, 6000) });
      const response = await fetchWithDeviceAuthRetry(identity, hub + '/api/v1/ai-proxy/vision/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal, body: payload,
      }, fetchImpl);
      let body = {};
      try { body = await response.json(); } catch (_) {}
      if (!response.ok || !body.ok) {
        const fallback = response.status === 401
          ? '设备凭据被 SoduWork 后台拒绝，请重启客户端重新登录'
          : '视觉模型服务不可用（HTTP ' + response.status + '）';
        return { ok: false, reason: body.reason || fallback };
      }
      results.push(body);
    } catch (error) {
      const reason = error && error.name === 'AbortError'
        ? '视觉模型识别超时，请稍后重试'
        : '连接视觉模型失败：' + String((error && error.message) || error);
      return { ok: false, reason };
    } finally {
      clearTimeout(timer);
    }
  }

  const imageCount = results.reduce((sum, item, index) =>
    sum + Number(item.imageCount || batches[index].length), 0);
  const observation = results.length === 1 ? results[0].observation : {
    summary: '已分批完成 ' + imageCount + ' 张图片的视觉观察',
    batches: results.map((item, index) => ({
      imageRange: [index * MAX_BATCH_IMAGES + 1,
        index * MAX_BATCH_IMAGES + batches[index].length],
      imageCount: Number(item.imageCount || batches[index].length),
      observation: item.observation,
    })),
  };
  return {
    ok: true, model: results[0].model, provider: results[0].provider,
    imageCount, observation,
    warnings: results.flatMap((item) => Array.isArray(item.warnings) ? item.warnings : []),
  };
}

module.exports = {
  analyze, compact, MAX_IMAGES, MAX_BATCH_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES, MAX_ALL_BYTES,
};
