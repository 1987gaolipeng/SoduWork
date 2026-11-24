import assert from 'node:assert/strict'
import test from 'node:test'
import './helpers/chinese-locale.mjs'
import { createComponentHarness } from './helpers/react-harness.mjs'

test('a write-only webhook reports the saved or draft HTTP scheme through its input description', async t => {
  const writes = []
  const api = {
    alertConfig: async () => ({ configured: true, url: '••••••••', usesPlainHttp: true }),
    async saveAlertConfig(url) {
      writes.push(url)
      return { configured: Boolean(url) }
    },
  }
  const page = await createComponentHarness(new URL('../src/screens/AlertChannel.jsx', import.meta.url), {
    dependencies: { '../api.js': { api }, '../ui.jsx': { ErrorState: 'div', toast() {} } },
  })
  t.after(() => page.unmount())
  const input = () => page.nodes(node => node.type === 'input')[0]
  const button = name => page.nodes(node => node.type === 'button' && node.props.children === name)[0]
  const type = value => page.act(() => input().props.onChange({ target: { value } }))
  function check(value, configured, warn) {
    const field = input().props
    assert.equal(field.type, 'password')
    assert.equal(field.value, value)
    const ids = field['aria-describedby'].split(/\s+/)
    const descriptions = ids.map(id => page.nodes(node => node.props.id === id)[0].props.children)
    assert.ok(descriptions.some(text => text.includes(configured ? '已配置' : '尚未配置')))
    const warnings = page.nodes(node => node.props.role === 'status')
    assert.equal(warnings.length, Number(warn))
    if (warn) {
      assert.ok(ids.includes(warnings[0].props.id))
      assert.match(warnings[0].props.children, /HTTP.*明文.*HTTPS/)
    }
  }

  page.render()
  await page.flush()
  check('', true, true)
  assert.equal(button('保存').props.disabled, true)
  const https = 'https://alerts.example.test/team'
  const http = 'http://alerts.example.test/team'
  type(https)
  check(https, true, false)
  type('')
  check('', true, true)
  type(https)
  await button('保存').props.onClick()
  check('', true, false)
  type(http)
  check(http, true, true)
  await button('保存').props.onClick()
  check('', true, true)
  await button('清除地址').props.onClick()
  check('', false, false)
  assert.equal(button('清除地址'), undefined)
  assert.deepEqual(writes, [https, http, ''])
})
