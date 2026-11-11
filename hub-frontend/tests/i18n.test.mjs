import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { messages } from '../src/locales/messages.js'
import { dictionary } from '../src/locales/shell.js'
import { getLocale, setLocale, normalizeLocale, translateText as tx, localeMap, localeOptions, subscribeLocale, useLocale, detectLocale } from '../src/i18n.js'
import { count, duration, when, calendarTrend } from '../src/screens/usage-center-format.js'
import { serverMessage } from '../src/i18n.js'

test('server descriptors localize templates while preserving business names and legacy diagnostics', () => {
  const names = '保存 {count} / 日本語 <script>'
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
    const text = serverMessage({key: 'plugin.mcp.missing', params: { names }}, '', locale)
    assert.ok(text.endsWith(names))
    assert.equal(serverMessage('保存', '', locale), '保存')
    assert.equal(serverMessage({key: 'future.unknown', fallback: '原始诊断'}, '', locale), '原始诊断')
    assert.equal(serverMessage({key: 'constructor'}, 'raw', locale), 'raw')
    assert.equal(serverMessage(null, 'legacy detail', locale), 'legacy detail')
  }
  assert.equal(serverMessage({key: 'plugin.skills.ready', params: {count: 3, bundled: 2}}, '', 'en-US'),
    '3 skills ready; 2 pinned with the plugin.')
})

test('normalizes supported languages and safely falls back', () => {
  assert.equal(getLocale(), 'en-US')
  assert.equal(normalizeLocale('en-GB'), 'en-US')
  assert.equal(normalizeLocale('zh-CN'), 'zh-CN')
  assert.equal(normalizeLocale('ja'), 'ja-JP')
  assert.equal(normalizeLocale('ko'), 'ko-KR')
  assert.equal(normalizeLocale('unknown'), 'en-US')
})

test('additional language catalogs translate authored copy and preserve business data', () => {
  assert.deepEqual(localeOptions().map(item => item.value), ['zh-CN', 'en-US', 'ja-JP', 'ko-KR'])
  setLocale('ja-JP')
  assert.equal(tx('设置'), '設定')
  assert.equal(tx('模型目录'), 'モデルカタログ')
  assert.equal(tx('项目-保存'), '项目-保存')
  setLocale('ko-KR')
  assert.equal(tx('设置'), '설정')
  assert.equal(tx('模型目录'), '모델 카탈로그')
  setLocale('zh-CN')
})

test('switches repeatedly without old text snapshots or duplicate notifications', () => {
  setLocale('zh-CN')
  let notifications = 0
  const stop = subscribeLocale(() => notifications++)
  for (let i = 0; i < 10; i++) {
    setLocale('en-US'); assert.equal(tx('保存'), 'Save')
    setLocale('en-US')
    setLocale('zh-CN'); assert.equal(tx('保存'), '保存')
  }
  stop()
  assert.equal(notifications, 20)
  assert.equal(getLocale(), 'zh-CN')
})

test('interpolation keeps Chinese user names, punctuation and token-like data intact', () => {
  setLocale('en-US')
  const name = '保存 / 新建项目 {1}，客户名'
  assert.equal(tx('确定删除「{0}」？删除后无法恢复。', [name]), `Delete “${name}”? This cannot be undone.`)
  assert.equal(tx('自定义的保存项目名称'), '自定义的保存项目名称')
  // Passing a business name as a React child never enters the translator.
  function Row() { useLocale(); return React.createElement('div', null, tx('项目名称'), React.createElement('b', null, '保存')) }
  assert.match(renderToStaticMarkup(React.createElement(Row)), /<b>保存<\/b>/)
})

test('model list accessibility labels localize around the original provider name', () => {
  const provider = '保存 / 模型 {1}'
  for (const [locale, expected] of [['en-US', `Models for ${provider}`], ['ja-JP', `${provider}のモデル一覧`], ['ko-KR', `${provider}의 모델 목록`]]) {
    setLocale(locale)
    assert.equal(tx('{0}的模型列表', [provider]), expected)
  }
  setLocale('zh-CN')
})

test('translated sentence fragments preserve exactly one authored leading space', () => {
  assert.equal(tx(' 个应用', [], 'en-US'), ' apps')
  assert.equal(tx(' 的固定拉取账号在「仓库目录」配置并测试连接；同步目录后，可按仓库开启 Issue 自动同步并关联成员账号。', [], 'en-US'),
    ' uses a fixed sync account configured and tested in Repository catalog. After syncing the catalog, enable Issue sync per repository and map member accounts.')
})

test('constant maps update in both directions without changing machine keys or React lazy identity', () => {
  const Screen = React.lazy(() => Promise.resolve({ default: () => null }))
  const source = { todo: { label: '需求', Comp: Screen }, nested: [['new', '新建项目']] }
  const labels = localeMap(() => source)
  setLocale('en-US')
  assert.equal(labels.todo.label, 'Issue')
  assert.equal(labels.todo.Comp, Screen)
  assert.deepEqual(Object.keys(labels), ['todo', 'nested'])
  assert.equal(labels.nested[0][0], 'new')
  assert.equal(labels.nested[0][1], 'New project')
  setLocale('zh-CN')
  assert.equal(labels.todo.label, '需求')
  assert.equal(labels.todo.Comp, Screen)
  assert.equal(labels.nested[0][1], '新建项目')
  assert.equal(source.todo.label, '需求')
})

test('all English messages preserve interpolation slots', () => {
  const slots = s => [...new Set(String(s).match(/\{(?:\d+|key)\}/g) || [])].sort()
  for (const [source, translated] of Object.entries(messages)) {
    assert.deepEqual(slots(translated), slots(source), source)
    assert.ok(translated.trim(), source)
  }
  assert.deepEqual(Object.keys(dictionary['zh-CN']).sort(), Object.keys(dictionary['en-US']).sort())
})

test('source runtime cannot translate arbitrary DOM or listen to DOM mutations', () => {
  const runtime = fs.readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8')
  assert.doesNotMatch(runtime, /MutationObserver|createTreeWalker|nodeValue\s*=/)
})

test('visible date and compact number formats follow the UI locale without changing ledger keys', () => {
  const value = '2026-09-29T14:05:00Z'
  setLocale('zh-CN')
  assert.equal(count(15000), '1.5万')
  assert.equal(duration(120000), '2 分钟')
  const chineseDate = when(value)
  const before = calendarTrend([{ key: '2026-09-29', tokens: 1 }], 30).map(row => row.key)
  setLocale('en-US')
  assert.equal(count(15000), '15K')
  assert.equal(duration(120000), '2 minutes')
  assert.notEqual(when(value), chineseDate)
  assert.deepEqual(calendarTrend([{ key: '2026-09-29', tokens: 1 }], 30).map(row => row.key), before)
})

// --- First visit must follow the browser language (regression) ---------------
// detectLocale() is a pure function: every input is a parameter, so these cases
// never read the machine's system language and need no global injection, no
// re-import of the module graph, and no forced sequential ordering. Node 21+
// exposes a global `navigator` reporting the build machine's locale; because the
// module only consults navigator behind `typeof window !== 'undefined'`, a test
// run in Node cannot pick it up.
test('first visit follows the browser language instead of falling back to English', () => {
  for (const [languages, expected] of [
    [['zh-CN'], 'zh-CN'],
    [['zh-Hans-CN'], 'zh-CN'],
    [['zh'], 'zh-CN'],
    [['zh-SG'], 'zh-CN'],
    [['zh-MY'], 'zh-CN'],
    [['en-US'], 'en-US'],
    [['en-GB'], 'en-US'],
    [['ja-JP'], 'ja-JP'],
    [['ko-KR'], 'ko-KR'],
    [['ko'], 'ko-KR'],
    // Unsupported entries are skipped, the first supported one wins.
    [['de-DE', 'zh-CN'], 'zh-CN'],
    [['de-DE', 'ja-JP'], 'ja-JP'],
    // A list that only has unsupported languages still ends on the fallback.
    [['de-DE', 'fr-FR'], 'en-US'],
  ]) {
    assert.equal(detectLocale({ languages }), expected, `navigator.languages=${languages}`)
  }
  // `navigator.language` is the documented fallback when the list is missing.
  assert.equal(detectLocale({ language: 'zh-CN' }), 'zh-CN')
  assert.equal(detectLocale({ language: 'ja-JP' }), 'ja-JP')
  // The preference list is honoured before the single value.
  assert.equal(detectLocale({ languages: ['ko-KR'], language: 'zh-CN' }), 'ko-KR')
  // No browser preference at all (SSR/Node) keeps the documented fallback.
  assert.equal(detectLocale({}), 'en-US')
  assert.equal(detectLocale(), 'en-US')
  assert.equal(detectLocale({ languages: [], language: undefined }), 'en-US')
  // A malformed list must not throw.
  assert.equal(detectLocale({ languages: 'zh-CN' }), 'en-US')
  assert.equal(detectLocale({ languages: [null, '', 42, 'zh-CN'] }), 'zh-CN')
})

test('a language the user picked stays authoritative over the browser language', () => {
  assert.equal(detectLocale({ stored: 'zh-CN', languages: ['en-US'] }), 'zh-CN')
  assert.equal(detectLocale({ stored: 'en-US', languages: ['zh-CN'] }), 'en-US')
  assert.equal(detectLocale({ stored: 'ja-JP', languages: ['zh-CN'] }), 'ja-JP')
  assert.equal(detectLocale({ stored: 'ko-KR', languages: ['zh-CN'] }), 'ko-KR')
  // A stored value is normalized too, so hand-edited tags still work.
  assert.equal(detectLocale({ stored: 'zh', languages: ['en-US'] }), 'zh-CN')
  assert.equal(detectLocale({ stored: 'ZH-hans-sg' }), 'zh-CN')
  // Blank/garbage stored values fall through to the browser instead of sticking.
  assert.equal(detectLocale({ stored: '   ', languages: ['zh-CN'] }), 'zh-CN')
  assert.equal(detectLocale({ stored: null, languages: ['zh-CN'] }), 'zh-CN')
  assert.equal(detectLocale({ stored: '', language: 'ja-JP' }), 'ja-JP')
})

test('simplified and traditional Chinese tags all read Chinese, never English', () => {
  // Simplified tags, plus Traditional ones: simplified copy is more readable
  // than English for these users, and Traditional Chinese support is tracked
  // separately rather than silently remapped to a different script.
  for (const value of ['zh', 'zh-CN', 'zh-Hans', 'zh-Hans-CN', 'zh-SG', 'zh-MY', 'zh-CHS', 'zh_cn', 'ZH-hans-sg', 'zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-TW']) {
    assert.equal(normalizeLocale(value), 'zh-CN', value)
  }
  assert.equal(normalizeLocale('en-SG'), 'en-US')
  assert.equal(normalizeLocale(''), 'en-US')
  assert.equal(normalizeLocale(null), 'en-US')
  assert.equal(normalizeLocale('de-DE'), 'en-US')
})

test('the picker contract and Chinese copy are unchanged by browser detection', () => {
  // Detection must not add a selectable language: still exactly four options.
  assert.deepEqual(localeOptions().map(item => item.value), ['zh-CN', 'en-US', 'ja-JP', 'ko-KR'])
  // A Traditional tag resolves to zh-CN and therefore gets real Chinese copy.
  assert.equal(tx('模型目录', [], detectLocale({ languages: ['zh-TW'] })), '模型目录')
  assert.equal(tx('保存', [], detectLocale({ languages: ['zh-HK'] })), '保存')
  assert.equal(tx('模型目录', [], detectLocale({ languages: ['en-US'] })), 'Model catalog')
  // The remaining locales keep their own catalogs.
  assert.equal(tx('模型目录', [], detectLocale({ languages: ['ja-JP'] })), 'モデルカタログ')
  assert.equal(tx('模型目录', [], detectLocale({ languages: ['ko-KR'] })), '모델 카탈로그')
})

test('detection is machine-independent: no host locale or environment lookup', () => {
  const runtime = fs.readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8')
  assert.doesNotMatch(runtime, /process\.(env|platform)|resolvedOptions|require\('os'\)/)
  // navigator may only be read behind a `window` guard, so Node's global
  // navigator (which reports the build machine locale) can never leak in.
  assert.match(runtime, /typeof window === 'undefined'/)
  // Same inputs, same output, regardless of any ambient state.
  const sample = { languages: ['de-DE', 'zh-CN'], language: 'de-DE' }
  assert.equal(detectLocale(sample), 'zh-CN')
  assert.equal(detectLocale(sample), 'zh-CN')
  assert.equal(detectLocale({ ...sample, languages: ['de-DE'] }), 'en-US')
})
