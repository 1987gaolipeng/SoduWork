import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

function fixture(fetch) {
  const source = fs.readFileSync(new URL('../src/api.js', import.meta.url), 'utf8')
    .replace(/^import .*$/m, '').replace(/export /g, '')
  const sandbox = { fetch, AbortController, AbortSignal, URL, URLSearchParams, FormData, Event,
    tx: text => text, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: { setTimeout: fn => setTimeout(fn, 20), clearTimeout, dispatchEvent() {} } }
  vm.runInNewContext(source + '\nglobalThis.testAPI = {call, upload, uploadForm, download, api};', sandbox)
  return sandbox.testAPI
}
test('headers do not end the timeout; JSON, upload, form, health and downloads recover after body stalls', async () => {
  let stall = true, aborted = 0
  const transport = fixture(async (_path, options) => {
    const body = () => stall ? new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
      aborted++; reject(Object.assign(Error('deadline'), { name: 'AbortError' }))
    }, { once: true })) : Promise.resolve('{"ok":true}')
    return { ok: true, status: 200, text: body, blob: body }
  })
  const calls = [() => transport.call('GET', '/fixture'), () => transport.api.health(),
    () => transport.upload('/fixture', new Blob(['data'])), () => transport.uploadForm('/fixture', new FormData()),
    () => transport.download('/fixture', 'file'), () => transport.api.downloadSkillSubmission('id', 'checksum', '', 'name')]
  for (const call of calls) await assert.rejects(call(), /请求超时/)
  assert.equal(aborted, calls.length)
  stall = false
  assert.equal((await transport.call('GET', '/fixture')).ok, true)
})
test('HTTP errors and authentication expiry retain existing handling', async () => {
  const unauthorized = fixture(async () => ({ status: 401, ok: false, text: () => { throw Error('must not read'); } }))
  await assert.rejects(unauthorized.call('GET', '/fixture'), /登录已失效/)
  const failed = fixture(async () => ({ status: 409, ok: false, text: async () => '{"detail":"conflict"}', headers: new Headers() }))
  await assert.rejects(failed.call('POST', '/fixture', {}), error => error.status === 409 && error.message === 'conflict')
})
