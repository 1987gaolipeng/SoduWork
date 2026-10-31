import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useState, useEffect } from 'react'
import { api } from '../api.js'
import { Loading, ErrorState, Icon } from '../ui.jsx'
import { FilterSelect } from '../FilterControls.jsx'
import ListPager from '../ListPager.jsx'
import { useViewportHeight } from '../viewport-height.js'
import './admin-access-pages.css'
import { detailText } from './audit-detail.js'

const ACTIONS = localeMap(() => ({
  'task.dispatch': { label: "下发需求", c: 'var(--c-blue)' },
  'task.dispatch.sub': { label: "分配需求给下属", c: 'var(--c-blue)' },
  'task.advance': { label: '推进流转', c: 'var(--ok)' },
  'task.reject': { label: '打回流转', c: 'var(--warn)' },
  'client.assign': { label: '分配 SoduWork 归属', c: 'var(--c-green)' },
  'client.reset_secret': { label: '重置设备密钥', c: 'var(--warn)' },
  'role.update': { label: '改角色权限', c: 'var(--c-rose)' },
  'user.create': { label: '新建用户', c: 'var(--c-green)' },
  'user.update': { label: '修改用户', c: 'var(--c-orange)' },
  'integration.delete': { label: '删除集成源', c: 'var(--crit)' },
  'report.generate': { label: '生成团队日报', c: 'var(--c-orange)' },
  'task.nudge': { label: '催办', c: 'var(--warn)' },
  'task.agent_run': { label: 'SoduWork 执行', c: 'var(--accent)' },
  'task.ai_dispatch': { label: "安排 AI 执行", c: 'var(--accent)' },
  'plugin.import': { label: '导入插件', c: 'var(--c-blue)' },
  'plugin.publish': { label: '发布插件', c: 'var(--c-green)' },
  'plugin.approve': { label: '批准插件', c: 'var(--ok)' },
  'plugin.reject': { label: '驳回插件', c: 'var(--warn)' },
  'plugin.bind': { label: '绑定插件', c: 'var(--c-blue)' },
  'plugin.run': { label: '运行插件流程', c: 'var(--accent)' },
  'plugin.run_cancel': { label: '取消插件运行', c: 'var(--warn)', noFilter: true },
  'plugin.retry_quality': { label: '重试质量检查', c: 'var(--c-orange)', noFilter: true },
  'plugin.retry_gate': { label: '重试门禁', c: 'var(--c-orange)', noFilter: true },
  'automation.project_launch': { label: '启动自动化交付', c: 'var(--accent)' },
  'environment.create': { label: '新建环境', c: 'var(--c-green)', noFilter: true },
  'environment.update': { label: '修改环境', c: 'var(--c-orange)', noFilter: true },
  'deployment_target.create': { label: '新建发布目标', c: 'var(--c-green)', noFilter: true },
  'deployment_target.update': { label: '修改发布目标', c: 'var(--c-orange)', noFilter: true },
  'runner.enroll': { label: '接入 Runner', c: 'var(--c-green)', noFilter: true },
  'runner.revoke_key': { label: '吊销 Runner 密钥', c: 'var(--crit)', noFilter: true },
  'runner.enable': { label: '启用云主机', c: 'var(--c-green)' },
  'runner.disable': { label: '停用云主机', c: 'var(--warn)' },
  'runner.reassign': { label: '重新分配云主机', c: 'var(--c-blue)' },
  'runner.reprovision': { label: '云主机安全接入', c: 'var(--c-blue)' },
  'release.deploy_request': { label: '申请发布', c: 'var(--c-blue)' },
  'release.rollback': { label: '执行回滚', c: 'var(--warn)' },
  // Retain labels for historical audit records without active filter entries.
  'task.multica_dispatch': { label: '历史托管执行（兼容记录）', c: 'var(--offline)', noFilter: true },
  'multica.config': { label: '历史托管配置（兼容记录）', c: 'var(--offline)', noFilter: true },
  'project.create': { label: '新建工程', c: 'var(--c-green)', noFilter: true },
  'project.update': { label: '修改工程', c: 'var(--c-orange)', noFilter: true },
  'project.delete': { label: '删除工程', c: 'var(--crit)', noFilter: true },
  'project.addtask': { label: "工程添加需求", c: 'var(--c-blue)', noFilter: true },
  'llm.config': { label: '旧模型配置（已迁移）', c: 'var(--offline)', noFilter: true },
  'task.assign': { label: '收件箱分配', c: 'var(--c-blue)', noFilter: true },
  // Label retired actions in historical records instead of displaying raw slugs.
  'task.agent.takeover': { label: 'AI 接管（已下线）', c: 'var(--offline)', noFilter: true },
  'plugin.install': { label: '安装插件', c: 'var(--c-green)' },
  'plugin.upgrade': { label: '升级插件', c: 'var(--c-blue)' },
  'plugin.enable': { label: '启用插件', c: 'var(--c-green)' },
  'plugin.uninstall': { label: '卸载插件', c: 'var(--warn)' },
  'plugin.conversation_grant': { label: '对话授权连接器', c: 'var(--accent)' },
  'plugin.conversation_use': { label: '对话调用连接器', c: 'var(--accent)' },
  'team.message': { label: '团队消息', c: 'var(--c-blue)' },
}))
const actInfo = (a) => ACTIONS[a] || { label: String(a || tx("未知操作")).replaceAll('.', ' · '), c: 'var(--offline)' }
/* Filter common actions directly; retain uncommon and historical actions under All. */
const FILTERS = localeMap(() => ([['', '全部'], ...Object.entries(ACTIONS).filter(([, v]) => !v.noFilter).map(([k, v]) => [k, v.label])]))
const PAGE = 30
function fmtT(ms) {
  if (!ms) return ''
  const d = new Date(ms), p = (n) => (n < 10 ? '0' : '') + n
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}
export default function Audit() {
  const uiLocale = useLocale();
  const listRef = useViewportHeight()
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    api.audit({ limit: PAGE, offset: (page - 1) * PAGE, ...(action ? { action } : {}) })
      .then((d) => { if (alive) { setData(d); setLoading(false) } })
      .catch((err) => { if (alive) { setError(err); setLoading(false) } })
    return () => { alive = false }
  }, [action, page, refreshKey])

  const items = (data && data.items) || []
  const total = (data && data.total) || 0
  const pages = Math.max(1, Math.ceil(total / PAGE))

  return (
    <section className="admin-access-page admin-audit-page">
      <div className="statrow admin-access-summary">
        <div className="stat"><div className="sv">{loading || error ? '—' : total}</div><div className="sl"><span className="sd" style={{ background: 'var(--c-blue)' }} />{tx("符合条件记录")}</div></div>
        <div className="stat"><div className="sv">{loading || error ? '—' : items.length}</div><div className="sl"><span className="sd" style={{ background: 'var(--accent)' }} />{tx("本页记录")}</div></div>
        <div className="stat"><div className="sv">{loading || error ? '—' : `${page} / ${pages}`}</div><div className="sl"><span className="sd" style={{ background: 'var(--offline)' }} />{tx("当前页 / 总页数")}</div></div>
      </div>
      <div className="admin-filterbar">
        <div className="admin-audit-filter"><span className="admin-audit-filter-label">{tx("操作类型")}</span>
          <FilterSelect className="f-sel" aria-label={tx("审计操作类型")} value={action} onChange={(e) => { setAction(e.target.value); setPage(1) }}>
            {FILTERS.map(([key, label]) => <option key={key || 'all'} value={key}>{label}</option>)}
          </FilterSelect>
        </div>
        <div className="admin-filter-actions"><button className="btn btn-ghost" disabled={loading} onClick={() => { setPage(1); setRefreshKey((key) => key + 1) }}><Icon name="refresh" />{tx("刷新")}</button></div>
      </div>
      <p className="admin-access-note">{tx("可见范围遵循组织权限；非超级管理员仅可查看本部门及下级部门成员的操作。")}</p>
      <div className="tablewrap">
        <div ref={listRef} className="tscroll" tabIndex={0} role="region" aria-label={tx("审计记录")} aria-busy={loading}>
          <table className="admin-audit-table">
            <colgroup><col className="audit-col-time" /><col className="audit-col-actor" /><col className="audit-col-action" /><col className="audit-col-target" /><col /></colgroup>
            <thead><tr><th scope="col">{tx("操作时间")}</th><th scope="col">{tx("操作者")}</th><th scope="col">{tx("操作")}</th><th scope="col">{tx("操作对象")}</th><th scope="col">{tx("详情")}</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={5}><Loading /></td></tr>}
              {!loading && error && <tr><td colSpan={5}><ErrorState msg={error.message} onRetry={() => setRefreshKey((key) => key + 1)} /></td></tr>}
              {!loading && !error && items.length === 0 && <tr><td colSpan={5}><div className="empty">{action ? tx("没有符合当前操作类型的记录，可切换为「全部」查看。") : tx("暂无审计记录，需求下发、用户或权限变更等管理操作会记录在此。")}</div></td></tr>}
              {!loading && !error && items.map((a) => {
                const info = actInfo(a.action)
                return (
                  <tr key={a.id}>
                    <td className="admin-audit-time">{fmtT(a.at) || '—'}</td>
                    <td>{a.actorName || '—'}</td>
                    <td><span className="admin-audit-action"><i style={{ background: info.c }} />{info.label}</span></td>
                    <td>{a.targetLabel || '—'}</td>
                    <td className="admin-audit-detail">{detailText(a) || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      {!loading && !error && <ListPager page={page} pages={pages} total={total} onChange={setPage} label={tx("审计记录分页")} />}
    </section>
  )
}
