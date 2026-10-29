import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { translateText as tx, getLocale, useLocale } from '../i18n.js'
import { Loading, Modal, SelectMenu } from '../ui.jsx'
import './repository-issue-sync.css'

function timestamp(value) {
  if (!value) return tx('尚未同步')
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? tx('尚未同步') : date.toLocaleString(getLocale())
}

function summary(value) {
  const { members, userOptions, writebacks, ...state } = value || {}
  return state
}

function issueUrl(value) {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}

export function RepositoryIssueSyncStatus({ value }) {
  useLocale()
  const state = value || {}
  return <span className={'rc-issue-status' + (state.enabled ? state.lastError ? ' bad' : ' on' : '')}>
    <span>{state.enabled ? state.lastError ? tx('Issue 同步异常') : tx('Issue 同步已开启') : tx('Issue 同步未开启')}</span>
    {state.enabled && <small>{tx('每 60 秒检查')}</small>}
  </span>
}

export default function RepositoryIssueSync({ row, onClose, onUpdated }) {
  useLocale()
  const providerName = String(row.provider || '').toLowerCase() === 'github' ? 'GitHub' : 'GitLab'
  const teamVisible = providerName === 'GitHub'
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState({ enabled: false, startedLabel: '' })
  const [memberDrafts, setMemberDrafts] = useState({})
  const [busy, setBusy] = useState('')
  const [reload, setReload] = useState(0)
  const request = useRef({ epoch: 0, active: false, busy: '' })

  useEffect(() => {
    const state = request.current
    const epoch = ++state.epoch
    state.active = true
    state.busy = ''
    setLoading(true); setData(null); setError(''); setNotice(''); setBusy(''); setMemberDrafts({})
    api.repositoryIssueSync(row.id).then((value) => {
      if (!state.active || state.epoch !== epoch) return
      setData(value)
      setDraft({ enabled: !!value.enabled, startedLabel: value.startedLabel || '' })
    }).catch((cause) => {
      if (state.active && state.epoch === epoch) setError(cause.message)
    }).finally(() => {
      if (state.active && state.epoch === epoch) setLoading(false)
    })
    return () => { state.active = false; state.epoch++ }
  }, [row.id, reload])

  function begin(kind) {
    const state = request.current
    if (!state.active || state.busy || loading || !data) return null
    state.busy = kind; setBusy(kind); setError(''); setNotice('')
    return state.epoch
  }
  function current(epoch) { return request.current.active && request.current.epoch === epoch }
  function finish(epoch) {
    if (!current(epoch)) return
    request.current.busy = ''; setBusy('')
  }
  function accept(value, resetDraft = false) {
    setData((previous) => ({ ...previous, ...value }))
    if (resetDraft) setDraft({ enabled: !!value.enabled, startedLabel: value.startedLabel || '' })
    onUpdated?.(summary(value))
  }

  async function save() {
    if (!draft.startedLabel.trim()) { setError(tx('请输入开始处理时添加的标签。')); return }
    const epoch = begin('save')
    if (epoch === null) return
    try {
      const value = await api.saveRepositoryIssueSync(row.id, { enabled: draft.enabled, startedLabel: draft.startedLabel.trim() })
      if (!current(epoch)) return
      accept(value, true)
      setNotice(tx('Issue 同步设置已保存。'))
    } catch (cause) { if (current(epoch)) setError(cause.message) }
    finally { finish(epoch) }
  }

  const dirty = !!data && (draft.enabled !== !!data.enabled || draft.startedLabel.trim() !== (data.startedLabel || ''))
  async function run() {
    if (!data?.enabled || dirty) return
    const epoch = begin('run')
    if (epoch === null) return
    try {
      const result = await api.runRepositoryIssueSync(row.id)
      if (!current(epoch)) return
      if (result.issueSync) accept(result.issueSync)
      if (result.ok === false) setError(result.issueSync?.lastError || tx('Issue 同步失败，请检查账号权限后重试。'))
      else {
        setNotice(tx('本次已同步 {0} 条新需求。', [result.created || 0]))
        // Scanning refreshes membership, while the run response only includes a summary.
        try {
          const value = await api.repositoryIssueSync(row.id)
          if (current(epoch)) accept(value)
        } catch (cause) {
          if (current(epoch)) setError(tx('Issue 已同步，但成员列表刷新失败：') + cause.message)
        }
      }
    } catch (cause) {
      if (!current(epoch)) return
      setError(cause.message)
      // A failed run can still update the server's health receipt.
      try {
        const value = await api.repositoryIssueSync(row.id)
        if (current(epoch)) accept(value)
      } catch { /* Keep the actionable run error when its receipt cannot be read. */ }
    } finally { finish(epoch) }
  }

  async function saveMember(member) {
    const selected = memberDrafts[member.externalUserId] ?? member.userId ?? ''
    if (selected === (member.userId || '')) return
    const epoch = begin('member:' + member.externalUserId)
    if (epoch === null) return
    try {
      await api.mapRepositoryIssueMember(row.id, member.externalUserId, { userId: selected || null })
      if (!current(epoch)) return
      // Read the authoritative mapping after a successful mutation.
      try {
        const value = await api.repositoryIssueSync(row.id)
        if (!current(epoch)) return
        accept(value)
        setMemberDrafts((previous) => { const next = { ...previous }; delete next[member.externalUserId]; return next })
        setNotice(tx('成员关联已保存。'))
      } catch (cause) {
        if (current(epoch)) setError(tx('成员关联已保存，但刷新失败：') + cause.message)
      }
    } catch (cause) { if (current(epoch)) setError(cause.message) }
    finally { finish(epoch) }
  }

  return <Modal scope="repository-issue-sync" title={tx('Issue 自动同步：{0}', [row.displayName || row.fullName])} onClose={onClose}
    footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{tx('关闭')}</button>
      <button className="btn btn-primary" disabled={loading || !!busy || !data || !dirty} onClick={save}>{busy === 'save' ? tx('正在保存…') : tx('保存设置')}</button>
    </>}>
    <div className="rc-issue-dialog">
      <p className="rc-issue-intro">{teamVisible ? tx('每 60 秒检查此仓库的新 Issue，自动进入收集箱，当前团队成员认领后移到待开始。') : tx('每 60 秒检查此仓库的新 Issue，自动进入收集箱，仓库成员认领后移到待开始。')}</p>
      <p className="rc-issue-note">{tx('首次开启只同步此后新建的 Issue；暂停后重新开启会补拉暂停期间的新 Issue。')}</p>
      {error && <div className="rc-issue-error" role="alert">{error}</div>}
      {notice && <div className="rc-issue-notice" role="status">{notice}</div>}
      {loading ? <Loading /> : !data ? <button className="btn btn-ghost" onClick={() => setReload((value) => value + 1)}>{tx('重新加载')}</button> : <>
        <label className="rc-issue-toggle">
          <input type="checkbox" checked={draft.enabled} disabled={!!busy} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
          <span><b>{tx('自动同步 Issue')}</b><small>{teamVisible ? tx('保存时验证仓库读取权限，通过后才会开启。') : tx('保存时验证仓库和成员读取权限，通过后才会开启。')}</small></span>
        </label>
        <label className="rc-issue-field"><span>{tx('开始处理时添加的标签')}</span>
          <input className="f-in" value={draft.startedLabel} maxLength={providerName === 'GitHub' ? 50 : 120} disabled={!!busy} onChange={(event) => setDraft({ ...draft, startedLabel: event.target.value })} />
        </label>
        <p className="rc-issue-note">{tx('认领后移到待开始，不启动执行或修改标签；真正开始后才添加此标签。后续状态由成员手动维护，不自动关闭源 Issue。')}</p>
        <div className="rc-issue-health">
          <RepositoryIssueSyncStatus value={data} />
          <dl>
            <div><dt>{tx('最近检查')}</dt><dd>{timestamp(data.lastPolledAt)}</dd></div>
            <div><dt>{tx('最近成功')}</dt><dd>{timestamp(data.lastSuccessAt)}</dd></div>
            <div><dt>{tx('累计新增需求')}</dt><dd>{data.importedCount || 0}</dd></div>
            <div><dt>{tx('最近新增需求')}</dt><dd>{data.lastCreatedCount || 0}</dd></div>
            {!!data.nextPollAt && data.enabled && <div><dt>{tx('下次检查')}</dt><dd>{timestamp(data.nextPollAt)}</dd></div>}
          </dl>
          {data.lastError && <p className="rc-issue-error">{data.lastError}</p>}
          {data.pendingWritebacks > 0 && <p className="rc-issue-note">{tx('{0} 个处理标签等待回写。', [data.pendingWritebacks])}</p>}
          {data.manualWritebacks > 0 && <p className="rc-issue-error">{tx('{0} 个处理标签需人工处理，请在 {1} 检查。', [data.manualWritebacks, providerName])}</p>}
          <div className="rc-issue-run">
            <button className="btn btn-ghost btn-sm" disabled={!data.enabled || !!busy || dirty} onClick={run}>{busy === 'run' ? tx('同步中…') : tx('立即同步 Issue')}</button>
            {dirty && <small>{tx('请先保存设置，再立即同步。')}</small>}
          </div>
        </div>
        {(data.writebacks || []).length > 0 && <section className="rc-issue-writebacks" aria-label={tx('标签回写异常')}>
          <h4>{tx('标签回写异常')}</h4>
          <p className="rc-issue-note">{tx('最多显示 20 条异常记录。需人工核对的 Issue，请在 {0} 检查处理标签。', [providerName])}</p>
          <ul className="rc-issue-writeback-list">
            {data.writebacks.slice(0, 20).map((entry) => {
              const href = issueUrl(entry.issueUrl)
              return <li className="rc-issue-writeback" key={entry.issueIid}>
                <div className="rc-issue-writeback-heading">
                  {href ? <a href={href} target="_blank" rel="noopener noreferrer" aria-label={tx('在 {0} 打开 Issue #{1}', [providerName, entry.issueIid])}>{tx('Issue #{0}', [entry.issueIid])}</a>
                    : <strong>{tx('Issue #{0}', [entry.issueIid])}</strong>}
                  <span className="rc-issue-writeback-state">{entry.state === 'manual' ? tx('需人工核对') : tx('等待自动重试')}</span>
                </div>
                <p className="rc-issue-writeback-error">{entry.lastError || tx('未返回错误详情，请在 {0} 核对标签。', [providerName])}</p>
                <div className="rc-issue-writeback-meta"><span>{tx('已尝试 {0} 次', [entry.attempts || 0])}</span>
                  {entry.state === 'error' && <span className="rc-issue-writeback-retry">{entry.nextRetryAt ? tx('下次重试：{0}', [timestamp(entry.nextRetryAt)]) : tx('暂无重试时间')}</span>}
                </div>
                {!href && <p className="rc-issue-note">{tx('链接不可用，请在此仓库的 {0} Issue 中核对。', [providerName])}</p>}
              </li>
            })}
          </ul>
        </section>}
        {teamVisible ? <section className="rc-issue-team" aria-label={tx('当前团队可见范围')}>
          <h4>{tx('当前团队全员')}</h4>
          <p className="rc-issue-note">{tx('同步的 Issue 对当前团队全员可见，团队成员均可认领，无需关联 GitHub 成员。')}</p>
        </section> : <section className="rc-issue-members" aria-label={tx('仓库成员关联')}>
          <div className="rc-issue-members-title"><h4>{tx('仓库成员关联')}</h4><span>{tx('已关联 {0} / {1}', [data.mappedMembers || 0, data.totalMembers || 0])}</span></div>
          <p className="rc-issue-note">{tx('仅已验证身份或明确关联的仓库成员可查看并认领。同名不会自动授权；待关联成员需选择对应的 SoduWork 账号。')}</p>
          {(data.members || []).length ? <div className="rc-issue-member-list">
            {data.members.map((member) => {
              const key = member.externalUserId
              const selected = memberDrafts[key] ?? member.userId ?? ''
              const options = data.userOptions || []
              return <div className="rc-issue-member" key={key}>
                <div className="rc-issue-member-name"><b>{member.displayName || member.username}</b><small>{member.username ? '@' + member.username : ''}</small>
                  <span className={member.userId ? 'linked' : 'pending'}>{!member.active ? tx('仓库成员已失效') : member.userId ? tx('已关联') : tx('待关联')}</span>
                </div>
                <SelectMenu className="f-sel" aria-label={tx('关联账号：{0}', [member.displayName || member.username])} value={selected} disabled={!!busy}
                  onChange={(event) => setMemberDrafts({ ...memberDrafts, [key]: event.target.value })}>
                  <option value="">{tx('暂不关联')}</option>
                  {member.userId && !options.some((option) => option.id === member.userId) && <option value={member.userId}>{member.userName || tx('当前关联账号')}</option>}
                  {options.map((option) => <option key={option.id} value={option.id}>{option.name || option.username}{option.name && option.username ? ' (@' + option.username + ')' : ''}</option>)}
                </SelectMenu>
                <button className="btn btn-ghost btn-sm" disabled={!!busy || selected === (member.userId || '')} onClick={() => saveMember(member)}>{busy === 'member:' + key ? tx('正在保存…') : tx('保存关联')}</button>
              </div>
            })}
          </div> : <p className="rc-issue-note">{tx('尚无仓库成员记录，开启同步后将读取成员。')}</p>}
        </section>}
      </>}
    </div>
  </Modal>
}
