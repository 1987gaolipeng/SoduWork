'use strict';






const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const DIRS = ['components/panels', 'components/workspace', 'components/pet', 'core', 'app'];

function walk(dir) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full)
    .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))   // Node tests may use global.
    .map((name) => path.join(dir, name).replace(/\\/g, '/'));
}

test('渲染层文件不许裸用 global：没有 IIFE 形参就必须写 window', () => {
  const offenders = [];
  for (const rel of DIRS.flatMap(walk)) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    const uses = source.match(/(^|[^.\w$])global\s*[.[]/g) || [];
    if (!uses.length) continue;
    /* Allow explicitly declared global wrapper parameters. */
    const declares = /\(\s*function\s*\(\s*global\b/.test(source)
      || /\(\s*\(\s*global\b[^)]*\)\s*=>/.test(source)
      || /\bfunction\s*\(\s*global\s*\)/.test(source);
    if (!declares) offenders.push(rel + '（用了 ' + uses.length + ' 处）');
  }
  assert.deepEqual(offenders, [],
    '这些文件里的 global 在浏览器里是 ReferenceError：' + offenders.join('、'));
});
