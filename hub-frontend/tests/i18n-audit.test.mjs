import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

function audit(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-i18n-audit-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const dir of ['scripts', 'src/screens', 'src/locales']) fs.mkdirSync(path.join(root, dir), { recursive: true })
  fs.copyFileSync(new URL('../scripts/audit-i18n.mjs', import.meta.url), path.join(root, 'scripts/audit-i18n.mjs'))
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}')
  fs.writeFileSync(path.join(root, 'src/locales/messages.js'),
    'export const messages = { "已连接": "Connected", "连接失败": "Connection failed", "重试": "Retry" }')
  fs.writeFileSync(path.join(root, 'src/screens/Fixture.jsx'), source)
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/audit-i18n.mjs'), path.join(root, 'report.json')], {
    encoding: 'utf8', env: { ...process.env, NODE_PATH: fileURLToPath(new URL('../node_modules', import.meta.url)) },
  })
  assert.equal(result.error, undefined)
  assert.ok(fs.existsSync(path.join(root, 'report.json')), result.stderr)
  return { status: result.status, report: JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8')) }
}

test('audit recognizes authored literals selected by nested tx conditionals', (t) => {
  const { status, report } = audit(t, "tx(connected ? '已连接' : retry ? '重试' : '连接失败')")
  assert.equal(status, 0)
  assert.equal(report.uiOccurrences, 3)
  assert.deepEqual(report.missingMessages, [])
  assert.deepEqual(report.unmarked, [])
})

test('each translated conditional branch still requires a catalog entry', (t) => {
  const { status, report } = audit(t, "tx(connected ? '已连接' : '未收录状态')")
  assert.equal(status, 1)
  assert.deepEqual(report.missingMessages, ['未收录状态'])
  assert.equal(report.missingOccurrences[0].source, '未收录状态')
  assert.deepEqual(report.unmarked, [])
})

test('audit keeps unmarked conditionals and nested data-building arguments visible', (t) => {
  const { status, report } = audit(t,
    "const label = ready ? '未翻译标题' : '未翻译备用'; tx(buildLabel('业务数据')); tx('前缀' + name)")
  assert.equal(status, 1)
  assert.equal(report.uiOccurrences, 0)
  assert.deepEqual(report.unmarked.map((row) => row.source), ['未翻译标题', '未翻译备用', '业务数据', '前缀'])
})
