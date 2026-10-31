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

test('wide workspace library selection toolbar follows the panel width', () => {
  const css = read('components/panels/panels-library.css');
  assert.match(css, /html\[data-desk-panel="workspace"\] #libraryPanel \.library-batch-toolbar\{[\s\S]*?width:100%;[\s\S]*?max-width:none;[\s\S]*?box-sizing:border-box;/);
});

test('workspace navigation keeps compact icons and accessible color active states', () => {
  const css = read('components/workspace/workspace-shell.css');
  const js = read('components/workspace/workspace-shell.js');
  assert.match(css, /\.ws-nav-item svg\{width:15px;height:15px;flex:0 0 15px/);
  // The user's gray state is open line art, not a desaturated solid icon.
  assert.match(js, /RAIL_COLOR_ICONS = new Set\(\['home', 'history', 'skills', 'schedules', 'library'\]\)/);
  assert.match(css, /\.ws-rail-button\{[^}]*width:36px;height:36px/);
  assert.match(css, /\.ws-rail-button \.ws-icon-solid\{display:none/);
  assert.match(css, /\.ws-rail-button\.active \.ws-icon-line\{display:none/);
  assert.match(css, /\.ws-rail-button\.active \.ws-icon-solid\{display:block/);
  assert.match(css, /\.ws-rail-button \.ws-rail-art\{display:none;width:22px;height:22px;object-fit:contain/);
  assert.match(css, /\.ws-rail-button \.ws-rail-line-art\{width:22px;height:22px\}/);
  assert.doesNotMatch(css, /grayscale\(/);
  assert.match(js, /<svg class="ws-icon-line"[^>]*aria-hidden="true" focusable="false"/);
  assert.match(js, /<img class="ws-rail-art ws-icon-solid" src="assets\/rail-icons\/' \+ key \+ '\.svg"[^>]*alt="" aria-hidden="true" draggable="false"/);
  assert.match(js, /<button class="ws-rail-button" type="button"[^>]*aria-label="/);
  assert.match(js, /if \(selected\) button\.setAttribute\('aria-current', 'page'\);\s*else button\.removeAttribute\('aria-current'\)/);
});

test('all five rail icons ship self-contained transparent vector artwork', () => {
  const js = read('components/workspace/workspace-shell.js');
  const declaration = js.match(/const RAIL_COLOR_ICONS = new Set\(\[([^\]]+)\]\)/);
  assert.ok(declaration);
  const keys = [...declaration[1].matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
  assert.deepEqual(keys, ['history', 'home', 'library', 'schedules', 'skills']);
  for (const key of keys) {
    const svg = read('assets/rail-icons/' + key + '.svg');
    assert.match(svg, /<svg[^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"[^>]*viewBox="0 0 40 40"[^>]*fill="none"/);
    assert.match(svg, /<\/svg>\s*$/);
    assert.doesNotMatch(svg, /<(?:script|image|foreignObject)|(?:href|onload|onclick)=/i);
    assert.match(svg, /#4f8df7/);
    assert.ok(new Set([...svg.matchAll(/fill="(#[a-f0-9]+)"/gi)].map(m => m[1])).size >= 2, key + ' retains distinct layers');
    assert.doesNotMatch(svg, /<rect[^>]*width="40"[^>]*height="40"/, key + ' has no enclosing tile');
  }
});

test('request pool rail uses task-tray artwork while other menus retain their compact glyph', () => {
  const css = read('components/workspace/workspace-shell.css');
  const js = read('components/workspace/workspace-shell.js');
  assert.match(css, /\.ws-nav-item svg\{width:15px;height:15px;flex:0 0 15px/);
  assert.match(js, /history: lineGlyph\(/);
  assert.match(js, /RAIL_COLOR_ICONS\.has\(key\)\s*\? '<svg class="ws-icon-line ws-rail-line-art"/);
  assert.match(js, /RAIL_LINE_ICONS\[key\]/);
  const artwork = read('assets/rail-icons/history.svg');
  assert.match(artwork, /fill="#fbbf24"/);
  assert.match(artwork, /stroke="#fff"/);
  assert.match(artwork, /fill="#7c5cf0"/);
});
