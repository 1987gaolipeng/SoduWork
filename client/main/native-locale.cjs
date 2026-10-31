'use strict';
const catalogs = require('../core/locales/manifest.json');
const registry = require('../core/locales/locale-registry.js');
const localeCatalogs = {};
for (const file of catalogs.filter(name => /^[a-z]{2}-[A-Z]{2}(?:-|\.)/.test(name))) {
  const locale = file.slice(0, 5);
  const pack = require('../core/locales/' + file);
  if (pack && typeof pack === 'object') localeCatalogs[locale] = { ...(localeCatalogs[locale] || {}), ...pack };
}
const messages = localeCatalogs['en-US'] || {};
const templates = Object.entries(messages).filter(([s]) => /\{\w+\}/.test(s)).sort(([a], [b]) => b.replace(/\{\w+\}/g, '').length - a.replace(/\{\w+\}/g, '').length).map(([s, target]) => {
  const names = [];
  const pattern = s.split(/(\{\w+\})/).map(part => {
    if (/^\{\w+\}$/.test(part)) { names.push(part.slice(1, -1)); return '([\\s\\S]*?)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return { expression: new RegExp('^' + pattern + '$'), names, target };
});
let locale = registry.defaultLocale || 'en-US';
function translate(source) {
  if (typeof source !== 'string') return source;
  if (locale === 'zh-CN') return source === 'Select a project folder to share' ? '选择要分享的项目文件夹' : source;
  const active = localeCatalogs[locale] || messages;
  if (Object.hasOwn(active, source)) return active[source];
  if (Object.hasOwn(messages, source)) return messages[source];
  if (source.includes('\n')) return source.split('\n').map(translate).join('\n');
  const removal = /^删除“([\s\S]*)”？$/.exec(source);
  if (removal) return 'Delete “' + removal[1] + '”?';
  const stop = /^停止「([\s\S]*)」？$/.exec(source);
  if (stop) return 'Stop “' + stop[1] + '”?';
  for (const template of templates) {
    const match = template.expression.exec(source);
    if (!match) continue;
    const values = Object.fromEntries(template.names.map((name, i) => [name, match[i + 1]]));
    return template.target.replace(/\{(\w+)\}/g, (token, name) => values[name] ?? token);
  }
  const install = /^安装([\s\S]+)？$/.exec(source);
  if (install) return 'Install ' + install[1] + '?';
  // A release note or error payload is data. Only localize known UI lines.
  return source;
}
function dialogOptions(options) {
  if (!options || typeof options !== 'object') return options;
  const result = { ...options };
  for (const key of ['title', 'message', 'detail', 'buttonLabel']) if (result[key]) result[key] = translate(result[key]);
  if (result.buttons) result.buttons = result.buttons.map(translate);
  if (result.filters) result.filters = result.filters.map(filter => ({ ...filter, name: translate(filter.name) }));
  return result;
}
function normalize(value) {
  const raw = String(value || '').trim();
  if (registry.locales[raw]) return raw;
  if (/^en(?:[-_]|$)/i.test(raw)) return 'en-US';
  if (/^ja(?:[-_]|$)/i.test(raw)) return 'ja-JP';
  if (/^(ko|kr)(?:[-_]|$)/i.test(raw)) return 'ko-KR';
  return registry.defaultLocale || 'en-US';
}
module.exports = { translate, dialogOptions, getLocale() { return locale; }, setLocale(value) { locale = normalize(value); }, normalize };
