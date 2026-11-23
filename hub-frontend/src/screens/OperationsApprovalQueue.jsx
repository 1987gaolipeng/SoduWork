import React, { useEffect, useState } from 'react'
import { api, can } from '../api.js'
import { localeMap, translateText as tx, useLocale } from '../i18n.js'
import ListPager from '../ListPager.jsx'
import { AUTO, ErrorState, Loading, Modal, useAsync } from '../ui.jsx'
import { OperationsTaskDialog } from './OperationsFailures.jsx'

const PAGE_SIZE = 20
const gateNames = localeMap(() => ({ baseline: '需求基线确认', review: '交付验收', uat: '上线验收', merge: '代码合并', deploy: '环境发布' }))
const actionNames = localeMap(() => ({ approve: '通过', reject: '打回', transfer: '转交', withdraw: '撤回' }))

function reviewerName(user) {
  const name = user.userName || user.userId
  return user.inactive ? tx('{0}（已停用）', [name]) : name
}

export default function OperationsApprovalQueue({ onClose, onChanged, formatAge }) {
  useLocale()
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [selection, setSelection] = useState(null)
  const [notice, setNotice] = useState('')
  function select(row, action) {
    setNotice('')
    setSelection({ row, action })
  }
  function refresh() {
    setRevision(value => value + 1)
    onChanged()
  }
  return <Modal title={tx('待审列表')} icon="shield" wide onClose={onClose}>
    {notice && <p role="status">{notice}</p>}
    <ApprovalPage key={page + '-' + revision} page={page} setPage={setPage} select={select} formatAge={formatAge} />
    {selection?.action === 'task' && <OperationsTaskDialog taskId={selection.row.taskId} onClose={() => setSelection(null)} />}
    {selection && selection.action !== 'task' && <ApprovalEditor {...selection} onClose={() => setSelection(null)}
      onSaved={result => {
        setNotice(result.status === 'pending' ? tx('已记录你的决定，正在等待其他审批人。') : tx('审批已更新'))
        setSelection(null)
        refresh()
      }} onConflict={refresh} />}
  </Modal>
}

function ApprovalPage({ page, setPage, select, formatAge }) {
  const locale = useLocale()
  const list = useAsync(() => api.operationsApprovals(PAGE_SIZE, (page - 1) * PAGE_SIZE), AUTO)
  const pages = list.data && Math.max(1, Math.ceil(list.data.total / PAGE_SIZE))
  useEffect(() => { if (pages && page > pages) setPage(pages) }, [page, pages, setPage])
  if (list.error) return <ErrorState msg={list.error.message} onRetry={list.reload} />
  if (!list.data || page > pages) return <Loading />
  if (!list.data.total) return <p className="ops-empty">{tx('当前没有待审记录')}</p>
  return <>
    <ul className="ops-approval-list">{list.data.items.map(row => {
      const assignees = new Intl.ListFormat(locale).format((row.assignees || []).map(reviewerName))
      const started = row.createdAt && new Date(row.createdAt)
      const actions = [row.canDecide && 'approve', row.canDecide && 'reject', row.canTransfer && 'transfer', row.canWithdraw && 'withdraw'].filter(Boolean)
      return <li key={row.id}>
        <strong>{row.taskTitle || row.id}</strong>
        <div>{gateNames[row.action] || row.action}{row.artifactLabel && ' · ' + row.artifactLabel}{row.environmentId && ' · ' + row.environmentId}</div>
        {started && <div title={started.toLocaleString(locale)}>{tx('已等待 {0}', [formatAge(Math.floor((Date.now() - started.getTime()) / 1000))])}
          {row.overdue && <strong className="ops-approval-overdue"> · {tx('审批已超时')}</strong>}</div>}
        {row.dueAt && <div>{tx('审批提醒时间：{0}', [new Date(row.dueAt).toLocaleString(locale)])}</div>}
        <div>{row.canViewDetails
          ? tx('待处理人：{0}', [assignees || tx('未分配')])
          : tx('当前账号无权查看这项审批的对象和处理人。')}</div>
        <div className="ops-approval-actions">
          {row.canViewDetails && can('task.view') && <button className="btn btn-ghost xs" onClick={() => select(row, 'task')}>{tx('查看需求')}</button>}
          {actions.map(action => <button key={action} className="btn btn-ghost xs" onClick={() => select(row, action)}>{actionNames[action]}</button>)}
        </div>
      </li>
    })}</ul>
    <ListPager page={page} pages={pages} total={list.data.total} onChange={setPage} />
  </>
}

function ApprovalEditor({ row, action, onClose, onSaved, onConflict }) {
  useLocale()
  const [note, setNote] = useState('')
  const sources = (row.assignees || []).filter(person => person.canTransfer)
  const [fromUserId, setFrom] = useState(sources[0]?.userId || '')
  const [toUserId, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const transfer = action === 'transfer'
  const canSubmit = !busy && (action === 'approve' || !!note.trim()) && (!transfer || !!toUserId)
  async function submit() {
    if (!canSubmit) return
    setBusy(true)
    setError('')
    try {
      const isDecision = action === 'approve' || action === 'reject'
      const body = { note: note.trim() }
      if (isDecision) body.decision = action
      if (transfer) Object.assign(body, { fromUserId, toUserId })
      const result = await api.updateOperationsApproval(row.id, isDecision ? 'decision' : action, body)
      onSaved(result)
    } catch (err) {
      setError(err.message)
      setBusy(false)
      if ([403, 404, 409].includes(err.status)) onConflict()
    }
  }
  return <Modal title={actionNames[action]} icon="shield" size="compact" onClose={() => { if (!busy) onClose() }}
    foot={<><button className="btn btn-ghost" disabled={busy} onClick={onClose}>{tx('取消')}</button>
      <button className={'btn ' + (action === 'withdraw' || action === 'reject' ? 'btn-danger' : 'btn-primary')} disabled={!canSubmit}
        onClick={submit}>{busy ? tx('处理中…') : tx('确认{0}', [actionNames[action]])}</button></>}>
    <div className="ops-approval-editor">
      <div><strong>{row.taskTitle || row.id}</strong><div>{gateNames[row.action] || row.action} · {row.artifactLabel || row.artifactVersionId}{row.environmentId && ' · ' + row.environmentId}</div></div>
      {action === 'approve' && row.action === 'merge' && <p>{tx('所需审批全部通过后，系统会尝试将此版本合入目标分支。')}</p>}
      {action === 'approve' && row.action === 'deploy' && <p>{tx('所需审批全部通过后，系统会将此版本加入目标环境的发布队列。')}</p>}
      {transfer && <>
        <label>{tx('原处理人')}<select className="f-sel" value={fromUserId} disabled={busy}
          onChange={event => { setFrom(event.target.value); setTo('') }}>
          {sources.map(user => <option key={user.userId} value={user.userId}>{reviewerName(user)}</option>)}
        </select></label>
        <TransferOptions key={fromUserId} id={row.id} fromUserId={fromUserId} value={toUserId} onChange={setTo} disabled={busy} />
      </>}
      <label>{action === 'approve' ? tx('备注（可选）') : tx('原因（必填）')}
        <textarea className="f-in" rows={3} maxLength={1200} value={note} disabled={busy} required={action !== 'approve'}
          onChange={event => setNote(event.target.value)} />
      </label>
      {error && <div className="ops-approval-overdue" role="alert">{error}</div>}
    </div>
  </Modal>
}

function TransferOptions({ id, fromUserId, value, onChange, disabled }) {
  useLocale()
  const query = useAsync(() => api.approvalTransferOptions(id, fromUserId))
  if (query.error) return <ErrorState msg={query.error.message} onRetry={query.reload} />
  if (!query.data) return <Loading />
  if (!query.data.items.length) return <p>{tx('当前审批策略下没有可转交的处理人。')}</p>
  return <label>{tx('新处理人')}<select className="f-sel" disabled={disabled} value={value} onChange={event => onChange(event.target.value)}>
    <option value="">{tx('请选择')}</option>
    {query.data.items.map(user => <option key={user.userId} value={user.userId}>{user.userName || user.userId}</option>)}
  </select></label>
}
