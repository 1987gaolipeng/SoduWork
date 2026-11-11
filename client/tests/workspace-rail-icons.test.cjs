'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const shell = fs.readFileSync(path.join(__dirname, '../components/workspace/workspace-shell.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../components/workspace/workspace-navigation.css'), 'utf8');

test('workspace rail reuses the apps page gift icon and restores other sidebar icons', () => {
  assert.match(shell, /APP_PAGE_GIFT_MARKUP/);
  assert.match(shell, /class="ws-rail-app-icon ws-icon-solid"/);
  assert.match(shell, /class="ws-icon-line"[^>]+data-icon="' \+ key/);
  assert.doesNotMatch(shell, /MULTI_SOLID_ICONS|APP_ICON_FIXED_COLORS|colorfulSolid/);
  assert.doesNotMatch(css, /ws-rail-button\.active \.ws-icon-solid\[data-icon=/);
  assert.match(css, /\.ws-rail-account\{[^}]*width:32px;height:32px/);
  assert.match(css, /\.ws-rail-avatar\{[^}]*width:24px;height:24px/);
});
