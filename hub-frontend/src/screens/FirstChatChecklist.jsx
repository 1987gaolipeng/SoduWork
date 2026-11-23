import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { translateText as tx, useLocale } from '../i18n.js'
import { navTo, useAsync } from '../ui.jsx'

const refreshPolicy = { interval: 30000, pauseWhenHidden: true }

export default function FirstChatChecklist({ accountId }) {
  useLocale()
  const key = 'soduwork-first-chat-hidden:' + accountId
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(key) === '1' } catch { return false }
  })
  const toggle = useRef(null)
  const restoreFocus = useRef(false)
  useEffect(() => {
    if (restoreFocus.current) { toggle.current?.focus(); restoreFocus.current = false }
  }, [hidden])
  function hide(value) {
    restoreFocus.current = true
    setHidden(value)
    try {
      if (value) localStorage.setItem(key, '1')
      else localStorage.removeItem(key)
    } catch { /* Keep the preference for this visit when storage is unavailable. */ }
  }
  if (hidden) return <button ref={toggle} className="btn first-chat-reopen" type="button" onClick={() => hide(false)}>{tx('查看首次对话清单')}</button>
  return <Steps accountId={accountId} onSkip={() => hide(true)} toggleRef={toggle} />
}

function Steps({ accountId, onSkip, toggleRef }) {
  useLocale()
  const readiness = useAsync(api.firstChatReadiness, refreshPolicy)
  const catalog = useAsync(api.modelCatalog, refreshPolicy)
  const [selection, setSelection] = useState('')
  const providers = (catalog.data?.providers || []).filter(p => p.enabled && p.baseUrl && p.keySet)
    .sort((a, b) => Number(!!a.builtin) - Number(!!b.builtin) || (a.name || a.id).localeCompare(b.name || b.id))
  const provider = providers.find(p => p.id === selection) || providers[0]
  const state = readiness.error ? null : readiness.data
  const states = [state?.providerReady, state?.chatModelReady, state?.runtimeReady, state?.modelReady]
  const done = states.filter(value => value === true).length
  const next = states.findIndex(value => value !== true)
  const go = (action, providerId) => navTo('models', { firstChat: action, providerId, accountId })
  const refresh = () => { readiness.reload(); catalog.reload() }
  const addService = <button className="btn" type="button" onClick={() => go('provider')}>{tx('连接模型服务')}</button>
  const modelActions = catalog.loading ? tx('正在读取模型服务…') : catalog.error
    ? <span role="alert">{tx('无法读取模型服务。')}</span>
    : provider ? <>
      <label>{tx('模型服务')}
        <select value={provider.id} onChange={e => setSelection(e.target.value)}>
          {providers.map(p => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
        </select>
      </label>
      <button className="btn" type="button" onClick={() => go('model', provider.id)}>{tx('添加对话模型')}</button>
      <button className="btn btn-ghost" type="button" onClick={() => go('discover', provider.id)}>{tx('发现模型')}</button>
    </> : <>{tx('请先连接可用的组织模型服务。')}{addService}</>
  const steps = [
    [tx('连接模型服务'), addService],
    [tx('添加对话模型'), modelActions],
    [tx('选择执行底座'), <a className="btn" href="soduwork://first-chat/runtime">{tx('打开桌面端底座设置')}</a>],
    [tx('选择对话模型'), <a className="btn" href="soduwork://first-chat/model">{tx('打开桌面端模型设置')}</a>],
  ]
  return <section className="card first-chat-setup" aria-labelledby="first-chat-title">
    <header>
      <h2 id="first-chat-title">{tx('首次对话清单')}</h2>
      <div><button className="btn btn-ghost" type="button" onClick={refresh}>{tx('重新检测')}</button>
        <button ref={toggleRef} className="btn btn-ghost" type="button" onClick={onSkip}>{tx('跳过清单')}</button></div>
    </header>
    {state ? <div className="first-chat-progress" role="status">
      <progress max={4} value={done} aria-label={tx('首次对话设置进度')} />
      <span>{tx('已完成 {0}/4 步', [done])}</span>
    </div> : <p role={readiness.error ? 'alert' : 'status'}>{readiness.error ? tx('无法读取设置进度，请重新检测。') : tx('正在检测设置进度…')}</p>}
    <ol>{steps.map(([title, action], i) => {
      const ready = states[i]
      const status = ready === true ? tx('已就绪') : ready === false ? tx('待设置')
        : state && i >= 2 ? tx('等待本账号桌面端报告') : tx('尚未检测')
      return <li key={i} aria-current={state && i === next ? 'step' : undefined}>
        <div><strong>{title}</strong><small>{state && i === next ? tx('下一步') + ' · ' : ''}{status}</small></div>
        <div className="first-chat-actions">{action}</div>
      </li>
    })}</ol>
  </section>
}
