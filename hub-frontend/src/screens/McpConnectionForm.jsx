import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useState, useEffect, useRef } from 'react'
import { api } from '../api.js'
import { Icon, Modal, toast } from '../ui.jsx'
import ConnectorIcon from '../components/ConnectorIcon.jsx'
import './McpConnectionForm.css'
import '../../../client/components/panels/connector-config.js'

const blank = () => ({ id: '', name: '', type: 'http', command: 'npx', args: [], env: {},
  url: '', headers: {}, keycloak: {}, description: '', enabled: true,
  startupTimeoutSeconds: 10, toolTimeoutSeconds: 60, enabledTools: [], disabledTools: [] })
const toPairs = value => Object.entries(value || {}).map(([key, val]) => key + '=' + val).join('\n')
const parsePairs = text => Object.fromEntries(text.split('\n').filter(line => line.trim()).map(line => {
  const i = line.indexOf('='); return [line.slice(0, i < 0 ? undefined : i).trim(), i < 0 ? '' : line.slice(i + 1).trim()]
}))
const names = text => [...new Set(text.split(/[\n,]/).map(x => x.trim()).filter(Boolean))]
const AUTH_FIELDS = localeMap(() => [
  ['tokenUrl', 'Token 地址'], ['clientId', 'Client ID'], ['clientSecret', 'Client Secret'],
  ['scope', 'Scope'], ['username', '用户名'], ['password', '密码'],
])

export function McpForm({ initial, template, onClose, onSave, busy, publishLabel, extraAction }) {
  useLocale()
  template = window.SoduWorkConnectorConfig.apiTemplate(initial) || template
  const [v, setV] = useState(() => ({ ...blank(), ...initial }))
  const [argsText, setArgsText] = useState((initial?.args || []).join('\n'))
  const [envText, setEnvText] = useState(toPairs(initial?.env))
  const [hdrText, setHdrText] = useState(toPairs(initial?.headers))
  const [allowed, setAllowed] = useState((initial?.enabledTools || []).join('\n'))
  const [denied, setDenied] = useState((initial?.disabledTools || []).join('\n'))
  const [probe, setProbe] = useState(null)
  const [testing, setTesting] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const guard = useRef({ id: 0, alive: true, pending: false, verified: '', result: null })
  const isHttp = v.type === 'http'
  const fields = template?.connectionFields || []
  const typed = !!template?.configurable && fields.length > 0
  const env = parsePairs(envText)
  const set = key => e => setV(old => ({ ...old, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const setKc = key => e => setV(old => ({ ...old, keycloak: { ...old.keycloak, [key]: e.target.value } }))
  const setEnv = (key, value) => setEnvText(toPairs({ ...env, [key]: value }))
  const spec = { ...v, name: v.name.trim(), args: argsText.split('\n').map(x => x.trim()).filter(Boolean),
    env, headers: isHttp ? parsePairs(hdrText) : {}, keycloak: isHttp ? v.keycloak : {},
    startupTimeoutSeconds: Number(v.startupTimeoutSeconds || 10), toolTimeoutSeconds: Number(v.toolTimeoutSeconds || 60),
    enabledTools: names(allowed), disabledTools: names(denied) }
  const fingerprint = JSON.stringify(spec)
  const current = useRef(fingerprint); current.current = fingerprint
  useEffect(() => {
    const g = guard.current; g.id++; g.pending = false; g.verified = ''; g.result = null
    setTesting(false); setProbe(null)
  }, [fingerprint])
  useEffect(() => { guard.current.alive = true; return () => { guard.current.alive = false; guard.current.id++ } }, [])
  const validate = () => {
    if (!spec.name) throw Error(tx('请填写连接名称'))
    if (isHttp ? !spec.url.trim() : !spec.command.trim()) throw Error(tx(isHttp ? '请填写连接地址' : '请填写启动命令'))
    const missing = fields.find(f => f.required && !String(env[f.key] || '').trim())
    if (missing) throw Error(tx('请填写') + missing.label)
    if (spec.enabledTools.some(x => spec.disabledTools.includes(x))) throw Error(tx('同一工具不能同时启用和禁用'))
    for (const [n, max] of [[spec.startupTimeoutSeconds, 120], [spec.toolTimeoutSeconds, 300]])
      if (!Number.isInteger(n) || n < 3 || n > max) throw Error(tx('请检查超时设置'))
  }
  async function run(mode = 'connect') {
    const g = guard.current
    if (g.pending || busy || connecting) return
    try { validate() } catch (e) { setProbe({ ok: false, error: e.message }); return }
    const id = ++g.id, snapshot = fingerprint
    const valid = () => g.alive && g.id === id && current.current === snapshot
    g.pending = true; setTesting(true); setConnecting(mode !== 'check')
    try {
      if (mode !== 'draft' && (mode === 'check' || g.verified !== snapshot)) {
        setProbe(null)
        const result = await api.probeMcpServer(spec)
        if (!valid()) return
        setProbe(result)
        if (!result?.ok) return
        g.verified = snapshot; g.result = result
      }
      if (mode !== 'check' && valid()) await onSave({ ...spec, enabled: mode !== 'draft' })
    } catch (e) { if (valid()) setProbe({ ok: false, error: e.message }) }
    finally { if (valid()) { g.pending = false; setTesting(false); setConnecting(false) } }
  }
  const field = f => f.type === 'boolean'
    ? <label key={f.key} className="chk-inline connector-write"><input type="checkbox" checked={env[f.key] === 'true'}
        onChange={e => setEnv(f.key, String(e.target.checked))} /><span>{f.label}<small>{tx('仅在需要创建、修改或发送内容时开启')}</small></span></label>
    : <label key={f.key} className="df-field"><span className="f-lbl">{f.label}{!f.required && <em>{tx('选填')}</em>}</span>
        <input className="f-in" type={f.secret ? 'password' : 'text'} autoComplete="off" value={env[f.key] || ''}
          onPaste={e => { const value = window.SoduWorkConnectorConfig.credentialPaste(f.key, e.clipboardData.getData('text/plain'));
            if (value !== null) { e.preventDefault(); setEnv(f.key, value) } }}
          onChange={e => setEnv(f.key, e.target.value)} placeholder={f.example || ''} /></label>
  return (
    <Modal className="connector-form-modal" title={tx(initial?.id ? '管理连接' : '添加连接器')} icon="plug" onClose={onClose}
      foot={<><button className="btn btn-ghost" onClick={onClose}>{tx('取消')}</button><span className="ml-auto" />{extraAction}
        <button className="btn btn-primary" disabled={busy || testing} onClick={() => run()}>
          {busy || connecting ? tx('正在连接…') : publishLabel || tx(initial?.id ? '保存并连接' : '连接')}</button></>}>
      <div className="connector-form">
        <div className="connector-form-intro"><ConnectorIcon value={template || v} /><div>
          <strong>{template?.name || tx('连接你的业务工具')}</strong>
          <p>{template?.description?.replace(/^.*?通用连接器[^：]*：/,'').split('。')[0] || tx('连接一次，在对话、插件和自动化中使用')}</p></div></div>
        <fieldset disabled={busy || connecting}>
          {!typed && <div className="df-grid">
            <label className="df-field"><span className="f-lbl">{tx('连接名称')}</span><input className="f-in" value={v.name} onChange={set('name')} autoFocus placeholder={tx('例如：团队知识库')} /></label>
            <label className="df-field"><span className="f-lbl">{tx('连接方式')}</span><select className="f-in" value={v.type} onChange={e => {
              setV(old => ({ ...old, type: e.target.value }))
            }}><option value="http">{tx('远程连接')}</option><option value="stdio">{tx('设备上的工具')}</option></select></label>
          </div>}
          {typed ? <div className="connector-fields">{fields.filter(f => f.required && f.type !== 'boolean').map(field)}</div>
            : isHttp ? <>
              <label className="df-field"><span className="f-lbl">{tx('连接地址')}</span><input className="f-in" value={v.url} onChange={e => {
                setV(old => ({ ...old, url: e.target.value, keycloak: {} })); setHdrText('')
              }} placeholder="https://example.com/mcp" /></label>
              <label className="df-field"><span className="f-lbl">{tx('鉴权头')} <em>{tx('选填，每行一项')}</em></span>
                <textarea className="f-in" rows={2} value={hdrText} onChange={e => setHdrText(e.target.value)} placeholder="Authorization=Bearer …" autoComplete="off" /></label>
            </> : <div className="df-grid"><label className="df-field"><span className="f-lbl">{tx('启动命令')}</span><input className="f-in" value={v.command} onChange={set('command')} placeholder="npx / uvx / node" /></label>
              <label className="df-field"><span className="f-lbl">{tx('参数，每行一个')}</span><textarea className="f-in" rows={2} value={argsText} onChange={e => setArgsText(e.target.value)} /></label></div>}
          {template?.officialDocs?.[0] && <a className="connector-form-help" href={template.officialDocs[0]} target="_blank" rel="noopener noreferrer">{tx('如何获取授权')} ↗</a>}
          <details className="connector-advanced"><summary>{tx('高级设置')}<Icon name="chevron" /></summary><div className="connector-advanced-body">
            {typed && <label className="df-field"><span className="f-lbl">{tx('连接名称')}</span><input className="f-in" value={v.name} onChange={set('name')} /></label>}
            <label className="df-field"><span className="f-lbl">{tx('说明')} <em>{tx('选填')}</em></span><input className="f-in" value={v.description} onChange={set('description')} /></label>
            {typed ? fields.filter(f => !f.required || f.type === 'boolean').map(field)
              : !isHttp && <label className="df-field"><span className="f-lbl">{tx('环境变量，每行一项')}</span><textarea className="f-in" rows={3} value={envText} onChange={e => setEnvText(e.target.value)} placeholder="API_TOKEN=…" autoComplete="off" /></label>}
            {isHttp && <details className="connector-auth"><summary>{tx('动态令牌')}</summary><div className="df-grid">
              {AUTH_FIELDS.map(([key,label]) =>
                <label key={key} className="df-field"><span className="f-lbl">{label}</span><input className="f-in" type={/Secret|password/.test(key) ? 'password' : 'text'} value={v.keycloak?.[key] || ''} onChange={setKc(key)} autoComplete="off" /></label>)}
            </div></details>}
            <div className="df-grid">
              <label className="df-field"><span className="f-lbl">{tx('启动超时（秒）')}</span><input className="f-in" type="number" min="3" max="120" value={v.startupTimeoutSeconds} onChange={set('startupTimeoutSeconds')} /></label>
              <label className="df-field"><span className="f-lbl">{tx('调用超时（秒）')}</span><input className="f-in" type="number" min="3" max="300" value={v.toolTimeoutSeconds} onChange={set('toolTimeoutSeconds')} /></label>
              <label className="df-field"><span className="f-lbl">{tx('允许的工具')}</span><textarea className="f-in" rows={2} value={allowed} onChange={e => setAllowed(e.target.value)} placeholder={tx('留空表示使用全部已授权工具')} /></label>
              <label className="df-field"><span className="f-lbl">{tx('禁用的工具')}</span><textarea className="f-in" rows={2} value={denied} onChange={e => setDenied(e.target.value)} placeholder={tx('每行一个工具名')} /></label>
            </div>
            <div className="connector-extra-actions"><button className="btn btn-ghost btn-sm" type="button" disabled={testing} onClick={() => run('check')}>{tx('仅检查连接')}</button>
              <button className="btn btn-ghost btn-sm" type="button" disabled={testing} onClick={() => run('draft')}>{tx('保存为停用配置')}</button></div>
          </div></details>
        </fieldset>
        {testing && !probe && <div className="connector-status" role="status">{tx('正在检查连接与执行设备…')}</div>}
        {probe && <div className={'connector-status ' + (probe.ok ? '' : 'bad')} role="status">
          <b>{tx(probe.ok ? (probe.authenticationTested === false || typed && probe.authenticationTested !== true ? '连接配置已就绪' : '连接可用') : '连接未完成')}</b>
          <span>{probe.ok ? tx(probe.authenticationTested === false || typed && probe.authenticationTested !== true ? '业务授权尚未验证，首次使用时会继续检查' : '可用于对话、插件和自动化') : probe.error || probe.message}</span>
        </div>}
        <p className="connector-consent">{tx('点击连接将检查并启用此连接；检查不会发送或修改业务内容。')}</p>
      </div>
    </Modal>
  )
}
