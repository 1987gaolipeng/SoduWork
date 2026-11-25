import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'

test('provider editor validates before calling the API and can clear optional lists', async t => {
  const calls = []
  const api = {
    async updateIdentityProvider(id, body) { calls.push({ id, body }); return { id } },
    async probeIdentityProvider(id) { calls.push({ probe: id }); return { ready: true } },
  }
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'https://hub.example' } } })
  t.after(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
    else delete globalThis.window
  })
  const page = await createComponentHarness(new URL('../src/screens/IdentityCenter.jsx', import.meta.url), {
    privateExports: ['ProviderEditor'], exportName: 'ProviderEditor',
    dependencies: { '../api.js': { api }, '../ui.jsx': { Modal: 'modal', Icon: 'icon', SelectMenu: 'select-menu', toast() {} },
      './admin-access-pages.css': {}, './identity-center.css': {} },
    props: { value: { id: 'provider-1', issuer: 'https://issuer.example', clientId: 'fixture',
      allowedDomains: ['example.test'], scopes: ['openid'] }, roles: [], orgs: [], onDone() {} },
  })
  t.after(() => page.unmount())
  const input = predicate => page.nodes(node => node.type === 'input' && predicate(node.props))[0]
  for (const field of [p => p.name === 'scopes', p => p.placeholder === 'company.com']) {
    page.act(() => input(field).props.onChange({ target: { value: '' } }))
    assert.equal(input(field).props.value, '')
  }
  const elements = Object.fromEntries(['issuer', 'clientId', 'scopes'].map(name => [name, {
    value: input(p => p.name === name).props.value,
    setCustomValidity(message) { this.message = message },
  }]))
  const submit = () => page.nodes(n => n.type === 'form')[0].props.onSubmit({
    preventDefault() {},
    currentTarget: { elements, reportValidity() { return Object.values(elements).every(el => !el.message) } },
  })
  for (const [field, value] of [['issuer', 'https:///missing-authority'], ['issuer', 'https://issuer.example?q=1'],
    ['clientId', '  '], ['scopes', 'openid not"valid']]) {
    const previous = elements[field].value
    elements[field].value = value
    await submit()
    assert.ok(elements[field].message)
    assert.equal(calls.length, 0)
    elements[field].value = previous
  }
  elements.scopes.value = 'profile,profile email'
  await submit()
  assert.deepEqual(calls[0].body.scopes, ['profile', 'email'])
  assert.deepEqual(calls[0].body.allowedDomains, [])
  assert.equal(calls[0].id, 'provider-1')
  assert.deepEqual(calls[1], { probe: 'provider-1' })
})
