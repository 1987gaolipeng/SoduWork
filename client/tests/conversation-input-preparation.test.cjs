const test = require('node:test');
const assert = require('node:assert/strict');

const { eligible, normalize } = require('../main/conversation/conversation-input-contract.cjs');

const supported = { conversationInputPreparation: { schemaVersion: 1, available: true } };
const base = { ownerScope: 'u:1', sessionId: 's1', submissionId: 'sub1', draftRevision: 1,
  userText: '按步骤处理数据', attachments: [{ attachmentId: 'steps', hash: 'h1' }, { attachmentId: 'data', hash: 'h2' }],
  plugins: [] };
const materials = [
  { attachmentId: 'steps', hash: 'h1', readStatus: 'read', roles: ['steps'], coverage: [{ type: 'paragraph', locator: 'p1' }], source: { type: 'attachment', attachmentId: 'steps' } },
  { attachmentId: 'data', hash: 'h2', readStatus: 'read', roles: ['object'], coverage: [{ type: 'sheet', locator: 'Sheet1!A1:C4' }], source: { type: 'attachment', attachmentId: 'data' } },
];

test('only folded text is bypassed, while no-plugin materials are eligible', () => {
  assert.equal(eligible({ userText: '折叠原文', userTextSource: 'folded', attachments: [], materialReferences: [] }, supported), false);
  assert.equal(eligible(base, supported), true);
  assert.equal(eligible({ ...base, plugins: [], attachments: [], materialReferences: [{ attachmentId: 'old' }] }, supported), true);
  assert.equal(eligible(base, { conversationInputPreparation: { available: false } }), false);
});

test('normalizes no-plugin input with roles and sources', () => {
  const out = normalize(base, materials, { goal: '处理数据', materials: materials.map((m) => ({ attachmentId: m.attachmentId, roles: m.roles, source: m.source })) });
  assert.deepEqual(out.inputsByPlugin, {});
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.status, 'ready');
  assert.equal(out.materials[0].roles[0], 'steps');
  assert.equal(out.userText, base.userText);
});

test('explicit values and userText win over inferred values and preserve conflicts', () => {
  const snap = { ...base, plugins: [{ id: 'p', version: '1.0.0', inputSchema: {
    format: { type: 'enum', values: ['csv', 'xlsx'], required: true }, client: { type: 'string', required: true },
  } }], inputValues: { format: 'csv', client: 'manual-client' }, explicitParameters: ['format', 'client'] };
  const out = normalize(snap, materials, { goal: '处理数据', inferredInputsByPlugin: { p: { format: 'xlsx', client: 'other-client' } }, materials: materials.map((m) => ({ attachmentId: m.attachmentId, roles: m.roles })) });
  assert.equal(out.inputsByPlugin.p.format.value, 'csv');
  assert.equal(out.inputsByPlugin.p.format.source, 'explicit');
  assert.equal(out.inputsByPlugin.p.client.value, 'manual-client');
  assert.equal(out.status, 'needs_input');
  assert.match(out.questions[0].question, /client|冲突/i);
});

test('rejects unknown material ids, fields, and invalid enums', () => {
  assert.throws(() => normalize(base, materials, { materials: [{ attachmentId: 'missing', roles: ['object'] }] }), /material/i);
  assert.throws(() => normalize(base, materials, { materials: [{ attachmentId: 'steps', roles: ['bogus'] }] }), /role/i);
  assert.throws(() => normalize(base, materials, { materials: [{ attachmentId: 'steps', roles: ['steps'], mystery: true }] }), /field/i);
  assert.throws(() => normalize({ ...base, plugins: [{ id: 'p', inputSchema: { format: { type: 'enum', values: ['csv'] } } }], inputValues: { format: 'xls' } }, materials, {}), /enum|format/i);
});

test('keeps explicit empty userText distinct from absent text', () => {
  assert.equal(normalize({ ...base, userText: '' }, materials, {}).userText, '');
  const absent = { ...base }; delete absent.userText;
  assert.equal(normalize(absent, materials, {}).userText, null);
});
