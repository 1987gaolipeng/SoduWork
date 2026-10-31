import test from 'node:test'
import assert from 'node:assert/strict'
import { translateText as tx } from '../src/i18n.js'
import english, { ja, ko } from '../src/locales/capability-catalog.js'
import { messages } from '../src/locales/messages.js'
import { messagesByLocale } from '../src/locales/extra-languages.js'

const catalogs = { 'en-US': english, 'ja-JP': ja, 'ko-KR': ko }
const wired = { 'en-US': messages, 'ja-JP': messagesByLocale['ja-JP'], 'ko-KR': messagesByLocale['ko-KR'] }
const slots = value => (value.match(/\{\d+\}/g) || []).sort()

test('capability catalog has the same 42 lookup keys and placeholders in English, Japanese and Korean', () => {
  const keys = Object.keys(english).sort()
  assert.equal(keys.length, 42)
  for (const [locale, catalog] of Object.entries(catalogs)) {
    assert.deepEqual(Object.keys(catalog).sort(), keys, locale + ': same key set')
    for (const key of keys) {
      assert.equal(key, key.trim(), locale + ': lookup trims authored source keys')
      assert.equal(typeof catalog[key], 'string', locale + ': ' + key)
      assert.ok(catalog[key].trim(), locale + ': non-empty translation for ' + key)
      assert.deepEqual(slots(catalog[key]), slots(key), locale + ': placeholders in ' + key)
    }
  }
})

for (const [locale, catalog] of Object.entries(catalogs)) {
  test(locale + ': actual registered translations cover every capability catalog label', () => {
    for (const [key, translated] of Object.entries(catalog)) {
      assert.ok(Object.hasOwn(wired[locale], key), locale + ': direct registration for ' + key)
      assert.equal(wired[locale][key], translated, locale + ': no later override for ' + key)
      assert.equal(tx(key, [], locale), translated, locale + ': actual translateText for ' + key)
    }
  })

  test(locale + ': counts and device labels preserve source spacing and business data', () => {
    for (const key of ['项', '台 SoduWork 在用']) {
      assert.equal(tx(' ' + key, [], locale), ' ' + catalog[key])
    }
    const device = 'SoduWork ·已开放-abc123'
    assert.equal(tx('提交设备：{0}', [device], locale), catalog['提交设备：{0}'].replace('{0}', device))
    assert.equal(tx('有 {0} 个开放项未匹配到当前目录', [3], locale),
      catalog['有 {0} 个开放项未匹配到当前目录'].replace('{0}', '3'))
  })
}
