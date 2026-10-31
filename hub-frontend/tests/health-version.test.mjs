import test from 'node:test'
import assert from 'node:assert/strict'
import { healthVersionLabel, healthReleaseLabel } from '../src/health-version.js'

const sha = 'eec6e541addd4e29c98f9f14b10eb4ddec515994'
const build = value => `Build ${value}`

test('release version and source revision remain independently visible', () => {
  assert.equal(healthVersionLabel('1.0.4', sha, build), 'v1.0.4 · Build eec6e541')
  assert.equal(healthVersionLabel('v1.0.5-rc.1', sha, build), 'v1.0.5-rc.1 · Build eec6e541')
  assert.equal(healthVersionLabel('1.0.4', '', build), 'v1.0.4')
})

test('old Hub build-only responses remain readable without inventing a version', () => {
  assert.equal(healthVersionLabel(sha, sha, build), 'Build eec6e541')
  assert.equal(healthVersionLabel('', '', build), '')
  assert.equal(healthVersionLabel('dev', '', build), 'Build dev')
})


test('service summaries expose only published versions while diagnostic builds remain available separately', () => {
  assert.equal(healthReleaseLabel('1.0.12'), 'v1.0.12')
  assert.equal(healthReleaseLabel('v1.0.12-rc.1'), 'v1.0.12-rc.1')
  for (const value of [sha, 'source-local', 'dev', '', null]) assert.equal(healthReleaseLabel(value), '')
  assert.equal(healthVersionLabel('1.0.12', sha, build), 'v1.0.12 · Build eec6e541')
})
