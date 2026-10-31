import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSubmissionOrigins, sameCapabilityPolicy, summarizeCapabilityPolicy } from '../src/screens/capability-catalog-model.js'

const submissions = (...ids) => ids.map((ownerClientId) => ({ name: 'presales-style', ownerClientId }))

test('same-named personal submissions keep a stable origin for every distinct owner', () => {
  const rows = submissions('u-alpha-123456', 'u-beta-654321', 'u-alpha-123456')
  const before = structuredClone(rows)
  const origins = buildSubmissionOrigins(rows)
  assert.deepEqual([...origins], [
    ['u-alpha-123456', { label: 'SoduWork ·123456', title: 'u-alpha-123456' }],
    ['u-beta-654321', { label: 'SoduWork ·654321', title: 'u-beta-654321' }],
  ])
  assert.deepEqual(rows, before)
})

test('colliding suffixes expand until labels distinguish every device', () => {
  const ids = ['u-alpha-abc123', 'u-beta-abc123', 'u-theta-abc123', 'u-other-654321']
  const origins = buildSubmissionOrigins(submissions(...ids))
  const labels = [...origins.values()].map((item) => item.label)
  assert.equal(new Set(labels).size, ids.length)
  assert.equal(origins.get(ids[3]).label, 'SoduWork ·654321')
  for (const id of ids) {
    assert.equal(origins.get(id).title, id)
    assert.ok(id.endsWith(origins.get(id).label.slice('SoduWork ·'.length)))
  }
  assert.deepEqual([...buildSubmissionOrigins(submissions(...ids.toReversed())).values()].toReversed(),
    [...origins.values()])
})

test('different length IDs whose full values overlap suffixes remain distinct', () => {
  const origins = buildSubmissionOrigins(submissions('abc123', 'Xabc123', 'YXabc123', 'ab', 'a'))
  assert.deepEqual([...origins.values()].map((item) => item.label), [
    'SoduWork ·abc123', 'SoduWork ·Xabc123', 'SoduWork ·YXabc123', 'SoduWork ·ab', 'SoduWork ·a',
  ])
})

test('missing or invalid owner IDs leave the UI fallback available', () => {
  assert.deepEqual([...buildSubmissionOrigins([null, {}, ...submissions('', '  ', null, undefined, 42)])], [])
  assert.equal(buildSubmissionOrigins(null).size, 0)
  assert.equal(buildSubmissionOrigins(undefined).size, 0)
})

test('active count uses unique names in the full catalog and reports stale names in policy order', () => {
  const rows = [{ name: 'visible' }, { name: 'outside-current-search' }, { name: 'visible' }, {}, null]
  const allowed = ['stale-b', 'visible', 'stale-a', 'visible', 'outside-current-search', 'stale-b']
  const before = structuredClone({ rows, allowed })
  assert.deepEqual(summarizeCapabilityPolicy(rows, allowed), {
    activeCount: 2, unmatchedNames: ['stale-b', 'stale-a'],
  })
  assert.deepEqual({ rows, allowed }, before)
  assert.deepEqual(summarizeCapabilityPolicy(rows, new Set(allowed)), {
    activeCount: 2, unmatchedNames: ['stale-b', 'stale-a'],
  })
})

test('empty and unknown catalogs do not count historical entries as active', () => {
  assert.deepEqual(summarizeCapabilityPolicy([], ['unknown', 'unknown']), {
    activeCount: 0, unmatchedNames: ['unknown'],
  })
  assert.deepEqual(summarizeCapabilityPolicy(null, null), { activeCount: 0, unmatchedNames: [] })
  assert.deepEqual(summarizeCapabilityPolicy([{ name: 'known' }], ['', null, undefined]), {
    activeCount: 0, unmatchedNames: [],
  })
})

test('policy equality ignores ordering and duplicate JSON names but preserves unknown selections', () => {
  assert.equal(sameCapabilityPolicy(['one', 'unknown', 'one'], ['unknown', 'one']), true)
  assert.equal(sameCapabilityPolicy(new Set(['one', 'two']), ['two', 'one', 'one']), true)
  assert.equal(sameCapabilityPolicy(['one', 'unknown'], ['one']), false)
  assert.equal(sameCapabilityPolicy(['one'], ['two']), false)
  assert.equal(sameCapabilityPolicy(undefined, []), true)
  assert.equal(sameCapabilityPolicy(null, new Set()), true)
})
