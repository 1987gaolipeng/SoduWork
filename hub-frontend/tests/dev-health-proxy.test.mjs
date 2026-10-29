import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import config from '../vite.config.js'

test('development health probes reach Hub, preserve failures and keep API/page routing', async (t) => {
  const requests = []
  let healthy = true
  const backend = http.createServer((req, res) => {
    requests.push(req.url)
    const route = new URL(req.url, 'http://localhost').pathname
    const body = route === '/healthz' ? { ok: healthy, service: 'test-hub', version: 'fixture' }
      : route === '/readyz' ? { ready: healthy, database: healthy }
        : { api: true }
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { backend.closeAllConnections(); backend.close(resolve) }))
  const target = `http://127.0.0.1:${backend.address().port}`
  // Retain exactly the production route keys; only isolate the upstream address.
  const proxy = Object.fromEntries(Object.entries(config.server.proxy).map(([route, rule]) => [route, { ...rule, target }]))
  const vite = await createServer({ ...config, configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'silent',
    server: { ...config.server, host: '127.0.0.1', port: 0, strictPort: false, proxy },
  })
  t.after(() => vite.close())
  await vite.listen()
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
  for (const path of ['/healthz?probe=status-card', '/readyz', '/api/v1/fixture']) {
    const res = await fetch(origin + path)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /application\/json/, `${path} must never fall through to the SPA HTML`)
    const body = await res.json()
    assert.equal(path.startsWith('/healthz') ? body.ok : path === '/readyz' ? body.ready : body.api, true)
  }
  assert.deepEqual(requests, ['/healthz?probe=status-card', '/readyz', '/api/v1/fixture'])
  healthy = false
  for (const path of ['/healthz', '/readyz']) {
    const res = await fetch(origin + path)
    assert.equal(res.status, 503, 'a real backend failure must stay visible')
    const body = await res.json()
    assert.equal(path === '/healthz' ? body.ok : body.ready, false)
  }
  const home = await fetch(origin + '/')
  assert.equal(home.status, 200)
  assert.match(home.headers.get('content-type'), /text\/html/)
})
