import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale } from '../src/i18n.js'

test('six packages share one escaped release note and legacy empty releases stay compact', async t => {
  const notes = '修复与改进\n<img src=x onerror=alert(1)>'
  const releases = Array.from({ length: 6 }, (_, i) => ({ id: String(i), version: '2.0.0', channel: 'stable',
    platform: 'linux', arch: 'x64', artifactName: 'package-' + i, notes, enabled: true }))
  releases.push({ id: 'old', version: '1.0.0', channel: 'stable', platform: 'linux', notes: '' })
  const page = await createComponentHarness(new URL('../src/screens/ClientReleases.jsx', import.meta.url), {
    dependencies: { '../api.js': { can: () => false, api: {
      clientReleases: async () => ({ releases }), clientUpdateAttempts: async () => ({ attempts: [], counts: {} }),
    } }, '../ui.jsx': { Icon: 'Icon', Loading: 'Loading' }, './client-releases.css': {} },
  })
  t.after(() => { page.unmount(); setLocale('zh-CN') })
  await page.flush()
  const details = page.nodes(node => node.type === 'details' && node.props.className === 'cr-notes')
  assert.equal(details.length, 1)
  const body = page.nodes(node => node.type === 'div' && node.props['data-user-content'])
  assert.equal(body.length, 1); assert.equal(body[0].props.children, notes)
  assert.equal(body[0].props.dangerouslySetInnerHTML, undefined)
  setLocale('en-US'); page.render({})
  assert.ok(page.nodes(node => node.type === 'summary' && node.props.children === 'Release notes').length)
  assert.equal(page.nodes(node => node.type === 'div' && node.props['data-user-content'])[0].props.children, notes)
})
