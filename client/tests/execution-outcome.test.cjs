'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recover } = require('../main/conversation/execution-outcome.cjs');

function row(patch = {}) {
  return { id: 'native', adapterId: 'pi', state: 'failed', status: 'failed',
    creator: { account: 'owner', hub: 'https://fixture.invalid' }, runtimeUnavailable: true,
    runtimeFailure: { code: 'RUNTIME_PROCESS_GONE', interrupted: false },
    executionOutcome: { version: 1, source: 'runtime', owner: 'owner', hub: 'https://fixture.invalid',
      state: 'completed', status: 'idle' }, ...patch };
}
for (const [state, status] of [['completed', 'idle'], ['failed', 'unreachable'], ['failed', 'idle'], ['stopped', 'aborted']]) {
  test('attributed idle loss restores the exact ' + state + '/' + status + ' outcome', () => {
    const original = row(); Object.assign(original.executionOutcome, { state, status });
    const recovered = recover(original);
    assert.equal(recovered.state, state); assert.equal(recovered.status, status);
    assert.equal(original.state, 'failed', 'recovery must not mutate its input');
  });
}
for (const patch of [
  { runtimeFailure: { code: 'RUNTIME_PROCESS_GONE', interrupted: true } },
  { runtimeFailure: { code: 'RUNTIME_PROCESS_GONE' } }, { runtimeFailure: null },
  { executionOutcome: null }, { cached: true }, { source: { id: 'foreign' } },
  { accountProjection: true }, { importedHistory: true }, { adapterId: 'qwen' },
  { creator: { account: 'another', hub: 'https://fixture.invalid' } },
  { creator: { account: 'owner', hub: 'https://another.invalid' } },
]) test('uncertain, foreign or non-native provenance cannot erase a failure: ' + JSON.stringify(patch), () => {
  assert.equal(recover(row(patch)), null);
});
