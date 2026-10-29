import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useId, useState } from 'react'
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
  const [edit, setEdit] = useState(null)
  const [servicesOpen, setServicesOpen] = useState(false)
  const servicesId = useId()
  useEffect(() => {
    let live = true
    let pending = false
    const refresh = async () => {
      if (pending || document.hidden) return
      pending = true
      try { const next = await api.modelRuntime(); if (live) { setData(next); setError('') } }
      catch (e) { if (live) setError(e.message || tx("运行状态读取失败")) }
      finally { pending = false }
    }
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => { live = false; clearInterval(timer) }
  }, [])
  const metrics = data?.lastHour || {}
  const values = [
    [tx("正在生成"), data ? `${data.running} / ${data.policy.globalConcurrent}` : '—'],
    [tx("排队等待"), data ? `${data.queued} / ${data.policy.queueSize}` : '—'],
    [tx("近一小时平均等待"), data ? `${Math.round((metrics.waitMs || 0) / Math.max(1, metrics.started || 0))} ms` : '—'],
    [tx("超时 / 上游限流"), data ? `${(metrics.timeout || 0) + (metrics.queueTimeout || 0)} / ${metrics.rateLimited || 0}` : '—'],
  ]
  return <section className="model-runtime" aria-label={tx("模型运行情况")}>
    <div className="model-runtime-head"><div><h3>{tx("模型运行情况")}</h3>
      <p>{tx("经 SoduWork 代理的请求共用容量；等待可取消，生成结束后释放名额。")}</p></div>
      <div className="model-runtime-actions">{catalogActions}
        <button className="btn btn-ghost xs" disabled={!data || !!error} onClick={() => setEdit(data)}>
          <Icon name="settings" />{tx("并发与等待")}</button></div></div>
    <div className={'model-runtime-metrics' + (catalogSummary ? ' with-catalog' : '')}>
      {catalogSummary}
      <div className="model-runtime-facts">
        {values.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
      </div>
    </div>
    <div className="model-runtime-services">
      <button type="button" className="model-runtime-services-head" aria-expanded={servicesOpen}
        aria-controls={servicesId} onClick={() => setServicesOpen((open) => !open)}>
        <span className="model-runtime-services-title"><b>{tx("服务与模型")}</b>
          <span className="model-runtime-services-count">{data ? tx("{0} 组", [data.groups?.length || 0]) : (error ? tx("读取失败") : tx("读取中…"))}</span></span>
        <span className="model-runtime-services-toggle">{servicesOpen ? tx("收起") : tx("展开")}<Icon name="chevron" aria-hidden="true" /></span>
      </button>
      {error && <div className="model-runtime-state" role="alert"><span>{error}</span><button className="btn btn-ghost xs" onClick={() => { setError(''); setData(null); api.modelRuntime().then(setData).catch(e => setError(e.message || tx("运行状态读取失败"))) }}>{tx("重试")}</button></div>}
      <div id={servicesId} className="model-runtime-services-body" hidden={!servicesOpen}>
        {!data && !error && <p className="model-runtime-empty">{tx("正在读取运行状态…")}</p>}
        {!error && data?.groups?.length ? <div className="model-runtime-table" tabIndex={0} role="region" aria-label={tx("服务与模型")}><table><thead><tr><th>{tx("服务 / 模型")}</th><th>{tx("生成中")}</th><th>{tx("等待中")}</th></tr></thead>
          <tbody>{data.groups.map(g => <tr key={`${g.provider}:${g.model}`}><td>{g.provider} / {g.model}</td>
            <td>{g.running}</td><td>{g.queued}</td></tr>)}</tbody></table></div>
          : null}
        {!error && data && !data.groups?.length && <p className="model-runtime-empty">{tx("暂无服务与模型运行记录")}</p>}
      </div>
    </div>
    {edit && <CapacityForm initial={edit} providers={providers} models={models}
      onClose={() => setEdit(null)} onSaved={() => { setEdit(null); api.modelRuntime().then(setData).catch(e => setError(e.message)) }} />}
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
