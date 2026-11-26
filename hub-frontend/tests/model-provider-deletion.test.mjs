import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'
import english, { ja, ko } from '../src/locales/model-provider-deletion.js'
import { translateText } from '../src/i18n.js'

test('a changed impact clears the typed ID and requires a fresh confirmation', async t => {
  const result = {
    providerName: 'Sample', providerRevision: 'provider-revision', impactRevision: 'initial',
    models: [], members: [], tasks: [], canListMembers: true, canListTasks: true,
  }
  const requests = []
  let deleted = false
  const api = {
    modelProviderDeletionImpact: async () => ({ ...result }),
    async deleteModelProvider(...args) {
      requests.push(args)
      if (requests.length === 1) {
        result.impactRevision = 'updated'
        throw Object.assign(new Error('Changed'), { status: 409 })
      }
    },
  }
  const page = await createComponentHarness(new URL('../src/screens/ModelProviderDeletion.jsx', import.meta.url), {
    dependencies: {
      '../api.js': { api }, '../ui.jsx': { Modal: 'dialog', ErrorState: 'div', Loading: 'div' },
    },
    props: { providerId: 'provider-id', onDeleted: () => { deleted = true }, onClose() {} },
  })
  t.after(() => page.unmount())
  const submit = () => page.nodes(node => node.props.className === 'btn btn-danger', page.render().props.foot)[0]
  const input = () => page.nodes(node => node.type === 'input')[0]
  const type = value => page.act(() => input().props.onChange({ target: { value } }))

  assert.equal(submit().props.disabled, true)
  await page.flush()
  type('Sample')
  assert.equal(submit().props.disabled, true)
  type('provider-id')
  assert.equal(submit().props.disabled, false)
  await submit().props.onClick()
  await page.flush()
  assert.equal(input().props.value, '')
  assert.equal(submit().props.disabled, true)
  assert.equal(deleted, false)
  type('provider-id')
  await submit().props.onClick()
  assert.equal(deleted, true)
  assert.deepEqual(requests, [
    ['provider-id', 'provider-revision', 'initial', 'provider-id'],
    ['provider-id', 'provider-revision', 'updated', 'provider-id'],
  ])
})

test('deletion prompts use all four locales and preserve the service identifier', () => {
  for (const [locale, catalog] of Object.entries({ 'en-US': english, 'ja-JP': ja, 'ko-KR': ko })) {
    for (const [source, translated] of Object.entries(catalog)) {
      assert.equal(translateText(source, [], locale), translated)
      assert.deepEqual(translated.match(/\{\d+\}/g), source.match(/\{\d+\}/g))
      assert.equal(translateText(source, [], 'zh-CN'), source)
    }
    assert.ok(translateText('输入服务 ID「{0}」确认删除', ['service_830'], locale).includes('service_830'))
  }
})
