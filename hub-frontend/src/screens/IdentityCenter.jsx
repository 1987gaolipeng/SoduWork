import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useMemo, useState } from 'react'
import { api } from '../api.js'
import { Icon, Loading, Modal, Confirm, toast, useAsync, SelectMenu } from '../ui.jsx'
import { useViewportHeight } from '../viewport-height.js'
import './admin-access-pages.css'
import './identity-center.css'

const defaults = () => ({
  key: 'company-oidc', name: '企业统一登录', issuer: '', clientId: '', clientSecretEnv: '',
  redirectUri: `${window.location.origin}/api/v1/auth/oidc/company-oidc/callback`,
  scopes: ['openid', 'profile', 'email'], claimMapping: { username: 'preferred_username', displayName: 'name', email: 'email' },
  allowedDomains: [], jitEnabled: false, defaultOrgId: '', defaultRoleId: '', enabled: false,
})

export default function IdentityCenter() {
  const listRef = useViewportHeight(180)
  const uiLocale = useLocale();
  const query = useAsync(async () => {
    const [providers, orgs, roles] = await Promise.all([api.identityProviders(), api.orgs(), api.roles()])
    return { providers: providers.items || [], orgs: orgs || [], roles: roles || [] }
  }, [])
  const [editing, setEditing] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [busy, setBusy] = useState('')
  const data = query.data || { providers: [], orgs: [], roles: [] }
  const ready = data.providers.filter((x) => x.ready).length
  const enabled = data.providers.filter((x) => x.enabled).length

  if (query.error) return <div className="idp-empty"><div className="idp-empty-icon bad"><Icon name="alert" /></div>
    <h3>{tx("身份配置没有加载出来")}</h3><p>{query.error.message}</p><button className="btn btn-ghost" onClick={query.reload}>{tx("重新加载")}</button></div>

  async function probe(row) {
    setBusy(row.id)
    try {
      const out = await api.probeIdentityProvider(row.id)
      toast(out.ready ? tx("连接与安全参数都通过了") : tx("没有通过：") + out.probeMessage)
      query.reload()
    } catch (e) { toast(tx("测试失败：") + e.message) }
    setBusy('')
  }

  async function toggle(row) {
    setBusy(row.id)
    try {
      await api.updateIdentityProvider(row.id, { enabled: !row.enabled })
      toast(row.enabled ? tx("登录入口已停用") : tx("登录入口已启用"))
      query.reload()
    } catch (e) { toast(e.message) }
    setBusy('')
  }

  async function remove(row) {
    setBusy(row.id)
    try { await api.deleteIdentityProvider(row.id); setPendingDelete(null); toast(tx("已删除")); query.reload() }
    catch (e) { toast(e.message) }
    setBusy('')
  }

  return <section className="admin-access-page idp-page">
    <div className="statrow admin-access-summary">
      <div className="stat"><div className="sv">{query.loading ? '—' : data.providers.length}</div><div className="sl"><span className="sd" style={{ background: 'var(--c-blue)' }} />{tx("身份源总数")}</div></div>
      <div className="stat"><div className="sv">{query.loading ? '—' : ready}</div><div className="sl"><span className="sd" style={{ background: 'var(--ok)' }} />{tx("已通过测试")}</div></div>
      <div className="stat"><div className="sv">{query.loading ? '—' : enabled}</div><div className="sl"><span className="sd" style={{ background: 'var(--accent)' }} />{tx("已开放登录")}</div></div>
    </div>
    <div className="admin-filterbar">
      <p className="admin-access-note">{tx("保存并测试后才能启用，启用的身份源会显示在登录页。")}</p>
      <div className="admin-filter-actions"><button className="btn btn-primary" onClick={() => setEditing(defaults())}><Icon name="plus" />{tx("接入身份源")}</button></div>
    </div>

    <div ref={listRef} className="idp-list admin-viewport-list" role="region" tabIndex={0} aria-label={tx("企业身份源")} aria-busy={query.loading}>
      {query.loading && <Loading />}
      {!query.loading && data.providers.map((row) => <article className={'idp-row ' + (row.enabled ? 'enabled' : '')} key={row.id}>
        <div className="idp-logo"><span>{row.name.slice(0, 1).toUpperCase()}</span></div>
        <div className="idp-main"><div><h3 title={row.name}>{row.name}</h3><code title={row.key}>{row.key}</code>
          <span className={'idp-status ' + row.probeState}><i />{row.probeState === 'ready' ? tx("连接可信") : row.probeState === 'failed' ? tx("测试失败") : tx("等待测试")}</span>
          <span className={'idp-login-state' + (row.enabled ? ' enabled' : '')}>{row.enabled ? tx("登录已启用") : tx("登录未启用")}</span></div>
          <p>{row.issuer}</p><div className="idp-facts"><span>Client ID <b>{row.clientId}</b></span>
            <span>{tx("密钥 ")}<b>{!row.clientSecretEnv ? tx("公开客户端") : row.clientSecretAvailable ? tx("{0} 已就绪", [row.clientSecretEnv]) : tx("{0} 未设置", [row.clientSecretEnv])}</b></span>
            <span>{tx("开户 ")}<b>{row.jitEnabled ? tx("首次登录自动开户") : tx("仅已绑定账号")}</b></span></div>
          {row.probeMessage && <div className={'idp-message ' + row.probeState}><Icon name={row.ready ? 'check' : 'alert'} /><span>{row.probeMessage}</span></div>}
        </div>
        <div className="admin-card-actions idp-actions"><button className="admin-card-action" disabled={busy === row.id} onClick={() => probe(row)}>
          {busy === row.id ? tx("处理中…") : tx("测试连接")}</button>
          <button className="admin-card-action is-primary" onClick={() => setEditing(row)}>{tx("配置")}</button>
          <button className={'admin-card-action' + (row.enabled ? ' is-danger' : '')} disabled={!row.ready || busy === row.id}
            title={!row.ready ? tx("测试通过后才能启用") : ''} onClick={() => toggle(row)}>{row.enabled ? tx("停用") : tx("启用")}</button>
          <button className="admin-card-action is-danger idp-delete" disabled={busy === row.id} onClick={() => setPendingDelete(row)}>{tx("删除")}</button></div>
      </article>)}
      {!query.loading && !data.providers.length && <div className="idp-empty"><div className="idp-empty-icon"><Icon name="key" /></div>
        <h3>{tx("还没有企业登录入口")}</h3><p>{tx("可以继续使用本地账号。接入 OIDC 后，员工会在同一个登录页看到企业入口。")}</p>
        <button className="btn btn-primary" onClick={() => setEditing(defaults())}>{tx("接入第一个身份源")}</button></div>}
    </div>

    <p className="idp-protocol-note"><Icon name="shield" />{tx("支持 OIDC（Authorization Code + PKCE）；暂不支持 SAML。连接测试会检查发现地址、回调、密钥引用和签名能力。")}</p>
    {editing && <ProviderEditor value={editing} orgs={data.orgs} roles={data.roles}
      onClose={() => setEditing(null)} onDone={() => { setEditing(null); query.reload() }} />}
    {pendingDelete && <Confirm danger title={tx("删除")} confirmText={tx("删除")}
      text={tx("删除「{0}」？已有登录绑定时系统会拒绝删除。", [pendingDelete.name])}
      onClose={() => setPendingDelete(null)} onConfirm={() => remove(pendingDelete)} />}
  </section>
}

function ProviderEditor({ value, orgs, roles, onClose, onDone }) {
  const uiLocale = useLocale();
  const original = value.id ? value : null
  const [form, setForm] = useState({ ...defaults(), ...value,
    claimMapping: { ...defaults().claimMapping, ...(value.claimMapping || {}) } })
  const [busy, setBusy] = useState(false)
  const set = (key, val) => setForm((old) => ({ ...old, [key]: val }))
  const callbackHint = useMemo(() => `${window.location.origin}/api/v1/auth/oidc/${form.key || 'company-oidc'}/callback`, [form.key, uiLocale])

  async function submit() {
    setBusy(true)
    try {
      const body = { ...form, enabled: false,
        scopes: Array.isArray(form.scopes) ? form.scopes : String(form.scopes).split(/[\s,]+/).filter(Boolean),
        allowedDomains: Array.isArray(form.allowedDomains) ? form.allowedDomains : String(form.allowedDomains).split(/[\s,]+/).filter(Boolean) }
      const saved = original ? await api.updateIdentityProvider(original.id, body) : await api.createIdentityProvider(body)
      const checked = await api.probeIdentityProvider(saved.id)
      toast(checked.ready ? tx("已保存，连接测试通过；确认后即可启用") : tx("已保存，但测试没有通过：") + checked.probeMessage)
      onDone()
    } catch (e) { toast(tx("保存失败：") + e.message) }
    setBusy(false)
  }

  return <Modal title={original ? tx("配置企业身份源") : tx("接入企业身份源")} icon="key" wide onClose={onClose}
    foot={<><button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button><button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? tx("正在保存并测试…") : tx("保存并测试")}</button></>}>
    <div className="idp-form">
      <div className="idp-form-note"><Icon name="shield" /><p><b>{tx("这里不填写密钥明文。")}</b>{tx("机密客户端只填 Hub 上的环境变量名；SoduWork 测试时会验证变量是否存在。")}</p></div>
      <div className="idp-form-grid">
        <label><span>{tx("显示名称")}</span><input className="f-in" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={tx("公司统一登录")} /></label>
        <label><span>{tx("稳定标识")}</span><input className="f-in" value={form.key} disabled={!!original} onChange={(e) => set('key', e.target.value.toLowerCase())} placeholder="company-oidc" /></label>
        <label className="wide"><span>Issuer</span><input className="f-in" value={form.issuer} onChange={(e) => set('issuer', e.target.value)} placeholder="https://login.company.com/realms/staff" /></label>
        <label><span>Client ID</span><input className="f-in" value={form.clientId} onChange={(e) => set('clientId', e.target.value)} placeholder="soduwork-console" /></label>
        <label><span>{tx("Client Secret 环境变量 ")}<small>{tx("公开客户端可留空")}</small></span><input className="f-in" value={form.clientSecretEnv} onChange={(e) => set('clientSecretEnv', e.target.value)} placeholder="SODUWORK_OIDC_CLIENT_SECRET" /></label>
        <label className="wide"><span>{tx("回调地址")}</span><input className="f-in" value={form.redirectUri} onChange={(e) => set('redirectUri', e.target.value)} placeholder={callbackHint} /><small className="idp-field-help">{tx("身份平台中登记的地址必须与这里完全一致。建议：")}{callbackHint}</small></label>
        <label><span>{tx("允许的邮箱域 ")}<small>{tx("逗号分隔；空为不限制")}</small></span><input className="f-in" value={(form.allowedDomains || []).join ? form.allowedDomains.join(', ') : form.allowedDomains} onChange={(e) => set('allowedDomains', e.target.value)} placeholder="company.com" /></label>
        <label><span>Scopes</span><input className="f-in" value={(form.scopes || []).join ? form.scopes.join(' ') : form.scopes} onChange={(e) => set('scopes', e.target.value)} /></label>
      </div>
      <div className="idp-jit"><label><input type="checkbox" checked={form.jitEnabled} onChange={(e) => set('jitEnabled', e.target.checked)} /><span><b>{tx("首次登录自动开户")}</b><small>{tx("关闭时，只允许已经建立 subject 绑定的账号登录。")}</small></span></label>
        {form.jitEnabled && <div className="idp-jit-route"><label><span>{tx("默认部门")}</span><SelectMenu className="f-sel" value={form.defaultOrgId || ''} onChange={(e) => set('defaultOrgId', e.target.value)}><option value="">{tx("不分配")}</option>{orgs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</SelectMenu></label>
          <label><span>{tx("默认角色")}</span><SelectMenu className="f-sel" value={form.defaultRoleId || ''} onChange={(e) => set('defaultRoleId', e.target.value)}><option value="">{tx("无管理权限")}</option>{roles.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</SelectMenu></label></div>}
      </div>
      <details className="idp-claims"><summary>{tx("高级：身份声明映射")}</summary><div>
        {[['username', tx("用户名 claim")], ['displayName', tx("姓名 claim")], ['email', tx("邮箱 claim")]].map(([key, label]) => <label key={key}><span>{label}</span><input className="f-in" value={form.claimMapping[key] || ''} onChange={(e) => set('claimMapping', { ...form.claimMapping, [key]: e.target.value })} /></label>)}</div></details>
    </div>
  </Modal>
}
