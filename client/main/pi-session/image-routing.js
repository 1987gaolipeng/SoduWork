'use strict';

// A legacy cached [text, image] declaration is not proof of a native route.
function isNative(model) {
  return model?.imageRouting === 'native' && model?.input?.includes('image') === true;
}

function requireAdapter(model) {
  if (model?.visionFallbackAvailable !== true) {
    throw new Error('当前所选模型未启用原生图片输入，且未配置可选的视觉适配服务。请手动选择支持图片输入的模型后重试；原图已保留，未自动更换模型。');
  }
}

function observationInputs(model, currentImages, messages, options = {}) {
  if (isNative(model)) return [];
  // Text follow-ups do not automatically re-analyze historical images.
  // New attachments still require vision; archives are never rewritten.
  if (options.allowHistoryOmission && !currentImages?.length) return [];
  const images = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!['user', 'toolResult'].includes(message?.role) || !Array.isArray(message.content)) continue;
    images.push(...message.content.filter(block => block?.type === 'image'));
  }
  images.push(...(Array.isArray(currentImages) ? currentImages : []));
  if (images.length) requireAdapter(model);
  // SDK conversion omits old tool images for text models. Observe the retained
  // context before that conversion, without rewriting the user's transcript.
  const seen = new Map();
  return images.filter(image => {
    const mime = String(image.mimeType || '').toLowerCase();
    if (!seen.has(mime)) seen.set(mime, new Set());
    const data = image.data;
    if (seen.get(mime).has(data)) return false;
    seen.get(mime).add(data);
    return true;
  });
}

function historyNotice(model, currentImages, messages) {
  if (isNative(model) || currentImages?.length) return '';
  const hasImages = (messages || []).some(message => ['user', 'toolResult'].includes(message?.role) &&
    Array.isArray(message.content) && message.content.some(block => block?.type === 'image'));
  return hasImages ? '【历史图片不可见】当前模型仅接收文字；历史原图仍保留，但本轮没有读取这些图片。按用户本轮文字继续，不要求用户为普通沟通反复切换模型；不得声称看过图片，需要视觉事实时说明限制。' : '';
}

module.exports = { isNative, requireAdapter, observationInputs, historyNotice };
