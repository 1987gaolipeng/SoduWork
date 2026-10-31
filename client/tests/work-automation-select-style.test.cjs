'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../components/panels/work-automation-sheet.css'), 'utf8');

test('automation creation selects use the themed control instead of the browser native chrome', () => {
  assert.match(css, /\.waz-field select\{[\s\S]*appearance:none/);
  assert.match(css, /\.waz-field select\{[\s\S]*background-image:[\s\S]*linear-gradient/);
  assert.match(css, /\.waz-field select:enabled:hover/);
  assert.match(css, /\.waz-field select:focus-visible/);
  assert.match(css, /\.waz-field select:disabled/);
  assert.match(css, /@media\(forced-colors:active\)[\s\S]*\.waz-field select/);
});
