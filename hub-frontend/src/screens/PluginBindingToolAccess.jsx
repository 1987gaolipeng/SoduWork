import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Icon } from '../ui.jsx'
import './plugin-binding-tools.css'

const RISK = localeMap(() => ({
  low: ['只读', 'is-low'], medium: ['会改数据', 'is-medium'], high: ['高风险', 'is-high'],
}))

export function PluginBindingToolAccess({ versionId, servers = [], value = {}, onChange, onState, riskConfirmed = false, onRiskConfirmed }) {
  const uiLocale = useLocale();
  const key = servers.join('\u0000')
  const [catalog, setCatalog] = useState({ loading: false, error: '', servers: [] })
  useEffect(() => {
    let alive = true
    if (!versionId || !servers.length) {
      setCatalog({ loading: false, error: '', servers: [] })
      return () => { alive = false }
    }
    setCatalog((old) => ({ ...old, loading: true, error: '' }))
    api.pluginMcpTools(versionId).then((data) => {
      if (alive) setCatalog({ loading: false, error: '', servers: data.servers || [] })
    }).catch((error) => {
      if (alive) setCatalog({ loading: false, error: error.message || tx("工具目录加载失败"), servers: [] })
    })
    return () => { alive = false }
  }, [versionId, key])

  const state = useMemo(() => {
    if (!servers.length) return { ready: true, loading: false, error: '' }
    if (catalog.loading) return { ready: false, loading: true, error: '' }
    if (catalog.error) return { ready: false, loading: false, error: catalog.error }
    const byName = Object.fromEntries(catalog.servers.map((item) => [item.name, item]))
    const missing = servers.filter((name) => {
      const row = byName[name]
      const available = new Set((row && row.tools || []).map((tool) => tool.name))
      const chosen = value[name] || []
      return !row || !row.ok || !chosen.length || chosen.some((tool) => !available.has(tool))
    })
    const highRisk = catalog.servers.some((row) => (value[row.name] || []).some((name) => {
      const tool = (row.tools || []).find((item) => item.name === name)
      return tool && tool.riskLevel === 'high'
    }))
    return { ready: !missing.length && (!highRisk || riskConfirmed), loading: false, error: '', missing, highRisk }
  }, [catalog, key, JSON.stringify(value), riskConfirmed, uiLocale])
  useEffect(() => { if (onState) onState(state) }, [state.ready, state.loading, state.error, state.highRisk, (state.missing || []).join('\u0000')])

  if (!servers.length) return null
  const byName = Object.fromEntries(catalog.servers.map((item) => [item.name, item]))
  function choose(server, tool, checked) {
    const next = { ...value }
    const selected = new Set(next[server] || [])
    if (checked) selected.add(tool); else selected.delete(tool)
    if (selected.size) next[server] = [...selected].sort(); else delete next[server]
    onChange(next)
  }
  function chooseAll(server, tools) {
    const next = { ...value }
    const names = tools.map((tool) => tool.name)
    if (names.length && names.every((name) => (next[server] || []).includes(name))) delete next[server]
    else next[server] = names
    onChange(next)
  }
  return <section className="plugin-tool-access">
    <div className="route-section-head"><span><b>{tx("连接器工具权限")}</b><small>{tx("只勾选这个插件完成工作必需的工具；未勾选的调用会被 Hub 和 Runner 同时拒绝")}</small></span><i>{tx("最小权限")}</i></div>
    {catalog.loading && <div className="plugin-tool-state"><i className="is-loading" /><span>{tx("正在读取真实工具目录…")}</span></div>}
    {catalog.error && <div className="plugin-tool-state is-error"><Icon name="alert" /><span><b>{tx("工具目录没有加载成功")}</b><small>{catalog.error}</small></span></div>}
    {!catalog.loading && !catalog.error && <div className="plugin-tool-servers">{servers.map((name) => {
      const row = byName[name] || { name, ok: false, tools: [], error: tx("连接未返回工具目录") }
      const selected = new Set(value[name] || [])
      const all = row.tools.length > 0 && row.tools.every((tool) => selected.has(tool.name))
      return <article className={!row.ok ? 'is-error' : ''} key={name}>
        <header><span><Icon name="link" /><span><b>{name}</b><small>{row.ok ? tx("{0} / {1} 个已批准", [selected.size, row.tools.length]) : row.error}</small></span></span>{row.ok && row.tools.length > 0 && <button type="button" onClick={() => chooseAll(name, row.tools)}>{all ? tx("全部取消") : tx("全选这组")}</button>}</header>
        {row.ok && row.tools.length === 0 && <p>{tx("这个连接没有暴露任何工具，暂时不能启用插件。")}</p>}
        {row.ok && row.tools.length > 0 && <div className="plugin-tool-list">{row.tools.map((tool) => {
          const risk = RISK[tool.riskLevel] || RISK.medium
          return <label key={tool.name}><input type="checkbox" checked={selected.has(tool.name)} onChange={(event) => choose(name, tool.name, event.target.checked)} /><span><b>{tool.name}</b><small>{tool.description || tx("这个连接器没有提供工具说明")}</small></span><em className={risk[1]}>{risk[0]}</em></label>
        })}</div>}
      </article>
    })}</div>}
    {!catalog.loading && !catalog.error && state.highRisk && <label className="plugin-tool-confirm"><input type="checkbox" checked={riskConfirmed} onChange={(event) => onRiskConfirmed(event.target.checked)} /><span><b>{tx("确认允许高风险工具")}</b><small>{tx("这些工具可能发布、删除、审批或改变外部系统状态；运行记录会持续审计。")}</small></span></label>}
    {!catalog.loading && !catalog.error && !state.ready && <p className="plugin-tool-note">{state.highRisk && !riskConfirmed ? tx("确认高风险工具后才能保存。") : tx("每个连接至少批准一个具体工具，才能通过绑定体检。")}</p>}
  </section>
}
