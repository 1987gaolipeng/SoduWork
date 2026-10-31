import { getLocale, translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useId, useRef, useState } from 'react'
import { api } from '../api.js'
import { Icon, Modal, toast, SelectMenu } from '../ui.jsx'
import './model-runtime.css'

const FIELDS = localeMap(() => ([
  ['globalConcurrent', '全站同时运行', 1, 256],
  ['providerConcurrent', '每个服务同时运行', 1, 256],
  ['keyConcurrent', '每把密钥同时运行', 1, 256],
  ['modelConcurrent', '每个模型同时运行', 1, 256],
  ['userConcurrent', '每人同时运行', 1, 256],
  ['queueSize', '全站等待名额', 0, 256],
  ['userQueueSize', '每人等待名额', 0, 32],
  ['queueTimeout', '最长排队（秒）', 1, 120],
  ['requestTimeout', '最长生成（秒）', 30, 3600],
  ['readTimeout', '最长无输出（秒）', 5, 600],
  ['connectTimeout', '连接超时（秒）', 1, 60],
]))

export default function ModelRuntime({ providers, models, catalogActions, catalogSummary }) {
  const uiLocale = useLocale();
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState(null)
  const refreshRef = useRef(null)
  const [edit, setEdit] = useState(null)
  const [servicesOpen, setServicesOpen] = useState(false)
  const servicesId = useId()
  useEffect(() => {
    let live = true
    let pending = false
    const refresh = async () => {
      if (pending || document.hidden) return
      pending = true
      try { const next = await api.modelRuntime(); if (live) { setData(next); setUpdatedAt(Date.now()); setError('') } }
      catch (e) { if (live) setError(e.message || tx("运行状态读取失败")) }
      finally { pending = false }
    }
    refreshRef.current = refresh
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => { live = false; refreshRef.current = null; clearInterval(timer) }
  }, [])
  const metrics = data?.lastHour || {}
  const started = metrics.started || 0
  const loads = [
    { key: 'running', label: tx("正在生成"), value: data?.running, limit: data?.policy.globalConcurrent, limitLabel: tx("全站并发上限 {0}", [data?.policy.globalConcurrent ?? '—']) },
    { key: 'queued', label: tx("排队等待"), value: data?.queued, limit: data?.policy.queueSize, limitLabel: data?.policy.queueSize === 0 ? tx("未启用排队") : tx("全站排队上限 {0}", [data?.policy.queueSize ?? '—']) },
  ]
  const recent = [
    { key: 'wait', label: tx("平均排队等待"), value: data && started > 0 ? Math.round((metrics.waitMs || 0) / started) : null, unit: 'ms', note: !data ? (error ? tx("读取失败") : tx("读取中…")) : started > 0 ? tx("基于 {0} 次已开始请求", [started]) : tx("暂无已开始请求") },
    { key: 'timeout', label: tx("调用超时"), value: data ? metrics.timeout || 0 : null, unit: tx("次"), note: tx("连接、生成或输出等待超时"), issue: true },
    { key: 'queueTimeout', label: tx("排队超时"), value: data ? metrics.queueTimeout || 0 : null, unit: tx("次"), note: tx("等待超过排队时限"), issue: true },
    { key: 'rateLimited', label: tx("上游限流"), value: data ? metrics.rateLimited || 0 : null, unit: tx("次"), note: 'HTTP 429', issue: true },
  ]
  return <section className="model-runtime" aria-label={tx("模型运行情况")}>
    <div className="model-runtime-head"><div><h3>{tx("模型运行情况")}</h3>
      <p>{tx("查看目录配置，以及经 SoduWork 代理的实时请求与近一小时统计。")}</p></div>
      <div className="model-runtime-actions">{catalogActions}
        <button className="btn btn-ghost xs" disabled={!data || !!error} onClick={() => setEdit(data)}>
          <Icon name="settings" />{tx("并发与等待")}</button></div></div>
    {error && <div className="model-runtime-state" role="alert"><div><b>{data ? tx("刷新失败，以下显示上次成功读取的数据。") : tx("运行状态暂不可用")}</b><span>{error}</span></div><button className="btn btn-ghost xs" onClick={() => refreshRef.current?.()}>{tx("重试")}</button></div>}
    <div className={'model-runtime-metrics' + (catalogSummary ? ' with-catalog' : '')}>
      {catalogSummary}
      <section className="model-runtime-live model-runtime-dimension" aria-label={tx("实时负载")}>
        <header className="model-dimension-head"><Icon name="activity" /><h4>{tx("实时负载")}</h4><small>{tx("每 5 秒刷新")}</small></header>
        <div className="model-runtime-loads">
          {loads.map(item => <div key={item.key} className={'model-load-card' + (data && item.limit > 0 && item.value >= item.limit ? ' is-full' : '')}>
            <div className="model-load-value"><span>{item.label}</span><strong>{data ? item.value : '—'}</strong></div>
            <small>{item.limitLabel}</small>
            {data && item.limit > 0 ? <progress max={item.limit} value={Math.min(item.value, item.limit)} aria-label={item.label} /> : <div className="model-load-track" aria-hidden="true" />}
          </div>)}
        </div>
        <p className="model-dimension-note">{tx("服务、密钥、模型和用户的并发上限同时生效。")}</p>
        <small className="model-runtime-updated">{updatedAt ? tx("上次更新 {0}", [new Date(updatedAt).toLocaleTimeString(getLocale(), { hour12: false })]) : error ? tx("读取失败") : tx("正在读取运行状态…")}</small>
      </section>
      <section className="model-runtime-recent model-runtime-dimension" aria-label={tx("近一小时请求情况")}>
        <header className="model-dimension-head"><Icon name="chart" /><h4>{tx("近一小时请求情况")}</h4></header>
        <div className="model-runtime-history">
          {recent.map(item => <div key={item.key} className={'model-runtime-stat' + (item.issue && item.value > 0 ? ' has-issue' : '')}>
            <span>{item.label}</span><strong>{item.value == null ? '—' : item.value.toLocaleString(getLocale())}{item.value != null && <small>{item.unit}</small>}</strong><p>{item.note}</p>
          </div>)}
        </div>
      </section>
    </div>
    <div className="model-runtime-services">
      <button type="button" className="model-runtime-services-head" aria-expanded={servicesOpen}
        aria-controls={servicesId} onClick={() => setServicesOpen((open) => !open)}>
        <span className="model-runtime-services-title"><b>{tx("实时请求分布")}</b>
          <span className="model-runtime-services-count">{data ? tx("{0} 组", [data.groups?.length || 0]) : (error ? tx("读取失败") : tx("读取中…"))}</span></span>
        <span className="model-runtime-services-toggle">{servicesOpen ? tx("收起") : tx("展开")}<Icon name="chevron" aria-hidden="true" /></span>
      </button>
      <div id={servicesId} className="model-runtime-services-body" hidden={!servicesOpen}>
        {!data && !error && <p className="model-runtime-empty">{tx("正在读取运行状态…")}</p>}
        {!error && data?.groups?.length ? <div className="model-runtime-table" tabIndex={0} role="region" aria-label={tx("实时请求分布")}><table><thead><tr><th>{tx("服务 / 模型")}</th><th>{tx("生成中")}</th><th>{tx("等待中")}</th></tr></thead>
          <tbody>{data.groups.map(g => <tr key={`${g.provider}:${g.model}`}><td>{g.provider} / {g.model}</td>
            <td>{g.running}</td><td>{g.queued}</td></tr>)}</tbody></table></div>
          : null}
        {!error && data && !data.groups?.length && <p className="model-runtime-empty">{tx("当前没有正在生成或排队的请求")}</p>}
      </div>
    </div>
    {edit && <CapacityForm initial={edit} providers={providers} models={models}
      onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refreshRef.current?.() }} />}
  </section>
}

function CapacityForm({ initial, providers, models, onClose, onSaved }) {
  const uiLocale = useLocale();
  const [policy, setPolicy] = useState(() => structuredClone(initial.policy))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [provider, setProvider] = useState(providers[0]?.id || '')
  const [model, setModel] = useState(models[0]?.id || '')
  function override(group, name, value) {
    setPolicy(prev => {
      const entries = { ...prev[group] }
      if (value === '') delete entries[name]
      else entries[name] = Number(value)
      return { ...prev, [group]: entries }
    })
  }
  async function save() {
    setBusy(true); setError('')
    try {
      for (const [key, label, min, max] of FIELDS) {
        if (!Number.isInteger(policy[key]) || policy[key] < min || policy[key] > max) throw new Error(tx("{0}应为 {1}–{2} 的整数", [label, min, max]))
      }
      await api.saveModelRuntime({ policy, expectedRevision: initial.revision })
      toast(tx("已保存，新请求按新策略执行")); onSaved()
    } catch (e) { setError(e.message || tx("保存失败，当前输入已保留")) }
    finally { setBusy(false) }
  }
  return <Modal title={tx("并发与等待")} wide onClose={onClose} foot={<>
    <button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button>
    <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? tx("保存中…") : tx("保存")}</button></>}>
    <p className="muted">{tx("按模型服务实际额度设置。各项上限同时生效；已提交请求继续使用原策略。这里控制并发，不替代服务商的每分钟额度。")}</p>
    <div className="model-runtime-form">{FIELDS.map(([key, label, min, max]) => <label key={key} className="f-lbl">{label}
      <input className="f-in" type="number" min={min} max={max} step="1" value={policy[key]}
        onChange={e => setPolicy({ ...policy, [key]: Number(e.target.value) })} /></label>)}</div>
    <details><summary>{tx("为指定服务或模型设置不同上限")}</summary>
      <label className="f-lbl">{tx("服务")}<SelectMenu className="f-in" value={provider} onChange={e => setProvider(e.target.value)}>
        {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</SelectMenu></label>
      <input aria-label={tx("服务并发上限")} className="f-in" type="number" min="1" max="256" placeholder={tx("留空使用默认值")}
        disabled={!provider} value={policy.providers[provider] ?? ''} onChange={e => override('providers', provider, e.target.value)} />
      <label className="f-lbl">{tx("模型")}<SelectMenu className="f-in" value={model} onChange={e => setModel(e.target.value)}>
        {models.map(m => <option key={m.id} value={m.id}>{m.providerId} / {m.label || m.name}</option>)}</SelectMenu></label>
      <input aria-label={tx("模型并发上限")} className="f-in" type="number" min="1" max="256" placeholder={tx("留空使用默认值")}
        disabled={!model} value={policy.models[model] ?? ''} onChange={e => override('models', model, e.target.value)} />
    </details>
    {error && <p className="model-runtime-error" role="alert">{error}</p>}
  </Modal>
}
