import test from 'node:test'
import assert from 'node:assert/strict'
import * as governance from '../src/screens/requirement-governance.js'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale } from '../src/i18n.js'

const row = (id, extra = {}) => ({ id, title: id, status: 'todo', triageStage: 'ready', ...extra })

test('server review projection survives doing and triage defaults without faking completion', () => {
  const review = row('review', { status: 'doing', requirementStage: 'reviewing', due: 1 })
  assert.equal(governance.requirementStage(review), 'reviewing')
  assert.equal(governance.pluginRequirementBlocker(review), '待验收')
  assert.equal(governance.requirementStage({ ...review, status: 'done' }), 'delivered')
  assert.equal(governance.requirementStage({ ...review, archivedAt: 1 }), 'closed')
  assert.equal(governance.requirementStage({ ...review, status: 'cancel' }), 'closed')
  assert.equal(governance.requirementStage(row('returned', { status: 'doing', ai: { state: 'done' } })), 'delivering')
  assert.equal(governance.requirementStage(row('paused', { status: 'paused', requirementStage: 'delivering' })), 'delivering')
  assert.equal(governance.requirementStage({ ...review, status: 'paused' }), 'reviewing')
  assert.equal(governance.pluginRequirementBlocker(row('paused', { status: 'paused' })), '正在交付')
  const summary = governance.requirementSummary([review], 100)
  assert.equal(summary.stages.reviewing, 1)
  assert.equal(summary.done, 0)
  assert.equal(summary.overdue, 1)
  assert.equal(summary.rate, 0)
  assert.equal(governance.requirementStage(row('bad', { requirementStage: 'unknown', triageStage: 'other' })), 'ready')
})

test('requirement stages and execution blockers follow the current language', () => {
  setLocale('en-US')
  try {
    assert.equal(governance.REQUIREMENT_LABELS.intake, 'Inbox')
    assert.equal(governance.REQUIREMENT_LABELS.reviewing, 'In review')
    assert.equal(governance.pluginRequirementBlocker(row('review', { requirementStage: 'reviewing' })), 'In review')
    assert.equal(governance.pluginRequirementBlocker(row('private', { canViewExecution: false })), 'No execution access')
  } finally { setLocale('zh-CN') }
  assert.equal(governance.REQUIREMENT_LABELS.reviewing, '待验收')
})

test('governance separates preparation, closed history and actual execution risk', () => {
  const rows = [row('intake', { triageStage: 'intake', due: 1 }), row('clarify', { triageStage: 'clarifying' }),
    row('priority', { urgent: true, important: true }), row('failed', { ai: { state: 'failed' }, due: 1 }),
    row('running', { status: 'doing' }), row('done', { status: 'done' }),
    row('cancelled', { status: 'cancel', due: 1 }), row('archived', { archivedAt: 5, ai: { state: 'failed' } })]
  const summary = governance.requirementSummary(rows, 100)
  assert.equal(summary.total, 6)
  assert.equal(summary.preparing, 2)
  assert.equal(summary.closed, 2)
  assert.equal(summary.done, 1)
  assert.equal(summary.overdue, 1)
  assert.equal(summary.failed, 1)
  assert.equal(summary.risk, 1, 'a failed overdue requirement is counted once')
  assert.equal(summary.stages.delivering, 1)
  assert.equal(governance.hasExecutionIssue(rows[2]), false, 'priority is not a failed execution')
})

test('plugin options label blocked requirements and preserve project scope', () => {
  const rows = [row('ready'), row('archive', { archivedAt: 1 }), row('intake', { triageStage: 'intake' }),
    row('clarifying', { triageStage: 'clarifying' }), row('private', { canViewExecution: false }),
    row('readonly', { readOnly: true }), row('norun', { canRunPlugin: false }),
    row('queued', { workRouting: { conversationTurn: { state: 'queued' } } }),
    row('dispatching', { ai: { state: 'dispatching' } }), row('done', { status: 'done' }),
    row('other', { projectId: 'other' })].map((task) => ({ projectId: 'project', ...task }))
  const choices = governance.pluginRequirementOptions(rows, { projectId: 'project' })
  assert.equal(choices.length, 10)
  assert.deepEqual(choices.filter((task) => !task.blockedReason).map((task) => task.id), ['ready'])
  assert.ok(choices.slice(1).every((task) => task.blockedReason.length > 0))
  assert.equal(rows[1].blockedReason, undefined, 'read projection does not mutate server data')
  assert.equal(governance.pluginRequirementOptions(rows, {}).length, rows.length)
})

test('real plugin form chooses a runnable requirement, changes binding safely and sends only valid selection', async () => {
  setLocale('zh-CN')
  const rows = [row('archive', { archivedAt: 1, projectId: 'a' }), row('private', { canViewExecution: false, projectId: 'a' }),
    row('ready-a', { projectId: 'a' }), row('intake-b', { projectId: 'b', triageStage: 'intake' })]
  const calls = [], notices = []
  const host = await createComponentHarness(new URL('../src/screens/PluginRunDialogs.jsx', import.meta.url), {
    exportName: 'PluginRunForm',
    props: { plugin: { name: 'Fixture', bindings: [
      { id: 'a', projectId: 'a', enabled: true, config: {} }, { id: 'b', projectId: 'b', enabled: true, config: {} },
    ], versions: [{ manifest: { inputs: [] } }] }, onStarted: (receipt) => calls.push(receipt), onClose() {} },
    dependencies: {
      './requirement-governance.js': governance,
      '../api.js': { api: { tasks: async () => rows, startPluginRun: async (id, body) => ({ id, ...body }) } },
      '../ui.jsx': { Icon: 'svg', Modal: 'dialog', SelectMenu: 'select', toast: (message) => notices.push(message) },
      './PluginOverviewParts.jsx': { LoadIssue: 'aside' },
      './PluginDialogParts.jsx': { Field: 'Field', NoticeList: 'NoticeList' },
    },
  })
  host.render(); await host.flush()
  let selects = host.nodes((node) => node.type === 'select')
  assert.equal(selects[0].props.value, 'ready-a')
  const options = host.nodes((node) => node.type === 'option')
  assert.equal(options.find((node) => node.props.value === 'archive').props.disabled, true)
  assert.equal(options.find((node) => node.props.value === 'private').props.disabled, true)
  const submit = () => host.render().props.foot.props.children[1]
  assert.equal(submit().props.disabled, false)
  await submit().props.onClick(); host.render()
  assert.deepEqual(calls, [{ id: 'ready-a', bindingId: 'a', inputs: {} }])
  host.act(() => selects[1].props.onChange({ target: { value: 'b' } }))
  selects = host.nodes((node) => node.type === 'select')
  assert.equal(selects[0].props.value, '')
  assert.equal(submit().props.disabled, true)
  await submit().props.onClick()
  assert.equal(calls.length, 1)
  assert.equal(notices.length, 1)
  host.unmount()
})
