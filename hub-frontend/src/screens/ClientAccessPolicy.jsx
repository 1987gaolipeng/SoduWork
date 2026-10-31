import { translateText as tx, useLocale } from '../i18n.js'
import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Icon, toast, SelectMenu } from '../ui.jsx'
import './client-access-policy.css'

const EMPTY = {
  allowSelfRegistration: true,
  defaultOrgId: '',
  defaultRoleId: '',
}

function Switch({ checked, onChange, label }) {
  const uiLocale = useLocale();
  return <button type="button" role="switch" aria-checked={checked}
    className={'cap-switch ' + (checked ? 'on' : '')}
    onClick={() => onChange(!checked)}>
    <i /><span>{label}</span>
  </button>
}

export default function ClientAccessPolicy() {
  const uiLocale = useLocale();
  const [form, setForm] = useState(EMPTY)
  const [orgs, setOrgs] = useState([])
  const [roles, setRoles] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const [policy, orgList, roleList] = await Promise.all([
        api.clientAuthPolicy(),
        api.orgs().catch(() => []),
        api.roles().catch(() => []),
      ])
      setForm({ ...EMPTY, ...(policy || {}) })
      setOrgs(Array.isArray(orgList) ? orgList : [])
      setRoles(Array.isArray(roleList) ? roleList : [])
    } catch (e) {
      setError(e.message || tx("登录策略没有加载出来"))
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function save() {
    setSaving(true)
    try {
      const next = await api.saveClientAuthPolicy({
        allowSelfRegistration: !!form.allowSelfRegistration,
        defaultOrgId: form.defaultOrgId || '',
        defaultRoleId: form.defaultRoleId || '',
      })
      setForm({ ...EMPTY, ...(next || {}) })
      toast(tx("客户端登录策略已生效"))
    } catch (e) {
      toast(tx("保存失败：") + (e.message || tx("请稍后重试")))
    }
    setSaving(false)
  }

  return <section className="cap-panel" aria-label={tx("登录策略")}>
    <header className="cap-head">
      <div>
        <p>{tx("员工验证邮箱并注册后绑定终端，可信设备可自动续登。")}</p>
      </div>
    </header>

    {loading && <div className="cap-state"><span className="en-spinner" /><div><b>{tx("正在读取策略")}</b><span>{tx("正在读取注册与登录规则")}</span></div></div>}
    {error && !loading && <div className="cap-state bad"><Icon name="alert" /><div><b>{tx("策略没有加载出来")}</b><span>{error}</span></div>
      <button className="btn btn-ghost xs" onClick={load}>{tx("重试")}</button></div>}

    {!loading && !error && <>
      <div className="cap-summary cap-login-summary">
        <article><span className={'cap-dot ' + (form.allowSelfRegistration ? 'good' : 'quiet')} />
          <div><small>{tx("首次使用")}</small><b>{form.allowSelfRegistration ? tx("允许自助注册") : tx("仅已有账号")}</b></div></article>
        <article><span className="cap-dot good" />
          <div><small>{tx("登录保持")}</small><b>{tx("可信设备自动续登")}</b></div></article>
      </div>

      <div className="cap-grid cap-login-grid">
        <article className="cap-card">
          <div className="cap-card-title"><span><Icon name="user" /></span><div><h3>{tx("员工注册")}</h3>
            <p>{tx("使用邮箱验证码完成注册，并设置登录密码。")}</p></div></div>
          <Switch checked={form.allowSelfRegistration}
            onChange={(value) => setForm((old) => ({ ...old, allowSelfRegistration: value }))}
            label={form.allowSelfRegistration ? tx("允许自助注册") : tx("关闭自助注册")} />
          <div className="cap-fields">
            <label><span>{tx("新用户默认部门")}</span><SelectMenu value={form.defaultOrgId || ''}
              onChange={(e) => setForm((old) => ({ ...old, defaultOrgId: e.target.value }))}>
              <option value="">{tx("自动选择根部门")}</option>
              {orgs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </SelectMenu></label>
            <label><span>{tx("新用户默认角色")}</span><SelectMenu value={form.defaultRoleId || ''}
              onChange={(e) => setForm((old) => ({ ...old, defaultRoleId: e.target.value }))}>
              <option value="">{tx("暂不授予角色")}</option>
              {roles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </SelectMenu></label>
          </div>
          <div className="cap-note"><Icon name="shield" /><span>{tx("密码只用于本次身份验证，不会写入客户端。服务器仅保存密码哈希。")}</span></div>
        </article>

      </div>

      <footer className="cap-actions">
        <div><b>{tx("策略修改后立即生效")}</b><span>{tx("已登录设备的身份与聊天记录不受影响。")}</span></div>
        <button className="btn btn-primary" onClick={save} disabled={saving}><Icon name="check" />{saving ? tx("正在保存") : tx("保存策略")}</button>
      </footer>
    </>}
  </section>
}
