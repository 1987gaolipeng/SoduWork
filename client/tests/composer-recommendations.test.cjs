'use strict';
/* Contract tests for the composer-page starter recommendation row: rest state must stay
   clean (hover-only background), each row carries the black "open app" pill action, and
   the row's UI strings route through the shared locale bridge. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const surface = fs.readFileSync(path.join(ROOT, 'components/panels/compose-surface.js'), 'utf8');
const composerCss = fs.readFileSync(path.join(ROOT, 'components/panels/work-composer.css'), 'utf8');

test('recommendation rows render one black open-app pill and no plus glyph', () => {
  assert.match(surface, /cp-recs-open/, 'row must render the open-app pill');
  assert.doesNotMatch(surface, /appsx-card-add/, 'the plus glyph is replaced by the pill action');
  assert.match(surface, /open\.textContent = _uiText\('打开即用'\)/, 'pill label routes through the locale bridge');
  assert.match(surface, /headTitle\.textContent = _uiText\('推荐'\)/, 'module head routes through the locale bridge');
  assert.match(surface, /item\.description \|\| _uiText\('打开即用工作界面'\)/, 'fallback copy routes through the locale bridge');
});

test('row cards keep the light-gray layer visible at rest and deepen it on hover', () => {
  assert.match(composerCss, /\.compose-panel \.cp-recs \.appsx-card\{[^}]*background:var\(--bg-1\)\}/,
    'rest state must keep the neutral light-gray layer visible (hovered look persists)');
  assert.match(composerCss, /\.compose-panel \.cp-recs \.appsx-card:hover\{background:var\(--bg-2\)\}/,
    'hover deepens the layer for live feedback');
});

test('open-app pill is an always-visible black ellipse at the row right edge', () => {
  assert.match(composerCss, /\.cp-recs-open\{[^}]*border-radius:999px/, 'pill shape');
  assert.match(composerCss, /\.cp-recs-open\{[^}]*background:var\(--ink\)/, 'black pill background');
  assert.doesNotMatch(composerCss, /\.cp-recs-open\{[^}]*opacity:0/, 'pill must not hide at rest');
});

test('built-in locale packs carry the new recommendation strings', () => {
  const enGap = fs.readFileSync(path.join(ROOT, 'core/locales/en-US-gap-pages.js'), 'utf8');
  const enCore = fs.readFileSync(path.join(ROOT, 'core/locales/en-US.js'), 'utf8');
  assert.match(enGap, /'打开即用':/, 'en-US must translate the pill label');
  assert.match(enCore, /'推荐':/, 'en-US must translate the module head');
  for (const pack of ['ja-JP-gap-pages.js', 'ko-KR-gap-pages.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'core/locales', pack), 'utf8');
    assert.match(source, /'打开即用':/, pack + ' must translate the pill label');
    assert.match(source, /'推荐':/, pack + ' must translate the module head');
  }
});
