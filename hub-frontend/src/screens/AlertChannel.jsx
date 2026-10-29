import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { ErrorState, toast } from '../ui.jsx'

/*
 * Configure external webhook alerts for delivery failures and provide an immediate test
 * action for each destination.
 */
export default function AlertChannel() {
  const uiLocale = useLocale();
  const [url, setUrl] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(null)

  const load = () => {
    setLoaded(false); setError(null)
    api.alertConfig().then((x) => { setUrl(x.url || ''); setLoaded(true) }).catch(setError)
  }
  useEffect(() => { load() }, [])

  async function save() {
    setBusy('save')
    try { await api.saveAlertConfig(url.trim()); toast(url.trim() ? tx("告警通道已保存") : tx("已关闭外部告警（只在应用内提醒）")) }
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
        <label className="f-lbl">{tx("机器人地址")}<small>{tx("企业微信 / 钉钉 / 飞书的群机器人 Webhook 都行；留空＝不往外发")}</small></label>
        <div className="integration-alert-controls">
          <input className="f-in mono" value={url} disabled={!loaded}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" />
        </div>
        <p className="muted" style={{ fontSize: 14.5, lineHeight: 1.7, marginTop: 10 }}>{tx("「测一下」会")}<b>{tx("真发一条")}</b>{tx("测试消息到群里。地址本身不进审计日志，只记“配没配”。")}</p>
      </div>
      <div className="admin-card-actions integration-alert-actions">
        <button className="admin-card-action is-primary" disabled={busy === 'save' || !loaded} onClick={save}>{busy === 'save' ? tx("保存中…") : tx("保存")}</button>
        <button className="admin-card-action" disabled={busy === 'test'} onClick={test}>{busy === 'test' ? tx("测试中…") : tx("测一下")}</button>
      </div>
    </div>
  )
}
