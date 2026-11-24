'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = readFileSync(path.join(__dirname, '..', 'components', 'panels', 'panels-usage.css'), 'utf8');

test('usage cards respond to the panel width and the ranking owns its scrollport', () => {
  assert.match(css, /container:usage-panel\s*\/\s*inline-size/);
  assert.match(css, /\.usage-rank-scroll\s*\{[^}]*contain:size[^}]*overflow-y:auto/);
  assert.match(css, /@container usage-panel \(max-width:800px\)\s*\{\s*\.usage-grid\s*\{grid-template-columns:1fr/);
  assert.match(css, /\.usage-rank-scroll\s*\{flex:none;contain:none;max-height:250px/);
});

test('small panels retain record metadata and allow totals to wrap', () => {
  assert.match(css, /\.usage-big,\.usage-balance\s*\{[^}]*flex-wrap:wrap/);
  const narrow = css.slice(css.indexOf('@container usage-panel (max-width:620px)'));
  assert.match(narrow, /\.usage-records \.usage-extra\s*\{display:none/);
  assert.match(narrow, /\.usage-records td \.usage-mobile\s*\{display:block/);
});

test('recent work footer contains only right-aligned pagination', () => {
  const panel = readFileSync(path.join(__dirname, '..', 'components', 'panels', 'panels-usage.js'), 'utf8');
  const footer = panel.split('class="usage-line usage-foot"')[1].split('</section>')[0];
  assert.match(footer, /usagePrev.*usageNext/);
  assert.doesNotMatch(footer, /北京时间/);
  assert.match(css, /\.usage-foot\s*\{[^}]*justify-content:flex-end/);
});
