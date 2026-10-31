'use strict';
// Formal app type is additive: historical UI plugins keep their old contract.
function validate(template, ui) {
  if (template !== 'app') return;
  const pages = (ui?.contributions || []).filter(item => item.slot === 'workspace.navigation' && ['external', 'package'].includes(item.source?.type));
  if (!pages.some(item => item.source.openMode !== 'external')) {
    throw new Error('即用必须声明 ui.contributions 中的 workspace.navigation 网页地址或包内页面，并由即用壳打开');
  }
  for (const page of pages) {
    if (page.source.type === 'package') { require('./plugin-package-page.cjs').entry(page.source.entry); continue; }
    let url;
    try { url = new URL(page.source.url); } catch (_) { throw new Error('即用页面需要有效的 HTTP(S) 地址'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('即用页面地址不能包含账号或密码');
  }
}
const categories = Object.freeze(['office','game','robot','other']);
function category(value) {
  if (value == null || value === '') return 'other';
  if (!categories.includes(value)) throw Error('请选择有效的即用分类');
  return value;
}
module.exports = { validate, category, categories };
