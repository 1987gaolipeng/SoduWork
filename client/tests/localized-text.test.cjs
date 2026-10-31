/*
 * Test locale precedence, fallback resolution, and default locale in the shared text
 * primitive.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../core/localized-text.js'), 'utf8');

function load(locale) {
  const c = { window: { SoduWorkI18n: { getLocale: () => locale } } };
  vm.createContext(c);
  vm.runInContext(source, c);
  return c.window.SoduworkLocalizedText;
}

test('pickLocale 精确命中并去除首尾空白', () => {
  const t = load('en-US');
  assert.equal(t.pickLocale({ 'en-US': '  Daily work summary  ' }, 'en-US'), 'Daily work summary');
});

test('pickLocale 大小写不敏感兜底（历史小写键）', () => {
  const t = load('en-US');
  assert.equal(t.pickLocale({ 'en-us': 'Daily' }, 'en-US'), 'Daily');
});

test('pickLocale zh-CN 直接回退基础字段（返回空）', () => {
  const t = load('zh-CN');
  assert.equal(t.pickLocale({ 'zh-CN': '不该被读到' }, 'zh-CN'), '');
});

test('pickLocale 缺失/垃圾输入安全返回空', () => {
  const t = load('ja-JP');
  assert.equal(t.pickLocale(null, 'ja-JP'), '');
  assert.equal(t.pickLocale({ 'en-US': 'x' }, ''), '');
  assert.equal(t.pickLocale({ 'en-US': '   ' }, 'en-US'), '');
  assert.equal(t.pickLocale({ 'ko-KR': 42 }, 'ko-KR'), '');
});

test('resolve 回退链：界面语言译文 → 管理员原文', () => {
  const t = load('en-US');
  assert.equal(t.resolve({ name: '每日工作总结', nameLocales: { 'en-US': 'Daily work summary' } }, 'name'), 'Daily work summary');
  assert.equal(t.resolve({ name: '每日工作总结', nameLocales: { 'ja-JP': '日次サマリ' } }, 'name'), '每日工作总结');
  assert.equal(t.resolve({ name: '每日工作总结' }, 'name'), '每日工作总结');
  assert.equal(t.resolve({ name: '每日工作总结' }, 'note'), '');
});

test('resolve 缺省 locale 时读当前界面语言', () => {
  const t = load('ko-KR');
  assert.equal(t.resolve({ name: 'x', nameLocales: { 'ko-KR': 'y' } }, 'name'), 'y');
});

test('currentLocale without i18n defaults to English', () => {
  const c = { window: {} };
  vm.createContext(c);
  vm.runInContext(source, c);
  assert.equal(c.window.SoduworkLocalizedText.currentLocale(), 'zh-CN');
});
