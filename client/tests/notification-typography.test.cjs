'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');

const panelsDesk = fs.readFileSync(path.join(
  __dirname, '..', 'components', 'panels', 'panels-desk.css'
), 'utf8');
const workspaceShell = fs.readFileSync(path.join(
  __dirname, '..', 'components', 'workspace', 'workspace-shell.css'
), 'utf8');

function cssRule(selector, source) {
  const escaped = selector.replace(/[.*+?^()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp('(?:^|\\n)\\s*' + escaped + '\\s*\\{([^}]*)\\}'));
  assert.ok(match, 'missing notification CSS rule: ' + selector);
  return match[1];
}

test('notification content keeps the shared 14.5px minimum', () => {
  for (const selector of ['.np-day', '.np-unread-pill', '.np-txt', '.np-time', '.np-empty']) {
    assert.match(cssRule(selector, panelsDesk), /font-size:max\(var\(--font-min-readable,\s*14\.5px\),\s*12px\)(?:;|$)/,
      selector + ' must remain readable at the shared floor');
  }
});

test('workspace notification kicker cannot introduce a sub-floor size', () => {
  assert.match(workspaceShell, /\.np-kicker/,
    'workspace notification kicker selector must remain part of the shared page-head rules');
  assert.doesNotMatch(workspaceShell, /\.np-kicker[^{}]*\{[^}]*font-size:\s*(?:[0-9]|1[0-3])(?:\.\d+)?px/,
    'workspace notification kicker must not use an unguarded sub-floor size');
});
