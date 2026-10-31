import React, { useEffect, useId, useRef, useState } from 'react'
import { translateText as tx, useLocale } from '../i18n.js'
import { api } from '../api.js'
import { Icon, SelectMenu, toast } from '../ui.jsx'
import './plugin-access-policy.css'

function rule(value) {
  return { mode: value?.mode || 'inherit', userIds: value?.userIds || [], orgUnitIds: value?.orgUnitIds || [] }
}
function policy(value) { return { use: rule(value?.use), edit: rule(value?.edit) } }
function payload(value) {
  return Object.fromEntries(['use', 'edit'].map(key => [key, {
    mode: value[key].mode,
    userIds: value[key].mode === 'users' ? value[key].userIds : [],
    orgUnitIds: value[key].mode === 'org_units' ? value[key].orgUnitIds : [],
  }]))
}
function incomplete(value) {
  return ['use', 'edit'].some(key => (value[key].mode === 'users' && !value[key].userIds.length) ||
    (value[key].mode === 'org_units' && !value[key].orgUnitIds.length))
}

export default function PluginAccessPolicy({ pluginId, disabled = false }) {
  useLocale()
  const [current, setCurrent] = useState(null)
  const [draft, setDraft] = useState(null)
  const [candidates, setCandidates] = useState({ items: [], orgUnits: [] })
  const [error, setError] = useState('')
  const [candidateError, setCandidateError] = useState('')
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)
  const alive = useRef(false)
  useEffect(() => {
    alive.current = true
    let active = true
    setError(''); setCandidateError(''); setCurrent(null); setDraft(null)
    api.pluginAccessPolicy(pluginId).then(value => {
      if (active) { setCurrent(value); setDraft(policy(value)) }
    }).catch(reason => { if (active) setError(reason.message || tx('权限加载失败')) })
    api.pluginAccessCandidates(pluginId).then(value => {
      if (active) setCandidates(value)
    }).catch(reason => { if (active) setCandidateError(reason.message || tx('成员与团队加载失败')) })
    return () => { active = false; alive.current = false }
  }, [pluginId, reload])

  const dirty = draft && JSON.stringify(payload(draft)) !== JSON.stringify(payload(policy(current)))
  async function save() {
    if (!dirty || saving || disabled || incomplete(draft)) return
    setSaving(true); setError('')
    try {
      const next = await api.updatePluginAccessPolicy(pluginId, {
        ...payload(draft), expectedUpdatedAt: current.updatedAt || 0,
      })
      if (!alive.current) return
      setCurrent(next); setDraft(policy(next))
      toast(tx('插件权限已生效'))
    } catch (reason) {
      if (alive.current) setError(reason.message || tx('权限保存失败，修改内容已保留'))
    } finally { if (alive.current) setSaving(false) }
  }
  return <section className="plugin-access-policy" aria-label={tx('插件权限')} aria-busy={!draft || saving}>
    <header><span className="plugin-access-mark"><Icon name="shield" /></span>
      <div><h3>{tx('使用与编辑权限')}</h3><p>{tx('分别决定谁能使用插件，以及谁能编辑新版本或通过对话改进。')}</p></div>
      <span className="plugin-access-live"><i />{tx('保存即生效')}</span>
    </header>
    {!draft && !error && <p role="status">{tx('正在加载权限…')}</p>}
    {error && <div className="plugin-access-error" role="alert"><span>{error}</span>
      <button type="button" disabled={saving} onClick={() => setReload(value => value + 1)}>{tx('重新加载')}</button>
    </div>}
    {draft && <>
      <div className="plugin-access-rules">{['use', 'edit'].map(key => <AccessRule key={key} kind={key}
        value={draft[key]} candidates={candidates} error={candidateError} disabled={disabled || saving}
        onChange={next => setDraft(old => ({ ...old, [key]: next }))} />)}</div>
      <footer><p>{tx('权限覆盖已安装插件，后续操作按最新配置校验，无需重新登录。编辑产生新版本，仍需审核上架。管理员保留治理权限。')}</p>
        <div>{dirty && <button type="button" className="btn btn-ghost" disabled={saving || disabled}
          onClick={() => { setDraft(policy(current)); setError('') }}>{tx('撤销修改')}</button>}
          <button type="button" className="btn btn-primary" disabled={!dirty || saving || disabled || incomplete(draft)} onClick={save}>
            {saving ? tx('正在保存…') : dirty ? tx('保存权限') : tx('已保存')}
          </button></div>
      </footer>
    </>}
  </section>
}

function AccessRule({ kind, value, candidates, error, disabled, onChange }) {
  const id = useId()
  const [query, setQuery] = useState('')
  const people = value.mode === 'users'
  const targeted = people || value.mode === 'org_units'
  const key = people ? 'userIds' : 'orgUnitIds'
  const selected = value[key]
  const rows = (people ? candidates.items : candidates.orgUnits) || []
  const matches = rows.filter(item => `${item.name} ${item.username || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const hiddenIds = selected.filter(item => !rows.some(row => row.id === item))
  const title = kind === 'use' ? tx('使用权限') : tx('编辑改进权限')
  function toggle(item) {
    onChange({ ...value, [key]: selected.includes(item) ? selected.filter(current => current !== item) : [...selected, item] })
  }
  return <div className="plugin-access-rule" data-access-kind={kind}>
    <label id={id + '-label'} htmlFor={id + '-mode'}><Icon name={kind === 'use' ? 'send' : 'pencil'} />{title}</label>
    <SelectMenu id={id + '-mode'} aria-labelledby={id + '-label'} value={value.mode} disabled={disabled}
      onChange={event => { setQuery(''); onChange({ ...value, mode: event.target.value }) }}>
      <option value="inherit">{tx('沿用现有范围')}</option>
      <option value="organization">{tx('全公司成员')}</option>
      <option value="users">{tx('指定人员')}</option>
      <option value="org_units">{tx('指定团队 / 部门')}</option>
      <option value="none">{tx('禁止成员使用此权限')}</option>
    </SelectMenu>
    <p className="plugin-access-rule-help">{value.mode === 'inherit'
      ? kind === 'use' ? tx('沿用插件版本的发布范围。') : tx('仅原作者及插件管理员可以编辑改进。')
      : value.mode === 'organization' ? tx('对当前插件所属企业的所有成员开放。')
        : value.mode === 'none' ? tx('成员无法执行此操作，管理员仍可管理插件。')
          : people ? tx('只有所选成员获得这项权限。') : tx('所选团队及其下级部门成员获得这项权限。')}</p>
    {targeted && <div className="plugin-access-picker">
      <div className="plugin-access-picker-head"><input type="search" aria-label={people ? tx('搜索人员') : tx('搜索团队')}
        placeholder={people ? tx('搜索姓名或账号') : tx('搜索团队 / 部门')} value={query} disabled={disabled}
        onChange={event => setQuery(event.target.value)} /><span>{tx('已选 {0} 项', [selected.length])}</span></div>
      {error && <p className="plugin-access-error" role="alert">{error}</p>}
      <div className="plugin-access-options" role="group" aria-label={title}>
        {matches.map(item => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} disabled={disabled}
          onChange={() => toggle(item.id)} /><span><b>{item.name}</b>{item.username && <small>{item.username}</small>}</span></label>)}
        {hiddenIds.map(item => <label key={item} className="plugin-access-unavailable"><input type="checkbox" checked disabled={disabled}
          onChange={() => toggle(item)} /><span>{tx('已选成员或团队暂不可用')}<small>{item}</small></span></label>)}
        {!matches.length && !hiddenIds.length && !error && <p>{tx('没有匹配的人员或团队')}</p>}
      </div>
      {!selected.length && <p className="plugin-access-required">{people ? tx('至少选择一位成员后保存。') : tx('至少选择一个团队后保存。')}</p>}
    </div>}
  </div>
}
