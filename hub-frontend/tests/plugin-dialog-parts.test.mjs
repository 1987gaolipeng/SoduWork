import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transformSync } from 'esbuild'
import * as locale from '../src/i18n.js'

const source = (name) => new URL('../src/screens/' + name, import.meta.url)
const Icon = ({ name }) => React.createElement('svg', { 'data-icon': name })
const loaded = new Map()
function exportsFrom(name, privateExports = []) {
  const key = name + ':' + privateExports.join(',')
  if (loaded.has(key)) return loaded.get(key)
  const code = fs.readFileSync(source(name), 'utf8') +
    (privateExports.length ? '\nexport { ' + privateExports.join(', ') + ' }' : '')
  const compiled = transformSync(code, { loader: 'jsx', format: 'cjs' }).code
  const imports = Object.fromEntries([...compiled.matchAll(/require\("([^"]+)"\)/g)].map(([, dependency]) => [dependency, {}]))
  Object.assign(imports, { react: React, '../ui.jsx': { Icon },
    '../i18n.js': { ...locale, useLocale: () => locale.getLocale() } })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled)((dependency) => dependency === './PluginDialogParts.jsx'
    ? exportsFrom('PluginDialogParts.jsx') : imports[dependency], module, module.exports)
  loaded.set(key, module.exports)
  return module.exports
}
const noticeOwners = ['PluginBindingDialog.jsx', 'PluginRunDialogs.jsx', 'PluginCenter.jsx', 'PluginDetailWorkspace.jsx']
const markup = (Component, props) => renderToStaticMarkup(React.createElement(Component, props))

test('binding field export preserves its label and child control markup', () => {
  const { Field } = exportsFrom('PluginBindingDialog.jsx')
  const html = markup(Field, { label: 'Executor', children: React.createElement('input', { name: 'executor', defaultValue: 'fixture-agent' }) })
  assert.match(html, /<label class="f-lbl">Executor<\/label>/)
  assert.match(html, /<input name="executor" value="fixture-agent"\/>/)
})

test('plugin notices stay absent without items across all existing owners', () => {
  for (const owner of noticeOwners) {
    const { NoticeList } = exportsFrom(owner, ['NoticeList'])
    for (const items of [undefined, null, []]) assert.equal(markup(NoticeList, { title: 'No notices', items }), '', owner)
  }
})

test('plugin notices share tone, icon, order and escaped content across existing owners', () => {
  for (const tone of ['', 'bad', 'warn']) {
    const props = { tone, title: 'Action needed', items: ['First <item>', 'Second & final'] }
    const rows = noticeOwners.map((owner) => markup(exportsFrom(owner, ['NoticeList']).NoticeList, props))
    assert.equal(new Set(rows).size, 1, 'every plugin surface renders the same notice contract')
    assert.ok(rows[0].includes('class="plugin-notice ' + tone + '"'))
    assert.ok(rows[0].includes('data-icon="' + (tone === 'bad' ? 'alert' : 'shield') + '"'))
    assert.match(rows[0], /<b>Action needed<\/b><span>First &lt;item&gt;<\/span><span>Second &amp; final<\/span>/)
  }
})
