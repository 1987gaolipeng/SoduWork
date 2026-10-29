import * as selectPopover from '../src/select-popover.js'
import * as orgOptions from '../src/org-options.js'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import React from 'react'
import * as ReactDOM from 'react-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { transform } from 'esbuild'
import * as locale from '../src/i18n.js'
import * as dialogFocus from '../src/dialog-focus.js'
import { createComponentHarness } from './helpers/react-harness.mjs'

const source = (name) => new URL('../src/' + name, import.meta.url)
const localeHost = { ...locale, useLocale: () => locale.getLocale() }

async function moduleSource(file, dependencies = {}) {
  const { code } = await transform(await fs.readFile(file, 'utf8'), { loader: 'jsx', format: 'cjs' })
  // Unused siblings and stylesheet imports remain inert; all components used in
  // the simulation's rendered tree below are the real production exports.
  const imports = Object.fromEntries([...code.matchAll(/require\("([^"]+)"\)/g)].map(([, name]) => [name, {}]))
  Object.assign(imports, { react: React, 'react-dom': ReactDOM, './i18n.js': localeHost,
    '../i18n.js': localeHost, './dialog-focus.js': dialogFocus, './select-popover.js': selectPopover, './org-options.js': orgOptions, '../org-options.js': orgOptions }, dependencies)
  return { code, imports }
}

async function exportsFrom(file, dependencies) {
  const { code, imports } = await moduleSource(file, dependencies)
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)((name) => imports[name], module, module.exports)
  return module.exports
}

test('real SimulationModal keeps plugin scope around the SSR workflow after a simulated result', async (t) => {
  const calls = []
  const api = {
    projects: async () => [],
    simulatePluginVersion: async (id, options) => {
      calls.push({ id, options })
      return { ok: true, checks: [], plan: [
        { key: 'spec', name: '确认需求', type: 'spec' },
        { key: 'deliver', name: '完成交付', type: 'ai' },
      ] }
    },
  }
  const ui = await exportsFrom(source('ui.jsx'), { './api.js': { api } })
  const parts = await exportsFrom(source('screens/PluginDialogParts.jsx'), { '../ui.jsx': ui })
  const binding = await exportsFrom(source('screens/PluginBindingDialog.jsx'), {
    '../api.js': { api }, '../ui.jsx': ui, './PluginDialogParts.jsx': parts,
  })
  const workspace = await exportsFrom(source('screens/PluginDetailWorkspace.jsx'), {
    '../ui.jsx': ui, './PluginDialogParts.jsx': parts,
  })
  const { imports } = await moduleSource(source('screens/PluginCenter.jsx'), {
    '../api.js': { api, can: () => true }, '../ui.jsx': ui,
    './PluginBindingDialog.jsx': binding, './PluginDetailWorkspace.jsx': workspace,
    './PluginDialogParts.jsx': parts,
  })
  const page = await createComponentHarness(source('screens/PluginCenter.jsx'), {
    exportName: 'SimulationModal', privateExports: ['SimulationModal'], dependencies: imports,
    props: { plugin: { name: '隔离验证插件' }, version: { id: 'fixture-v1' }, onClose() {} },
  })
  t.after(() => page.unmount())
  page.render(); await page.flush()
  const actions = React.Children.toArray(page.render().props.foot.props.children)
  await actions.find((node) => node.props.className?.includes('btn-primary')).props.onClick()
  await page.flush()
  const html = renderToStaticMarkup(page.render())
  assert.deepEqual(calls, [{ id: 'fixture-v1', options: { projectId: '', agentKind: '' } }])
  assert.match(html, /class="modal modal-wide plugin-page"/, 'the portal panel itself carries the existing plugin stylesheet scope')
  assert.match(html, /class="workflow-graph workflow-graph-v2"/)
  assert.match(html, /class="workflow-node type-spec"/)
  assert.match(html, /class="workflow-node type-ai"/)
  assert.match(html, /class="workflow-arrow"/)
  assert.match(html, /确认需求/)
  assert.match(html, /完成交付/)
})
