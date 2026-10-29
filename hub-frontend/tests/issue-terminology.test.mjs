import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { messages } from '../src/locales/messages.js'
import { setLocale, translateText as tx } from '../src/i18n.js'
import * as governance from '../src/screens/requirement-governance.js'
import { createComponentHarness } from './helpers/react-harness.mjs'

const require = createRequire(import.meta.url)
const { parse } = require('@babel/parser')
const traverse = require('@babel/traverse').default
const localeDir = new URL('../src/locales/', import.meta.url)
const background = new Set([
  '日常零活', '任务查询路径要以 / 开头，并包含 {id}', '异步任务查询路径（可选）',
  '会替换为创建接口返回的任务 ID。', '等待任务结束', '项工作自然结束，结束后自动安装',
])
const specification = new Set([
  '需求与标准', '需求定版', '需求确认、风险判断与最终验收由人决定，其余交给持续执行。',
  '从需求文档到可上线版本', '需求澄清\n方案设计\n结构化表达',
  '职业画像（可多选，用于理解需求与推荐工作场景，不授予系统权限）',
])
function assertBusinessTerm(source, translated, context) {
  if (!/需求|任务/.test(source) || background.has(source) || source.includes('升级任务') || specification.has(source)) return
  assert.doesNotMatch(translated, /\b(?:tasks?|requirements?|requests?)\b/i, `${context}: ${source} → ${translated}`)
  assert.doesNotMatch(translated, /\ba issue\b/i, `${context}: incorrect article`)
}

test('every source locale fragment uses Issue for the business object, including entries hidden by later overrides', () => {
  let checked = 0
  for (const file of fs.readdirSync(localeDir).filter(name => name.endsWith('.js'))) {
    const ast = parse(fs.readFileSync(new URL(file, localeDir), 'utf8'), { sourceType: 'module' })
    traverse(ast, { ObjectProperty(p) {
      const { key, value } = p.node
      if (key.type !== 'StringLiteral' || value.type !== 'StringLiteral') return
      assertBusinessTerm(key.value, value.value, `${file}:${value.loc.start.line}`)
      if (/需求|任务/.test(key.value)) checked++
    } })
  }
  assert.ok(checked > 200, 'audit must cover the complete locale catalog, not just the final override')
  for (const [source, translated] of Object.entries(messages)) assertBusinessTerm(source, translated, 'effective catalog')
})

test('effective navigation, assignment, detail, acceptance and notification copy use Issues consistently', () => {
  setLocale('en-US')
  try {
    for (const [source, expected] of [
      ['需求池', 'Issues'], ['需求', 'Issue'], ['查看需求池', 'View issues'],
      ['需求标题', 'Issue title'], ['创建需求', 'Create issue'], ['需求编号', 'Issue ID'],
      ['分配需求给下属', 'Assign issues to team members'], ['逾期需求', 'Overdue issues'],
      ['需求已交付', 'Issues delivered'], ['没有可执行需求', 'No executable issues'],
      ['组织内所有需求', 'All issues in the organization'],
    ]) assert.equal(tx(source), expected, source)
    assert.match(tx('暂无审计记录，需求下发、用户或权限变更等管理操作会记录在此。'), /Issue dispatches/)
    assert.equal(tx('让一句需求，稳定走到可验收的结果'), 'From an issue to a consistently acceptable result')
    assert.equal(tx('需求列表加载失败：'), 'Issues could not be loaded: ')
  } finally { setLocale('zh-CN') }
})

test('HTTP requests, approvals, sharing applications, merge requests and specification requirements retain their meaning', () => {
  setLocale('en-US')
  try {
    for (const source of ['请求', '模型请求', '请求超时，请稍后重试', '请求失败（HTTP {0}）',
      '申请发布', '退回申请', '查看申请', '查看 {0} 的共享申请', '合并请求（MR/PR）'])
      assert.match(tx(source), /\brequests?\b/i, source)
    for (const source of specification) assert.match(tx(source), /\brequirements\b/i, source)
    for (const source of background) assert.match(tx(source), /\btasks?\b/i, source)
    assert.equal(tx('让「{0}」处理需求', ['Task / Request / Requirement 客户原文']),
      'Run “Task / Request / Requirement 客户原文” for an issue')
    assert.equal(tx('需求池'), 'Issues')
  } finally { setLocale('zh-CN') }
  assert.equal(tx('需求池'), '需求池')
})

test('authored JSX labels cannot bypass the Issue dictionary with hardcoded English object names', () => {
  const root = new URL('../src/', import.meta.url)
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? (entry.name === 'locales' ? [] : walk(new URL(entry.name + '/', dir)))
      : /\.(jsx|js)$/.test(entry.name) ? [new URL(entry.name, dir)] : [])
  let checked = 0
  for (const file of walk(root)) {
    const ast = parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['jsx'] })
    const inspect = (p, value) => {
      checked++
      assert.doesNotMatch(value, /\b(?:Tasks?|Requirements?|Requests?)\b/, `${path.basename(file.pathname)}:${p.node.loc.start.line}`)
    }
    traverse(ast, {
      JSXText(p) { inspect(p, p.node.value) },
      JSXAttribute(p) {
        if (['title', 'label', 'placeholder', 'aria-label'].includes(p.node.name.name) && p.node.value?.type === 'StringLiteral')
          inspect(p, p.node.value.value)
      },
    })
  }
  assert.ok(checked > 100)
})

test('the real English execution form renders Issue labels without rewriting user titles or the Task API payload', async () => {
  setLocale('en-US')
  const calls = []
  let host
  try {
    host = await createComponentHarness(new URL('../src/screens/PluginRunDialogs.jsx', import.meta.url), {
      exportName: 'PluginRunForm',
      props: { plugin: { name: 'Customer Request Helper', bindings: [
        { id: 'binding-a', enabled: true, config: {} },
      ], versions: [{ manifest: { inputs: [] } }] }, onStarted() {}, onClose() {} },
      dependencies: {
        './requirement-governance.js': governance,
        '../api.js': { api: {
          tasks: async () => [{ id: 'task-api-id', title: 'Customer Task / Request / Requirement', status: 'todo', triageStage: 'ready' }],
          startPluginRun: async (...args) => { calls.push(args); return { ok: true } },
        } },
        '../ui.jsx': { Icon: 'svg', Modal: 'dialog', SelectMenu: 'select', toast() {} },
        './PluginOverviewParts.jsx': { LoadIssue: 'aside' },
        './PluginDialogParts.jsx': { Field: 'Field', NoticeList: 'NoticeList' },
      },
    })
    host.render(); await host.flush()
    assert.equal(host.render().props.title, 'Run “Customer Request Helper” for an issue')
    const options = host.nodes(node => node.type === 'option')
    assert.equal(options.find(node => node.props.value === '').props.children, 'Select issue')
    assert.deepEqual(options.find(node => node.props.value === 'task-api-id').props.children, ['Customer Task / Request / Requirement', ''])
    await host.render().props.foot.props.children[1].props.onClick()
    assert.deepEqual(calls, [['task-api-id', { bindingId: 'binding-a', inputs: {} }]])
  } finally { host?.unmount(); setLocale('zh-CN') }
})
