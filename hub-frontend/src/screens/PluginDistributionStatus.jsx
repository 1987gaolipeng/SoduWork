import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React from 'react'
import { Icon } from '../ui.jsx'
import { buildPluginDistributionState, INSTALLATION_LABEL } from './plugin-distribution-state.js'
import './plugin-distribution-status.css'

export function PluginDistributionStatus({ plugin, version, evaluationData, audienceData, lightweight = false }) {
  const uiLocale = useLocale();
  if (!plugin || !version) return null
  const { policy, approved, bindings, catalogOpen, taskOpen, next, audience } =
    buildPluginDistributionState({ plugin, version, evaluationData, audienceData, lightweight })

  return <section className="plugin-distribution-status">
    <header>
      <div><span className="eyebrow">{tx("访问策略")}</span><h3>{tx("开放范围")}</h3>
        <p>{tx("版本发布与实际使用分开控制；员工自助和自动化执行互不影响。")}</p></div>
      <em className={(catalogOpen || taskOpen) ? 'is-ready' : ''}>{next}</em>
    </header>
    <div className="plugin-release-channels">
      <article className={catalogOpen ? 'is-ready' : ''}>
        <span className="plugin-release-channel-icon"><Icon name="users" /></span>
        <div><small>{tx("员工自助使用")}</small><b>{catalogOpen
          ? INSTALLATION_LABEL[policy.installation] : approved ? tx("当前未开放个人安装") : tx("审核通过后才可开放")}</b>
          <p>{audience} · {policy.configured ? tx("目录策略已配置") : tx("使用默认目录策略")}</p></div>
        <i>{catalogOpen ? tx("已生效") : tx("未生效")}</i>
      </article>
      <article className={taskOpen ? 'is-ready' : ''}>
        <span className="plugin-release-channel-icon"><Icon name="sitemap" /></span>
        <div><small>{tx("需求与自动化")}</small><b>{taskOpen
          ? tx("{0} 个生效绑定", [bindings.length]) : approved ? tx("尚未建立生效绑定") : tx("审核通过后才可绑定")}</b>
          <p>{tx("按项目或组织绑定；每个节点可独立选择 Agent、模型和 Runner 条件")}</p></div>
        <i>{taskOpen ? tx("已生效") : tx("未生效")}</i>
      </article>
    </div>
  </section>
}
