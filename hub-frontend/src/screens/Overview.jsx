import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React from 'react'
import { api, can } from '../api.js'
import { useViewportHeight } from '../viewport-height.js'
import { useAsync, Loading, ErrorState, AUTO, Icon, navTo } from '../ui.jsx'
import './overview.css'
import { requirementSummary, requirementStage, hasExecutionIssue, isOverdue } from './requirement-governance.js'

const COLORS = ['var(--c-blue)', 'var(--c-green)', 'var(--c-orange)', 'var(--c-rose)', 'var(--offline)']

function Metric({ label, value, note, tone = '' }) {
  const uiLocale = useLocale();
  return <article className={'gov-metric ' + tone}>
    <span>{label}</span><b>{value}</b><small>{note}</small>
  </article>
}

function AttentionRow({ tone, label, value, note, action, onClick }) {
  const uiLocale = useLocale();
  return <article className={'gov-attention-row ' + tone}>
    <span className="gov-attention-dot" />
    <div><b>{label}</b><small>{note}</small></div>
    <strong>{value}</strong>
    {action && <button type="button" onClick={onClick}>{action}<Icon name="external" /></button>}
  </article>
}
export default function Overview() {
  // Keep department and attention sections tall enough for their primary rows.
  // Scroll the page on short windows rather than compressing these sections.
  const mainGridRef = useViewportHeight(460)
  const uiLocale = useLocale();
  const mayViewClients = can('client.view')
  const mayViewTasks = can('task.view')
  const mayManageIntegrations = can('integration.manage')
  const mayManageBindings = can('binding.manage')
  const hasDepartmentScope = mayViewClients && can('org.manage') && can('user.manage')

  // Skip unauthorized dimensions and report authorized request failures instead of substituting zero data.
  const clients = useAsync(() => mayViewClients ? api.clients() : Promise.resolve([]), AUTO)
  const tasks = useAsync(() => mayViewTasks ? api.tasks() : Promise.resolve([]), AUTO)
  const ints = useAsync(() => mayManageIntegrations ? api.integrations() : Promise.resolve([]), AUTO)
  const unassigned = useAsync(() => mayManageBindings ? api.unassigned() : Promise.resolve([]), AUTO)
  const orgs = useAsync(() => hasDepartmentScope ? api.orgs() : Promise.resolve([]))
  const users = useAsync(() => hasDepartmentScope ? api.users() : Promise.resolve([]))
  // Treat delivery failures and pending approval as operational attention items.
  const board = useAsync(() => mayViewTasks ? api.deliveryBoard() : Promise.resolve({}), AUTO)
  const sources = [clients, tasks, ints, unassigned, orgs, users, board]
  if (sources.some((source) => source.loading)) return <Loading />
  const failed = sources.find((source) => source.error)
  if (failed) return <ErrorState msg={failed.error.message} onRetry={() => sources.forEach((source) => source.reload())} />

  // Explain missing operational permissions rather than rendering an all-zero dashboard.
  if (!can('task.view') && !can('client.view')) {
    return (
      <div className="card">
        <div className="empty" style={{ padding: '40px 24px', lineHeight: 1.7 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 6 }}>{tx("你的账号暂无运营数据权限")}</div>{tx("当前角色未开通「查看需求 / 查看 SoduWork」等权限，因此看不到运营看板。")}<br />{tx("如需查看，请联系管理员为你的角色分配相应权限点。")}</div>
      </div>
    )
  }

  const cl = clients.data || [], it = ints.data || [], ua = unassigned.data || []
  const summary = requirementSummary(tasks.data || [])
  const tk = summary.active
  const ol = orgs.data || [], ul = users.data || []
  const online = cl.filter((c) => c.online).length
  const now = Date.now()

  // Overall risk and completion.
  const { done, overdue, failed: stuck, rate } = summary
  const jammed = ((board.data || {}).counts || {}).attention || 0

  // Aggregate members by their direct department.
  const orgName = {}; ol.forEach((o) => { orgName[o.id] = o.name })
  const userOrg = {}; ul.forEach((u) => { userOrg[u.id] = u.orgId })
  const clientUser = {}; cl.forEach((c) => { clientUser[c.id] = c.ownerUserId })
  const dept = {}
  const ensure = (oid) => {
    if (!dept[oid]) dept[oid] = { oid, name: oid === '__none__' ? tx("未归属 SoduWork") : (orgName[oid] || tx("未命名部门")), members: new Set(), boxes: 0, online: 0, total: 0, done: 0, open: 0, overdue: 0, stuck: 0 }
    return dept[oid]
  }
  ul.forEach((u) => { if (u.orgId) ensure(u.orgId).members.add(u.id) })
  cl.forEach((c) => { const oid = userOrg[c.ownerUserId]; if (oid) { const d = ensure(oid); d.boxes++; if (c.online) d.online++ } })
  tk.forEach((t) => {
    const uid = clientUser[t.ownerClientId]
    const oid = (uid && userOrg[uid]) || '__none__'
    const d = ensure(oid)
    d.total++
    if (requirementStage(t) === 'delivered') d.done++
    else d.open++
    if (isOverdue(t, now)) d.overdue++
    if (hasExecutionIssue(t)) d.stuck++
  })
  const deptRows = hasDepartmentScope ? Object.values(dept)
    .map((d) => ({ ...d, members: d.members.size, rate: d.total ? Math.round(d.done / d.total * 100) : 0 }))
    .filter((d) => d.total > 0 || d.members > 0)
    .sort((a, b) => (b.overdue + b.stuck) - (a.overdue + a.stuck) || b.total - a.total) : []

  // Source distributions.
  const by = {}
  tk.forEach((t) => { const k = t.origin === 'local' ? tx("本地新建") : t.origin === 'dispatch' ? tx("平台下发") : (t.source || t.origin); by[k] = (by[k] || 0) + 1 })
  const rows = Object.entries(by).sort((a, b) => b[1] - a[1])
  const max = Math.max(1, ...rows.map((r) => r[1]))
  const attention = summary.risk + jammed
  const onlineRate = cl.length ? Math.round(online / cl.length * 100) : 0
  return (
    <section className="gov-page">
      <div className="gov-ledger" aria-label={tx("核心治理指标")}>
        <Metric label={tx("需求池")} value={tk.length} note={tx("待整理与澄清 {0} · 已关闭 {1}", [summary.preparing, summary.closed])} />
        <Metric label={tx("需求交付率")} value={rate + '%'} note={tx("{0} / {1} 已交付，不含已关闭", [done, tk.length])} tone="good" />
        <Metric label={tx("待处理风险")} value={attention} note={tx("逾期 ") + overdue + tx(" · 执行异常 ") + stuck} tone={attention ? 'risk' : 'good'} />
        <Metric label={tx("SoduWork 在线率")} value={onlineRate + '%'} note={online + ' / ' + cl.length + tx(" 台在线")} tone={onlineRate < 60 && cl.length ? 'warn' : ''} />
      </div>

      <div ref={mainGridRef} className="gov-main-grid">
        <section className="gov-section gov-departments">
          <header><div><h3>{tx("部门需求态势")}</h3></div><small>{tx("按风险优先排列")}</small></header>
          {!hasDepartmentScope && <div className="gov-empty">{tx("当前角色没有完整的组织、用户与执行网络查看权限，因此不展示可能失真的部门统计。")}</div>}
          {hasDepartmentScope && deptRows.length === 0 && <div className="gov-empty">{tx("作用域内暂无部门数据。")}</div>}
          {deptRows.length > 0 && <div className="gov-dept-table" tabIndex={0} role="region" aria-label={tx("部门需求态势")}>
            <div className="gov-dept-head"><span>{tx("部门与在线情况")}</span><span>{tx("完成进度")}</span><span>{tx("需求")}</span><span>{tx("风险")}</span></div>
            {deptRows.map((d) => <article key={d.oid} className={d.overdue + d.stuck ? 'has-risk' : ''}>
              <div className="gov-dept-name"><b>{d.name}</b><small>{d.members}{tx(" 人 · SoduWork ")}{d.online}/{d.boxes}{tx(" 在线")}</small></div>
              <div className="gov-dept-progress"><span><i style={{ width: d.rate + '%' }} /></span><b>{d.rate}%</b></div>
              <div className="gov-dept-count"><b>{d.total}</b><small>{d.open}{tx(" 未完成")}</small></div>
              <div className="gov-dept-risk"><b>{d.overdue + d.stuck}</b><small>{tx("逾期 ")}{d.overdue}{tx(" · 执行异常 ")}{d.stuck}</small></div>
            </article>)}
          </div>}
        </section>

        <aside className="gov-section gov-attention">
          <header><div><h3>{tx("现在先处理什么")}</h3></div><small>{attention || tx("无")}{tx(" 项")}</small></header>
          <div className="gov-attention-list" tabIndex={0} role="region" aria-label={tx("现在先处理什么")}>
            <AttentionRow tone={overdue ? 'warning' : 'quiet'} label={tx("逾期需求")} value={overdue} note={overdue ? tx("已超过计划截止时间") : tx("没有逾期需求")} />
            <AttentionRow tone={stuck ? 'critical' : 'quiet'} label={tx("执行异常")} value={stuck} note={stuck ? tx("执行失败或回执待核实，需负责人跟进") : tx("没有执行异常")} />
            <AttentionRow tone={jammed ? 'critical' : 'quiet'} label={tx("交付门禁待处理")} value={jammed} note={jammed ? tx("失败或等待人工审批") : tx("交付门禁流转正常")} action={jammed ? tx("去处理") : ''} onClick={() => navTo('automation')} />
          </div>
          {(overdue > 0 || stuck > 0) && <p className="gov-attention-note"><Icon name="shield" />{tx("负责人在客户端「需求池」中处理；执行过程在关联对话中继续，管理端呈现全局风险。")}</p>}
        </aside>
      </div>

      <div className="gov-secondary-grid">
        <section className="gov-section gov-sources">
          <header><div><h3>{tx("来源分布")}</h3></div><small>{rows.length}{tx(" 类来源")}</small></header>
          <div className="gov-source-list">
            {!rows.length && <div className="gov-empty">{tx("成员提交、流转或交付需求后，这里会按来源实时汇总。")}</div>}
            {rows.map(([k, v], i) => <article key={k}>
              <span className="gov-source-name"><i style={{ background: COLORS[i % COLORS.length] }} />{k}</span>
              <span className="gov-source-track"><i style={{ width: (v / max * 100) + '%', background: COLORS[i % COLORS.length] }} /></span>
              <b>{v}</b>
            </article>)}
          </div>
        </section>

        <section className="gov-section gov-network">
          <header><div><h3>{tx("终端与业务来源")}</h3></div><button type="button" onClick={() => navTo('clients')}>{tx("查看执行网络")}<Icon name="external" /></button></header>
          <div className="gov-network-ledger">
            {mayViewClients && <div><b>{online}<small> / {cl.length}</small></b><span>{tx("在线 SoduWork")}</span></div>}
            {mayManageBindings && <div><b>{ua.length}</b><span>{tx("未分配需求")}</span></div>}
            {mayManageIntegrations && <div><b>{it.filter((i) => i.enabled).length}<small> / {it.length}</small></b><span>{tx("启用集成源")}</span></div>}
          </div>
          {!mayViewClients && !mayManageBindings && !mayManageIntegrations && <div className="gov-empty">{tx("当前角色没有接入与执行网络的查看权限。")}</div>}
          {mayManageIntegrations && it.length > 0 && <div className="gov-integration-list">
            {it.slice(0, 5).map((item) => <article key={item.id}>
              <i className={item.enabled ? 'on' : ''} /><b>{item.name}</b><span>{item.enabled ? tx("接收中") : tx("已停用")}</span><strong>{item.taskCount ?? 0}{tx(" 条")}</strong>
            </article>)}
          </div>}
        </section>
      </div>
    </section>
  )
}
