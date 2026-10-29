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
