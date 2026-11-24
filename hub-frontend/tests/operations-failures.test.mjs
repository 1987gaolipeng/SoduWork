import './helpers/chinese-locale.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createComponentHarness } from './helpers/react-harness.mjs'
import * as governance from '../src/screens/requirement-governance.js'

const deps = {
  './requirement-governance.js': governance,
  '../ui.jsx': { Icon: 'i', Modal: 'dialog', toast() {} },
  './PluginRunDialogs.jsx': { RunDrawer: 'aside' }, './plugin-foundation.css': {},
  './plugin-workshop-dialogs.css': {}, './plugin-admin-polish.css': {},
  './PluginOverviewParts.jsx': {}, './PluginDialogParts.jsx': {},
}
const file = name => new URL('../src/screens/' + name + '.jsx', import.meta.url)

test('failure rows show a diagnosis, open the exact run and task, and respect read permissions', async () => {
  const row = { id: 'run-9', taskId: 'task-3', taskTitle: 'Synthetic issue', diagnosis: '执行通道暂不可用',
    error: 'ECONNRESET' }
  const perms = new Set(['plugin.manage', 'task.view'])
  const host = await createComponentHarness(file('OperationsFailures'), { props: { rows: [row] },
    dependencies: { ...deps, '../api.js': { can: key => perms.has(key) } } })
  const html = renderToStaticMarkup(host.render())
  assert.match(html, /执行通道暂不可用/)
  assert.match(html, /Synthetic issue/)
  assert.doesNotMatch(html, /ECONNRESET/)
  const click = label => host.act(() => host.nodes(n => n.type === 'button' && n.props.children === label)[0].props.onClick())
  click('查看运行日志')
  const run = host.nodes(n => n.type.name === 'FailureRunDialog')[0]
  assert.equal(run.props.row.id, 'run-9')
  host.act(run.props.onClose)
  click('查看需求')
  const task = host.nodes(n => n.type.name === 'OperationsTaskDialog')[0]
  assert.equal(task.props.taskId, 'task-3')
  host.act(task.props.onClose)
  perms.clear()
  assert.doesNotMatch(renderToStaticMarkup(host.render({ rows: [row] })), /<button/)
})

test('retry uses the selected node model and is unavailable for read-only or historical attempts', async () => {
  const node = { id: 'second', key: 'build', type: 'ai', state: 'failed', retryModels: ['model-b'],
    diagnosis: { kind: 'execution', retryable: true, title: '本关执行失败', action: '' } }
  let allowed = true
  const calls = []
  const host = await createComponentHarness(file('PluginRunDialogs'), {
    exportName: 'NodeRunRow', privateExports: ['NodeRunRow'], props: { node, onRetry: (...args) => calls.push(args) },
    dependencies: { ...deps, '../api.js': { can: () => allowed } },
  })
  const select = host.nodes(n => n.type === 'select')[0]
  host.act(() => select.props.onChange({ target: { value: 'model-b' } }))
  host.act(() => host.nodes(n => n.type === 'button' && n.props.children === '换模型重试')[0].props.onClick())
  assert.deepEqual(calls, [[node, 'model-b']])
  allowed = false
  assert.doesNotMatch(renderToStaticMarkup(host.render({ node })), /<button|<select/)
  allowed = true
  const historical = { ...node, diagnosis: { ...node.diagnosis, retryable: false } }
  assert.doesNotMatch(renderToStaticMarkup(host.render({ node: historical })), /<button|<select/)
})

test('the open log drawer follows the latest run error after retry', async () => {
  const node = { id: 'attempt-2', key: 'build', attempt: 2, state: 'failed' }
  const run = { id: 'run-9', state: 'failed', error: 'first failure', nodes: [node] }
  const calls = []
  const host = await createComponentHarness(file('PluginRunDialogs'), {
    exportName: 'RunDrawer', props: { run, evidenceOpen: true },
    dependencies: { ...deps, '../api.js': { api: { retryRunGate: async (...args) => {
      calls.push(args)
      return { run: { ...run, state: 'succeeded', error: '' } }
    } } } },
  })
  const errors = () => host.nodes(n => n.props.className === 'ops-run-error').map(n => n.props.children)
  assert.deepEqual(errors(), ['first failure'])
  await host.nodes(n => n.type.name === 'NodeRunRow')[0].props.onRetry(node, 'model-b')
  assert.deepEqual(calls, [['run-9', 'build', { sourceNodeId: 'attempt-2', resumeRework: false,
    execution: { model: 'model-b' } }]])
  assert.deepEqual(errors(), [])
  host.unmount()
})
