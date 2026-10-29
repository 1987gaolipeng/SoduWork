import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { catalogPlugin, presentPlugin } from '../src/plugin-locales.js'
import { selectCatalog } from '../src/screens/plugin-catalog-model.js'
import { setLocale } from '../src/i18n.js'
const desktop = createRequire(import.meta.url)('../../client/core/plugin-locales.js')
const locales = { 'zh-CN': { name: '运营', description: '运营说明', ui: { main: { title: '工作台' } } },
  'en-US': { name: 'Operations', description: 'Manage work', ui: { main: { title: 'Workspace' } }, inputs: { mode: { label: 'Mode', options: { auto: 'Automatic' } } } },
  'ko-KR': { name: '운영' } }
const manifest = { name: '旧名称', description: '旧说明', locales, ui: { contributions: [{ id: 'main', source: { url: 'https://example.invalid/' } }] }, inputs: [{ key: 'mode', default: 'auto', options: ['auto'] }] }
test('admin and desktop share fallback and safe presentation semantics', () => {
  for (const locale of ['en-US', 'zh-TW', 'ko-KR', 'fr', 'en-GB']) assert.deepEqual(presentPlugin(manifest, locale), desktop.present(manifest, locale))
  assert.equal(presentPlugin(manifest, 'fr').name, 'Operations')
  assert.equal(presentPlugin(manifest, 'ko').description, 'Manage work')
})
test('catalog searches localized names and review uses the selected immutable version', () => {
  const plugin = { id: 'app', name: '数据库名称', latestVersion: { manifest, capabilities: {} } }
  setLocale('en-US')
  assert.equal(selectCatalog([plugin], {}, { query: 'Operations' }).shown[0].plugin.name, 'Operations')
  const old = { manifest: { ...manifest, locales: { ...locales, 'en-US': { name: 'Old operations', description: 'Old version' } } } }
  assert.equal(catalogPlugin(plugin, 'en-US', old).name, 'Old operations')
  assert.equal(plugin.name, '数据库名称')
  setLocale('zh-CN')
  assert.equal(selectCatalog([plugin], {}, { query: '运营' }).shown[0].plugin.name, '运营')
})
