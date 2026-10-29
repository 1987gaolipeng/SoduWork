import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Loading, ErrorState, Icon, toast } from '../ui.jsx'

/*
 * Retain organization defaults for reports and compatibility execution without maintaining
 * a second model catalog.
 */
export default function LlmSettings({ embedded = false }) {
  const uiLocale = useLocale();
  const [d, setD] = useState(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = () => {
    setError(null)
    api.llmConfig().then((r) => {
      setD(r); setBaseUrl(r.baseUrl || ''); setModel(r.model || '')
    }).catch(setError)
  }
  useEffect(() => { load() }, [])

  async function save() {
    if (baseUrl && !/^https?:\/\//.test(baseUrl.trim())) { toast(tx("接口地址要以 http(s):// 开头")); return }
    setBusy(true)
    try {
      const r = await api.saveLlmConfig({
        expectedRevision: d.revision,
        baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey.trim(),
      })
      toast(r.keyChanged ? tx("已保存，密钥已更新") : tx("已保存（密钥未改动）"))
      setApiKey(''); load()
    } catch (e) { toast(tx("保存失败：") + (e.message || e)) }
    setBusy(false)
  }

  if (!d && error) return <ErrorState msg={error.message} onRetry={load} />
  if (!d) return <Loading />
  return (
    <>
      {!embedded && <div className="toolbar">
        <span className="hintline">{tx("组织默认调用供日报总结和仍在迁移的兼容执行入口使用；可用服务与模型统一由“模型目录”治理。")}</span>
      </div>}
      <div className="card" style={embedded ? { border: 0, boxShadow: 'none', padding: 0 } : { maxWidth: 640, padding: '20px 22px' }}>
        <div className="muted" style={{ marginBottom: 14, lineHeight: 1.7 }}>{tx("这是过渡期的")}<b style={{ color: 'var(--ink-2)' }}>{tx("组织默认调用")}</b>{tx("。日报总结和兼容执行入口暂时使用它；新需求与 Runner 的可用模型以模型目录为准。")}</div>
        <div><label className="f-lbl">{tx("接口地址（含 /v1）")}</label>
          <input className="f-in" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://ai-gateway.example.com/v1" /></div>
        <div style={{ marginTop: 12 }}><label className="f-lbl">{tx("模型名")}</label>
          <input className="f-in" value={model} onChange={(e) => setModel(e.target.value)} placeholder={tx("模型标识")} /></div>
        <div style={{ marginTop: 12 }}><label className="f-lbl">API Key（{d.keySet ? tx("已配置 · {0} 字符，留空保存则不改", [d.keyLen]) : tx("未配置")}）</label>
          <input className="f-in" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder={d.keySet ? tx("输入新密钥以轮换，留空则保持现有") : tx("粘贴 API Key")} autoComplete="new-password" /></div>
        <div className="muted" style={{ fontSize: 14.5, marginTop: 10, lineHeight: 1.7 }}>{tx("密钥仅保存在后台数据库并用于调用网关，任何接口都不会回显明文。若密钥曾在聊天/文档中暴露过，建议尽快在此轮换。")}</div>

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button className="btn btn-primary" disabled={busy} onClick={save}><Icon name="check" />{busy ? tx("保存中…") : tx("保存")}</button>
        </div>
      </div>
    </>
  )
}
