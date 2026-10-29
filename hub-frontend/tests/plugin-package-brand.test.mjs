import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

test('downloaded starter uses the current extension and both import pickers accept it and old packages', async t => {
  const elements = []
  const globals = ['localStorage', 'window', 'document', 'fetch']
  const saved = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  globalThis.localStorage = { getItem: () => null }
  globalThis.window = { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} }
  globalThis.document = {
    documentElement: {},
    body: { appendChild() {} },
    createElement(tag) {
      assert.equal(tag, 'a')
      const link = { click() { elements.push({ ...this }) }, remove() {} }
      return link
    },
  }
  globalThis.fetch = async url => {
    assert.equal(url, '/api/v1/admin/plugins/starter')
    return new Response('isolated starter bytes', { headers: { 'Content-Type': 'application/zip' } })
  }
  const { api } = await import('../src/api.js')
  await api.downloadPluginStarter()
  assert.equal(elements.length, 1)
  const filename = elements[0].download
  assert.equal(filename, 'soduwork-workflow-starter.soduwork-plugin')
  const backend = await fs.readFile(new URL('../../hub-backend/app/services/plugin_starter.py', import.meta.url), 'utf8')
  assert.ok(backend.includes('FILENAME = "' + filename + '"'))
  const source = await fs.readFile(new URL('../src/screens/PluginCenter.jsx', import.meta.url), 'utf8')
  const pickers = [...source.matchAll(/(?:input\.accept\s*=\s*|\baccept=)["']([^"']+)["']/g)]
  assert.equal(pickers.length, 2)
  for (const [, accept] of pickers) {
    for (const suffix of ['.soduwork-plugin', '.zip']) {
      assert.ok(accept.split(',').includes(suffix), suffix)
    }
  }
})
