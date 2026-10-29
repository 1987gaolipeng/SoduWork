import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, {useEffect, useState} from 'react'
import {api} from '../api.js'
import {toast} from '../ui.jsx'
import {McpForm} from './McpServers.jsx'

export default function McpSharing({onPublished}) {
  const uiLocale = useLocale();
  const [items,setItems]=useState([]), [selected,setSelected]=useState(null), [busy,setBusy]=useState(false), [error,setError]=useState('')
  async function load() {
    try { setItems((await api.mcpSubmissions()).items || []); setError('') }
    catch(e) { setError(e.message) }
  }
  useEffect(()=>{load()},[])
  async function review(action,server) {
    if(busy || !selected)return
    setBusy(true)
    try {
      await api.reviewMcpSubmission(selected.id,{action,server})
      setSelected(null); await load(); onPublished()
      toast(action==='publish'?tx("实测通过，连接已向公司客户端开放"):tx("已退回申请"))
    } catch(e) { toast(e.message) }
    finally {setBusy(false)}
  }
  const pending=items.filter(x=>x.status==='pending')
  return <section className="mcp-sharing">
    <div className="mcp-toolbar"><span className="mcp-toolbar-copy"><b>{tx("员工提交的连接 ")}<small>{pending.length}{tx(" 项待检查")}</small></b>
      <small>{tx("只接收连接配置，不接收个人密钥；补充公司凭据并实测后开放。")}</small></span>
      <button className="btn btn-ghost btn-sm" onClick={load}>{tx("刷新")}</button></div>
    {error?<p role="alert">{error}</p>:pending.length?pending.map(item=><div className="mcp-item" key={item.id}>
      <span className="mcp-i-main"><b>{item.name}</b><span className="mcp-i-desc">{tx("由 ")}{item.submittedBy}{tx(" 提交 · ")}{item.spec.type==='http'?tx("HTTP 服务"):tx("本机工具")}
      {item.requiredCredentials.length>0?tx(" · 需补充 ")+item.requiredCredentials.length+tx(" 项公司凭据"):''}</span></span>
      <button className="admin-text-action" data-mcp-review={item.id} onClick={()=>setSelected(item)}>{tx("检查并开放")}</button>
    </div>):<p className="mcp-sharing-empty">{tx("没有待检查的连接。员工可从客户端提交共享。")}</p>}
    {selected&&<McpForm initial={{...selected.spec,enabled:true}} busy={busy} onClose={()=>!busy&&setSelected(null)}
      onSave={server=>review('publish',server)} publishLabel={tx("实测并开放")}
      extraAction={<button className="btn btn-ghost" disabled={busy} onClick={()=>review('reject')}>{tx("退回申请")}</button>}/>}
  </section>
}
