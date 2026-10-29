'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('client capability center exposes one connection catalog for connectors and MCP records', () => {
  const source = read('components/panels/panels-capabilities.js');
  const css = read('components/panels/panels-capabilities.css');
  assert.match(source, /tabButton\('connections'/);
  assert.doesNotMatch(source, /tabButton\('(apps|mcp)'/);
  assert.match(source, /tab === 'connections'/);
  assert.match(source, /renderMcp\(content\)/);
  assert.match(css, /\.cap-tab-connections/);
  assert.doesNotMatch(css, /\.cap-tab-(apps|mcp)/);
});

test('library document titles use readable regular weight', () => {
  const css = read('components/panels/panels-library.css');
  assert.match(css, /\.library-card-copy b\{[^}]*font-weight:500/);
  assert.match(css, /\.library-content\.is-list \.library-card-copy b\{[^}]*font-weight:500/);
  assert.match(css, /\.library-content:not\(\.is-list\) \.library-file-card \.library-card-copy b,[\s\S]*?font-weight:500/);
  assert.doesNotMatch(css, /\.library-content\.is-list \.library-card-copy b\{[^}]*font-weight:(?:59|6|7)\d/);
});

test('workspace navigation uses compact icons and a storage-box icon for the issue entry', () => {
  const css = read('components/workspace/workspace-shell.css');
  const js = read('components/workspace/workspace-shell.js');
  assert.match(css, /\.ws-nav-item svg\{width:15px;height:15px;flex:0 0 15px/);
  assert.match(js, /history: lineGlyph\('<path d="M4 8\.5h16v10\.25/);
});
