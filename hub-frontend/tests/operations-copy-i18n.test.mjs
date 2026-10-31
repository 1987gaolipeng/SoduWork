import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { messages } from '../src/locales/messages.js'
import { messagesByLocale } from '../src/locales/extra-languages.js'
import { getLocale, setLocale, translateText as tx } from '../src/i18n.js'
import { operationsText } from '../src/screens/operations-copy.js'

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../hub-backend')
const source = fs.readFileSync(path.join(backend, 'app', 'services', 'operations.py'), 'utf8')

// operations.py composes the overview copy in zh-CN and the screen renders it verbatim
// after an operationsText pass. Extract every double-quoted CJK literal (f-string bodies
// included) and normalize the interpolation placeholders to the {0} dictionary shape. If
// the backend adds or renames a string, this lock fails until en/ja/ko entries exist.
const normalized = value => value
  .replace(/\{workflow\['failed'\]\}/g, '{0}')
  .replace(/\{type\(exc\)\.__name__\}/g, '{0}')
const composed = [...source.matchAll(/"([^"\\]*[\u3400-\u9fff][^"\\]*)"/g)].map(m => normalized(m[1]))
const catalogStrings = [...new Set(composed)]

test('every operations.py string carries en, ja and ko entries', () => {
  assert.ok(catalogStrings.length >= 11, `extraction broke: ${catalogStrings.length} entries`)
  const missing = []
  for (const label of catalogStrings) {
    if (!(label.trim() in messages)) missing.push(`en: ${label}`)
    if (!(label.trim() in messagesByLocale['ja-JP'])) missing.push(`ja: ${label}`)
    if (!(label.trim() in messagesByLocale['ko-KR'])) missing.push(`ko: ${label}`)
  }
  // The empty-error fallback lives on the screen, not in the backend response.
  for (const label of ['流程执行失败', '选择文件', '未选择任何文件']) {
    if (!(label in messages)) missing.push(`en: ${label}`)
    if (!(label in messagesByLocale['ja-JP'])) missing.push(`ja: ${label}`)
    if (!(label in messagesByLocale['ko-KR'])) missing.push(`ko: ${label}`)
  }
  assert.deepEqual(missing, [])
})

test('operations overview copy resolves per locale', () => {
  setLocale('en-US')
  for (const label of catalogStrings) {
    const probe = label.includes('{0}') ? label.replace('{0}', '7') : label
    assert.notEqual(operationsText(probe), probe, `missing en entry for ${label}`)
  }
  assert.equal(operationsText('75 条流程失败'), '75 failed workflows')
  assert.equal(operationsText('数据库不可用：ConnectionError'), 'Database unavailable: ConnectionError')
  assert.equal(operationsText('多实例控制面'), 'Multi-instance control plane')
  assert.equal(operationsText(''), '')
  setLocale('ja-JP')
  assert.equal(operationsText('75 条流程失败'), 'ワークフローが 75 件失敗しました')
  assert.equal(operationsText('数据库不可用：ConnectionError'), 'データベースに接続できません: ConnectionError')
  setLocale('ko-KR')
  assert.equal(operationsText('75 条流程失败'), '실패한 워크플로 75건')
  setLocale('zh-CN')
  assert.equal(operationsText('75 条流程失败'), '75 条流程失败')
  assert.equal(getLocale(), 'zh-CN')
})

test('unknown backend copy and run data stay verbatim in every locale', () => {
  setLocale('en-US')
  assert.equal(operationsText('自定义阻塞说明'), '自定义阻塞说明')
  assert.equal(operationsText('模型调用失败或已中断，请查看会话记录后重试。'), '模型调用失败或已中断，请查看会话记录后重试。')
  setLocale('zh-CN')
})
