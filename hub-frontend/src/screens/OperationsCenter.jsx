import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React from 'react'
import { api } from '../api.js'
import { AUTO, Icon, useAsync } from '../ui.jsx'
import './operations-center.css'
import { operationsText } from './operations-copy.js'

const ACTIVE = ['queued', 'running', 'waiting_human', 'waiting_external']
const sum = (obj, keys) => keys.reduce((n, key) => n + Number((obj || {})[key] || 0), 0)
const ago = (seconds) => {
  const value = Math.max(0, Number(seconds || 0))
  if (value < 60) return tx("{0} 秒", [value])
  if (value < 3600) return tx("{0} 分钟", [Math.floor(value / 60)])
  if (value < 86400) return tx("{0} 小时", [Math.floor(value / 3600)])
  return tx("{0} 天", [Math.floor(value / 86400)])
}

function State({ ok, children }) {
  const uiLocale = useLocale();
  return <span className={'ops-state ' + (ok ? 'ok' : 'warn')}><i />{children}</span>
}

export default function OperationsCenter() {
  const uiLocale = useLocale();
  const query = useAsync(() => api.operationsOverview(), AUTO)
  const data = query.data
  if (query.error) return <div className="ops-loading ops-load-error"><Icon name="alert" /><b>{tx("运行状态没有加载出来")}</b><small>{query.error.message}</small><button className="btn btn-ghost" onClick={query.reload}>{tx("重新加载")}</button></div>
  if (!data) return <div className="ops-loading"><span /><b>{tx("正在汇总平台运行状态")}</b><small>{tx("数据库、Runner 与执行链路会在同一张图里出现")}</small></div>
  const req = data.requests || {}
  const work = data.work || {}
  const runners = data.runners || { items: [] }
  const activeRuns = sum(work.workflow, ACTIVE)
  const activeSessions = sum(work.executions, ['queued', 'running'])
  function openAutomation() {
    try { sessionStorage.setItem('soduwork-execution-tab', 'runners') } catch (_e) {}
    window.dispatchEvent(new CustomEvent('soduwork-hub-nav', { detail: { screen: 'clients' } }))
  }

  return <section className="ops-page ops-control-page">
    <div className="ops-ledger">
      <article><span>{tx("正在运行")}</span><b>{activeRuns}</b><small>{tx("工作流 · ")}{activeSessions}{tx(" 个执行会话")}</small></article>
      <article><span>{tx("执行能力")}</span><b>{runners.accepting || 0}<em> / {runners.total || 0}</em></b><small>{tx("可接活 Runner · 当前负载 ")}{runners.busy || 0}</small></article>
      <article><span>{tx("等待人审")}</span><b>{work.pendingApprovals || 0}</b><small>{tx("只有关键验收关需要人处理")}</small></article>
      <article><span>{tx("请求健康")}</span><b>{Number(req.errorRate || 0) < .001 ? '99.9+' : (100 - Number(req.errorRate || 0) * 100).toFixed(1)}<em>%</em></b>
        <small>{req.windowMinutes || 30}{tx(" 分钟 · P95 ≤ ")}{req.p95Ms || 0} ms</small></article>
    </div>

    {(data.blockers || []).length > 0 && <div className="ops-alerts">{data.blockers.map((item, i) =>
      <article key={i} className={item.level}><Icon name="alert" /><div><b>{operationsText(item.title)}</b><span>{operationsText(item.detail)}</span></div></article>)}</div>}

    <div className="ops-grid">
      <section className="ops-panel ops-topology">
        <header><div><span>{tx("运行拓扑")}</span><h3>{operationsText(data.hub.modeLabel)}</h3></div><button className="btn btn-ghost xs" onClick={openAutomation}>{tx("管理执行节点")}</button></header>
        <div className="ops-hub-row">
          <div className="ops-node-icon hub"><Icon name="activity" /></div>
          <div><b>{data.hub.nodeId}</b><span>{data.hub.service} · v{data.hub.version}</span></div>
          <State ok={data.hub.ready}>{data.hub.ready ? tx("已就绪") : tx("未就绪")}</State>
        </div>
        <div className="ops-rail"><i /><span>{runners.online || 0}{tx(" 个实时连接")}</span><i /></div>
        <div className="ops-runner-list" tabIndex="0" role="region" aria-label={tx("执行节点列表，可滚动")}>
          <div className="ops-runner-head"><span>{tx("执行节点与底座")}</span><span>{tx("负载")}</span><span>{tx("状态")}</span></div>
          {(runners.items || []).map((row) => <article key={row.runnerId}>
            <div className={'ops-node-icon ' + (row.online ? 'live' : '')}><Icon name="monitor" /></div>
            <div className="ops-runner-name"><b title={row.label || row.host}>{row.label || row.host}</b><span title={`${row.owner || tx("共享节点")} · ${row.agents?.map((x) => x.name || x.key).join(' / ') || tx("未发现 Agent")}`}>{row.owner || tx("共享节点")} · {row.agents?.map((x) => x.name || x.key).join(' / ') || tx("未发现 Agent")}</span></div>
            <div className="ops-runner-load"><b>{row.busy || 0}</b><span>{tx("负载")}</span></div>
            <State ok={row.online && row.mode === 'accepting'}>{!row.online ? tx("离线") : row.mode === 'accepting' ? tx("可接活") : tx("排空中")}</State>
          </article>)}
          {!(runners.items || []).length && <div className="ops-empty">{tx("还没有登记执行节点")}</div>}
        </div>
        <p className="ops-truth"><Icon name="shield" />{operationsText(data.hub.clusterNote)}</p>
      </section>

      <section className="ops-panel ops-work">
        <header><div><span>{tx("交付运行态")}</span><h3>{tx("需求从执行到发布")}</h3></div></header>
        <div className="ops-work-groups" tabIndex={0} role="region" aria-label={tx("需求从执行到发布")}>
          <WorkRow label={tx("工作流")} data={work.workflow} active={ACTIVE} failed="failed" />
          <WorkRow label={tx("AI 会话")} data={work.executions} active={['queued', 'running']} failed="failed" />
          <WorkRow label={tx("环境发布")} data={work.deployments} active={['queued', 'running', 'verifying']} failed="failed" />
        </div>
        <div className="ops-failures" tabIndex={0} role="region" aria-label={tx("最近失败")}><div className="ops-section-label">{tx("最近失败")}</div>
          {(data.recentFailures || []).map((row) => <article key={row.id}><span className="ops-fail-dot" />
            <div><b>{row.error || tx("流程执行失败")}</b><span>{tx("需求 ")}{row.taskId || '—'}</span></div></article>)}
          {!(data.recentFailures || []).length && <div className="ops-empty compact">{tx("当前没有失败流程")}</div>}
        </div>
      </section>

      <section className="ops-panel ops-requests">
        <header><div><span>{tx("服务请求")}</span><h3>{tx("近 ")}{req.windowMinutes || 30}{tx(" 分钟")}</h3></div><small>{tx("已运行 ")}{ago(req.uptimeSeconds)}</small></header>
        <div className="ops-request-summary"><span><b>{req.requests || 0}</b>{tx("请求")}</span><span><b>{req.errors || 0}</b>{tx("服务错误")}</span><span><b>{req.p95Ms || 0} ms</b>{tx("全接口 P95（分桶上界）")}</span></div>
        <div className="ops-route-list" tabIndex={0} role="region" aria-label={tx("服务请求")}>{(req.routes || []).slice(0, 7).map((row) => {
          const timing = row.timing || {}
          const ttfb = timing.upstreamHeadersMs?.avgMs
          const admission = timing.admissionMs?.avgMs
          return <article key={row.method + row.route}>
            <code>{row.method}</code><span title={row.route}>{row.route}</span>
            <b title={ttfb != null ? tx("上游响应头 ") + ttfb + ' ms' : undefined}>{row.avgMs} ms
              <small>{tx("路由 P95 上界 ")}{row.p95Ms || 0} ms{ttfb != null ? tx(" · 上游响应头 ") + ttfb + ' ms' : ''}{admission != null ? tx(" · 调度 ") + admission + ' ms' : ''}</small>
            </b><em className={row.errors ? 'bad' : ''}>{row.errors || '—'}</em>
          </article>
        })}{!(req.routes || []).length && <div className="ops-empty compact">{tx("开始使用后会显示真实请求指标")}</div>}</div>
      </section>
    </div>
  </section>
}

function WorkRow({ label, data = {}, active, failed }) {
  const uiLocale = useLocale();
  const running = sum(data, active)
  const done = sum(data, ['done', 'success', 'completed'])
  const errors = Number(data[failed] || 0)
  const total = Math.max(1, running + done + errors)
  return <article><div><b>{label}</b><span>{running}{tx(" 进行中 · ")}{done}{tx(" 完成 · ")}{errors}{tx(" 失败")}</span></div>
    <div className="ops-bar"><i className="done" style={{ width: `${done / total * 100}%` }} />
      <i className="running" style={{ width: `${running / total * 100}%` }} /><i className="failed" style={{ width: `${errors / total * 100}%` }} /></div></article>
}
