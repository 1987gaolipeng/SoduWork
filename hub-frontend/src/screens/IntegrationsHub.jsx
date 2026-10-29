import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useState } from 'react'
import { can } from '../api.js'
import Integrations from './Integrations.jsx'
import Bindings from './Bindings.jsx'
import RepoMap, { AutoBatch } from './RepoMap.jsx'
import AlertChannel from './AlertChannel.jsx'
import './integrations-layout.css'

/*
 * Group external integrations, ownership bindings, repository mappings, batching, and
 * alert channels. Govern model services and credentials exclusively in the model catalog.
 */
const TABS = localeMap(() => ([
  ['sources', '接入源', Integrations, 'integration.manage'],
  ['bindings', '负责人绑定 · 未分配', Bindings, 'binding.manage'],
  ['repomap', '工程映射', RepoMap, 'binding.manage'],
  ['autobatch', '批量归并', AutoBatch, 'task.dispatch'],
  ['alert', '告警通道', AlertChannel, 'integration.manage'],
]))

export default function IntegrationsHub(props) {
  const uiLocale = useLocale();
  const tabs = TABS.filter(([, , , perm]) => !perm || can(perm))
  const [tab, setTab] = useState(() => tabs[0]?.[0] || '')
  const active = tabs.some(([key]) => key === tab) ? tab : (tabs[0]?.[0] || '')
  const Comp = (tabs.find(([key]) => key === active) || tabs[0])?.[2]

  if (!Comp) return <div className="card"><div className="empty">{tx("当前角色没有可管理的系统集成能力。")}</div></div>
  return (
    <div className="integrations-hub">
      <div className="hubtabs">
        {tabs.map(([key, label]) => (
          <button key={key} className={'hubtab' + (active === key ? ' on' : '')}
            onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      <Comp {...props} />
    </div>
  )
}
