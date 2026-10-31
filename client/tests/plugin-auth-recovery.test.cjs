'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const recovery = require('../components/panels/plugin-auth-recovery');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '..', 'components', 'panels', name), 'utf8');

test('plugin authorization metadata is reduced to missing runtime capabilities', () => {
  assert.deepEqual(recovery.authorization({
    missing: ['browser', 'browser', 'computer', 'x'.repeat(200)],
    missingMcp: ['calendar'],
    readOnlyConflicts: ['repository'],
    unsupported: ['legacy'],
    required: ['browser', 'computer', 'calendar'],
  }), {
    missing: ['browser', 'computer', 'x'.repeat(80)],
    missingMcp: ['calendar'],
    readOnlyConflicts: ['repository'],
    unsupported: ['legacy'],
    required: ['browser', 'computer', 'calendar'],
  });
});

test('new-session continuation preserves the failed draft and adds missing capabilities', () => {
  const file = { name: 'steps.docx', size: 12 };
  const payload = recovery.newSessionPayload({
    text: 'Use the steps and create the report.',
    files: [file],
    plugins: [{ pluginId: 'local:app-developer', name: '即用开发', inputValues: { target: 'report' } }],
  }, { missing: ['browser'] }, {
    capabilities: ['office'], cwd: 'C:\\work', workspaceLabel: 'Work', projectId: 'p1',
  });
  assert.deepEqual(payload.capabilities, ['office', 'browser']);
  assert.equal(payload.prefill, 'Use the steps and create the report.');
  assert.deepEqual(payload.initialFiles, [file]);
  assert.deepEqual(payload.initialPlugins.map(row => row.pluginId), ['local:app-developer']);
  assert.equal(payload.newSession, true);
  assert.equal(payload.tab, 'chat');
  assert.equal(payload.cwd, 'C:\\work');
});

test('new-session continuation keeps the full supported draft length', () => {
  const payload = recovery.newSessionPayload({ text: 'x'.repeat(50000), files: [], plugins: [] },
    { missing: ['browser'] }, {});
  assert.equal(payload.prefill.length, 50000);
});

test('connector-only failures do not offer a capability session handoff', () => {
  assert.equal(recovery.newSessionPayload({ text: 'x', files: [], plugins: [] }, {
    missing: [], missingMcp: ['calendar'],
  }, {}), null);
});

test('renderer uses a dedicated handoff action and composer accepts the preserved selection', () => {
  assert.match(read('chat-message-renderer.js'), /data-plugin-new-session/);
  assert.match(read('chat-composer-bindings.js'), /_openPluginAuthRecovery/);
  const compose = read('panels-compose.js');
  assert.match(compose, /q\.initialPlugins/);
  assert.match(compose, /_requestedCapabilities/);
});
