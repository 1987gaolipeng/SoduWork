import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { transform } from 'esbuild'

test('GitLab authentication and scans can finish after the standard request deadline', async () => {
  const source = await fs.readFile(new URL('../src/api.js', import.meta.url), 'utf8')
  const { code } = await transform(source, { format: 'cjs', loader: 'js' })
  const timers = new Map(), requests = []
  let sequence = 0
  const window = { setTimeout(fn, ms) { timers.set(++sequence, { fn, ms }); return sequence }, clearTimeout(id) { timers.delete(id) } }
  const storage = { getItem() { return null }, setItem() {}, removeItem() {} }
  const fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error(), { name: 'AbortError' })))
    requests.push({ url, finish: () => resolve({ ok: true, status: 200, text: async () => '{}' }) })
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'localStorage', 'window', 'fetch', 'AbortController', code)(
    () => ({ translateText: (value) => value }), module, module.exports, storage, window, fetch, AbortController)
  const { api } = module.exports
  const calls = [api.testPullAccount('source', {}), api.syncRepositoryCatalog('source'),
    api.saveRepositoryIssueSync('repo', { enabled: true }), api.runRepositoryIssueSync('repo'), api.repositoryBranches('repo')]
  // Advance the simulated browser clock beyond the standard 30-second deadline.
  for (const timer of timers.values()) if (timer.ms <= 35000) timer.fn()
  requests.forEach((request) => request.finish())
  assert.equal((await Promise.all(calls)).length, 5)
  assert.equal(timers.size, 0)
  const ordinary = api.integrations()
  for (const timer of timers.values()) if (timer.ms <= 35000) timer.fn()
  await assert.rejects(ordinary, /请求超时/, 'ordinary requests keep the existing shorter deadline')
})
