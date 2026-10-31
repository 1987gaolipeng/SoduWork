import React, { useEffect, useState } from 'react'
import { translateText as tx, useLocale } from '../i18n.js'
import { api } from '../api.js'
import { Icon } from '../ui.jsx'
import { MemberEditor } from './QuotaEditors.jsx'
import { usagePercent } from './quota-model.js'

const PAGE_SIZE = 50
function statusLabel(quota) {
  if (quota.reason === 'trial_expired') return tx('试用已到期')
  if (quota.reason === 'model_exhausted') return tx('模型额度已用完')
  if (quota.reason === 'model_not_allowed') return tx('模型不在套餐中')
  if (quota.exceeded || quota.reason === 'total_exhausted') return tx('额度已用完')
  return tx('可使用')
}

export default function QuotaMembers({ config, revision }) {
  const locale = useLocale()
  const [q, setQ] = useState(''), [offset, setOffset] = useState(0), [refresh, setRefresh] = useState(0)
  const [page, setPage] = useState({ items: [], total: 0 }), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [editing, setEditing] = useState(null)
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    const timer = setTimeout(() => {
      api.quotaMembers({ q: q.trim(), limit: PAGE_SIZE, offset }).then(next => {
        if (!active) return
        setPage(next); setLoading(false)
      }).catch(e => { if (active) { setError(e.message); setLoading(false) } })
    }, q ? 250 : 0)
    return () => { active = false; clearTimeout(timer) }
  }, [q, offset, refresh, revision])
  const number = value => Number(value || 0).toLocaleString(locale)
  const date = value => value ? new Date(value).toLocaleDateString(locale) : '—'
  return <div className="qm-members">
    <div className="qm-toolbar">
      <label className="qm-search"><Icon name="search" /><input className="f-in" aria-label={tx('搜索姓名或账号')} placeholder={tx('搜索姓名或账号')} value={q} maxLength={100}
        onChange={e => { setQ(e.target.value); setOffset(0) }} /></label>
      <button className="btn btn-ghost" disabled={loading} onClick={() => setRefresh(value => value + 1)}><Icon name="refresh" />{tx('刷新')}</button>
    </div>
    <p className="qm-help">{tx('按账号统一计量；切换套餐、增加额度或更换设备不会清空当前周期用量。')}</p>
    {error && <div className="qm-feedback" role="alert"><span>{error}</span><button className="btn btn-ghost" onClick={() => setRefresh(value => value + 1)}>{tx('重试')}</button></div>}
    <div className="tablewrap qm-table" role="region" aria-label={tx('成员额度列表')} tabIndex={0} aria-busy={loading}>
      <table><thead><tr><th>{tx('成员')}</th><th>{tx('额度规则')}</th><th>{tx('本期用量')}</th><th>{tx('状态')}</th><th>{tx('到期或重置时间')}</th><th>{tx('操作')}</th></tr></thead>
        <tbody>
          {loading && <tr><td colSpan={6}><div className="empty" role="status">{tx('加载中…')}</div></td></tr>}
          {!loading && !error && !page.items.length && <tr><td colSpan={6}><div className="empty">{tx('没有匹配的成员')}</div></td></tr>}
          {!loading && !error && page.items.map(member => {
            const quota = member.quota, limited = quota.totalLimited
            return <tr key={member.id}>
              <td><div className="qm-table-stack"><b>{member.displayName || member.username}</b><span>{member.username}</span></div></td>
              <td><div className="qm-table-stack"><b>{member.assignment.mode === 'plan' ? quota.planName : member.assignment.mode === 'custom' ? tx('个人自定义') : tx('原有规则')}</b>
                <span>{quota.period === 'trial' ? tx('一次性试用') : tx('每自然月')}{quota.models?.length ? ' · ' + tx('{0} 个模型额度', [quota.models.length]) : ''}</span></div></td>
              <td><div className="qm-usage"><span><b>{number(quota.used)}</b> / {limited ? number(quota.limit) : tx('不限额')}</span>
                {limited && <div className="qm-meter" role="progressbar" aria-label={tx('本期用量')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usagePercent(quota))} aria-valuetext={tx('已使用 {0} / {1} Tokens', [number(quota.used), number(quota.limit)])}><i style={{ width: usagePercent(quota) + '%' }} /></div>}
              </div></td>
              <td><span className={'qm-status ' + (quota.exceeded ? 'qm-status-limited' : '')}>{member.isActive ? statusLabel(quota) : tx('账号已停用')}</span></td>
              <td className="nowrap">{date(quota.expiresAt || quota.resetsAt)}</td>
              <td><button className="admin-text-action" aria-label={tx('分配额度：{0}', [member.displayName || member.username])} onClick={() => setEditing(member)}>{tx('分配额度')}</button></td>
            </tr>
          })}
        </tbody>
      </table>
    </div>
    <div className="qm-pagination"><span aria-live="polite">{loading ? tx('加载中…') : tx('共 {0} 位成员', [number(page.total)])}</span>
      <div><button className="btn btn-ghost" aria-label={tx('上一页')} disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - PAGE_SIZE))}><Icon name="chevron-left" /></button>
        <span>{Math.floor(offset / PAGE_SIZE) + 1} / {Math.max(1, Math.ceil(page.total / PAGE_SIZE))}</span>
        <button className="btn btn-ghost" aria-label={tx('下一页')} disabled={loading || offset + PAGE_SIZE >= page.total} onClick={() => setOffset(value => value + PAGE_SIZE)}><Icon name="chevron-right" /></button></div>
    </div>
    {editing && <MemberEditor member={editing} config={config} onClose={() => setEditing(null)} onSaved={() => setRefresh(value => value + 1)} />}
  </div>
}
