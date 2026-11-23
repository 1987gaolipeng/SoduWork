import { translateText as tx, useLocale } from '../i18n.js'
import React, { useEffect, useId, useState } from 'react'
import { api } from '../api.js'
import { ErrorState, toast } from '../ui.jsx'

const isPlainHttp = (url) => /^http:\/\//i.test(url.trim())

/*
 * Configure external webhook alerts for delivery failures and provide an immediate test
 * action for each destination.
 */
export default function AlertChannel() {
  useLocale()
  const fieldId = useId()
  const hintId = fieldId + '-hint'
  const warningId = fieldId + '-http-warning'
  const [configured, setConfigured] = useState(false)
  const [savedUsesPlainHttp, setSavedUsesPlainHttp] = useState(false)
  const [url, setUrl] = useState('')
  const usesPlainHttp = url.trim() ? isPlainHttp(url) : savedUsesPlainHttp
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(null)

  const load = () => {
    setLoaded(false); setError(null)
    api.alertConfig().then((config) => {
      setConfigured(config.configured ?? !!config.url)
      setSavedUsesPlainHttp(config.usesPlainHttp ?? isPlainHttp(config.url || ''))
      setUrl('')
      setLoaded(true)
    }).catch(setError)
  }
  useEffect(() => { load() }, [])

  async function save(nextUrl) {
    setBusy('save')
    try {
      const result = await api.saveAlertConfig(nextUrl)
      setConfigured(result.configured)
      setSavedUsesPlainHttp(isPlainHttp(nextUrl))
      setUrl('')
      toast(result.configured ? tx("告警通道已保存") : tx("已关闭外部告警（只在应用内提醒）"))
    }
    catch (e) { toast(tx("保存失败：") + e.message) }
    setBusy('')
  }
  async function test() {
    setBusy('test')
    try { const r = await api.testAlert(); toast(r.detail || (r.ok ? tx("发出去了") : tx("没发出去"))) }
    catch (e) { toast(tx("测不通：") + e.message) }
    setBusy('')
  }

  if (error && !loaded) return <ErrorState msg={error.message} onRetry={load} />

  return (
    <div className="card integration-alert-card">
      <div className="card-head"><h3>{tx("告警通道")}</h3>
        <span className="muted" style={{ fontSize: 14.5 }}>{tx("发布、上线核对、合并这几关失败时，除了应用内提醒，再往这个地址发一份")}</span></div>
      <div className="integration-alert-body">
        <label className="f-lbl" htmlFor={fieldId}>{tx("机器人地址")}</label>
        <span className="muted" id={hintId}>{configured
          ? tx("已配置机器人地址。输入新地址可替换，清除可关闭外部告警。")
          : tx("尚未配置机器人地址。")}</span>
        <div className="integration-alert-controls">
          <input id={fieldId} className="f-in mono" type="password" autoComplete="off" spellCheck={false}
            aria-describedby={usesPlainHttp ? hintId + ' ' + warningId : hintId}
            value={url} disabled={!loaded || !!busy}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…" />
        </div>
        {usesPlainHttp && <p id={warningId} role="status" className="integration-alert-warning">{tx('HTTP 会以明文发送告警内容，建议使用 HTTPS 地址。')}</p>}
        <p className="muted" style={{ fontSize: 14.5, lineHeight: 1.7, marginTop: 10 }}>{tx("「测一下」会")}<b>{tx("真发一条")}</b>{tx("测试消息到群里。地址本身不进审计日志，只记“配没配”。")}</p>
      </div>
      <div className="admin-card-actions integration-alert-actions">
        <button className="admin-card-action is-primary" disabled={!!busy || !loaded || !url.trim()} onClick={() => save(url.trim())}>{busy === 'save' ? tx("保存中…") : tx("保存")}</button>
        {configured && <button className="admin-card-action" disabled={!!busy || !loaded} onClick={() => save('')}>{tx("清除地址")}</button>}
        <button className="admin-card-action" disabled={!!busy || !loaded || !configured || !!url.trim()} onClick={test}>{busy === 'test' ? tx("测试中…") : tx("测一下")}</button>
      </div>
    </div>
  )
}
