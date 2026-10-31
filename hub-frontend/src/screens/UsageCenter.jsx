import { getLocale, translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { Icon } from '../ui.jsx'
import { FilterSelect } from '../FilterControls.jsx'
import { Empty, PanelHead, SceneLedger, TrendPanel } from './usage-center-charts.jsx'
import { agentName, count, duration, money, numeric, precise, ratio, sceneLabel, share, when } from './usage-center-format.js'
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
        const rows = (next.filters && next.filters.agents || []).map((key) => ({ key, label: agentName(key) }))
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
      <div className="ugc-layout">
        <MemberLedger rows={data.users || []} total={total} selected={userId} onSelect={setUserId} />
        <AgentLedger rows={data.byAgent || []} total={total} selected={agent} onSelect={setAgent} />
      </div>
      <RecentLedger rows={data.recent || []} />
      <QualityFooter quality={data.quality || {}} />
    </>}
  </div>
}

function Pulse({ data }) {
  const uiLocale = useLocale();
  const summary = data.summary || {}
  const costQuality = data.costQuality || {}
  const knownZero = costQuality.records > 0 && !costQuality.unknown && !costQuality.otherCurrency
  const activeUsers = (data.users || []).filter((item) => item.userId && numeric(item.tokens) > 0).length
  return <section className="ugc-metrics" aria-label={tx("用量概览")}>
    <Metric icon="activity" label={tx("Token 总用量")} value={count(summary.tokens)} unit="Tokens" note={tx("近 {0} 天 · {1} 条用量记录", [data.days || 30, precise(summary.sessions)])} detail={`${precise(summary.tokens)} Tokens`} />
    <Metric icon="ticket" label={tx("已知模型成本")} value={money(summary.costMicrousd, knownZero ? '$0.00' : summary.sessions ? tx("待对账") : '—')} tone="cost" detail={summary.costMicrousd || knownZero ? "USD " + (numeric(summary.costMicrousd) / 1000000).toFixed(6) : undefined} note={summary.costMicrousd || knownZero ? tx("USD · 仅包含已知价格的成本") : tx("价格未知时仍统计 Token 用量")} />
    <Metric icon="users" label={tx("活跃成员")} value={precise(activeUsers)} unit={tx("人")} note={tx("当前范围内产生 Token 用量的成员")} />
    <Metric icon="monitor" label={tx("AI 活跃时长")} value={duration(summary.durationMs)} note={tx("{0} 次模型请求", [precise(summary.requests)])} />
  </section>
}

function Metric({ icon, label, value, unit, note, tone = '', detail }) {
  const uiLocale = useLocale();
  return <article className={'ugc-metric ' + tone}><div className="ugc-metric-head"><span>{label}</span><i><Icon name={icon} /></i></div>
    <div className="ugc-metric-value" title={detail}><b>{value}</b>{unit && <span>{unit}</span>}</div><p>{note}</p></article>
}

function Pager({ page, pages, total, onChange, label = tx("记录") }) {
  const uiLocale = useLocale();
  if (pages <= 1) return null
  return <footer className="ugc-pager"><span>{tx("共 ")}{total}{tx(" 条")}{label}{tx(" · 第 ")}{page} / {pages}{tx(" 页")}</span><div>
    <button type="button" disabled={page === 1} onClick={() => onChange(page - 1)} aria-label={tx("{0}上一页", [label])}><Icon name="chevron-left" />{tx("上一页")}</button>
    <button type="button" disabled={page === pages} onClick={() => onChange(page + 1)} aria-label={tx("{0}下一页", [label])}>{tx("下一页")}<Icon name="chevron-right" /></button>
  </div></footer>
}

function MemberLedger({ rows, total, selected, onSelect }) {
  const uiLocale = useLocale();
  const [page, setPage] = useState(1)
  const pages = Math.max(1, Math.ceil(rows.length / 8)), current = Math.min(page, pages)
  useEffect(() => setPage(1), [rows])
  return <section className="ugc-panel ugc-members">
    <PanelHead icon="users" title={tx("成员用量")} description={tx("按 Token 用量排序 · 点击成员筛选")} meta={tx("{0} 位成员", [rows.filter((row) => row.userId).length])} />
    {!rows.length ? <Empty text={tx("当前范围还没有成员用量")} /> : <>
      <div className="ugc-table-wrap" tabIndex="0" role="region" aria-label={tx("成员用量明细，可横向滚动")}><table className="ugc-member-table">
        <thead><tr><th>{tx("成员")}</th><th className="num">{tx("记录")}</th><th className="num">{tx("Token 用量")}</th><th className="num">{tx("已知成本")}</th><th className="num">{tx("用量占比")}</th></tr></thead>
        <tbody>{rows.slice((current - 1) * 8, current * 8).map((row, index) => <tr key={row.userId || index} className={row.userId && selected === row.userId ? 'selected' : ''}>
          <td><button type="button" className="ugc-member" disabled={!row.userId} aria-pressed={!!row.userId && selected === row.userId} onClick={() => onSelect(selected === row.userId ? '' : row.userId)}>
            <i>{String(row.label || '?').slice(0, 1)}</i><span><b title={row.label}>{row.label || tx("未绑定用户")}</b><small>{row.userId ? tx("组织成员") : tx("待完成设备归属")}</small></span></button></td>
          <td className="num">{precise(row.sessions)}</td><td className="num" title={precise(row.tokens)}><b>{count(row.tokens)}</b></td>
          <td className="num"><span className={row.costMicrousd ? '' : 'ugc-muted'}>{money(row.costMicrousd, row.costKnown && row.currency === "USD" ? "$0.00" : undefined)}</span></td>
          <td className="num"><span className="ugc-share-cell"><span className="ugc-share"><i style={{ width: ratio(row.tokens, total) + '%' }} /></span><em>{share(row.tokens, total)}</em></span></td>
        </tr>)}</tbody>
      </table></div><Pager page={current} pages={pages} total={rows.length} onChange={setPage} label={tx("成员记录")} />
    </>}
  </section>
}

function AgentLedger({ rows, total, selected, onSelect }) {
  const uiLocale = useLocale();
  return <section className="ugc-panel ugc-agents">
    <PanelHead icon="monitor" title={tx("Agent 与模型")} description={tx("点击 Agent 筛选其全部模型")} meta={tx("{0} 个组合", [rows.length])} />
    {!rows.length ? <Empty text={tx("当前范围还没有 Agent 用量")} /> : <div className="ugc-agent-list">{rows.map((row, index) =>
      <button type="button" key={`${row.key || index}|${row.provider || ''}`} aria-pressed={selected === row.agent} onClick={() => onSelect(selected === row.agent ? '' : row.agent)}>
        <span className="ugc-agent-rank">{String(index + 1).padStart(2, '0')}</span>
        <span className="ugc-agent-copy"><b>{agentName(row.agent || row.label)}</b><small title={[row.model, row.provider].filter(Boolean).join(' · ')}>{[row.model || tx("跟随默认模型"), row.provider].filter(Boolean).join(' · ')}</small>
          <i><em style={{ width: ratio(row.tokens, total) + '%' }} /></i></span>
        <span className="ugc-agent-value"><b title={`${precise(row.tokens)} Tokens`}>{count(row.tokens)}</b><small>{money(row.costMicrousd)}</small></span>
      </button>)}</div>}
  </section>
}

function RecentLedger({ rows }) {
  const uiLocale = useLocale();
  const [page, setPage] = useState(1)
  const pages = Math.max(1, Math.ceil(rows.length / 8)), current = Math.min(page, pages)
  useEffect(() => setPage(1), [rows])
  return <section className="ugc-panel ugc-recent">
    <PanelHead icon="file" title={tx("最近用量记录")} description={tx("核对消耗来源与异常峰值")} meta={tx("最近 {0} 条", [rows.length])} />
    {!rows.length ? <Empty text={tx("当前范围还没有最近记录")} /> : <>
      <div className="ugc-table-wrap" tabIndex="0" role="region" aria-label={tx("最近用量记录，可横向滚动")}><table className="ugc-recent-table">
        <thead><tr><th>{tx("工作内容 / 场景")}</th><th>{tx("成员")}</th><th>{tx("Agent / 模型")}</th><th className="num">{tx("Token 用量")}</th><th className="num">{tx("已知成本")}</th><th className="num">{tx("时间")}</th></tr></thead>
        <tbody>{rows.slice((current - 1) * 8, current * 8).map((row) => <tr key={row.id}>
          <td><b className="ugc-record-title" title={row.title}>{row.title || tx("AI 使用")}</b><small>{sceneLabel(row.sourceType, row.sourceLabel)}</small></td>
          <td><span className="ugc-record-user" title={row.user}>{row.user || tx("未绑定用户")}</span></td>
          <td><b className="ugc-record-agent">{agentName(row.agent)}</b><small className="ugc-record-model" title={row.model}>{row.model || tx("跟随默认模型")}</small></td>
          <td className="num" title={precise(row.tokens)}><b>{count(row.tokens)}</b></td><td className="num"><span className={row.costMicrousd ? '' : 'ugc-muted'}>{money(row.costMicrousd, row.costKnown && row.currency === "USD" ? "$0.00" : undefined)}</span></td>
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
  return <div className="ugc-skeleton" aria-label={tx("正在加载企业用量")}><div className="ugc-sk-metrics">{[0, 1, 2, 3].map((i) => <span key={i} />)}</div>
    <div className="ugc-sk-panels"><span /><span /></div></div>
}
