import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dictionary } from '../src/locales/shell.js'
import english, { ja, ko } from '../src/locales/governance-overview.js'
import { messages } from '../src/locales/messages.js'
import { messagesByLocale } from '../src/locales/extra-languages.js'
import { setLocale, t, translateText as tx, localeMap } from '../src/i18n.js'

const locales = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']
const nativeCatalogs = { 'en-US': messages, 'ja-JP': messagesByLocale['ja-JP'], 'ko-KR': messagesByLocale['ko-KR'] }

test('every supported language has the full public shell catalog without fallback', () => {
  const required = Object.keys(dictionary['zh-CN']).sort()
  assert.ok(required.length >= 64)
  for (const locale of locales) {
    assert.deepEqual(Object.keys(dictionary[locale]).sort(), required, locale)
    for (const key of required) {
      assert.ok(dictionary[locale][key].trim(), locale + ': ' + key)
      assert.equal(t(key, '__missing__', locale), dictionary[locale][key])
    }
  }
  assert.equal(t('nav.overview', '', 'ja-JP'), 'ガバナンス概要')
  assert.equal(t('nav.overview', '', 'ko-KR'), '거버넌스 개요')
  assert.equal(t('health.ok', '', 'ja-JP'), 'サービスは正常です')
  assert.equal(t('health.ok', '', 'ko-KR'), '서비스가 정상입니다')
})

test('all authored governance and shell text has direct English, Japanese and Korean entries', () => {
  const labels = new Set()
  for (const relative of ['../src/screens/Overview.jsx', '../src/App.jsx']) {
    const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
    for (const match of source.matchAll(/tx\(\s*["']([^"']+)["']/g)) {
      const label = match[1].trim()
      if (/[\u3400-\u9fff]/.test(label)) labels.add(label)
    }
  }
  assert.ok(labels.size >= 45, 'source extraction must cover the whole overview')
  for (const [locale, catalog] of Object.entries(nativeCatalogs)) {
    assert.deepEqual([...labels].filter(label => !Object.hasOwn(catalog, label)), [], locale)
  }
})

test('governance catalogs preserve every interpolation slot and receive native text', () => {
  const slots = value => [...new Set(value.match(/\{\d+\}/g) || [])].sort()
  for (const [locale, catalog] of Object.entries({ 'en-US': english, 'ja-JP': ja, 'ko-KR': ko })) {
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(english).sort(), locale)
    for (const [source, translated] of Object.entries(catalog)) {
      assert.ok(translated.trim(), source)
      assert.deepEqual(slots(translated), slots(source), locale + ': ' + source)
    }
  }
  const businessValue = '客户项目 {1} / 保存'
  assert.equal(tx('{0} 未完成', [businessValue], 'ja-JP'), '未完了 ' + businessValue + ' 件')
  assert.equal(tx('{0} 未完成', [businessValue], 'ko-KR'), '미완료 ' + businessValue + '건')
  assert.equal(tx('客户自定义来源', [], 'en-US'), '客户自定义来源')
})

test('language changes refresh navigation constants, metrics and settings without English fallback', () => {
  const nav = localeMap(() => ({ label: '治理总览', group: '总览' }))
  try {
    for (let repeat = 0; repeat < 2; repeat++) {
      setLocale('ja-JP')
      assert.deepEqual([nav.label, nav.group], ['ガバナンス概要', '概要'])
      assert.equal(tx('逾期 {0} · 执行异常 {1}', [2, 3]), '期限超過 2 件 · 実行上の問題 3 件')
      assert.equal(tx('当前{0}主题，切换为{1}', [tx('深色'), tx('浅色')]), '現在のテーマ: ダーク。ライトに切り替え')
      setLocale('ko-KR')
      assert.deepEqual([nav.label, nav.group], ['거버넌스 개요', '개요'])
      assert.equal(tx('已启用'), '활성화')
      assert.equal(tx('已停用'), '비활성화')
      assert.equal(tx('暂无关联需求'), '연결된 이슈가 없습니다')
      assert.equal(tx('逾期 {0} · 执行异常 {1}', [2, 3]), '기한 초과 2건 · 실행 문제 3건')
      assert.equal(tx('当前{0}主题，切换为{1}', [tx('深色'), tx('浅色')]), '현재 테마: 어둡게. 밝게 테마로 전환')
      setLocale('en-US')
      assert.equal(tx('定时派活'), 'Scheduled assignment')
      assert.equal(tx('已启用'), 'Enabled')
      setLocale('zh-CN')
      assert.deepEqual([nav.label, nav.group], ['治理总览', '总览'])
      assert.equal(tx('已启用'), '已启用')
    }
  } finally { setLocale('zh-CN') }
})
