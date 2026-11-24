import test from 'node:test'
import assert from 'node:assert/strict'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale } from '../src/i18n.js'

test('the waiting metric opens the approval queue with a keyboard-accessible button', async t => {
  const queue = 'approval-queue'
  const host = await createComponentHarness(new URL('../src/screens/OperationsCenter.jsx', import.meta.url), {
    dependencies: {
      '../api.js': { api: {} },
      '../ui.jsx': { Icon: 'svg', useAsync: () => ({ data: { work: { pendingApprovals: 2 }, hub: {} } }) },
      './operations-center.css': {},
      './operations-copy.js': { operationsText: value => value },
      './OperationsApprovalQueue.jsx': { default: queue, __esModule: true },
      './OperationsFailures.jsx': { default: 'failure-list', __esModule: true },
    },
  })
  t.after(host.unmount)
  const trigger = host.nodes(node => node.type === 'button' && node.props['aria-haspopup'] === 'dialog')[0]
  assert.ok(trigger, 'waiting approvals should be an actionable metric')
  assert.equal(host.nodes(node => node.type === queue).length, 0)
  host.act(trigger.props.onClick)
  const dialog = host.nodes(node => node.type === queue)[0]
  assert.ok(dialog)
  host.act(dialog.props.onClose)
  assert.equal(host.nodes(node => node.type === queue).length, 0)
})

const queueFile = new URL('../src/screens/OperationsApprovalQueue.jsx', import.meta.url)
function queueHost(name, props, api, extras = {}) {
  return createComponentHarness(queueFile, { exportName: name, privateExports: [name], props, dependencies: {
    '../api.js': { api, can: () => true },
    '../ui.jsx': { Modal: 'dialog', useAsync: read => ({ data: read() }) },
    '../ListPager.jsx': 'pager', './OperationsFailures.jsx': {},
    ...extras,
  } })
}

test('the queue identifies the waiting reviewers, overdue requests and permitted actions', async t => {
  setLocale('zh-CN')
  const row = { id: 'gate', taskTitle: 'Release notes', action: 'deploy', canViewDetails: true,
    createdAt: Date.now() - 120_000, dueAt: Date.now() - 60_000, overdue: true, assignees: [{ userId: 'u', userName: 'Casey' }],
    canDecide: false, canWithdraw: true, canTransfer: true }
  const monitorOnly = { id: 'masked', action: 'review', canViewDetails: false, assignees: [] }
  const selected = []
  const host = await queueHost('ApprovalPage', { page: 2, setPage() {}, formatAge: () => '2 分钟',
    select: (...args) => selected.push(args) }, { operationsApprovals(limit, offset) {
    assert.deepEqual([limit, offset], [20, 20]); return { items: [row, monitorOnly], total: 22 }
  } })
  t.after(host.unmount)
  const [item, masked] = host.nodes(node => node.type === 'li')
  const text = host.nodes(node => typeof node.props.children === 'string', item).map(node => node.props.children)
  assert.ok(text.includes('Release notes') && text.includes('待处理人：Casey'))
  assert.ok(host.nodes(node => node.props.className === 'ops-approval-overdue', item).length)
  const actions = host.nodes(node => node.type === 'button', item)
  assert.deepEqual(actions.map(button => button.props.children), ['查看需求', '转交', '撤回'])
  actions[1].props.onClick()
  assert.deepEqual(selected, [[row, 'transfer']])
  assert.equal(host.nodes(node => node.type === 'button', masked).length, 0)
})

test('a transfer submits only after choosing both the reviewer and a reason', async t => {
  const requests = []
  let saved = false
  const host = await queueHost('ApprovalEditor', {
    row: { id: 'gate', action: 'deploy', assignees: [{ userId: 'other', canTransfer: false }, { userId: 'old', canTransfer: true }] }, action: 'transfer',
    onSaved: () => { saved = true }, onConflict: assert.fail, onClose() {},
  }, { updateOperationsApproval: (...args) => { requests.push(args) } })
  t.after(host.unmount)
  const confirm = () => host.render().props.foot.props.children[1].props
  assert.deepEqual(host.nodes(node => node.type === 'option').map(node => node.props.value), ['old'])
  assert.equal(confirm().disabled, true)
  host.act(() => host.nodes(node => node.type === 'textarea')[0].props.onChange({ target: { value: '  Next shift  ' } }))
  assert.equal(confirm().disabled, true)
  host.act(() => host.nodes(node => node.props.fromUserId === 'old')[0].props.onChange('new'))
  assert.equal(confirm().disabled, false)
  await confirm().onClick()
  assert.deepEqual(requests, [['gate', 'transfer', { fromUserId: 'old', toUserId: 'new', note: 'Next shift' }]])
  assert.equal(saved, true)
})
