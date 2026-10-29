'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'panels', 'panels-usage.css'),
  'utf8',
);

test('usage panel responds to its own width inside the workspace shell', () => {
  assert.match(css, /container:usage-panel\s*\/\s*inline-size/);
  assert.match(css, /@container usage-panel \(max-width:980px\)/);
  assert.match(css, /@container usage-panel \(max-width:720px\)/);
  assert.match(css, /grid-template-areas:"total" "vitals" "flow" "trend"/);
});

test('usage total can wrap without pushing the vitals column off-screen', () => {
  assert.match(css, /\.usage-total>div\{[^}]*min-width:0[^}]*flex-wrap:wrap/);
  assert.match(css, /\.usage-total b\{[^}]*clamp\(34px,4cqw,50px\)/);
});

test('token counts use compact units so billion-scale totals cannot overflow', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'components', 'panels', 'panels-usage.js'),
    'utf8',
  );
  assert.match(src, /function compact\(value\)/);
  // Use compact values in totals, metrics, and recent work while retaining exact tooltip counts.
  assert.match(src, /'<div><b>' \+ compact\(total\) \+ '<\/b><em>tokens<\/em><\/div>'/);
  assert.match(src, /'<strong>' \+ compact\(item\.tokens\) \+ '<\/strong>/);
  assert.match(src, /usage-event-value"><b>' \+ compact\(item\.tokens\) \+ '<\/b>/);
  // Verify full small-number formatting, compact-unit thresholds, and trailing-zero removal.
  const start = src.indexOf('function compact(value)'), end = src.indexOf('function precise(', start);
  assert.ok(start >= 0 && end > start);
  const compact = require('node:vm').runInNewContext(src.slice(start, end) + '\ncompact', {
    count: value => String(value),
  });
  assert.equal(compact(9999), '9999');
  assert.equal(compact(10000), '1 万');
  assert.equal(compact(12500), '1.3 万');
  assert.equal(compact(1e8), '1 亿');
  assert.equal(compact(1e12), '1 万亿');
});
