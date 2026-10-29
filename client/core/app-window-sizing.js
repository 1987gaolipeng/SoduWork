(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SoduWorkAppWindowSizing = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const defaults = Object.freeze({ width: '1800px', height: '1125px', minWidth: '480px', minHeight: '360px' });
  const labels = { width: '打开宽度', height: '打开高度', minWidth: '最小宽度', minHeight: '最小高度', maxWidth: '打开时最大宽度', maxHeight: '打开时最大高度' };
  function length(value, label, fallback) {
    if (value == null || value === '') return fallback;
    if (!['string', 'number'].includes(typeof value)) throw Error(label + '格式不正确');
    const match = String(value).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(px|vw|vh)?$/);
    if (!match) throw Error(label + '请填写数字、px、vw 或 vh，例如 1280 或 100vw');
    const number = Number(match[1]), unit = match[2] || 'px';
    if (!(number > 0 && number <= (unit === 'px' ? 100000 : 1000))) throw Error(label + '超出允许范围');
    return String(number) + unit;
  }
  function threshold(value, label, fallback) {
    if (value == null || value === '') return fallback;
    if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value))) throw Error(label + '须为非负整数');
    const number = Number(value);
    if (number > 100000) throw Error(label + '超出允许范围');
    return number;
  }
  function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
  function normalize(raw) {
    if (raw == null) raw = {};
    if (!object(raw)) throw Error('窗口配置须为对象');
    const result = {};
    for (const key of Object.keys(labels)) result[key] = length(raw[key], labels[key], defaults[key] || null);
    for (const axis of ['Width', 'Height']) {
      const min = result['min' + axis], max = result['max' + axis];
      if (max && min.endsWith('px') && max.endsWith('px') && parseFloat(min) > parseFloat(max)) {
        throw Error(labels['min' + axis] + '不能大于' + labels['max' + axis]);
      }
    }
    if (raw.rules != null && !Array.isArray(raw.rules)) throw Error('屏幕适配规则须为列表');
    if ((raw.rules || []).length > 12) throw Error('屏幕适配规则最多 12 条');
    result.rules = (raw.rules || []).map((rule, index) => {
      if (!object(rule)) throw Error('第 ' + (index + 1) + ' 条屏幕规则格式不正确');
      const name = '第 ' + (index + 1) + ' 条规则：';
      const minScreenWidth = threshold(rule.minScreenWidth, name + '屏幕宽度下限', 0);
      const maxScreenWidth = threshold(rule.maxScreenWidth, name + '屏幕宽度上限', null);
      if (maxScreenWidth != null && maxScreenWidth < minScreenWidth) throw Error(name + '屏幕宽度上限不能小于下限');
      const width = length(rule.width, name + labels.width, null), height = length(rule.height, name + labels.height, null);
      if (!width && !height) throw Error(name + '至少填写打开宽度或高度');
      return { minScreenWidth, maxScreenWidth, width, height };
    });
    return result;
  }
  function pixels(value, area) {
    const number = parseFloat(value);
    if (value.endsWith('vw')) return Math.round(number * area.width / 100);
    if (value.endsWith('vh')) return Math.round(number * area.height / 100);
    return Math.round(number);
  }
  function resolve(raw, displayArea) {
    const settings = normalize(raw), input = displayArea || {};
    const area = { x: Number.isFinite(input.x) ? Math.round(input.x) : 0,
      y: Number.isFinite(input.y) ? Math.round(input.y) : 0,
      width: Number.isFinite(input.width) && input.width > 0 ? Math.floor(input.width) : 1280,
      height: Number.isFinite(input.height) && input.height > 0 ? Math.floor(input.height) : 800 };
    const matchedRule = settings.rules.findIndex(rule => area.width >= rule.minScreenWidth &&
      (rule.maxScreenWidth == null || area.width <= rule.maxScreenWidth));
    const rule = settings.rules[matchedRule] || {};
    const capW = Math.max(1, Math.min(area.width, settings.maxWidth ? pixels(settings.maxWidth, area) : area.width));
    const capH = Math.max(1, Math.min(area.height, settings.maxHeight ? pixels(settings.maxHeight, area) : area.height));
    const minWidth = Math.max(1, Math.min(capW, pixels(settings.minWidth, area)));
    const minHeight = Math.max(1, Math.min(capH, pixels(settings.minHeight, area)));
    const width = Math.max(minWidth, Math.min(capW, pixels(rule.width || settings.width, area)));
    const height = Math.max(minHeight, Math.min(capH, pixels(rule.height || settings.height, area)));
    return { bounds: { x: area.x + Math.floor((area.width - width) / 2), y: area.y + Math.floor((area.height - height) / 2), width, height },
      limits: { minWidth, minHeight }, matchedRule, workArea: area };
  }
  function opening(raw, displayArea) {
    const result = resolve(raw, displayArea), { bounds, limits, workArea } = result;
    const startMaximized = bounds.width === workArea.width && bounds.height === workArea.height &&
      (limits.minWidth < bounds.width || limits.minHeight < bounds.height);
    const width = startMaximized ? Math.max(limits.minWidth, Math.round(bounds.width * .85)) : bounds.width;
    const height = startMaximized ? Math.max(limits.minHeight, Math.round(bounds.height * .85)) : bounds.height;
    const normalBounds = { x: workArea.x + Math.floor((workArea.width - width) / 2),
      y: workArea.y + Math.floor((workArea.height - height) / 2), width, height };
    return { ...result, normalBounds, startMaximized };
  }
  return Object.freeze({ normalize, resolve, opening, defaults });
});
