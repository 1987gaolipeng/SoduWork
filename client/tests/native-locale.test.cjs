const test = require('node:test');
const assert = require('node:assert/strict');
const locale = require('../main/native-locale.cjs');

test('catalog composition preserves package order, source dictionaries and prototype-like translation keys', () => {
  const packs = {
    'en-US-first.js': Object.freeze({ collision: 'First', retained: 'Retained' }),
    'builtin-fixture.js': Object.freeze({
      'en-US': Object.freeze({ collision: 'Builtin', builtinOnly: 'Builtin only' }),
      'ja-JP': Object.freeze({ collision: 'Builtin Japanese', japaneseOnly: 'Japanese only' }),
    }),
    'en-US-last.js': Object.freeze(JSON.parse('{"collision":"Last","__proto__":"Own proto","constructor":"Own constructor"}')),
    'ja-JP-last.js': Object.freeze({ collision: 'Last Japanese' }),
  };
  const before = JSON.stringify(packs), module = { exports: {} };
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../main/native-locale.cjs'), 'utf8'), {
    module,
    require(name) {
      if (name.endsWith('/manifest.json')) return Object.keys(packs);
      if (name.endsWith('/locale-registry.js')) return { defaultLocale: 'en-US', locales: { 'en-US': {}, 'ja-JP': {} } };
      const pack = packs[name.replace('../core/locales/', '')];
      assert.ok(pack, name); return pack;
    },
  });
  const composed = module.exports;
  assert.equal(composed.translate('collision'), 'Last');
  assert.equal(composed.translate('retained'), 'Retained');
  assert.equal(composed.translate('builtinOnly'), 'Builtin only');
  assert.equal(composed.translate('__proto__'), 'Own proto');
  assert.equal(composed.translate('constructor'), 'Own constructor');
  assert.equal(composed.translate('toString'), 'toString');
  composed.setLocale('ja-JP');
  assert.equal(composed.translate('collision'), 'Last Japanese');
  assert.equal(composed.translate('japaneseOnly'), 'Japanese only');
  assert.equal(composed.translate('retained'), 'Retained');
  assert.equal(JSON.stringify(packs), before);
});

test('native dialog translation preserves file paths, filter extensions and source options', () => {
  const original = { title: '下载附件', defaultPath: 'D:/保存/文件.txt', buttons: ['取消', '保存'],
    filters: [{ name: 'SoduWork 插件', extensions: ['soduwork-plugin', 'zip'] }], properties: ['openFile'] };
  locale.setLocale('en-US');
  const options = locale.dialogOptions(original);
  assert.equal(options.title, 'Download attachment');
  assert.deepEqual(options.buttons, ['Cancel', 'Save']);
  assert.equal(options.filters[0].name, 'SoduWork plugin');
  assert.equal(options.defaultPath, original.defaultPath);
  assert.deepEqual(options.filters[0].extensions, original.filters[0].extensions);
  assert.equal(original.title, '下载附件');
  assert.equal(original.filters[0].name, 'SoduWork 插件');
  locale.setLocale('zh-CN');
  assert.deepEqual(locale.dialogOptions(original), original);
});

test('native dialog copy localizes complete actions without translating inserted chat names', () => {
  locale.setLocale('en-US');
  assert.equal(locale.translate('删除“保存  和 删除”？'), 'Delete “保存  和 删除”?');
  assert.equal(locale.translate('停止「删除」？'), 'Stop “删除”?');
  assert.equal(locale.translate('这是发布说明：保存与删除的实现'), '这是发布说明：保存与删除的实现');
  assert.equal(locale.translate('SoduWork 已准备好更新\n这是发布说明'), 'SoduWork is ready to update\n这是发布说明');
  assert.equal(locale.translate('例如：保存\n还有 5 项工作没有结束'), 'For example: 保存\nWork still in progress: 5');
  locale.setLocale('zh-CN');
  assert.equal(locale.translate('删除“保存”？'), '删除“保存”？');
});

test('native windows accept the additional locale packs and use translated copy', () => {
  locale.setLocale('ja');
  assert.equal(locale.getLocale(), 'ja-JP');
  assert.equal(locale.translate('设置'), '設定');
  assert.equal(locale.translate('模型服务'), 'モデルサービス');
  locale.setLocale('ko-KR');
  assert.equal(locale.getLocale(), 'ko-KR');
  assert.equal(locale.translate('设置'), '설정');
  locale.setLocale('zh-CN');
});
