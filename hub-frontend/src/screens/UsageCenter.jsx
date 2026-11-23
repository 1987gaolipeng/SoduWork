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
  const [excludeAnomalies, setExcludeAnomalies] = useState(false)
  const [detail, setDetail] = useState('')
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
    const filters = { days, userId, source, agent }
    api.usageOverview(excludeAnomalies ? { ...filters, excludeAnomalies } : filters).then((result) => {
      if (!alive || current !== request.current) return
      const next = result || {}
      setData({ ...next, filtersUsed: filters })
      setDetail('')
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
  }, [days, userId, source, agent, reload, excludeAnomalies])

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
      <Pulse data={data} detail={detail} onDetail={(mode) => setDetail(detail === mode ? '' : mode)}
        excludeAnomalies={excludeAnomalies} onExclude={setExcludeAnomalies} />
      {detail && <UsageDiagnostics key={detail} mode={detail} filters={data.filtersUsed}
        tokenLimit={data.anomalies?.tokenLimit} />}
      <div className="ugc-overview">
        <TrendPanel recent={data.recent || []} points={data.trend || []} days={data.days || 30} />
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

function Pulse({ data, detail, onDetail, excludeAnomalies, onExclude }) {
  const uiLocale = useLocale();
  const summary = data.summary || {}
  const costQuality = data.costQuality || {}
  const knownUsd = costQuality.knownUsd ?? Math.max(0, (costQuality.records || 0) - (costQuality.unknown || 0) - (costQuality.otherCurrency || 0))
  const knownCost = costQuality.knownMicrousd ?? summary.costMicrousd
  const anomalies = data.anomalies || {}
  const activeUsers = (data.users || []).filter((item) => item.userId && numeric(item.tokens) > 0).length
  return <section className="ugc-metrics" aria-label={tx("用量概览")}>
    <Metric icon="activity" label={tx("Token 总用量")} value={count(summary.tokens)} unit="Tokens" note={tx("近 {0} 天 · {1} 条用量记录", [data.days || 30, precise(summary.sessions)])} detail={`${precise(summary.tokensExact ?? summary.tokens)} Tokens`}>
      {anomalies.records > 0 && <><strong className="ugc-warning">{tx("{0} 条异常记录，请核对上报", [precise(anomalies.records)])}</strong>
        <button className="ugc-refresh" type="button" aria-expanded={detail === 'anomalous'} onClick={() => onDetail('anomalous')}>{tx("查看异常记录")}</button></>}
      {(anomalies.records > 0 || excludeAnomalies) && <label><input type="checkbox" checked={!!excludeAnomalies} onChange={e => onExclude(e.target.checked)} />{tx("从用量汇总中排除异常记录")}</label>}
    </Metric>
    <Metric icon="ticket" label={tx("已知模型成本")} value={money(knownCost, knownUsd ? '$0.00' : '—')} tone="cost"
      detail={knownUsd || knownCost ? 'USD ' + (numeric(knownCost) / 1000000).toFixed(6) : undefined} note={tx("当前筛选范围内 {0} 条 USD 记录已计价", [precise(knownUsd)])}>
      {costQuality.estimatedUsageUsd > 0 && <span>{tx("其中 {0} 来自用量标为估算的记录", [money(costQuality.estimatedUsageMicrousd, '$0.00')])}</span>}
      {costQuality.knownOtherCurrency > 0 && <span>{tx("{0} 条其他币种记录未折算", [precise(costQuality.knownOtherCurrency)])}</span>}
      {costQuality.unknown > 0 && <><strong className={costQuality.unknownAnomalous ? 'ugc-warning' : ''}>{costQuality.unknownAnomalous ? tx("未计价用量（高）") : tx("未计价用量")}</strong>
        <span>{costQuality.unknownTokens == null ? tx("{0} 条用量记录", [precise(costQuality.unknown)]) : tx("{0} 条 · {1} Tokens", [precise(costQuality.unknown), precise(costQuality.unknownTokens)])}</span>
        {data.detailPage && <button className="ugc-refresh" type="button" aria-expanded={detail === 'unpriced'} onClick={() => onDetail('unpriced')}>{tx("查看未计价记录并估算")}</button>}</>}
    </Metric>
    <Metric icon="users" label={tx("活跃成员")} value={precise(activeUsers)} unit={tx("人")} note={tx("当前范围内产生 Token 用量的成员")} />
    <Metric icon="monitor" label={tx("AI 活跃时长")} value={duration(summary.durationMs)} note={tx("{0} 次模型请求", [precise(summary.requests)])} />
  </section>
}

function Metric({ icon, label, value, unit, note, tone = '', detail, children }) {
  const uiLocale = useLocale();
  return <article className={'ugc-metric ' + tone}><div className="ugc-metric-head"><span>{label}</span><i><Icon name={icon} /></i></div>
    <div className="ugc-metric-value" title={detail}><b>{value}</b>{unit && <span>{unit}</span>}</div><p>{note}</p>
    {children && <div className="ugc-metric-actions">{children}</div>}</article>
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
          <td className="num">{precise(row.sessions)}</td><td className="num" title={precise(row.tokensExact ?? row.tokens)}><b>{count(row.tokens)}</b></td>
          <td className="num">{money(row.costMicrousd, row.knownUsd ? '$0.00' : '—')}</td>
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
        <span className="ugc-agent-value"><b title={`${precise(row.tokensExact ?? row.tokens)} Tokens`}>{count(row.tokens)}</b><small>{money(row.costMicrousd, row.knownUsd ? '$0.00' : '—')}</small></span>
      </button>)}</div>}
  </section>
}

function UsageDiagnostics({ mode, filters, tokenLimit }) {
  const [page, setPage] = useState(1)
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    setReport(null)
    setError('')
    api.usageOverview({ ...filters, detail: mode, page }).then(result => {
      if (!result?.detailPage) throw new Error(tx("用量数据加载失败"))
      if (active) setReport(result)
    }).catch(reason => {
      if (active) setError(reason.message || tx("用量数据加载失败"))
    })
    return () => { active = false }
  }, [filters, mode, page, retry])
  return <section className="ugc-panel ugc-diagnostic">
    <PanelHead icon="file" title={mode === 'unpriced' ? tx("未计价记录") : tx("异常用量记录")}
      description={mode === 'unpriced' ? tx("当前筛选范围内尚未取得价格的记录，包含异常用量。")
        : tx("单条日用量超过 {0} Tokens，请按来源核对。", [precise(tokenLimit)])} />
    {mode === 'unpriced' && report?.costQuality && <CostEstimate costs={report.costQuality} />}
    {error ? <div className="ugc-inline-error" role="alert">{error}<button className="ugc-refresh" type="button" onClick={() => setRetry(v => v + 1)}>{tx("重新加载")}</button></div>
      : report ? <RecentLedger rows={report.recent} detailPage={report.detailPage} onPage={setPage} />
      : <p className="ugc-chart-note" role="status">{tx("正在加载企业用量")}</p>}
  </section>
}

function CostEstimate({ costs }) {
  const [rate, setRate] = useState('')
  const [budget, setBudget] = useState('')
  // USD per million tokens times tokens gives micro-USD. Keep this scenario out of ledger totals.
  const scenario = Number(costs.unknownTokens) * Number(rate)
  const validRate = rate !== '' && Number(rate) > 0 && Number.isFinite(scenario)
  const shareOfBudget = ((numeric(costs.knownMicrousd) + scenario) / 1000000) / Number(budget) * 100
  return <div className="ugc-estimate">
    <p>{tx("输入适用于这些模型的最高 Token 单价。估算包含异常上报，核对用量和供应商报价后再作预算决策。")}</p>
    <div className="ugc-estimate-fields">
      <label>{tx("最高单价（USD / 百万 Tokens）")}<input type="number" min="0" step="any" value={rate} onChange={e => setRate(e.target.value)} /></label>
      <label>{tx("本期预算（USD，可选）")}<input type="number" min="0" step="any" value={budget} onChange={e => setBudget(e.target.value)} /></label>
    </div>
    <output aria-live="polite">{validRate ? <><b>{tx("未计价成本估算上限约 {0}", [money(scenario, '$0.00')])}</b>
      {Number(budget) > 0 && Number.isFinite(shareOfBudget) && <span>{tx("已知 USD 成本加估算上限约占预算的 {0}%。", [shareOfBudget.toLocaleString(getLocale(), { maximumFractionDigits: 2 })])}</span>}
      <span>{tx("此次测算不计入账单，其他币种费用未折算。")}</span></>
      : rate !== '' && <span>{tx("请输入有效的正数单价。")}</span>}</output>
  </div>
}

function RecentLedger({ rows, detailPage, onPage }) {
  const uiLocale = useLocale();
  const [page, setPage] = useState(1)
  const total = detailPage?.total ?? rows.length
  const pages = Math.max(1, Math.ceil(total / (detailPage?.pageSize || 8)))
  const current = detailPage?.page ?? Math.min(page, pages)
  useEffect(() => setPage(1), [rows])
  const visible = detailPage ? rows : rows.slice((current - 1) * 8, current * 8)
  return <section className={detailPage ? 'ugc-detail-rows' : 'ugc-panel ugc-recent'}>
    {!detailPage && <PanelHead icon="file" title={tx("最近用量记录")} description={tx("核对消耗来源与异常峰值")} meta={tx("最近 {0} 条", [rows.length])} />}
    {!rows.length ? <Empty text={detailPage ? tx("当前筛选范围没有匹配记录") : tx("当前范围还没有最近记录")} /> : <>
      <div className="ugc-table-wrap" tabIndex="0" role="region" aria-label={detailPage ? tx("用量记录") : tx("最近用量记录，可横向滚动")}><table className="ugc-recent-table">
        <thead><tr><th>{tx("工作内容 / 场景")}</th><th>{tx("成员")}</th><th>{tx("Agent / 模型")}</th><th className="num">{tx("Token 用量")}</th><th className="num">{tx("已知成本")}</th><th className="num">{tx("时间")}</th></tr></thead>
        <tbody>{visible.map((row) => <tr key={row.id}>
          <td><b className="ugc-record-title" title={row.title}>{row.title || tx("AI 使用")}</b><small>{sceneLabel(row.sourceType, row.sourceLabel)}</small>
            {detailPage && <div className="ugc-record-ids"><span>{tx("记录 ID：{0}", [row.id])}</span><span>{tx("事件 ID：{0}", [row.eventId])}</span>
              {row.sourceId && <span>{tx("来源 ID：{0}", [row.sourceId])}</span>}</div>}</td>
          <td><span className="ugc-record-user" title={row.user}>{row.user || tx("未绑定用户")}</span></td>
          <td><b className="ugc-record-agent">{agentName(row.agent)}</b><small className="ugc-record-model" title={row.model}>{row.model || tx("跟随默认模型")}</small>{detailPage && <small>{row.provider}</small>}</td>
          <td className="num" title={precise(row.tokensExact ?? row.tokens)}><b>{detailPage ? precise(row.tokensExact ?? row.tokens) : count(row.tokens)}</b>
            {row.anomalous && <small><strong className="ugc-warning">{tx("异常用量")}</strong></small>}
            {row.quality === 'estimated' && <small>{tx("用量为估算值")}</small>}</td>
          <td className="num">{row.costKnown ? row.currency === 'USD' ? money(row.costMicrousd, '$0.00') : tx("{0}（未折算美元）", [row.currency]) : tx("未计价")}</td>
          <td className="num ugc-muted"><time dateTime={row.occurredAt} title={row.occurredAt}>{when(row.occurredAt)}</time></td>
        </tr>)}</tbody>
      </table></div><Pager page={current} pages={pages} total={total} onChange={onPage || setPage} label={tx("用量记录")} />
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
