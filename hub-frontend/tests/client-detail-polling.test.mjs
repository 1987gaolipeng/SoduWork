import test from 'node:test'
import assert from 'node:assert/strict'
import { createComponentHarness } from './helpers/react-harness.mjs'
import * as appearance from '../src/client-appearance.js'

const deferred = () => { let resolve; const promise = new Promise(a => { resolve = a }); return { promise, resolve } }

test('device changes and close discard delayed history; hidden views do not poll', async t => {
  const originalDoc = globalThis.document, listeners = new Set(), requests = []
  const doc = globalThis.document = { hidden: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) }
  t.after(() => { globalThis.document = originalDoc })
  const page = await createComponentHarness(new URL('../src/screens/Clients.jsx', import.meta.url), {
    exportName: 'ClientDetail', privateExports: ['ClientDetail'], props: { client: { id: 'a' } }, dependencies: {
      '../api.js': { can: permission => permission === 'client.view', api: {
        clientDetail: async id => ({ id, config: {} }),
        clientUpdates: id => { const req = deferred(); requests.push({ ...req, id }); return req.promise },
      } },
      '../ui.jsx': { Icon: 'Icon', Modal: 'Modal', Confirm: 'Confirm', SelectMenu: 'SelectMenu', toast() {} },
      '../FilterControls.jsx': {}, '../ListPager.jsx': {}, './RunnerBoard.jsx': {}, './ClientAccessPolicy.jsx': {}, './MailSettings.jsx': {},
      './client-updates.css': {}, './execution-network.css': {}, '../client-appearance.js': appearance,
    },
  })
  page.render(); await page.flush(); assert.deepEqual(requests.map(x => x.id), ['a'])
  page.render({ client: { id: 'b' } }); await page.flush()
  assert.deepEqual(requests.map(x => x.id), ['a', 'b'])
  requests[0].resolve({ attempts: [{ id: 'stale-a' }] }); await page.flush()
  assert.equal(JSON.stringify(page.render()).includes('stale-a'), false)
  doc.hidden = true; listeners.forEach(fn => fn())
  requests[1].resolve({ attempts: [{ id: 'hidden-b' }] }); await page.flush()
  assert.equal(JSON.stringify(page.render()).includes('hidden-b'), false)
  doc.hidden = false; listeners.forEach(fn => fn()); await page.flush()
  assert.equal(requests.length, 3)
  page.unmount(); requests[2].resolve({ attempts: [{ id: 'unmounted' }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(listeners.size, 0)
})
