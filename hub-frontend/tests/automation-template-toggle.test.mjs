import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale, translateText } from '../src/i18n.js'
import messages, { ja, ko } from '../src/locales/automation-templates.js'

const original = [
  { id: 'daily-report', name: 'Daily report', enabled: true, every: 'daily', note: 'Keep instructions',
    nameLocales: { 'ja-JP': '日報' }, requiredCapabilities: ['office'], updatedAt: '2026-11-02' },
  { id: 'weekly-review', name: 'Weekly review', enabled: false, every: 'weekly' },
]

test('template list toggles publication, preserving data and locking actions until persistence succeeds', async t => {
  setLocale('zh-CN')
  const requests = [], notices = []
  let settle
  const page = await createComponentHarness(new URL('../src/screens/AutomationTemplates.jsx', import.meta.url), {
    dependencies: {
      '../api.js': { api: {
        automationTemplates: async () => ({ items: structuredClone(original) }),
        saveAutomationTemplates: items => { requests.push(items); return new Promise((resolve, reject) => { settle = { resolve, reject } }) },
      } },
      '../ui.jsx': { Confirm: () => null, Icon: () => null, Loading: () => null, Modal: () => null,
        SelectMenu: () => null, toast: text => notices.push(text) },
      '../components/LocalesEditor.jsx': () => null, './automation-templates.css': {},
    },
  })
  t.after(() => page.unmount())
  page.render(); await page.flush()
  const toggle = () => page.nodes(n => n.props.className?.includes('at-toggle'))[0]
  const request = toggle().props.onClick()
  assert.equal(toggle().props.disabled, true)
  assert.equal(toggle().props['aria-busy'], true)
  assert.equal(page.nodes(n => n.type === 'button' && !n.props.disabled).length, 0)
  await toggle().props.onClick()
  assert.equal(requests.length, 1, 'cannot submit twice while saving')
  assert.deepEqual(requests[0], [{ ...original[0], enabled: false }, original[1]])
  assert.equal(page.nodes(n => n.type === 'article')[0].props.className, 'at-card', 'do not display success before receipt')
  settle.reject(new Error('Offline')); await request; page.render()
  assert.equal(toggle().props.children, '停用')
  assert.match(notices.at(-1), /Offline/)
  const retry = toggle().props.onClick()
  settle.resolve({ items: requests.at(-1) }); await retry; page.render()
  assert.equal(toggle().props.children, '启用')
  assert.equal(page.nodes(n => n.type === 'article')[0].props.className, 'at-card off')
  const enable = toggle().props.onClick()
  settle.resolve({ items: requests.at(-1) }); await enable; page.render()
  assert.deepEqual(requests.at(-1), original, 'reenabling restores only publication, not different instructions')
  assert.equal(toggle().props.children, '停用')
})

test('publication messages have English, Japanese and Korean translations', () => {
  for (const [locale, catalog] of [['en-US', messages], ['ja-JP', ja], ['ko-KR', ko]]) {
    for (const [key, value] of Object.entries(catalog)) {
      assert.notEqual(value, key)
      assert.equal(translateText(key, ['日报'], locale), value.replace('{0}', '日报'))
    }
  }
})
