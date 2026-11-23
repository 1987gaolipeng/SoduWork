import { getLocale, translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Icon } from '../ui.jsx'
import { FilterSelect } from '../FilterControls.jsx'
import { Empty, PanelHead, SceneLedger, TrendPanel } from './usage-center-charts.jsx'
import { agentName, count, duration, numeric, precise, ratio, sceneLabel, share, when } from './usage-center-format.js'
import './usage-center.css'

function mergeOptions(previous, next, key, label) {
  const map = new Map(previous.map((item) => [item.key, item]))
  next.forEach((item) => {
    const id = String(item[key] || '')
    if (id) map.set(id, { key: id, label: String(item[label] || id) })
  })
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, getLocale()))
}

export default function UsageCenter() {
  const uiLocale = useLocale();
  const [days, setDays] = useState(30)
  const [userId, setUserId] = useState('')
  const [source, setSource] = useState('')
  const [agent, setAgent] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [userOptions, setUserOptions] = useState([])
  const [agentOptions, setAgentOptions] = useState([])
  const request = useRef(0)

  useEffect(() => {
    let alive = true
    const current = ++request.current
    setLoading(true)
    setError('')
    api.usageOverview({ days, userId, source, agent }).then((result) => {
      if (!alive || current !== request.current) return
      const next = result || {}
      setData(next)
      setUserOptions((old) => mergeOptions(old, next.users || [], 'userId', 'label'))
      setAgentOptions((old) => {
        const rows = (next.filters && next.filters.agents || []).map((key) => ({ key, label: agentName(key, next.agentNames) }))
        return mergeOptions(old, rows, 'key', 'label')
      })
    }).catch((reason) => {
      if (alive && current === request.current) setError(reason.message || tx("用量数据加载失败"))
    }).finally(() => {
      if (alive && current === request.current) setLoading(false)
    })
    return () => { alive = false }
  }, [days, userId, source, agent, reload])

  const sourceOptions = data?.filters?.sources || []
  const total = numeric(data?.summary?.tokens)

  return <div className="usage-governance" aria-busy={loading}>
    <section className="ugc-filterbar admin-filterbar" aria-label={tx("用量筛选工具栏")}>
      <label><span>{tx("统计周期")}</span><FilterSelect aria-label={tx("统计周期")} resetValue={30} value={days} onChange={(e) => setDays(Number(e.target.value))}>
        {[7, 30, 90].map((value) => <option key={value} value={value}>{tx("近 ")}{value}{tx(" 天")}</option>)}
      </FilterSelect></label>
      <label><span>{tx("成员")}</span><FilterSelect aria-label={tx("成员")} resetValue="" value={userId} onChange={(e) => setUserId(e.target.value)}>
        <option value="">{tx("全部成员")}</option>{userOptions.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}
      </FilterSelect></label>
      <label><span>{tx("工作场景")}</span><FilterSelect aria-label={tx("工作场景")} resetValue="" value={source} onChange={(e) => setSource(e.target.value)}>
        <option value="">{tx("全部场景")}</option>{sourceOptions.map((item) => <option value={item.key} key={item.key}>{sceneLabel(item.key, item.label)}</option>)}
      </FilterSelect></label>
      <label><span>Agent</span><FilterSelect aria-label="Agent" resetValue="" value={agent} onChange={(e) => setAgent(e.target.value)}>
        <option value="">{tx("全部 Agent")}</option>{agentOptions.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}
      </FilterSelect></label>
    </section>

    {!data && loading && <UsageSkeleton />}
    {!data && error && <section className="ugc-error" role="alert"><Icon name="alert" /><div><b>{tx("用量账本没有加载成功")}</b><span>{error}</span></div>
      <button type="button" onClick={() => setReload((value) => value + 1)}>{tx("重新加载")}</button></section>}
    {data && <>
      {loading && <div className="ugc-updating" role="status">{tx("正在更新筛选结果，当前仍显示上一次数据。")}</div>}
      {error && <div className="ugc-inline-error" role="alert"><Icon name="alert" />{tx("刷新失败，正在保留上一次数据：")}{error}</div>}
      <Pulse data={data} />
      <div className="ugc-overview">
        <TrendPanel points={data.trend || []} days={data.days || 30} />
        <SceneLedger rows={data.bySource || []} total={total} selected={source} onSelect={setSource} />
      </div>
      <UsageDetails data={data} total={total} userId={userId} agent={agent}
        onMember={setUserId} onAgent={setAgent} />
      <RecentLedger rows={data.recent || []} names={data.agentNames} />
      <QualityFooter quality={data.quality || {}} />
    </>}
  </div>
}

function Pulse({ data }) {
  const uiLocale = useLocale();
  const summary = data.summary || {}
  const activeUsers = (data.users || []).filter((item) => item.userId && numeric(item.tokens) > 0).length
  return <section className="ugc-metrics" aria-label={tx("用量概览")}>
    <Metric icon="activity" label={tx("Token 总用量")} value={count(summary.tokens)} unit="Tokens" note={tx("近 {0} 天 · {1} 条用量记录", [data.days || 30, precise(summary.sessions)])} detail={`${precise(summary.tokens)} Tokens`} />
    <Metric icon="users" label={tx("活跃成员")} value={precise(activeUsers)} unit={tx("人")} note={tx("当前范围内产生 Token 用量的成员")} />
    <Metric icon="monitor" label={tx("AI 活跃时长")} value={duration(summary.durationMs)} note={tx("{0} 次模型请求", [precise(summary.requests)])} />
  </section>
}

function Metric({ icon, label, value, unit, note, detail }) {
  const uiLocale = useLocale();
  return <article className="ugc-metric"><div className="ugc-metric-head"><span>{label}</span><i><Icon name={icon} /></i></div>
    <div className="ugc-metric-value" title={detail}><b>{value}</b>{unit && <span>{unit}</span>}</div><p>{note}</p></article>
}

function Pager({ page, pages, total, onChange, label = tx("记录"), pageSize, onPageSize }) {
  const uiLocale = useLocale();
  if (pages <= 1 && !onPageSize) return null
  return <footer className="ugc-pager"><span>{tx("共 ")}{total}{tx(" 条")}{label}{tx(" · 第 ")}{page} / {pages}{tx(" 页")}</span><div>
    {onPageSize && <select aria-label={tx("每页条数")} value={pageSize} onChange={e => onPageSize(Number(e.target.value))}>
      {[10, 25, 50].map(size => <option key={size} value={size}>{tx("每页 {0} 条", [size])}</option>)}
    </select>}
    <button type="button" disabled={page === 1} onClick={() => onChange(page - 1)} aria-label={tx("{0}上一页", [label])}><Icon name="chevron-left" />{tx("上一页")}</button>
    <button type="button" disabled={page === pages} onClick={() => onChange(page + 1)} aria-label={tx("{0}下一页", [label])}>{tx("下一页")}<Icon name="chevron-right" /></button>
  </div></footer>
}

function UsageDetails({ data, total, userId, agent, onMember, onAgent }) {
  useLocale()
  const [view, setView] = useState('agents')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const members = view === 'members'
  const people = data.users || [], combinations = data.byAgent || []
  const rows = members ? people : combinations
  const selected = members ? userId : agent
  const nameOf = row => members ? row.label || tx("未绑定用户") : agentName(row.agent || row.label, data.agentNames)
  const term = query.trim().toLowerCase()
  // Overview returns these rows in descending token order. Search only narrows this table.
  const matches = term ? rows.filter(row => (members ? [nameOf(row)] : [nameOf(row), row.agent, row.model, row.provider])
    .some(value => String(value || '').toLowerCase().includes(term))) : rows
  const pages = Math.max(1, Math.ceil(matches.length / pageSize)), current = Math.min(page, pages)
  const searchLabel = members ? tx("搜索成员") : tx("搜索底座或模型")
  useEffect(() => setPage(1), [data])

  function switchView(next) {
    if (next === view) return
    setView(next); setQuery(''); setPage(1)
  }
  const tabs = [
    { key: 'members', title: tx("成员用量"), count: people.filter(row => row.userId).length },
    { key: 'agents', title: tx("底座与模型"), count: combinations.length },
  ]
  function navigateTabs(event, index) {
    const next = { ArrowLeft: 1 - index, ArrowRight: 1 - index, Home: 0, End: 1 }[event.key]
    if (next === undefined) return
    event.preventDefault()
    switchView(tabs[next].key)
    event.currentTarget.parentElement.children[next].focus()
  }

  return <section className="ugc-panel ugc-details">
    <PanelHead icon="activity" title={tx("用量明细")} />
    <div className="ugc-detail-tools">
      <div className="ugc-detail-tabs" role="tablist" aria-label={tx("用量明细")}>
        {tabs.map((tab, index) => <button key={tab.key} id={'ugc-tab-' + tab.key} type="button" role="tab"
          aria-controls="ugc-detail-panel" aria-selected={tab.key === view} tabIndex={tab.key === view ? 0 : -1}
          onKeyDown={event => navigateTabs(event, index)} onClick={() => switchView(tab.key)}>
          {tab.title}<span>{precise(tab.count)}</span></button>)}
      </div>
      <label className="ugc-detail-search"><Icon name="search" /><input type="search" value={query}
        aria-label={searchLabel} placeholder={searchLabel} onChange={e => { setQuery(e.target.value); setPage(1) }} /></label>
    </div>
    <div role="tabpanel" id="ugc-detail-panel" aria-labelledby={'ugc-tab-' + view}>
      {matches.length ? <div className="ugc-table-wrap" tabIndex="0" role="region" aria-label={members ? tx("成员用量") : tx("底座与模型")}>
        <table className="ugc-detail-table"><thead><tr>
          <th>{members ? tx("成员") : tx("底座")}</th><th className={members ? 'num' : ''}>{members ? tx("记录") : tx("模型")}</th>
          <th className="num" aria-sort="descending">{tx("Token 用量")} <span aria-hidden="true">↓</span></th>
          <th className="num">{tx("用量占比")}</th>
        </tr></thead><tbody>{matches.slice((current - 1) * pageSize, current * pageSize).map(row => {
          const id = members ? row.userId : row.agent, active = Boolean(id && selected === id)
          const name = nameOf(row)
          return <tr key={members ? row.userId || '' : JSON.stringify([row.agent, row.model, row.provider])} className={active ? 'selected' : ''}>
            <td><button type="button" className="ugc-detail-link" disabled={!id} aria-pressed={active}
              onClick={() => (members ? onMember : onAgent)(active ? '' : id)}>{name}</button>
              {members && !id && <small>{tx("待完成设备归属")}</small>}</td>
            {members ? <td className="num">{precise(row.sessions)}</td> : <td>{row.model || tx("跟随默认模型")}
              {row.provider && row.provider !== row.model && <small>{row.provider}</small>}</td>}
            <td className="num" title={precise(row.tokens)}><b>{count(row.tokens)}</b></td>
            <td className="num"><span className="ugc-share-cell"><em>{share(row.tokens, total, 1)}</em>
              <span className="ugc-share"><i style={{ width: ratio(row.tokens, total) + '%' }} /></span></span></td>
          </tr>
        })}</tbody></table></div> : <Empty text={term ? tx("没有匹配的结果") : members ? tx("当前范围还没有成员用量") : tx("当前范围还没有 Agent 用量")}
          note={term ? tx("试试其他关键词") : undefined} />}
      {!!rows.length && <Pager page={current} pages={pages} total={matches.length} onChange={setPage} pageSize={pageSize}
        onPageSize={size => { setPageSize(size); setPage(1) }} label={members ? tx("成员记录") : tx("模型组合")} />}
    </div>
  </section>
}

function RecentLedger({ rows, names }) {
  const uiLocale = useLocale();
  const [page, setPage] = useState(1)
  const pages = Math.max(1, Math.ceil(rows.length / 8)), current = Math.min(page, pages)
  useEffect(() => setPage(1), [rows])
  return <section className="ugc-panel ugc-recent">
    <PanelHead icon="file" title={tx("最近用量记录")} description={tx("核对消耗来源与异常峰值")} meta={tx("最近 {0} 条", [rows.length])} />
    {!rows.length ? <Empty text={tx("当前范围还没有最近记录")} /> : <>
      <div className="ugc-table-wrap" tabIndex="0" role="region" aria-label={tx("最近用量记录，可横向滚动")}><table className="ugc-recent-table">
        <thead><tr><th>{tx("工作内容 / 场景")}</th><th>{tx("成员")}</th><th>{tx("Agent / 模型")}</th><th className="num">{tx("Token 用量")}</th><th className="num">{tx("时间")}</th></tr></thead>
        <tbody>{rows.slice((current - 1) * 8, current * 8).map((row) => <tr key={row.id}>
          <td><b className="ugc-record-title" title={row.title}>{row.title || tx("AI 使用")}</b><small>{sceneLabel(row.sourceType, row.sourceLabel)}</small></td>
          <td><span className="ugc-record-user" title={row.user}>{row.user || tx("未绑定用户")}</span></td>
          <td><b className="ugc-record-agent">{agentName(row.agent, names)}</b><small className="ugc-record-model" title={row.model}>{row.model || tx("跟随默认模型")}</small></td>
          <td className="num" title={precise(row.tokens)}><b>{count(row.tokens)}</b></td>
          <td className="num ugc-muted">{when(row.occurredAt)}</td>
        </tr>)}</tbody>
      </table></div><Pager page={current} pages={pages} total={rows.length} onChange={setPage} label={tx("用量记录")} />
    </>}
  </section>
}

function QualityFooter({ quality }) {
  const uiLocale = useLocale();
  const coverage = Math.min(100, numeric(quality.coveragePct))
  const total = ['reported', 'reconciled', 'estimated', 'unknown'].reduce((sum, key) => sum + numeric(quality[key]), 0)
  return <footer className="ugc-quality"><div className="ugc-quality-heading"><Icon name="shield" /><b>{tx("数据口径")}</b>
    <span className={'ugc-coverage ' + (total ? coverage >= 90 ? 'good' : 'partial' : '')}>{total ? tx("上报 / 核对覆盖率 {0}%", [coverage]) : tx("暂无用量记录")}</span></div>
    <div className="ugc-quality-counts"><span>{tx("已上报 ")}<b>{precise(quality.reported)}</b></span><span>{tx("已核对 ")}<b>{precise(quality.reconciled)}</b></span>
      <span>{tx("估算 ")}<b>{precise(quality.estimated)}</b></span><span>{tx("未知 ")}<b>{precise(quality.unknown)}</b></span></div>
    <p>{tx("成本按美元归集，仅包含已知价格的记录；未计价用量不代表免费。")}</p>
  </footer>
}

function UsageSkeleton() {
  const uiLocale = useLocale();
  return <div className="ugc-skeleton" aria-label={tx("正在加载企业用量")}><div className="ugc-sk-metrics">{[0, 1, 2].map((i) => <span key={i} />)}</div>
    <div className="ugc-sk-panels"><span /><span /></div></div>
}
