import { translateText as tx, useLocale } from '../i18n.js'
import React, { useState, useEffect, useMemo } from 'react'
import { api } from '../api.js'
import { Loading, ErrorState, Icon, toast } from '../ui.jsx'
import { FilterInput, FilterSelect } from '../FilterControls.jsx'
import ListPager from '../ListPager.jsx'
import { useViewportHeight } from '../viewport-height.js'
import './admin-access-pages.css'
import { detailText } from './audit-detail.js'
import { FILTERS, actInfo, fmtT, auditEnvironmentLabel } from './audit-format.js'

function localMidnight(date, days = 0) {
  const boundary = new Date(date + 'T00:00:00')
  boundary.setDate(boundary.getDate() + days)
  if (!Number.isFinite(boundary.getTime()) || boundary.getUTCFullYear() < 1 || boundary.getUTCFullYear() > 9999) return null
  return boundary.toISOString()
}

export default function Audit() {
  useLocale()
  const listRef = useViewportHeight()
  const [filters, setFilters] = useState({ action: '', actor: '', start: '', end: '' })
  const { action, actor, start, end } = filters
  const query = useMemo(() => ({
    ...(action && { action }),
    ...(actor.trim() && { actor: actor.trim() }),
    ...(start && { since: localMidnight(start) }),
    ...(end && { until: localMidnight(end, 1) }),
  }), [action, actor, start, end])
  let dateError = ''
  if (start && !query.since) dateError = tx('开始日期无效，请重新选择')
  else if (end && !query.until) dateError = tx('结束日期无效，请重新选择')
  else if (start && end && start > end) dateError = tx('开始日期不能晚于结束日期')
  const [pageSize, setPageSize] = useState(30)
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [exporting, setExporting] = useState(false)

  function filterBy(field, value) {
    setFilters(previous => ({ ...previous, [field]: value }))
    setPage(1)
  }

  useEffect(() => {
    if (dateError) {
      setLoading(false)
      setData(null)
      setError(null)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    api.audit({ ...query, limit: pageSize, offset: (page - 1) * pageSize }, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return
        const lastPage = Math.max(1, Math.ceil(result.total / pageSize))
        if (page > lastPage) { setPage(lastPage); return }
        setData(result)
        setLoading(false)
      })
      .catch(err => { if (!controller.signal.aborted) { setError(err); setLoading(false) } })
    return () => controller.abort()
  }, [query, dateError, page, pageSize, refreshKey])

  async function exportCsv() {
    setExporting(true)
    try { await api.exportAudit(query) }
    catch (err) { toast(err.message) }
    finally { setExporting(false) }
  }

  const items = (data && data.items) || []
  const total = (data && data.total) || 0
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const environment = auditEnvironmentLabel(data?.environment)

  return (
    <section className="admin-access-page admin-audit-page">
      <div className="statrow admin-access-summary">
        <div className="stat"><div className="sv">{loading || error ? '—' : total}</div><div className="sl"><span className="sd" style={{ background: 'var(--c-blue)' }} />{tx("符合条件记录")}</div></div>
        <div className="stat"><div className="sv">{loading || error ? '—' : items.length}</div><div className="sl"><span className="sd" style={{ background: 'var(--accent)' }} />{tx("本页记录")}</div></div>
        <div className="stat"><div className="sv">{loading || error ? '—' : `${page} / ${pages}`}</div><div className="sl"><span className="sd" style={{ background: 'var(--offline)' }} />{tx("当前页 / 总页数")}</div></div>
      </div>
      <div className="admin-filterbar">
        <div className="admin-audit-filter"><span className="admin-audit-filter-label">{tx("操作类型")}</span>
          <FilterSelect className="f-sel" aria-label={tx("审计操作类型")} value={action} onChange={e => filterBy('action', e.target.value)}>
            {FILTERS.map(([key, label]) => <option key={key || 'all'} value={key}>{label}</option>)}
          </FilterSelect>
        </div>
        <div className="admin-audit-filter">
          <label className="admin-audit-filter-label" htmlFor="audit-actor">{tx('操作者')}</label>
          <FilterInput id="audit-actor" aria-label={tx('操作者')} placeholder={tx('姓名或用户 ID')} value={actor}
            onChange={e => filterBy('actor', e.target.value)} />
        </div>
        <label className="admin-filter-field"><span>{tx('开始日期')}</span>
          <input type="date" aria-label={tx('开始日期')} value={start} max={end || undefined}
            onChange={e => filterBy('start', e.target.value)} /></label>
        <label className="admin-filter-field"><span>{tx('结束日期')}</span>
          <input type="date" aria-label={tx('结束日期')} value={end} min={start || undefined}
            onChange={e => filterBy('end', e.target.value)} /></label>
        <div className="admin-filter-actions">
          <button className="btn btn-ghost" disabled={loading || !!dateError} onClick={() => setRefreshKey(key => key + 1)}><Icon name="refresh" />{tx("刷新")}</button>
          <button className="btn btn-ghost" disabled={loading || !!dateError || !!error || !total || exporting} onClick={exportCsv}>{exporting ? tx('正在导出…') : tx('导出 CSV')}</button>
        </div>
      </div>
      <p className="admin-access-note">{tx("可见范围遵循组织权限；非超级管理员仅可查看本部门及下级部门成员的操作。")}</p>
      {environment && <strong className="admin-audit-environment">{environment}</strong>}
      <div className="tablewrap">
        <div ref={listRef} className="tscroll" tabIndex={0} role="region" aria-label={tx("审计记录")} aria-busy={loading}>
          <table className="admin-audit-table">
            <colgroup><col className="audit-col-time" /><col className="audit-col-actor" /><col className="audit-col-action" /><col className="audit-col-target" /><col /></colgroup>
            <thead><tr><th scope="col">{tx("操作时间")}</th><th scope="col">{tx("操作者")}</th><th scope="col">{tx("操作")}</th><th scope="col">{tx("操作对象")}</th><th scope="col">{tx("详情")}</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={5}><Loading /></td></tr>}
              {!loading && error && <tr><td colSpan={5}><ErrorState msg={error.message} onRetry={() => setRefreshKey((key) => key + 1)} /></td></tr>}
              {dateError && <tr><td colSpan={5} role="alert">{dateError}</td></tr>}
              {!dateError && !loading && !error && items.length === 0 && <tr><td colSpan={5}><div className="empty">{Object.keys(query).length ? tx('没有符合当前筛选条件的审计记录。') : tx("暂无审计记录，需求下发、用户或权限变更等管理操作会记录在此。")}</div></td></tr>}
              {!loading && !error && items.map((a) => {
                const info = actInfo(a.action)
                return (
                  <tr key={a.id}>
                    <td className="admin-audit-time">{fmtT(a.at) || '—'}</td>
                    <td>{a.actorName || '—'}</td>
                    <td><span className="admin-audit-action" title={a.action}><i style={{ background: info.c }} />{info.label}</span></td>
                    <td>{a.targetLabel || '—'}</td>
                    <td className="admin-audit-detail">{detailText(a)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      {data && !error && !dateError && <ListPager page={page} pages={pages} total={total} disabled={loading}
        onChange={setPage} label={tx("审计记录分页")} pageSize={pageSize}
        onPageSizeChange={size => { setPageSize(size); setPage(1) }} />}
    </section>
  )
}
