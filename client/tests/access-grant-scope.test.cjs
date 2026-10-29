'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), os = require('node:os');
const policies = require('../main/access-control/policy');
const { create } = require('../main/access-control/broker');

test('session shell grants ignore display metadata but preserve command, cwd, env, tool and unknown inputs', async t => {
  const policy = policies.create('standard', os.tmpdir()), broker = create({ policy });
  t.after(() => broker.close());
  const operation = { action: 'command.execute', tool: 'bash', cwd: policy.workspaceRoot,
    arguments: { command: 'npm test', description: 'Run tests', timeout: 10 }, verdict: 'ask' };
  const first = broker.authorize(operation), request = broker.pending()[0];
  broker.answer({ ...request, decision: 'session' }); assert.equal(await first, true);
  assert.equal(await broker.authorize({ ...operation, arguments: { command: 'npm test', description: 'Recheck', timeout: 20 } }), true);
  for (const change of [
    { arguments: { command: 'npm install' } }, { cwd: policy.workspaceRoot + '-other' },
    { arguments: { command: 'npm test', env: { MODE: 'write' } } },
    { arguments: { command: 'npm test', unknownOption: true } }, { tool: 'custom_bash' },
  ]) {
    const waiting = broker.authorize({ ...operation, ...change });
    assert.equal(broker.pending().length, 1, JSON.stringify(change));
    broker.cancel(); assert.equal(await waiting, false);
  }
});

test('session grants release matching queued operations; once releases only one and mandatory once cannot be bypassed', async t => {
  const policy = policies.create('standard', os.tmpdir()), broker = create({ policy });
  t.after(() => broker.close());
  const op = { action: 'command.execute', tool: 'bash', arguments: { command: 'npm test' }, verdict: 'ask' };
  const first = broker.authorize(op), second = broker.authorize(op);
  broker.answer({ ...broker.pending()[0], decision: 'once' });
  assert.equal(await first, true); assert.equal(broker.pending().length, 1);
  broker.answer({ ...broker.pending()[0], decision: 'deny' }); assert.equal(await second, false);
  broker.beginTurn();
  const a = broker.authorize(op), b = broker.authorize(op);
  broker.answer({ ...broker.pending()[0], decision: 'session' });
  assert.deepEqual(await Promise.all([a, b]), [true, true]); assert.equal(broker.pending().length, 0);
  const forced = broker.authorize({ ...op, allowSession: false }), request = broker.pending()[0];
  assert.deepEqual(request.choices, ['once', 'deny']);
  assert.equal(broker.answer({ ...request, decision: 'session' }).ok, false);
  broker.answer({ ...request, decision: 'once' }); assert.equal(await forced, true);
});

test('MCP fields named description or timeout remain part of the grant', async t => {
  const policy = policies.create('standard', os.tmpdir()), broker = create({ policy });
  t.after(() => broker.close());
  const op = { action: 'tool.execute', tool: 'mcp.create_record', arguments: { description: 'Original', timeout: 1 }, verdict: 'ask' };
  const first = broker.authorize(op); broker.answer({ ...broker.pending()[0], decision: 'session' }); await first;
  const other = broker.authorize({ ...op, arguments: { description: 'Changed', timeout: 2 } });
  assert.equal(broker.pending().length, 1); broker.cancel(); assert.equal(await other, false);
});

test('a session reply never admits an expired queued request before its timer fires', async t => {
  const policy = policies.create('standard', os.tmpdir()), broker = create({ policy, timeoutMs: 10000 });
  t.after(() => broker.close());
  const op = { action: 'command.execute', tool: 'bash', arguments: { command: 'npm test' }, verdict: 'ask' };
  const now = Date.now;
  try {
    const first = broker.authorize(op);
    Date.now = () => now() + 5000;
    const second = broker.authorize(op), later = broker.pending()[1];
    Date.now = () => now() + 12000;
    assert.equal(broker.answer({ ...later, decision: 'session' }).ok, true);
    assert.equal(await first, false); assert.equal(await second, true);
  } finally { Date.now = now; }
});
