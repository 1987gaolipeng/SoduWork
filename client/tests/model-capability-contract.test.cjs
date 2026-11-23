'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const target = path.join(__dirname, '../main/model-capability-contract.cjs');
function contract() {
  assert.equal(fs.existsSync(target), true, 'the trusted capability projection must exist');
  return require(target);
}
const check = (status, checkedAt = '2026-11-15T00:00:00Z') => ({ status, checkedAt });

test('runtime compatibility tolerates absent or malformed optional metadata', () => {
  const c = contract();
  for (const value of [null, undefined, [], 'invalid', 42]) assert.deepEqual(c.compatibility(value), {});
});

test('manual declarations and legacy routes retain their provenance when a probe is inconclusive', () => {
  const c = contract();
  const evidence = { reportVersion: 2, apiFamily: 'chat-completions', checks: { imageInput: check('inconclusive') } };
  assert.equal(c.profile({ capabilities: { imageInput: 'supported' } }, evidence).imageInput.source, 'configured');
  assert.equal(c.profile({ imageRouting: 'native' }, evidence).imageInput.source, 'legacy-native');
  assert.equal(c.profile({}, evidence).imageInput.state, 'unknown');
});

test('a transient attempt retains conclusive evidence and exposes both outcomes', () => {
  const c = contract();
  const previous = { reportVersion: 2, apiFamily: 'chat-completions', configRevision: 'target', checks: { imageInput: check('passed') } };
  const merged = c.mergeEvidence(previous, { ...previous, checks: { imageInput: check('inconclusive', '2026-11-15T00:01:00Z') } });
  assert.equal(merged.checks.imageInput.status, 'inconclusive');
  assert.equal(merged.verifiedChecks.imageInput.status, 'passed');
  assert.equal(c.profile({}, merged).imageInput.state, 'supported');
  assert.equal(c.profile({}, merged).imageInput.checkStatus, 'inconclusive');
});

test('run sequence wins over wall-clock rollback while legacy timestamp ordering stays protected', () => {
  const c = contract(), previous = { apiFamily: 'chat-completions', configRevision: 'target', runSequence: 1,
    checks: { imageInput: check('passed', '2026-11-15T01:00:00Z') } };
  const newer = { ...previous, runSequence: 2, checks: { imageInput: check('unsupported', '2026-11-15T00:59:59Z') } };
  assert.equal(c.mergeEvidence(previous, newer).checks.imageInput.status, 'unsupported');
  assert.deepEqual(c.mergeEvidence(previous, newer).verifiedChecks.imageInput, previous.checks.imageInput);
  assert.equal(c.mergeEvidence({ ...previous, runSequence: undefined }, { ...newer, runSequence: undefined }).checks.imageInput.status, 'passed');
});

test('an image rejection preserves only the same target’s proven image route', () => {
  const c = contract();
  const keys = ['imageInput', 'streaming', 'toolCalling'];
  const makeReport = (runSequence, status, configRevision = 'target') => ({
    reportVersion: 2, apiFamily: 'chat-completions', configRevision, runSequence,
    checks: Object.fromEntries(keys.map(key => [key, check(status, '2026-11-15T00:0' + runSequence + ':00Z')])),
  });
  const first = makeReport(1, 'passed');
  let saved = first;
  for (const sequence of [2, 3]) {
    const rejection = makeReport(sequence, 'unsupported');
    saved = c.mergeEvidence(saved, rejection);
    assert.deepEqual(saved.checks, rejection.checks);
    assert.deepEqual(saved.verifiedChecks.imageInput, first.checks.imageInput);
    assert.deepEqual(saved.verifiedChecks.toolCalling, rejection.checks.toolCalling);
    assert.deepEqual(saved.verifiedChecks.streaming, rejection.checks.streaming);
    assert.deepEqual(c.runtimeFields({}, saved).input, ['text', 'image']);
  }
  assert.equal(c.profile({ capabilities: { imageInput: 'supported' } }, saved).imageInput.conflict, true);
  const disabled = c.runtimeFields({ capabilities: { imageInput: 'unsupported' } }, saved);
  assert.deepEqual(disabled.input, ['text']);
  assert.ok(!disabled.capabilityProfile.imageInput.conflict);
  assert.equal(c.runtimeFields({ imageRouting: 'vision-fallback' }, saved).imageRouting, 'vision-fallback');
  for (const status of ['inconclusive', 'cancelled', 'skipped']) {
    const later = c.mergeEvidence(saved, makeReport(4, status));
    assert.equal(later.checks.imageInput.status, status);
    assert.deepEqual(later.verifiedChecks.imageInput, first.checks.imageInput);
    assert.equal(c.profile({ capabilities: { imageInput: 'supported' } }, later).imageInput.conflict, true);
    assert.ok(!c.profile({ capabilities: { imageInput: 'unsupported' } }, later).imageInput.conflict);
  }
  const changed = c.mergeEvidence(saved, makeReport(4, 'unsupported', 'new-target'));
  assert.deepEqual(c.runtimeFields({}, changed).input, ['text']);
  const recovered = c.mergeEvidence(saved, makeReport(4, 'passed'));
  assert.deepEqual(recovered.verifiedChecks.imageInput, recovered.checks.imageInput);
});

test('legacy tool and stream conclusions require a strict recheck without losing image proof or declarations', () => {
  const c = contract(), legacy = { reportVersion: 1, configRevision: 'target', checks: {
    imageInput: check('passed'), toolCalling: check('unsupported'), streaming: check('passed') } };
  const projected = c.profile({}, legacy);
  assert.equal(projected.imageInput.state, 'supported');
  assert.equal(projected.toolCalling.state, 'unknown'); assert.equal(projected.streaming.state, 'unknown');
  assert.equal(c.profile({ capabilities: { toolCalling: 'supported' } }, legacy).toolCalling.source, 'configured');
  const merged = c.mergeEvidence(legacy, { reportVersion: 2, apiFamily: 'chat-completions', configRevision: 'target',
    runSequence: 1, checks: { connection: check('passed') } });
  assert.equal(merged.verifiedChecks.toolCalling, undefined); assert.equal(merged.verifiedChecks.streaming, undefined);
  assert.equal(merged.checks.toolCalling.code, 'legacy_recheck_required');
  assert.equal(legacy.checks.toolCalling.status, 'unsupported', 'Reading or merging must preserve the original historical record');
});

test('changed targets and different API families cannot lend capability evidence', () => {
  const c = contract();
  const previous = { reportVersion: 2, apiFamily: 'chat-completions', configRevision: 'old', checks: { imageInput: check('passed') } };
  const merged = c.mergeEvidence(previous, { ...previous, configRevision: 'new', checks: { connection: check('passed') } });
  assert.equal(c.profile({}, merged).imageInput.state, 'unknown');
  assert.equal(c.profile({}, { ...previous, apiFamily: 'responses' }).imageInput.state, 'unknown');
});

test('runtime projection routes images and carries verified compatibility without inventing an adapter', () => {
  const c = contract();
  const evidence = { apiFamily: 'chat-completions', checks: { imageInput: check('passed') },
    compatibility: { maxTokensField: 'max_tokens', streamOptions: false, toolChoice: 'auto' } };
  const runtime = c.runtimeFields({}, evidence);
  assert.deepEqual(runtime.input, ['text', 'image']);
  assert.equal(runtime.imageRouting, 'native');
  assert.equal(runtime.visionFallbackAvailable, false);
  assert.equal(runtime.compatibility.streamOptions, false);
  assert.equal(c.runtimeFields({ imageRouting: 'vision-fallback' }, evidence).imageRouting, 'vision-fallback');
});

test('only functional changes alter runtime revisions and conflicts remain visible', () => {
  const c = contract();
  const first = { apiFamily: 'chat-completions', checks: { imageInput: check('passed') } };
  const later = { ...first, checks: { imageInput: { ...check('passed', '2026-11-16T00:00:00Z'),
    stage: 'output', detailCode: 'expected_output_mismatch' } } };
  assert.equal(c.runtimeRevision('target', c.runtimeFields({}, first)), c.runtimeRevision('target', c.runtimeFields({}, later)));
  const conflict = c.profile({ capabilities: { imageInput: 'unsupported' } }, first).imageInput;
  assert.equal(conflict.state, 'unsupported');
  assert.equal(conflict.conflict, true);
});

test('desktop follows the shared Hub/Runner capability contract vectors', () => {
  const c = contract();
  const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '../../tools/contracts/model-capabilities-v2.json'), 'utf8'));
  for (const { name, config, evidence, expected } of vectors.cases) {
    const result = c.runtimeFields(config, evidence);
    for (const [key, value] of Object.entries(expected.imageInput)) assert.equal(result.capabilityProfile.imageInput[key], value, name + ': ' + key);
    assert.equal(result.imageRouting, expected.imageRouting, name);
    assert.deepEqual(result.input, expected.input, name);
  }
});
