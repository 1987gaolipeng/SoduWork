import React, { useEffect, useState } from 'react'
import { api } from './api.js'
import { FilterSelect } from './FilterControls.jsx'
import { translateText as tx, useLocale } from './i18n.js'
import { Confirm, toast } from './ui.jsx'

const sourceLabels = { business: '正式数据', test: '测试数据', legacy: '历史未分类' }
const actionLabels = { business: '标记为正式', test: '标记为测试', archive: '归档', restore: '恢复' }

export function RecordSource({ row }) {
  useLocale()
  return <span className="chip">{tx(sourceLabels[row.dataSource] || sourceLabels.legacy)}{row.isArchived && ' · ' + tx('已归档')}</span>
}

export function SourceField({ value, onChange }) {
  useLocale()
  return <label className="admin-filter-field"><span>{tx('数据来源')}</span>
    <select className="f-sel" aria-label={tx('数据来源')} value={value || ''} onChange={event => onChange(event.target.value)}>
      <option value="">{tx('跟随创建账号和所属记录')}</option>
      <option value="test">{tx('测试数据')}</option>
    </select></label>
}

export function useBusinessRecords({ kind, rows = [], reload, canManage, canSelect = () => true, scopeKey = '' }) {
  useLocale()
  const [view, setView] = useState('default')
  const [selected, setSelected] = useState([])
  const [pending, setPending] = useState(null)
  const [busy, setBusy] = useState(false)
  function matches(row) {
    if (view === 'archived') return !!row.isArchived
    if (row.isArchived) return false
    const source = row.dataSource || 'legacy'
    return view === 'all' || (view === 'default' ? source !== 'test' : source === view)
  }
  const candidates = rows.filter(row => matches(row) && canSelect(row))
  const eligible = new Set(candidates.map(row => row.id))
  const chosen = candidates.filter(row => selected.includes(row.id))
  const eligibleKey = JSON.stringify([...eligible].sort())
  useEffect(() => {
    setSelected(previous => previous.some(id => !eligible.has(id)) ? previous.filter(id => eligible.has(id)) : previous)
    setPending(null)
  }, [eligibleKey])
  useEffect(() => { setSelected([]); setPending(null) }, [scopeKey, view])
  function toggle(id) {
    setSelected(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id])
  }
  async function apply() {
    if (busy || !pending || pending.ids.some(id => !eligible.has(id))) return
    setBusy(true)
    try {
      const { changed } = await api.manageRecords(kind, { ids: pending.ids, action: pending.action, scopeId: scopeKey })
      setPending(null)
      setSelected([])
      toast(tx('已更新 {0} 条记录', [changed]))
      await reload()
    } finally { setBusy(false) }
  }
  function checkbox(row) {
    if (!canManage || !eligible.has(row.id)) return null
    return <input type="checkbox" checked={selected.includes(row.id)} disabled={busy || (!selected.includes(row.id) && chosen.length >= 200)}
      aria-label={tx('选择 {0}', [row.name])} onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()} onChange={() => toggle(row.id)} />
  }
  const toolbar = <div className="admin-filter-options">
    <FilterSelect aria-label={tx('数据范围')} value={view} resetValue="default" onChange={event => setView(event.target.value)}>
      <option value="default">{tx('业务列表（含历史未分类）')}</option>
      <option value="test">{tx('测试数据')}</option>
      <option value="legacy">{tx('历史未分类')}</option>
      <option value="business">{tx('正式数据')}</option>
      <option value="all">{tx('全部未归档')}</option>
      <option value="archived">{tx('已归档')}</option>
    </FilterSelect>
    {canManage && candidates.length > 0 && <button type="button" className="btn btn-ghost" disabled={busy}
      onClick={() => setSelected(chosen.length ? [] : candidates.slice(0, 200).map(row => row.id))}>
      {chosen.length ? tx('清除选择（{0}）', [chosen.length]) : candidates.length > 200 ? tx('选择前 200 条') : tx('选择当前筛选记录')}</button>}
    {canManage && chosen.length > 0 && (view === 'archived' ? ['restore'] : ['test', 'business', 'archive']).map(action =>
      <button key={action} type="button" className="btn btn-ghost" disabled={busy}
        onClick={() => setPending({ action, ids: chosen.map(row => row.id), names: chosen.map(row => row.name) })}>
        {tx(actionLabels[action])}</button>)}
    {pending && <Confirm title={tx(actionLabels[pending.action])} confirmText={tx(actionLabels[pending.action])}
      focusCancel danger={pending.action === 'archive'} onConfirm={apply} onClose={() => { if (!busy) setPending(null) }}
      text={<><p>{tx('所选记录（{0}）', [pending.ids.length])}</p><ul className="user-batch-preview">{pending.names.map((name, index) =>
        <li key={pending.ids[index]}>{name}</li>)}</ul></>} />}
  </div>
  return { matches, toolbar, checkbox }
}
