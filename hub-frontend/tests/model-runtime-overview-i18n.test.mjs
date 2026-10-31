import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import english, { ja, ko } from '../src/locales/model-runtime-overview.js'
import { messages } from '../src/locales/messages.js'
import { messagesByLocale } from '../src/locales/extra-languages.js'
import { translateText as tx } from '../src/i18n.js'

const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8')
const literals = source => [...source.matchAll(/tx\(\s*["']([^"']+)["']/g)]
  .map(match => match[1].trim()).filter(label => /[\u3400-\u9fff]/.test(label))
const runtime = read('../src/screens/ModelRuntime.jsx')
const catalog = read('../src/screens/ModelCatalog.jsx')
const summaryStart = catalog.indexOf('catalogSummary={')
const summaryEnd = catalog.indexOf('{error && <ErrorState', summaryStart)
const fieldStart = runtime.indexOf('const FIELDS = localeMap')
const fieldEnd = runtime.indexOf('export default function ModelRuntime', fieldStart)
const fields = [...runtime.slice(fieldStart, fieldEnd).matchAll(/\['[^']+',\s*'([^']+)'/g)].map(match => match[1])
const required = new Set([...literals(runtime), ...literals(catalog.slice(summaryStart, summaryEnd)),
  ...fields, '已配置', '已启用模型'])
const directCatalogs = { 'en-US': messages, 'ja-JP': messagesByLocale['ja-JP'], 'ko-KR': messagesByLocale['ko-KR'] }

test('runtime overview and concurrency controls have direct English, Japanese and Korean copy', t => {
  assert.ok(summaryStart >= 0 && summaryEnd > summaryStart, 'extract the real catalog summary and its actions')
  assert.ok(fieldStart >= 0 && fieldEnd > fieldStart && fields.length > 0, 'extract the real concurrency field labels')
  for (const key of ['目录配置', '实时负载', '近一小时请求情况', '每人同时运行', '未启用排队', '暂无已开始请求']) {
    assert.ok(required.has(key), 'extraction covers ' + key)
  }
  t.diagnostic('Fixed model overview and capacity labels: ' + required.size)
  for (const [locale, dictionary] of Object.entries(directCatalogs)) {
    assert.deepEqual([...required].filter(key => !Object.hasOwn(dictionary, key)), [], locale + ': no fallback')
    for (const key of required) assert.ok(dictionary[key].trim(), locale + ': ' + key)
  }
})

test('model overview catalogs preserve placeholders and are connected to the active translator', () => {
  const slots = value => [...new Set(value.match(/\{\d+\}/g) || [])].sort()
  assert.deepEqual(Object.keys(english).sort(), [...required].sort(), 'catalog matches the intended overview and runtime scope')
  for (const [locale, dictionary] of Object.entries({ 'en-US': english, 'ja-JP': ja, 'ko-KR': ko })) {
    assert.deepEqual(Object.keys(dictionary).sort(), Object.keys(english).sort(), locale)
    for (const [source, translated] of Object.entries(dictionary)) {
      assert.ok(translated.trim(), source)
      assert.deepEqual(slots(translated), slots(source), locale + ': ' + source)
      assert.equal(tx(source, [], locale), translated, locale + ': active catalog entry')
    }
  }
})

test('model overview scope explains the proxy boundary without translating parameter values', () => {
  const scope = '查看目录配置，以及经 SoduWork 代理的实时请求与近一小时统计。'
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    assert.ok(tx(scope, [], locale).includes('SoduWork'))
    const label = '客户服务 {9} / Fixture provider'
    const result = tx('{0}应为 {1}–{2} 的整数', [label, 1, 256], locale)
    assert.ok(result.includes(label), locale + ': caller-provided labels stay unchanged')
    assert.ok(result.includes('1') && result.includes('256'))
  }
})
