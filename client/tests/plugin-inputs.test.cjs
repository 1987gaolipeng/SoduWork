'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sheet = fs.readFileSync(
  path.join(root, 'components', 'panels', 'plugin-input-sheet.js'), 'utf8');

test('任务转交按统一插件参数契约渲染选项、数字、说明与默认值', () => {
  assert.match(sheet, /field\.type === 'select'/);
  assert.match(sheet, /field\.type === 'number'/);
  assert.match(sheet, /field\.description/);
  assert.match(sheet, /field\.default/);
  assert.match(sheet, /form\.elements\[field\.key\]/);
  assert.match(sheet, /Number\(raw\)/);
});
