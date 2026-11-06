'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), os = require('node:os');
const { canonicalEntry, entriesOf } = require('../main/conversation/persisted-entry-compat.cjs');
const policy = require('../main/access-control/policy');

test('preceding archive permissions restore without expanding mode, root or revision', () => {
  const root = os.tmpdir();
  const old = {type: 'custom', customType: 'sodo.access.policy',
    data: {schema: 'sodo.access-policy/v1', mode: 'readonly', revision: 4, workspaceRoot: root}};
  const pending = {...old, customType: 'sodo.access.pending', data: {...old.data, mode: 'standard', revision: 5}};
  const [saved, next] = entriesOf({getEntries: () => [old, pending]});
  const restored = policy.restoreState(saved.data, next.data, root);
  assert.equal(restored.accessPolicy.mode, 'readonly');
  assert.equal(restored.accessPolicy.revision, 4);
  assert.equal(restored.nextAccessPolicy.mode, 'standard');
  assert.throws(() => policy.restore(saved.data, path.join(root, 'different')), /workspace mismatch/);
  assert.equal(old.data.schema, 'sodo.access-policy/v1', 'original archive is not mutated');
});

test('unknown schemas and arbitrary custom entries remain untrusted', () => {
  const old = {type: 'custom', customType: 'sodo.access.policy', data: {schema: 'unknown'}};
  assert.throws(() => policy.restore(canonicalEntry(old).data, os.tmpdir()), /Invalid access policy/);
  const user = {type: 'message', customType: 'sodo.model.selection', data: {name: 'untrusted'}};
  assert.equal(canonicalEntry(user), user);
  const unknown = {type: 'custom', customType: 'foreign.access.policy'};
  assert.equal(canonicalEntry(unknown), unknown);
});

test('known model and owner entries preserve their data and ordering', () => {
  const owner = {type: 'custom', customType: 'sodo.work-entry', data: {version: 1, owner: 'foreign'}};
  const model = {type: 'custom', customType: 'sodo.model.selection', data: {name: 'previous-model'}};
  const entries = entriesOf({getEntries: () => [owner, model]});
  assert.equal(entries[0].data.owner, 'foreign');
  assert.equal(entries[0].customType, 'soduwork.work-entry');
  assert.equal(entries[1].data.name, 'previous-model');
});
