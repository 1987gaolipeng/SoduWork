import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale } from '../src/i18n.js'

test('upgrade status labels change with locale while filter values, rows and progress stay intact', async (t) => {
  t.after(() => setLocale('zh-CN'))
  const changes = [], attempts = [{ id: 'attempt', clientId: 'device', clientName: '用户自定义设备',
    state: 'downloading', releasePlatform: 'linux', targetVersion: '1.2.3', progress: 37 }]
  const before = JSON.stringify(attempts)
  const props = { releases: [], attempts, counts: { downloading: 1 }, loading: false,
    releaseFilter: '', stateFilter: 'all', onReleaseFilter() {}, onStateFilter: (value) => changes.push(value), onRefresh() {} }
  const page = await createComponentHarness(new URL('../src/screens/ClientReleases.jsx', import.meta.url), {
    exportName: 'AttemptsPanel', privateExports: ['AttemptsPanel'],
    props,
    dependencies: { '../api.js': { api: {}, can: () => false },
      '../ui.jsx': { Icon: 'Icon' }, './client-releases.css': {} },
  })
  t.after(() => page.unmount())
  for (const [locale, expected] of [['zh-CN', '下载中'], ['en-US', 'Downloading'], ['ja-JP', 'ダウンロード中'], ['ko-KR', '다운로드 중'], ['zh-CN', '下载中']]) {
    setLocale(locale); page.render(props)
    assert.equal(page.nodes((node) => node.type === 'option' && node.props.value === 'downloading')[0].props.children, expected)
    assert.equal(page.nodes((node) => node.props.className === 'cr-flag ')[0].props.children, expected)
    assert.ok(page.nodes((node) => node.type === 'b' && node.props.children === '用户自定义设备').length)
    assert.ok(page.nodes((node) => node.props.style?.width === '37%').length)
    const filter = page.nodes((node) => node.type === 'select' && node.props.value === 'all')[0]
    filter.props.onChange({ target: { value: 'installed' } })
  }
  assert.deepEqual(changes, Array(5).fill('installed'))
  assert.equal(JSON.stringify(attempts), before)
})

test('activity failures retain only the current filter and tiny artifacts keep a nonzero size', async (t) => {
  const pending = []
  const sizes = [[1, '1 B'], [1023, '1023 B'], [1024, '1.0 KB'], [10240, '10.0 KB'],
    [1048576, '1.0 MB'], [1073741824, '1.00 GB']]
  const releases = sizes.map(([artifactSize], i) => ({ id: String(i), platform: 'win32',
    version: '1.0', artifactName: 'installer-' + i, artifactSize }))
  const api = {
    clientReleases: async () => ({ releases }),
    clientReleaseNotes: async () => ({ notes: [] }),
    clientUpdateAttempts: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  }
  const page = await createComponentHarness(new URL('../src/screens/ClientReleases.jsx', import.meta.url), {
    dependencies: { '../api.js': { api, can: () => false }, '../ui.jsx': { Icon: 'Icon', Loading: 'Loading' },
      './client-releases.css': {} },
  })
  t.after(() => page.unmount())
  const panel = () => page.nodes(node => typeof node.props.onReleaseFilter === 'function')[0].props
  page.render()
  pending.shift().resolve({ attempts: [{ id: 'old' }], counts: { installed: 1 } })
  await page.flush()
  assert.deepEqual(page.nodes(node => node.props.className === 'cr-artifact')
    .map(node => node.props.children[1].props.children), sizes.map(([, label]) => label))
  panel().onRefresh()
  pending.shift().reject(new Error('Service unavailable'))
  await page.flush()
  assert.equal(panel().error, 'Service unavailable')
  assert.equal(panel().attempts[0].id, 'old')
  panel().onRefresh()
  const stale = pending.shift()
  page.act(() => panel().onStateFilter('failed'))
  assert.deepEqual(panel().attempts, [])
  pending.shift().resolve({ attempts: [{ id: 'current' }], counts: { failed: 1 } })
  stale.resolve({ attempts: [{ id: 'late' }] })
  await page.flush()
  assert.equal(panel().error, null)
  assert.deepEqual(panel().attempts, [{ id: 'current' }])
})
