import { translateText as tx, useLocale } from './i18n.js'
import React, { useEffect, useId, useState } from 'react'
import { api, setToken, setUser } from './api.js'

function Brand() { return <span className="public-brand"><img src="/soduwork.png" alt="" className="logo-box" /><b>SoduWork</b></span> }
export default function Login({ onLogin, onBack, initialError = '' }) {
  useLocale()
  const formId = useId()
  const [user, setAccount] = useState('')
  const [pass, setPass] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [err, setErr] = useState(initialError)
  const [busy, setBusy] = useState(false)
  const [providers, setProviders] = useState([])
  useEffect(() => {
    let active = true
    api.authProviders().then(r => { if (active) setProviders(r.items || []) }).catch(() => {})
    return () => { active = false }
  }, [])
  async function submit(event) {
    event.preventDefault()
    if (busy) return
    setErr(''); setBusy(true)
    try {
      const result = await api.login(user.trim(), pass)
      setToken(result.token); setUser(result.user); onLogin()
    } catch (error) {
      setErr(error?.status === 401 || error?.status === 403 || error?.message === tx('登录已失效，请重新登录') ? tx('账号或密码不正确') : (error?.message || tx('登录失败，请稍后重试')))
    } finally { setBusy(false) }
  }
  return <div className="public-login public-theme workbench-login">
    <header className="login-workbench-header">
      <Brand /><span className="login-platform-caption">{tx('企业智能工作台')}</span>
      {onBack && <button type="button" className="public-login-back" onClick={onBack}><span aria-hidden="true">←</span>{tx('返回 SoduWork 首页')}</button>}
    </header>
    <aside className="login-story">
      <div className="login-capability-orbit" role="img" aria-label={'SoduWork ' + tx('管理端能力')}>
        <svg className="login-orbit-mesh" viewBox="0 0 520 500" fill="none" aria-hidden="true">
          <defs><radialGradient id={`${formId}-mesh`}><stop stopColor="currentColor" stopOpacity=".08" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></radialGradient></defs>
          <ellipse cx="260" cy="250" rx="220" ry="210" fill={`url(#${formId}-mesh)`} />
          <g stroke="currentColor" strokeWidth=".8" opacity=".26">
            <ellipse cx="260" cy="250" rx="194" ry="184" /><ellipse cx="260" cy="250" rx="155" ry="184" transform="rotate(58 260 250)" />
            <ellipse cx="260" cy="250" rx="100" ry="184" transform="rotate(-54 260 250)" />
            <path d="M260 56 438 152 421 348 270 444 85 350 78 158Z M260 56 421 348 78 158 270 444 438 152 85 350Z M260 56 270 444 M78 158 421 348 M85 350 438 152" />
          </g>
          <g fill="currentColor" opacity=".46"><circle cx="260" cy="56" r="3" /><circle cx="438" cy="152" r="3" /><circle cx="421" cy="348" r="3" /><circle cx="270" cy="444" r="3" /><circle cx="85" cy="350" r="3" /><circle cx="78" cy="158" r="3" /></g>
        </svg>
        <div className="login-orbit-core"><h2>{tx('让团队的能力，')}<br />{tx('在这里汇合。')}</h2></div>
        <span className="login-orbit-label orbit-conversation">{tx('对话与成果')}</span>
        <span className="login-orbit-label orbit-team">{tx('需求协作')}</span>
        <span className="login-orbit-label orbit-automation">{tx('自动化')}</span>
        <span className="login-orbit-label orbit-plugins">{tx('插件与连接')}</span>
        <span className="login-orbit-label orbit-memory">{tx('个人与组织记忆')}</span>
        <span className="login-orbit-label orbit-permissions">{tx('权限与审批')}</span>
      </div>
      <p className="login-orbit-description">{tx('为人与 AI 建立共同的工作空间。从组织与能力配置，到运行与审计，让协作有方向，也有清晰的边界。')}</p>
    </aside>
    <main className="public-login-main">
      <form onSubmit={submit} className="login-card" aria-labelledby={`${formId}-title`} aria-busy={busy}>
        <div className="login-mobile-brand"><Brand /></div>
        <div className="login-head"><span className="public-eyebrow">{tx('SoduWork 管理端')}</span><h1 className="login-title" id={`${formId}-title`}>{tx('欢迎回来。')}</h1><p className="login-sub">{tx('登录你的账号，继续管理团队的工作空间。')}</p></div>
        {err && <div id={`${formId}-error`} className="login-error" role="alert">{err}</div>}
        {providers.length > 0 && <div className="login-sso">{providers.map(item => <button type="button" className="login-sso-button" key={item.key} disabled={busy} onClick={() => window.location.assign(item.startUrl)}><span className="login-sso-mark" aria-hidden="true">S</span><span>{tx('使用 {0} 登录', [item.name])}</span><b aria-hidden="true">→</b></button>)}<div className="login-divider"><span>{tx('或使用 SoduWork 账号')}</span></div></div>}
        <div className="login-field"><label className="f-lbl" htmlFor={`${formId}-account`}>{tx('账号')}</label><input id={`${formId}-account`} className="f-in" name="username" autoComplete="username" value={user} onChange={event => setAccount(event.target.value)} placeholder={tx('输入你的账号')} autoCapitalize="none" spellCheck={false} required autoFocus aria-describedby={err ? `${formId}-error` : undefined} /></div>
        <div className="login-field"><label className="f-lbl" htmlFor={`${formId}-password`}>{tx('密码')}</label><div className="login-password"><input id={`${formId}-password`} className="f-in" name="password" autoComplete="current-password" type={revealed ? 'text' : 'password'} value={pass} onChange={event => setPass(event.target.value)} placeholder={tx('输入你的密码')} required aria-describedby={err ? `${formId}-error` : undefined} /><button className="login-password-toggle" type="button" onClick={() => setRevealed(!revealed)} aria-label={revealed ? tx('隐藏密码') : tx('显示密码')} aria-pressed={revealed}>{revealed ? tx('隐藏') : tx('显示')}</button></div></div>
        <button type="submit" className="login-submit" disabled={busy}>{busy ? tx('正在登录…') : tx('进入控制台')}<span aria-hidden="true">→</span></button>
        <p className="login-help">{tx('需要账号或登录帮助？请联系你的企业管理员。')}</p>
      </form>
      <footer className="public-login-footer">{tx('权限由你的组织分配，工作在共同规则下展开。')}</footer>
    </main>
  </div>
}
