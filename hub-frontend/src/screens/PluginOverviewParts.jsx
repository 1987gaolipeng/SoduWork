import { getLocale, translateText as tx, localeMap, useLocale } from '../i18n.js'
import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Icon } from '../ui.jsx'
import PluginAppTag from './PluginAppTag.jsx'

const fmt = (ms) => ms ? new Date(ms).toLocaleString(getLocale(), { hour12: false }) : '—'
const duration = (ms) => {
  if (ms == null) return '—'
  if (ms < 60000) return Math.max(1, Math.round(ms / 1000)) + tx(" 秒")
  if (ms < 3600000) return Math.round(ms / 60000) + tx(" 分钟")
  return (ms / 3600000).toFixed(ms < 36000000 ? 1 : 0) + tx(" 小时")
}
const failureLabel = (detail) => ({
  'call-budget': tx("本轮额度已用完"),
  'list-budget': tx("清单额度已用完"),
  concurrency: tx("并发已满"),
  'circuit-open': tx("熔断中") + (detail.retryAfterSeconds ? ' · ' + detail.retryAfterSeconds + tx(" 秒") : ''),
}[detail.failureKind] || tx("失败"))

export function PluginHealth({ data }) {
  const uiLocale = useLocale();
  if (!data) return null
  const rate = data.successRate == null ? '—' : data.successRate + '%'
  const hotspot = (data.failureHotspots || [])[0]
  return <section className={'plugin-health-strip state-' + data.state}>
    <div className="plugin-health-state"><i /><span><b>{data.label}</b><small>{tx("近 ")}{data.windowDays || 30}{tx(" 天真实运行")}{data.sampled ? tx(" · 取最近 500 次") : ''}</small></span></div>
    <span><small>{tx("运行")}</small><b>{data.runs || 0}</b><em>{data.active || 0}{tx(" 个进行中")}</em></span>
    <span><small>{tx("成功率")}</small><b>{rate}</b><em>{data.succeeded || 0}{tx(" 成功 · ")}{data.failed || 0}{tx(" 失败")}</em></span>
    <span><small>{tx("典型耗时")}</small><b>{duration(data.medianDurationMs)}</b><em>P95 {duration(data.p95DurationMs)}</em></span>
    <span><small>{tx("主要失败点")}</small><b>{hotspot ? hotspot.nodeKey : tx("无")}</b><em>{hotspot ? hotspot.attempts + tx(" 次失败尝试") : tx("尚无失败证据")}</em></span>
  </section>
}

const GOVERNANCE_ACTION = localeMap(() => ({
  'plugin.import': ['导入插件', 'plus', 'neutral'],
  'plugin.submit': ['提交插件', 'plus', 'neutral'],
  'plugin.personal_publish': ['提交企业插件', 'plus', 'neutral'],
  'plugin.approve': ['审批启用', 'check', 'good'],
  'plugin.reject': ['退回修改', 'alert', 'warn'],
  'plugin.revoke': ['撤销版本', 'alert', 'danger'],
  'plugin.evaluation_start': ['开始发布评测', 'activity', 'live'],
  'plugin.evaluation_review': ['确认评测结论', 'shield', 'good'],
  'plugin.evaluation_cancel': ['停止发布评测', 'alert', 'warn'],
  'plugin.bind': ['建立生效绑定', 'link', 'good'],
  'plugin.binding_update': ['更新生效绑定', 'link', 'neutral'],
  'plugin.rollout': ['切换或回退版本', 'refresh', 'live'],
  'plugin.catalog_policy': ['更新员工目录策略', 'grid', 'neutral'],
  'plugin.access_policy': ['更新使用与编辑权限', 'shield', 'neutral'],
  'plugin.publisher_candidate_trust': ['登记可信发布者', 'shield', 'good'],
  'plugin.run': ['启动插件流程', 'send', 'live'],
  'plugin.run_cancel': ['结束插件流程', 'alert', 'warn'],
  'plugin.retry_quality': ['重试质量门禁', 'refresh', 'live'],
  'plugin.retry_gate': ['重试失败节点', 'refresh', 'live'],
  'plugin.redispatch_gate': ['重新派发节点', 'send', 'live'],
  'plugin.install': ['成员安装', 'check', 'neutral'],
  'plugin.uninstall': ['成员卸载', 'alert', 'neutral'],
}))

function versionLabel(plugin, id) {
  const version = ((plugin && plugin.versions) || []).find((item) => item.id === id)
  return version ? 'v' + version.version : (id ? String(id).slice(0, 10) : '')
}

function governanceDetail(row, plugin) {
  const detail = row.detail || {}
  const versionId = detail.targetVersionId || detail.versionId ||
    (row.targetType === 'plugin_version' ? row.targetId : '')
  const version = detail.targetVersion ? 'v' + detail.targetVersion : versionLabel(plugin, versionId)
  if (row.action === 'plugin.rollout') return (detail.changed || 0) + tx(" 个绑定 → ") + (version || tx("目标版本")) + tx("，失败则全部保持原状")
  if (row.action === 'plugin.bind') return (detail.projectId ? tx("项目绑定") : tx("组织通用绑定")) + ' · ' + (version || tx("已审批版本"))
  if (row.action === 'plugin.binding_update') {
    const after = detail.after || detail
    return (after.enabled ? tx("已启用") : tx("已停用")) + (versionLabel(plugin, after.versionId) ? ' · ' + versionLabel(plugin, after.versionId) : '')
  }
  if (row.action.startsWith('plugin.evaluation_')) return [detail.caseKey, detail.decision].filter(Boolean).join(' · ') || tx("发布质量门禁")
  if (row.action === 'plugin.access_policy') return tx('插件使用与编辑改进权限已即时更新')
  if (row.action === 'plugin.catalog_policy') return tx("员工可见与安装策略已更新，需求绑定不受影响")
  if (row.action === 'plugin.import' || row.action === 'plugin.submit' || row.action === 'plugin.personal_publish') return detail.filename || tx("新版本进入隔离区")
  if (row.action === 'plugin.approve' || row.action === 'plugin.reject' || row.action === 'plugin.revoke') return [version, detail.note].filter(Boolean).join(' · ') || row.targetLabel
  if (row.action.startsWith('plugin.run') || row.action.includes('retry') || row.action.includes('redispatch')) return [row.targetLabel, detail.node].filter(Boolean).join(' · ') || tx("插件执行控制")
  return row.targetLabel || version || tx("插件治理操作")
}

export function PluginInvocationActivity({ plugin }) {
  const uiLocale = useLocale();
  const pluginId = plugin && plugin.id
  const [reload, setReload] = useState(0)
  const [view, setView] = useState('governance')
  const [state, setState] = useState({ loading: true, data: null, error: '' })
  useEffect(() => {
    let alive = true
    setView('governance')
    setState((old) => ({ loading: true, data: old.data, error: '' }))
    api.pluginActivity(pluginId).then((data) => {
      if (alive) setState({ loading: false, data, error: '' })
    }).catch((error) => {
      if (alive) setState((old) => ({ loading: false, data: old.data, error: error.message || tx("运行与审计记录加载失败") }))
    })
    return () => { alive = false }
  }, [pluginId, reload])
  const data = state.data || { summary: {}, items: [], total: 0, governance: { items: [], total: 0 } }
  const summary = data.summary || {}
  const rows = data.items || []
  const governance = data.governance || { items: [], total: 0 }
  const auditRows = governance.items || []
  const latestAudit = auditRows[0]
  return <section className="plugin-invocations">
    <header><div><span className="eyebrow">{tx("运行与审计")}</span><h3>{tx("运行与审计")}</h3><p>{tx("流程证据、治理变更与连接调用分开呈现；不保存参数、返回内容或凭据。")}</p></div>
      <div className="plugin-activity-tools"><nav aria-label={tx("插件活动类型")}>
        <button className={view === 'governance' ? 'on' : ''} onClick={() => setView('governance')}>{tx("治理变更")}<b>{governance.total || 0}</b></button>
        <button className={view === 'invocations' ? 'on' : ''} onClick={() => setView('invocations')}>{tx("连接调用")}<b>{data.total || 0}</b></button>
      </nav><button type="button" disabled={state.loading} onClick={() => setReload((x) => x + 1)}><Icon name="refresh" />{state.loading ? tx("更新中") : tx("刷新")}</button></div></header>
    {state.error && <div className="plugin-invocation-error"><Icon name="alert" /><span>{state.error}</span><button onClick={() => setReload((x) => x + 1)}>{tx("重试")}</button></div>}
    {view === 'governance' && <>
      <div className="plugin-audit-summary">
        <span><small>{tx("治理记录")}</small><b>{governance.total || 0}</b></span>
        <span><small>{tx("最近操作")}</small><b>{latestAudit ? (GOVERNANCE_ACTION[latestAudit.action] || [latestAudit.action])[0] : tx("暂无")}</b></span>
        <span><small>{tx("操作人")}</small><b>{latestAudit ? latestAudit.actorName || tx("系统") : '—'}</b></span>
      </div>
      {!state.loading && !state.error && auditRows.length === 0 && <div className="plugin-invocation-empty">{tx("还没有导入、审批、评测、绑定或版本切换记录。")}</div>}
      {auditRows.length > 0 && <div className="plugin-audit-list">{auditRows.slice(0, 12).map((row) => {
        const meta = GOVERNANCE_ACTION[row.action] || [row.action, 'activity', 'neutral']
        return <div className={'tone-' + meta[2]} key={row.id}><span className="plugin-audit-icon"><Icon name={meta[1]} /></span><span><b>{meta[0]}</b><small>{governanceDetail(row, plugin)}</small></span><em>{row.actorName || tx("系统")}</em><time>{fmt(row.at)}</time></div>
      })}</div>}
    </>}
    {view === 'invocations' && <>
      <div className="plugin-invocation-summary">
        <span><small>{tx("调用")}</small><b>{data.total || 0}</b></span>
        <span><small>{tx("成功率")}</small><b>{summary.successRate == null ? '—' : summary.successRate + '%'}</b></span>
        <span><small>{tx("典型耗时")}</small><b>{duration(summary.medianDurationMs)}</b></span>
        <span><small>{tx("连接")}</small><b>{(summary.connectors || []).join('、') || '—'}</b></span>
      </div>
      {!state.loading && !state.error && rows.length === 0 && <div className="plugin-invocation-empty">{tx("还没有通过对话调用这个插件的连接。")}</div>}
      {rows.length > 0 && <div className="plugin-invocation-list">{rows.slice(0, 8).map((row) => {
        const failed = row.action === 'plugin.mcp_failed'
        const detail = row.detail || {}
        return <div className={failed ? 'is-failed' : ''} key={row.id}><i /><span><b>{row.actorName || tx("未知成员")}</b><small>{row.targetId || tx("插件连接")} · {detail.tool || (detail.operation === 'list' ? tx("读取工具") : tx("调用工具"))}</small></span><em>{detail.durationMs == null ? '—' : duration(detail.durationMs)} · {failed ? failureLabel(detail) : tx("成功")}</em><time>{fmt(row.at)}</time></div>
      })}</div>}
    </>}
  </section>
}

export function PluginVersionHistory({ plugin, selectedId, busy, canManage, onSelect, onSimulate, onEnable, onReject, onRevoke }) {
  const uiLocale = useLocale();
  const versions = plugin.versions || []
  if (!versions.length) return null
  const bindings = plugin.bindings || []
  const compatibilityName = { initial: tx("首个版本"), current: tx("当前版本"), safe: tx("兼容"), review: tx("需复核"), breaking: tx("破坏性变更") }
  return <section className="plugin-version-history">
    <div className="plugin-version-head">
      <div><span className="eyebrow">{tx("不可变版本历史")}</span><h3>{tx("版本与回退")}</h3><p>{tx("选择版本查看对应流程、权限、发布评测和模拟结果；已有绑定切换版本前会重新预检。")}</p></div>
      <span>{versions.length}{tx(" 个不可变版本")}</span>
    </div>
    <div className="plugin-version-list">
      {versions.map((version, index) => {
        const activeBindings = bindings.filter((x) => x.versionId === version.id && x.enabled).length
        const state = version.trustState === 'approved' && version.enabled
          ? 'approved' : version.trustState === 'revoked' ? 'revoked' : 'quarantined'
        const stateName = state === 'approved' ? tx("已启用") : state === 'revoked' ? tx("已撤销") : tx("隔离待审")
        const compatibility = version.compatibility || {}
        return <article className={(selectedId === version.id ? 'is-selected ' : '') + 'state-' + state} key={version.id}>
          <button className="plugin-version-main" type="button" onClick={() => onSelect(version.id)}>
            <span className="plugin-version-number">v{version.version}<PluginAppTag version={version} />{index === 0 && <em>{tx("最新")}</em>}</span>
            <span className="plugin-version-meta"><b>{stateName}</b><small>{fmt(version.createdAt)} · {(version.provenance || {}).publisherName || tx("未知发布者")} · {String(version.checksum || '').slice(0, 10)}</small></span>
            <span className={'plugin-version-compat level-' + (compatibility.level || 'initial')}><b>{compatibilityName[compatibility.level] || tx("待分析")}</b><small>{activeBindings ? activeBindings + tx(" 个生效绑定") : tx("没有生效绑定")}</small></span>
          </button>
          <span className="plugin-version-actions">
            <button type="button" onClick={() => onSimulate(version)}>{tx("预检")}</button>
            {canManage && state === 'quarantined' && <button type="button" className="danger" disabled={busy === version.id} onClick={() => onReject(version)}>{tx("退回修改")}</button>}
            {canManage && state !== 'approved' && <button type="button" className="primary" disabled={busy === version.id} onClick={() => onEnable(version)}>{busy === version.id ? tx("处理中…") : tx("审查启用")}</button>}
            {canManage && state === 'approved' && <button type="button" className="danger" disabled={busy === version.id} onClick={() => onRevoke(version)}>{tx("撤销")}</button>}
          </span>
        </article>
      })}
    </div>
  </section>
}

export function PluginAudienceReview({ data, onRetry }) {
  const uiLocale = useLocale();
  if (!data || data.loading) return <section className="plugin-audience-review is-loading"><span className="plugin-audience-mark"><Icon name="shield" /></span><div><b>{tx("正在核对定向范围…")}</b><small>{tx("只有插件管理员可以看到具体范围")}</small></div></section>
  if (data.error) return <section className="plugin-audience-review is-error"><span className="plugin-audience-mark"><Icon name="alert" /></span><div><b>{tx("定向范围暂时没有加载出来")}</b><small>{data.error}</small></div><button type="button" onClick={onRetry}>{tx("重试")}</button></section>
  const items = data.items || []
  const teams = items.length > 0 && items.every((item) => item.type === 'org_unit')
  return <section className="plugin-audience-review">
    <span className="plugin-audience-mark"><Icon name="shield" /></span>
    <div className="plugin-audience-copy"><b>{tx("定向发布给 ")}{items.length} {teams ? tx("个团队") : tx("位成员")}</b><small>{teams ? tx("团队范围随当前不可变版本固化；所选团队及其下级组织成员可用") : tx("名单随当前不可变版本固化；停用账号仍保留在审计视图中")}</small></div>
    <div className="plugin-audience-people">
      {items.slice(0, 12).map((item) => <span className={item.active ? '' : 'is-inactive'} key={item.id}><i>{item.name.slice(0, 1)}</i><b>{item.name}</b>{item.type !== 'org_unit' && !item.active && <em>{tx("已停用")}</em>}</span>)}
      {items.length > 12 && <span className="is-more">{tx("还有 ")}{items.length - 12} {teams ? tx("个团队") : tx("人")}</span>}
    </div>
  </section>
}

export function Capability({ icon, label, value }) {
  const uiLocale = useLocale();
  return <span className="capability"><Icon name={icon} /><span><small>{label}</small><b title={value}>{value}</b></span></span>
}

export function LoadIssue({ message, onRetry }) {
  const uiLocale = useLocale();
  return <div className="plugin-load-issue"><Icon name="alert" /><span>{message}</span><button type="button" onClick={onRetry}>{tx("重试")}</button></div>
}
