'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const native = require('../main/conversation/device-history-native.cjs');

const id = 'acp-legacy-chat', command = 'Review changes';
const digest = crypto.createHash('sha256').update(command).digest('hex');
function plan(seq, segment, end) {
  return { seq, kind: 'do', tool: 'Plan', text: command, arguments: { command }, callId: '', toolKind: '',
    seg: segment, _stream: 'out', _streamEnd: end };
}
const events = [
  { seq: 1, kind: 'do', tool: 'Read', callId: 'read' },
  plan(2, 1, 100),
  { seq: 3, kind: 'out', callId: 'read', text: 'Complete' },
  { seq: 4, kind: 'user', text: 'Keep the original order' },
  plan(5, 1, 200), // A real tool_call with empty IDs, identical after normalization.
  { seq: 6, kind: 'say', text: 'Response' },
  plan(7, 2, 100),
  { seq: 8, kind: 'do', tool: 'Write', callId: 'pending' },
];
const plans = [[1, 100, digest], [1, 200, ''], [2, 100, digest]];
const proof = { ref: id, revision: events.length, plans };

function read(receipt, rows = events, previous) {
  const runtime = { async rpc(op, args) {
    if (op === 'job.session') return { ok: true,
      data: { ref: id, seq: rows.length, items: rows.slice(args.since, args.since + 3) } };
    assert.equal(op, 'runtime.history.acpPlans');
    assert.deepEqual(args, { ref: id, adapterId: 'kimi', revision: rows.length });
    return { ok: true, data: receipt };
  } };
  return native.read({ app: {}, session: {}, row: { id, adapterId: 'kimi' }, runtime, guard() {},
    previousSources: previous?.coverage.sources, previousSnapshot: previous?.snapshot });
}

test('old ACP plan announcements recover in order after validating a cursor-only cache', async () => {
  const old = await read({});
  const { journalDigest } = old.coverage.sources[0];
  delete old.coverage.sources[0].journalDigest;
  assert.equal(old.coverage.unresolvedTools.length, 4);
  const data = await read(proof, events, old);
  assert.equal(data.coverage.sources[0].journalDigest, journalDigest);
  assert.deepEqual(data.snapshot.messages.map(m => m.text || m.blocks[0].text),
    [command, 'Keep the original order', 'Response', command]);
  assert.deepEqual(data.snapshot.tools.map(t => [t.name, t.after, t.state]),
    [['Read', 0, 'done'], ['Plan', 1, 'running'], ['Write', 3, 'running']]);
  assert.equal(data.coverage.unresolvedTools.length, 2);
  const { withTranscript } = require('../main/conversation/conversation-body.cjs');
  const dialogue = [{ role: 'user', text: 'Keep the original order' }, { role: 'assistant', text: 'Response' }];
  assert.equal(withTranscript(data, dialogue), data);
  assert.equal(withTranscript(data, [dialogue[0], { role: 'assistant', text: 'A different answer' }]).coverage.complete, false);
  const changed = structuredClone(events);
  changed[3].text = 'Rewritten prefix';
  await assert.rejects(read(proof, changed, old), { code: 'NATIVE_HISTORY_DIVERGED' });
});

test('truncated, reordered, unrelated or stale ACP proofs leave ambiguous tools unresolved', async () => {
  for (const receipt of [{}, { ...proof, ref: 'another-chat' }, { ...proof, revision: 9 },
    { ...proof, plans: plans.slice(0, 2) }, { ...proof, plans: plans.toReversed() },
    { ...proof, plans: [plans[0], plans[1], [2, 100, 'not the command']] }]) {
    assert.equal((await read(receipt)).coverage.unresolvedTools.length, 4);
  }
  const changed = structuredClone(events);
  changed[6]._stream = 'err';
  assert.equal((await read(proof, changed)).coverage.unresolvedTools.length, 4);
  changed[6]._stream = 'out';
  changed[6].callId = 'real-plan-tool';
  assert.equal((await read(proof, changed)).coverage.unresolvedTools.length, 4);
});
