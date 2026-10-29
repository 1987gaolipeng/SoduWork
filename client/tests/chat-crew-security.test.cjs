'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
global.window = global;
require('../components/panels/agent-brand.js');
const crew = require('../components/panels/chat-crew.js');
delete global.window;

test('crew detail and session header escape runtime names, states and summaries', () => {
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const rows = crew._rowsHtml({ nodes: [{ name: hostile, state: hostile,
    executor: { resolved: { agentKind: hostile } } }] });
  const header = crew._headHtml({ headline: hostile, detail: hostile, beads: [{ id: hostile }] });
  for (const html of [rows, header]) {
    assert.ok(html.includes('&lt;img'));
    assert.doesNotMatch(html, /<script|<img src=x|onerror="alert/);
  }
});
