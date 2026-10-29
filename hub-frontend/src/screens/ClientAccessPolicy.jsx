import { getLocale, translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Icon, toast, SelectMenu } from '../ui.jsx'
import './client-access-policy.css'

const EMPTY = {
  allowSelfRegistration: true,
  defaultOrgId: '',
  defaultRoleId: '',
  tokenLimitEnabled: false,
  monthlyTokenLimit: 0,
}

function Switch({ checked, onChange, label }) {
  const uiLocale = useLocale();
  return <button type="button" role="switch" aria-checked={checked}
    className={'cap-switch ' + (checked ? 'on' : '')}
    onClick={() => onChange(!checked)}>
    <i /><span>{label}</span>
  </button>
}

function numberLabel(value) {
  try { return new Intl.NumberFormat(getLocale()).format(Number(value) || 0) }
  catch (_e) { return String(Number(value) || 0) }
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

  const quotaHint = useMemo(() => {
    if (!form.tokenLimitEnabled) return tx("不限额")
    if (!Number(form.monthlyTokenLimit)) return tx("未设置有效上限")
    return numberLabel(form.monthlyTokenLimit) + tx(" Tokens / 人 / 自然月")
  }, [form.tokenLimitEnabled, form.monthlyTokenLimit, uiLocale])

  async function save() {
    if (form.tokenLimitEnabled && Number(form.monthlyTokenLimit) <= 0) {
      toast(tx("开启额度限制后，请填写大于 0 的月度 Token 上限"))
      return
    }
    setSaving(true)
    try {
      const next = await api.saveClientAuthPolicy({
        allowSelfRegistration: !!form.allowSelfRegistration,
        defaultOrgId: form.defaultOrgId || '',
        defaultRoleId: form.defaultRoleId || '',
        tokenLimitEnabled: !!form.tokenLimitEnabled,
        monthlyTokenLimit: Math.max(0, Math.floor(Number(form.monthlyTokenLimit) || 0)),
      })
      setForm({ ...EMPTY, ...(next || {}) })
      toast(tx("客户端登录与额度策略已生效"))
    } catch (e) {
      toast(tx("保存失败：") + (e.message || tx("请稍后重试")))
    }
    setSaving(false)
  }

  return <section className="cap-panel" aria-label={tx("登录与额度策略")}>
    <header className="cap-head">
      <div>
        <p>{tx("员工首次登录自动建号并绑定当前终端；以后由设备安全身份自动续登。")}</p>
      </div>
    </header>

    {loading && <div className="cap-state"><span className="en-spinner" /><div><b>{tx("正在读取策略")}</b><span>{tx("组织、角色和额度规则会一起加载")}</span></div></div>}
    {error && !loading && <div className="cap-state bad"><Icon name="alert" /><div><b>{tx("策略没有加载出来")}</b><span>{error}</span></div>
      <button className="btn btn-ghost xs" onClick={load}>{tx("重试")}</button></div>}

    {!loading && !error && <>
      <div className="cap-summary">
        <article><span className={'cap-dot ' + (form.allowSelfRegistration ? 'good' : 'quiet')} />
          <div><small>{tx("首次使用")}</small><b>{form.allowSelfRegistration ? tx("自动注册") : tx("仅已有账号")}</b></div></article>
        <article><span className="cap-dot good" />
          <div><small>{tx("登录保持")}</small><b>{tx("可信设备自动续登")}</b></div></article>
        <article><span className={'cap-dot ' + (form.tokenLimitEnabled ? 'warn' : 'quiet')} />
          <div><small>{tx("月度额度")}</small><b>{quotaHint}</b></div></article>
      </div>

      <div className="cap-grid">
        <article className="cap-card">
          <div className="cap-card-title"><span><Icon name="user" /></span><div><h3>{tx("员工注册")}</h3>
            <p>{tx("尽量少填信息：账号、密码，显示名可选。")}</p></div></div>
          <Switch checked={form.allowSelfRegistration}
            onChange={(value) => setForm((old) => ({ ...old, allowSelfRegistration: value }))}
            label={form.allowSelfRegistration ? tx("允许首次登录自动注册") : tx("关闭自助注册")} />
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

        <article className="cap-card">
          <div className="cap-card-title"><span><Icon name="activity" /></span><div><h3>{tx("AI Token 额度")}</h3>
            <p>{tx("按用户、按自然月统计；达到上限立即结束登录态。")}</p></div></div>
          <Switch checked={form.tokenLimitEnabled}
            onChange={(value) => setForm((old) => ({ ...old, tokenLimitEnabled: value }))}
            label={form.tokenLimitEnabled ? tx("已开启月度上限") : tx("暂不限额")} />
          <div className={'cap-limit ' + (!form.tokenLimitEnabled ? 'disabled' : '')}>
            <label><span>{tx("每人每月 Token 上限")}</span>
              <input type="number" min="1" step="1000" disabled={!form.tokenLimitEnabled}
                value={form.monthlyTokenLimit || ''}
                placeholder={tx("例如 10000000")}
                onChange={(e) => setForm((old) => ({ ...old, monthlyTokenLimit: e.target.value }))} />
            </label>
            <div><b>{form.tokenLimitEnabled && Number(form.monthlyTokenLimit) > 0
              ? numberLabel(form.monthlyTokenLimit) : '—'}</b><span>{tx("Tokens / 自然月")}</span></div>
          </div>
          <div className="cap-note"><Icon name="alert" /><span>{tx("额度用完后，客户端自动退出并提示联系管理员；下个自然月自动恢复。")}</span></div>
          <div className="cap-note"><Icon name="user" /><span>{tx("可在用户编辑中单独设置个人上限或不限额；未单独设置的用户继承本页规则。")}</span></div>
        </article>
      </div>

      <footer className="cap-actions">
        <div><b>{tx("策略修改后立即生效")}</b><span>{tx("不会要求在线员工重新输入密码；仅在额度耗尽或主动退出时结束会话。")}</span></div>
        <button className="btn btn-primary" onClick={save} disabled={saving}><Icon name="check" />{saving ? tx("正在保存") : tx("保存策略")}</button>
      </footer>
    </>}
  </section>
}
