const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'desk.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'components/settings/settings.css'), 'utf8');

test('settings styles load once after workspace chrome', () => {
  const marker = 'href="components/settings/settings.css"';
  assert.equal(html.split(marker).length - 1, 1);
  assert.ok(html.indexOf(marker) > html.indexOf('href="theme/workspace-experience.css"'));
});
test('settings cards use explicit spans, independent of account-card insertion', () => {
  assert.equal((html.match(/class="set-group set-half"/g) || []).length, 2);
  assert.equal((html.match(/class="set-group set-third"/g) || []).length, 3);
  assert.doesNotMatch(css, /nth-of-type/);
  for (const id of ['boxNameSave', 'workRootSave', 'skinOpenBtn', 'clientUpdateAction']) {
    assert.equal(html.split('id="' + id + '"').length - 1, 1);
  }
  assert.doesNotMatch(html, /id="hubUrlSave"/, 'the production endpoint is fixed');
});
test('settings primary controls and checkboxes share the theme token', () => {
  assert.match(css, /--settings-accent:\s*var\(--accent/);
  assert.match(css, /\.hub-save\s*\{[^}]*background:\s*var\(--settings-accent\)/);
  assert.match(css, /accent-color:\s*var\(--settings-accent\)/);
  assert.match(css, /--settings-small:\s*max\(var\(--font-min-readable,\s*14\.5px\),/);
  assert.match(css, /prefers-reduced-motion/);
});
test('closed settings do not cover other workspace pages', () => {
  assert.match(css, /#settingsPanel:not\(\.show\)\s*\{\s*display:\s*none\s*!important/);
});
