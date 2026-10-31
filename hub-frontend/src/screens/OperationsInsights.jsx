import { getLocale, translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useMemo, useState } from 'react'
import { api } from '../api.js'
import { AUTO, Icon, Modal, useAsync } from '../ui.jsx'
import { FilterInput, FilterSelect } from '../FilterControls.jsx'
import { UsageTrend } from './operations-insights-charts.jsx'
import { summarizeTrend } from './insights-metrics.js'
import ListPager from '../ListPager.jsx'
import './operations-center.css'
import './operations-insights.css'








const CATEGORY = localeMap(() => ({
  dev: '研发与交付', office: '办公文稿', research: '信息与研究', errand: '日常零活',
}))
const AGENT_NAME = { pi: 'Pi', opencode: 'OpenCode', claude: 'Claude Code', codex: 'Codex', qwen: 'Qwen', dsh: 'DSH' }

const dayLabel = (iso) => {
  if (!iso) return '—'
  const diff = (Date.now() - new Date(iso).getTime()) / 86400000
  if (diff < 1) return tx("今天")
  if (diff < 2) return tx("昨天")
  return tx("{0} 天前", [Math.floor(diff)])
}
const timeLabel = (iso) => {
  if (!iso) return ''
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  const diff = (Date.now() - t.getTime()) / 86400000
  if (diff < 1) return tx("今天 {0}", [hm])
  if (diff < 2) return tx("昨天 {0}", [hm])
  return tx("{0}月{1}日", [t.getMonth() + 1, t.getDate()])
}
const fullTimeLabel = (iso) => {
  if (!iso) return tx("暂无记录")
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return tx("暂无记录")
  return t.toLocaleString(getLocale(), { hour12: false })
}
const dateLabel = (ymd) => {
  const parts = String(ymd || '').split('-')
  return parts.length === 3 ? tx("{0}月{1}日", [+parts[1], +parts[2]]) : ymd
}

/* SVG sparkline with area fill and the latest point highlighted. */
function Spark({ points, tone = 'accent', height = 32 }) {
  const uiLocale = useLocale();
  const w = 120
  const max = Math.max(1, ...points)
  const step = points.length > 1 ? w / (points.length - 1) : w
  const xy = points.map((v, i) => [i * step, height - 3 - (v / max) * (height - 8)])
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `0,${height} ${line} ${w},${height}`
  const [lx, ly] = xy[xy.length - 1] || [0, height]
  const hasActivity = points.some((v) => v > 0)
  return <svg className={`oi-spark tone-${tone}`} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" aria-hidden="true">
    {hasActivity ? <>
      <polygon className="oi-spark-area" points={area} />
      <polyline className="oi-spark-line" points={line} />
      <circle className="oi-spark-dot" cx={lx} cy={ly} r="2.4" />
    </> : <line className="oi-spark-zero" x1="0" x2={w} y1={height - 3} y2={height - 3} />}
  </svg>
}

/* Compare against the preceding seven days; hide zero-to-zero changes and label zero-to-positive as new. */
function Delta({ now, prev }) {
  const uiLocale = useLocale();
  if (!prev && !now) return null
  if (!prev) return <em className="oi-delta up">{tx("新增 ")}{now}</em>
  const pct = Math.round((now - prev) * 100 / prev)
  if (pct === 0) return <em className="oi-delta flat">{tx("与上周持平")}</em>
  return <em className={'oi-delta ' + (pct > 0 ? 'up' : 'down')}>
    {pct > 0 ? '↑' : '↓'} {Math.abs(pct)}%<i>{tx("vs 上周")}</i></em>
}

function Stat({ label, value, sub, description, delta, spark, tone = 'accent', icon, unit }) {
  const uiLocale = useLocale();
  /* Metric cards align labels, values, same-baseline deltas, descriptions, and full-width trends. */
  return <article className={`oi-stat tone-${tone}`}>
    <div className="oi-stat-head"><span className="oi-stat-label">{label}</span><span className="oi-stat-icon"><Icon name={icon} /></span></div>
    <div className="oi-stat-line"><b>{value == null ? '—' : Number(value).toLocaleString(getLocale())}</b><span className="oi-stat-unit">{unit}</span>{delta}</div>
    <small className="oi-stat-sub" title={description || (typeof sub === 'string' ? sub : undefined)} tabIndex={description ? 0 : undefined} aria-label={description ? `${sub} · ${description}` : undefined}>{sub}</small>
    {spark && <Spark points={spark} tone={tone} />}
  </article>
}

/*
 * Share segmented bars across departments and runtimes; zero values use neutral stubs
 * rather than positive-colored minimum widths.
 */
function BarRow({ name, segments, value, unit, sub, title }) {
  const uiLocale = useLocale();
  const empty = segments.every((s) => !s.w)
  return <div className="oi-row">
    <b className="oi-row-name" title={title || name}>{name}</b>
    <span className="oi-track">
      {empty ? <i className="zero" /> : segments.map((s, i) =>
        s.w > 0 && <i key={i} className={s.cls || ''} style={{ width: `${Math.min(100, s.w)}%` }} />)}
    </span>
    <b className="oi-row-val">{value}<small>{unit}</small></b>
    {sub && <small className="oi-row-sub">{sub}</small>}
  </div>
}

/*
 * Stack completed, failed, and active runs separately over 30 days; zero days use a
 * neutral 2px stub.
 */
function StackBars({ trend }) {
  const uiLocale = useLocale();
  const [tip, setTip] = useState(null)
  const peak = Math.max(0, ...trend.map((d) => d.automationRuns))
  const max = Math.max(1, peak)
  const mid = trend[Math.floor(trend.length / 2)]
  return <div className="oi-chart">
    <div className="oi-chart-head">
      <span>{tx("每日触发")}<span className="oi-chart-unit">{tx(" · 次")}</span></span>
      <span className="oi-legend"><i className="ok" />{tx("已完成")}<i className="bad" />{tx("失败")}<i className="pending" />{tx("进行中")}</span>
    </div>
    <div className="oi-bars" onMouseLeave={() => setTip(null)} role="img" tabIndex="0"
      onFocus={() => trend.length && setTip({ i: trend.length - 1, d: trend[trend.length - 1] })}
      onBlur={() => setTip(null)} onKeyDown={(event) => {
        if (event.key === 'Escape') { setTip(null); return }
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || !trend.length) return
        event.preventDefault()
        const i = Math.max(0, Math.min(trend.length - 1, (tip?.i ?? trend.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1)))
        setTip({ i, d: trend[i] })
      }}
      aria-label={tx("30 天自动化触发趋势，单日最多 {0} 次。使用左右方向键查看每日数据。{1}", [peak, tip ? tx("{0}触发 {1} 次，失败 {2} 次。", [dateLabel(tip.d.date), tip.d.automationRuns, tip.d.automationFailed]) : ''])}>
      {trend.map((d, i) => {
        const okN = Math.max(0, d.automationSucceeded || 0)
        const pendingN = Math.max(0, d.automationRunning ||
          d.automationRuns - (d.automationCompleted || d.automationFailed || 0))
        return <div key={d.date} className={'oi-col' + (tip && tip.i === i ? ' hot' : '')}
          onMouseEnter={() => setTip({ i, d })}>
            {d.automationRuns === 0 ? <i className="oi-seg none" /> : <>
            {okN > 0 && <i className="oi-seg ok" style={{ height: `${okN * 100 / max}%` }} />}
            {d.automationFailed > 0 && <i className="oi-seg bad" style={{ height: `${d.automationFailed * 100 / max}%` }} />}
            {pendingN > 0 && <i className="oi-seg pending" style={{ height: `${pendingN * 100 / max}%` }} />}
          </>}
        </div>
      })}
      {tip && <div className={'oi-tip' + (tip.i < 5 ? ' at-left' : tip.i > trend.length - 6 ? ' at-right' : '')}
        style={{ left: `${(tip.i + 0.5) * 100 / trend.length}%` }}>
        <b>{dateLabel(tip.d.date)}</b>
        <span>{tx("触发 ")}{tip.d.automationRuns}</span>
        {tip.d.automationRuns > 0 && <>
          <span className="ok">{tx("已完成 ")}{tip.d.automationSucceeded || 0}</span>
          <span className="bad">{tx("失败 ")}{tip.d.automationFailed || 0}</span>
          {(tip.d.automationRunning || 0) > 0 && <span className="pending">{tx("进行中 ")}{tip.d.automationRunning}</span>}
        </>}
      </div>}
    </div>
    <div className="oi-axis"><span>{dateLabel(trend[0] && trend[0].date)}</span>
      <span>{dateLabel(mid && mid.date)}</span><span>{dateLabel(trend[trend.length - 1]?.date)}</span></div>
  </div>
}

const SORTS = {
  use: (a, b) => (b.runs30d + b.conversationUses30d) - (a.runs30d + a.conversationUses30d) || b.installs - a.installs,
  installs: (a, b) => b.installs - a.installs,
  rate: (a, b) => (b.successRate ?? -1) - (a.successRate ?? -1),
  name: (a, b) => a.name.localeCompare(b.name, 'zh'),
}

export default function OperationsInsights() {
  const uiLocale = useLocale();
  const query = useAsync(() => api.operationsInsights(), AUTO)
  const [category, setCategory] = useState('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('use')
  const [idleOnly, setIdleOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [failureDetail, setFailureDetail] = useState(null)
  const PAGE_SIZE = 12
  const data = query.data

  const trend = data ? data.trend || [] : []
  const sessions = summarizeTrend(trend, 'aiSessions')
  const spark = useMemo(() => ({
    clients: trend.map((d) => d.activeClients || 0),
    tasks: trend.map((d) => d.tasksCreated),
    sessions: sessions.values,
    automation: trend.map((d) => d.automationRuns),
  }), [trend, uiLocale])

  if (query.error) return <div className="ops-loading ops-load-error"><Icon name="alert" /><b>{tx("运营数据没有加载出来")}</b><small>{query.error.message}</small><button className="btn btn-ghost" onClick={query.reload}>{tx("重新加载")}</button></div>
  if (!data) return <div className="ops-page oi-page oi-skeleton" aria-busy="true" aria-label={tx("正在加载运营分析")}>
    <div className="oi-sk-head" /><div className="oi-metrics">{[0, 1, 2, 3].map((i) => <article key={i} className="oi-sk-card" />)}</div>
    <div className="oi-overview-grid"><section className="oi-sk-panel" /><section className="oi-sk-panel" /></div>
  </div>

  const adoption = data.adoption || {}
  const agents = adoption.agents || {}
  const plugins = data.plugins || []
  const automation = data.automation || {}
  const output = data.output || {}
  const departments = data.departments || []
  const runsTotal = trend.reduce((n, d) => n + d.automationRuns, 0)
  const failTotal = trend.reduce((n, d) => n + d.automationFailed, 0)
  const completedTotal = trend.reduce((n, d) => n + (d.automationCompleted || 0), 0)
  const failRate = completedTotal > 0 ? Math.round(failTotal * 100 / completedTotal) : 0
  const donePct = output.tasksCreated30d ? Math.round((output.tasksDone30d || 0) * 100 / output.tasksCreated30d) : 0
  const failing = automation.failing || []
  const topErrors = automation.topErrors || []

  const cats = [...new Set(plugins.map((p) => p.category).filter(Boolean))]
  const used = plugins.filter((p) => p.runs30d + p.conversationUses30d > 0).length
  const idle = plugins.filter((p) => p.installs > 0 && p.runs30d + p.conversationUses30d === 0).length
  const q = search.trim().toLowerCase()
  const filtered = plugins
    .filter((p) => !category || p.category === category)
    .filter((p) => !idleOnly || (p.installs > 0 && p.runs30d + p.conversationUses30d === 0))
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q))
    .sort(SORTS[sort])
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const current = Math.min(page, pages)
  const rows = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)
  const jump = (fn) => (...args) => { fn(...args); setPage(1) }
  const maxDept = Math.max(1, ...departments.map((d) => d.activeUsers7d))
  const runnersTotal = Math.max(1, adoption.runnersTotal || 1)

  return <section className="ops-page oi-page">
    <div className="oi-metrics">
      <Stat label={tx("近 7 天活跃设备")} value={adoption.activeClients7d || 0} icon="monitor" unit={tx("台")}
        sub={tx("30 天 {0} 台活跃 · 全部 {1} 台", [adoption.activeClients30d || 0, adoption.clientsTotal || 0])}
        delta={<Delta now={adoption.activeClients7d || 0} prev={adoption.activeClientsPrev7d || 0} />}
        spark={spark.clients} tone="accent" />
      <Stat label={tx("近 30 天新建需求")} value={output.tasksCreated30d || 0} icon="box" unit={tx("项")}
        sub={tx("完成 {0}（{1}%） · 上线 {2} 次", [output.tasksDone30d || 0, donePct, output.deployments30d || 0])}
        spark={spark.tasks} tone="ok" />
      <Stat label={tx("近 30 个自然日 AI 会话")} value={sessions.total} icon="webhook" unit={tx("场")}
        sub={sessions.average == null ? tx("暂无趋势数据") : tx("日均 {0} 场", [sessions.average.toLocaleString(getLocale())])}
        description={trend.length ? tx("{0} 至 {1} · 北京时间 UTC+8（含今天），日均按 {2} 个自然日计算。", [trend[0].date, trend[trend.length - 1].date, trend.length]) : undefined}
        spark={spark.sessions} tone="accent" />
      <Stat label={tx("近 30 天自动化触发")} value={runsTotal} icon="activity" unit={tx("次")}
        sub={runsTotal > 0
          ? <>{tx("失败 ")}<em className={failRate >= 30 ? 'oi-crit' : ''}>{failTotal}{tx(" 次（已结束运行的 ")}{failRate}%）</em></>
          : tx("暂无自动化运行记录")}
        spark={spark.automation} tone={failRate >= 50 ? 'crit' : failRate >= 20 ? 'warn' : 'accent'} />
    </div>

    <div className="oi-overview-grid">
      <UsageTrend trend={trend} />
      <section className="ops-panel oi-panel oi-departments">
        <header className="oi-panel-header"><div className="oi-panel-title"><span className="oi-panel-icon"><Icon name="users" /></span><div><h3>{tx("部门采用")}</h3><p>{tx("近 7 天活跃人数")}</p></div></div>
          <span className="oi-total-badge">{departments.length}{tx(" 个部门")}</span></header>
        <div className="oi-body oi-dept-body" tabIndex={0} role="region" aria-label={tx("部门采用")}>
          {departments.length === 0 && <div className="oi-chart-empty"><Icon name="users" /><b>{tx("暂无部门使用记录")}</b><span>{tx("部门成员开始对话后，即可查看采用情况。")}</span></div>}
          {departments.map((d) => <BarRow key={d.org} name={d.org}
            segments={[{ w: d.activeUsers7d * 100 / maxDept }]}
            value={d.activeUsers7d} unit={tx("人")}
            sub={tx("30 天 {0} 需求{1}", [d.tasks30d, d.tasks30d > 0 ? tx(" · 完成 {0}%", [Math.round(d.done30d * 100 / d.tasks30d)]) : ''])} />)}
        </div>
      </section>

    </div>

    <div className="oi-detail-grid">
    <section className="ops-panel oi-panel oi-automation">
      <header className="oi-panel-header"><div className="oi-panel-title"><span className="oi-panel-icon"><Icon name="activity" /></span><div><h3>{tx("自动化健康")}</h3><p>{automation.enabled || 0}{tx(" 条已启用 / 共 ")}{automation.schedules || 0}{tx(" 条计划")}</p></div></div>
        <span className={'oi-health-badge ' + (automation.failed7d ? 'warn' : automation.runs7d ? 'ok' : '')}>{automation.failed7d ? tx("近 7 天失败 {0} 次", [automation.failed7d]) : automation.runs7d ? tx("近 7 天无失败") : tx("暂无运行")}</span></header>
      <div className="oi-body oi-auto-grid">
        <StackBars trend={trend} />
        {failing.length > 0 && <div className="oi-fail-list" tabIndex={0} role="region" aria-label={tx("最近失败的计划")}>
            <span className="oi-label">{tx("最近失败的计划 ")}<em>{tx("近 7 天")}</em></span>
            {failing.map((f, i) => {
              const failureKey = f.id || f.planId || f.key || f.title || i
              return <article key={failureKey} className="oi-fail-card">
              <div className="oi-fail-head"><b title={f.title}>{f.title}</b>
                {!f.enabled && <em className="oi-off">{tx("已停用")}</em>}
                <em className="oi-count">{f.failed7d == null ? tx("暂无记录") : tx("{0} 次", [f.failed7d])}</em></div>
              <small className="oi-fail-meta">{f.owner || tx("暂无记录")}{tx(" · 最近失败 ")}{timeLabel(f.lastFailedAt) || tx("暂无记录")}</small>
              <div className="oi-fail-actions">
                <button type="button" className="oi-fail-detail" onClick={() => setFailureDetail({ ...f, failureKey })}>{tx("查看详情")}</button>
              </div>
            </article>
            })}
          </div>}
          {topErrors.length > 0 && <details className="oi-err-list">
            <summary>{tx("按错误汇总")}<span>{topErrors.length}{tx(" 类问题")}</span></summary>
            {topErrors.map((item, i) => <div key={i} className="oi-err-row">
              <em>{item.n}{tx(" 次")}</em>
              <p>{item.error}{item.code && <code>{item.code}</code>}</p>
            </div>)}
          </details>}
        {failing.length === 0 && topErrors.length === 0 &&
          <div className={'oi-healthy' + (automation.runs7d ? '' : ' is-empty')}><Icon name={automation.runs7d ? 'check' : 'activity'} /><span><b>{automation.runs7d ? tx("近 7 天运行平稳") : tx("暂无自动化运行记录")}</b><small>{automation.runs7d ? tx("已触发 {0} 次，未记录失败。", [automation.runs7d]) : tx("计划运行后，这里会展示触发情况与异常。")}</small></span></div>}
      </div>
    {failureDetail && <Modal wide title={tx("自动化失败详情")} icon="alert" onClose={() => setFailureDetail(null)}>
      <div className="oi-failure-modal">
        <div className="oi-failure-modal-head"><div><b>{failureDetail.title || tx("未命名计划")}</b>
          <span>{failureDetail.owner ? `${failureDetail.owner} · ` : ''}{fullTimeLabel(failureDetail.lastFailedAt)}</span></div>
          <em>{failureDetail.failed7d == null ? tx("暂无记录") : tx("{0} 次失败", [failureDetail.failed7d])}</em></div>
        <div className="oi-failure-code"><span>{tx("错误代码")}</span><code>{failureDetail.lastErrorCode || tx("暂无记录")}</code></div>
        <pre className="oi-failure-copy" tabIndex={0} role="region" aria-label={tx("自动化失败详情")}>{failureDetail.lastError || tx("暂无记录")}</pre>
      </div>
    </Modal>}
    </section>
    <section className="ops-panel oi-panel oi-agents">
      <header className="oi-panel-header"><div className="oi-panel-title"><span className="oi-panel-icon"><Icon name="monitor" /></span><div><h3>{tx("执行环境")}</h3><p>{tx("Agent 安装与登录状态")}</p></div></div>
        <span className="oi-total-badge">{adoption.runnersOnline || 0} / {adoption.runnersTotal || 0}{tx(" 台在线")}</span></header>
      <div className="oi-body">
        {Object.keys(agents).length === 0 && <div className="oi-chart-empty"><Icon name="monitor" /><b>{tx("暂无执行环境")}</b><span>{tx("连接执行机后，即可查看 Agent 可用情况。")}</span></div>}
        {Object.entries(agents).map(([key, item]) => {
          const hasAuth = item.authed + item.unauthed > 0
          const unknown = Math.max(0, item.installed - item.authed - item.unauthed)
          return <BarRow key={key} name={AGENT_NAME[key] || key}
            segments={hasAuth
              ? [{ w: item.authed * 100 / runnersTotal, cls: 'seg-ok' },
                 { w: item.unauthed * 100 / runnersTotal, cls: 'seg-warn' },
                 { w: unknown * 100 / runnersTotal, cls: 'seg-dim' }]
              : [{ w: item.installed * 100 / runnersTotal }]}
            value={item.installed} unit={tx("台")}
            sub={hasAuth ? <>{tx("已登录 ")}<em className="ok">{item.authed}</em>{item.unauthed > 0 && <>{tx(" · 待登录 ")}<em className="warn">{item.unauthed}</em></>}{unknown > 0 && tx(" · 待上报 {0}", [unknown])}</> : tx("已安装")} />
        })}
        <p className="oi-note"><Icon name="shield" />{tx("Codex / Claude Code 需在对应电脑上完成账号登录。")}</p>
      </div>
    </section>
    </div>

    <section className="ops-panel oi-panel oi-plugins">
      <header className="oi-panel-header">
        <div className="oi-panel-title"><span className="oi-panel-icon"><Icon name="plug" /></span><div><h3>{tx("插件使用")}</h3><p>{used}{tx(" 个近 30 天有使用 / 共 ")}{plugins.length}{tx(" 个插件")}</p></div></div>
        <div className="oi-plugin-tools">
          <FilterInput className="oi-search-field" type="search" placeholder={tx("搜索插件名称或标识")} value={search}
            onChange={jump((e) => setSearch(e.target.value))} aria-label={tx("搜索插件")} />
          <label className="admin-filter-field oi-plugin-filter"><span>{tx("筛选")}</span><FilterSelect
            value={idleOnly ? 'idle' : category ? `category:${category}` : ''} aria-label={tx("筛选")}
            onChange={jump((e) => {
              const value = e.target.value
              setIdleOnly(value === 'idle')
              setCategory(value.startsWith('category:') ? value.slice(9) : '')
            })}>
            <option value="">{tx("全部插件")} ({plugins.length})</option>
            {cats.map((key) => <option key={key} value={`category:${key}`}>{CATEGORY[key] || key}</option>)}
            {idle > 0 && <option value="idle">{tx("已安装未使用")} ({idle})</option>}
          </FilterSelect></label>
          <label className="admin-filter-field oi-plugin-sort"><span>{tx("排序")}</span><FilterSelect resetValue="use" value={sort} onChange={jump((e) => setSort(e.target.value))} aria-label={tx("排序")}>
            <option value="use">{tx("按真实使用")}</option><option value="installs">{tx("按安装")}</option>
            <option value="rate">{tx("按成功率")}</option><option value="name">{tx("按名称")}</option>
          </FilterSelect></label>
        </div>
      </header>
      <div className="oi-body">
        <div className="oi-table-wrap" tabIndex="0" role="region" aria-label={tx("插件使用明细，可横向滚动")}><table className="oi-table">
          <thead><tr><th>{tx("插件")}</th><th>{tx("分类")}</th><th className="num">{tx("安装")}</th>
            <th className="num">{tx("流程运行（30 天）")}</th><th className="num">{tx("对话调用")}</th>
            <th className="num"><span className="oi-metric-help" tabIndex={0} title={tx("仅统计已结束的流程运行，不包含对话调用。")} aria-label={tx("成功率") + '：' + tx("仅统计已结束的流程运行，不包含对话调用。")}>{tx("成功率")}</span></th><th className="when">{tx("最近使用")}</th></tr></thead>
          <tbody>{rows.map((p) => <tr key={p.pluginId} className={p.enabled ? '' : 'is-off'}>
            <td className="name"><div className="oi-plugin-name"><span className={`oi-plugin-icon cat-${p.category || 'other'}`}><Icon name={p.category === 'dev' ? 'box' : p.category === 'office' ? 'file' : p.category === 'research' ? 'search' : 'plug'} /></span><div><b title={p.name}>{p.name}</b><small>{p.version ? `v${p.version}` : ''}{p.enabled ? '' : (p.version ? ' · ' : '') + tx("已停用")}</small></div></div></td>
            <td className="cat"><span className="oi-category">{CATEGORY[p.category] || (p.category ? p.category : '—')}</span></td>
            <td className="num">{p.installs > 0 ? p.installs : <span className="oi-dim">0</span>}</td>
            <td className="num">{p.runs30d > 0 ? <><b>{p.runs30d}</b><small>{tx("成 ")}{p.succeeded30d}{tx(" · 败 ")}{p.failed30d}</small></> : <span className="oi-dim">0</span>}</td>
            <td className="num">{p.conversationUses30d > 0 ? p.conversationUses30d : <span className="oi-dim">0</span>}</td>
            <td className="num">{p.successRate == null ? <span className="oi-dim oi-metric-help" tabIndex={0} title={tx("暂无已结束的流程运行；成功率仅统计流程运行，不包含对话调用。")} aria-label={tx("暂无已结束的流程运行；成功率仅统计流程运行，不包含对话调用。")}>—</span>
              : <em className={'oi-rate' + (p.successRate >= 80 ? ' ok' : p.successRate >= 50 ? ' mid' : ' bad')}>{p.successRate}%</em>}</td>
            <td className="when">{dayLabel(p.lastUsedAt)}</td>
          </tr>)}</tbody>
        </table></div>
        {rows.length === 0 && <div className="oi-empty">{q ? tx("没有匹配「") + search + tx("」的插件") : idleOnly ? tx("没有已安装但未使用的插件") : plugins.length ? tx("这一类还没有插件") : tx("暂无插件，添加后即可查看安装与使用情况。")}</div>}
        <ListPager page={current} pages={pages} total={filtered.length} unit={tx("个")} onChange={setPage} label={tx("插件使用分页")} />
      </div>
    </section>
  </section>
}
