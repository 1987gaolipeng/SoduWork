import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React from 'react'
import { Icon } from '../ui.jsx'
import './plugin-lifecycle.css'

const ACTIVE_RUNS = new Set(['running', 'dispatching', 'queued', 'waiting_external', 'waiting_human', 'rework'])

function stageState(done, blocked = false, active = false) {
  if (blocked) return 'blocked'
  if (active) return 'active'
  return done ? 'done' : 'pending'
}

export default function PluginLifecycleRail({ version, evaluationData, bindings = [], runs = [], lightweight = false, onNavigate }) {
  const uiLocale = useLocale();
  if (!version) return null
  const gate = (evaluationData && evaluationData.gate) || version.capabilities?.qualitySummary || {}
  const caseCount = Number(gate.caseCount || 0)
  const evaluationRuns = (evaluationData && evaluationData.items) || []
  const evaluationActive = evaluationRuns.some((item) => ACTIVE_RUNS.has(item.state))
  const evaluationReady = Boolean(gate.readyForApproval)
  const evaluationDone = caseCount > 0 && Boolean(gate.ok || evaluationReady)
  const evaluationBlocked = caseCount > 0 && !evaluationDone && !evaluationActive &&
    evaluationRuns.some((item) => item.verdict === 'failed' || item.state === 'failed')
  const approved = version.trustState === 'approved'
  const revoked = version.trustState === 'revoked'
  const published = approved && version.enabled
  const activeBindings = bindings.filter((item) => item.enabled && item.versionId === version.id)
  const liveRun = runs.some((item) => ACTIVE_RUNS.has(item.state))
  const hasEvidence = runs.some((item) => ['succeeded', 'failed', 'cancelled'].includes(item.state))
  const evaluationNote = gate.ok
    ? tx("{0} 项证据已确认", [caseCount])
    : evaluationReady
      ? tx("验证完成，待发布确认")
      : evaluationActive
        ? tx("正在自动验证")
        : evaluationBlocked
          ? tx("验证未通过")
          : caseCount
            ? tx("等待自动验证")
            : tx("未声明验证场景")
  const accessNote = !published
    ? tx("发布后按策略开放")
    : liveRun
      ? tx("已开放 · 正在运行")
      : hasEvidence
        ? tx("已开放 · 有运行记录")
        : activeBindings.length
          ? tx("已开放 · {0} 处需求绑定", [activeBindings.length])
          : tx("员工可按策略使用")

  const strictStages = [
    { key: 'package', label: tx("包校验"), note: tx("来源与静态预检完成"), state: 'done', icon: 'box', target: 'versions' },
    { key: 'evaluation', label: tx("自动验证"), note: evaluationNote, state: stageState(evaluationDone, evaluationBlocked, evaluationActive), icon: 'activity', target: 'versions' },
    { key: 'release', label: tx("发布确认"), note: published ? tx("v{0} 已发布", [version.version]) : revoked ? tx("版本已撤销") : evaluationDone ? tx("可以发布") : tx("验证后可发布"), state: stageState(published, revoked, evaluationDone && !approved), icon: 'shield', target: 'versions' },
    { key: 'access', label: tx("开放使用"), note: accessNote, state: stageState(published, revoked, liveRun), icon: 'send', target: activeBindings.length ? 'bindings' : 'versions' },
  ]
  const stages = lightweight ? [
    strictStages[0],
    { key: 'review', label: tx("管理员审核"), note: published ? tx("v{0} 已通过", [version.version])
      : revoked ? tx("版本已撤销") : tx("核对来源、用途与权限"),
      state: stageState(published, revoked, !published && !revoked), icon: 'shield', target: 'versions' },
    { ...strictStages[3], label: tx("上架使用") },
  ] : strictStages
  const complete = stages.filter((item) => item.state === 'done').length

  return <section className="plugin-lifecycle" aria-label={tx("插件发布生命周期")}>
    <header>
      <div><span className="eyebrow">{tx("发布流程")}</span><b>{tx("发布与开放")}</b><small>{lightweight ? tx("企业内插件只需静态预检和一次管理员审核") : tx("平台插件执行完整评测与发布治理")}</small></div>
      <em>{complete}/{stages.length}{tx(" 已就绪")}</em>
    </header>
    <div className="plugin-lifecycle-track">
      {stages.map((stage, index) => <React.Fragment key={stage.key}>
        {index > 0 && <i className="plugin-lifecycle-link" />}
        <button type="button" className={'state-' + stage.state} onClick={() => onNavigate?.(stage.target)}>
          <span><Icon name={stage.icon} /></span>
          <b>{stage.label}</b>
          <small>{stage.note}</small>
        </button>
      </React.Fragment>)}
    </div>
  </section>
}
