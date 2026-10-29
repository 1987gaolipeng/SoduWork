'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'skills', 'browser-use', 'scripts', 'browser.mjs'), 'utf8');

test('browser-use bounds every CDP request', () => {
  assert.match(source, /CDP_REQUEST_TIMEOUT_MS\s*=\s*30\s*\*\s*1000/);
  assert.match(source, /pend\.delete\(i\);\s*\n\s*rej\(new Error\(method \+ ' 超过 30 秒没有响应'\)\)/);
});

test('browser-use exits deterministically after a completed command', () => {
  assert.match(source, /setTimeout\(\(\) => process\.exit\(process\.exitCode \|\| 0\), 100\)/);
  assert.match(source, /exitTimer\.unref\(\)/);
});
