'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('批量删除确认只展示选择数量，不把文件名展开到弹窗', () => {
  const source = read('components/panels/panels-library.js');
  assert.match(source, /description: '已选择 \{count\} 项资料，将移入回收站，仍可恢复。'/);
  assert.match(source, /descriptionParams: \{ count: rows\.length \}/);
  assert.match(source, /descriptionClass: 'library-confirm-batch'/);
  assert.doesNotMatch(source, /const names = rows\.slice\(0, 3\)\.map\(displayName\)/);
});

test('批量删除确认说明使用独立的紧凑样式并支持英文翻译', () => {
  const dialogs = read('components/panels/panels-library-dialogs.js');
  const css = read('components/panels/panels-library.css');
  const locale = read('core/locales/en-US-library.js');
  assert.match(dialogs, /descriptionClass/);
  assert.match(css, /\.library-confirm-description\.library-confirm-batch\{/);
  assert.match(locale, /'已选择 \{count\} 项资料，将移入回收站，仍可恢复。':/);
});

test('资料库分享支持文件夹与混合选择，并将文件夹交给服务端打包', () => {
  const source = read('components/panels/panels-library.js');
  const api = read('api.js');
  const dialogs = read('components/panels/panels-library-dialogs.js');
  assert.match(source, /data-library-select-folder/);
  assert.match(source, /folderIds/);
  assert.match(source, /data-library-share-folder/);
  assert.match(api, /payload\.folderIds/);
  assert.match(dialogs, /压缩包只能下载或保存到资料库/);
});
