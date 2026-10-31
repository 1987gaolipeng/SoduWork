import { getLocale, translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useState, useEffect, useId } from 'react'
import { orgOptions } from '../org-options.js'
import { api } from '../api.js'
import { FilterInput, FilterSelect } from '../FilterControls.jsx'
import { useViewportHeight } from '../viewport-height.js'
import { useAsync, Loading, Icon, Modal, Confirm, toast, SelectMenu } from '../ui.jsx'
import './admin-access-pages.css'

const AVA = ['#245cb9', '#087052', '#855209', '#b02c43', '#6246a8']
function avaColor(s) { let h = 0; for (const c of (s || '?')) h = (h * 31 + c.charCodeAt(0)) % 997; return AVA[h % AVA.length] }

export default function Users() {
  const uiLocale = useLocale();
  const listRef = useViewportHeight()
  const users = useAsync(() => api.users())
  const orgs = useAsync(() => api.orgs())
  const roles = useAsync(() => api.roles())
  const [edit, setEdit] = useState(null)
  const [q, setQ] = useState('')
  const [dept, setDept] = useState('')
  if (users.loading || orgs.loading || roles.loading) return <Loading />
  const ul = users.data || [], ol = orgs.data || [], rl = roles.data || []
  const orgName = (id) => { const o = ol.find((x) => x.id === id); return o ? o.name : '—' }
  const roleName = (id) => { const r = rl.find((x) => x.id === id); return r ? r.name : '—' }

  const filtered = ul.filter((u) => {
    const kw = q.trim().toLowerCase()
    const hit = !kw || (u.displayName || '').toLowerCase().includes(kw) || (u.username || '').toLowerCase().includes(kw)
    return hit && (!dept || u.orgId === dept)
  })
  const active = ul.filter((u) => u.isActive).length

  return (
    <section className="admin-access-page">
      <div className="statrow admin-access-summary">
        <div className="stat"><div className="sv">{ul.length}</div><div className="sl"><span className="sd" style={{ background: 'var(--c-blue)' }} />{tx("用户总数")}</div></div>
        <div className="stat"><div className="sv">{active}</div><div className="sl"><span className="sd" style={{ background: 'var(--c-green)' }} />{tx("启用中")}</div></div>
        <div className="stat"><div className="sv">{ul.length - active}</div><div className="sl"><span className="sd" style={{ background: 'var(--offline)' }} />{tx("已停用")}</div></div>
      </div>
      <div className="admin-filterbar">
        <FilterInput aria-label={tx("搜索姓名或账号")} value={q} onChange={(e) => setQ(e.target.value)} placeholder={tx("搜索姓名 / 账号")} />
        <div className="admin-filter-options">
          <FilterSelect className="f-sel" aria-label={tx("所属部门")} value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">{tx("全部部门")}</option>
            {orgOptions(ol).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </FilterSelect>
          <button className="btn btn-ghost" onClick={() => { users.reload(); orgs.reload(); roles.reload() }}><Icon name="refresh" />{tx("刷新")}</button>
          <button className="btn btn-primary" onClick={() => setEdit({ user: null })}><Icon name="plus" />{tx("新建用户")}</button>
        </div>
      </div>
      <div className="tablewrap"><div ref={listRef} className="tscroll" tabIndex={0} role="region" aria-label={tx("用户列表")}><table>
        <thead><tr><th scope="col">{tx("用户")}</th><th scope="col">{tx("账号")}</th><th scope="col">{tx("部门")}</th><th scope="col">{tx("角色")}</th><th scope="col">{tx("状态")}</th><th scope="col">{tx("最后登录")}</th><th scope="col" className="admin-access-actions-col">{tx("操作")}</th></tr></thead>
        <tbody>
          {filtered.length === 0 && <tr><td colSpan={7}><div className="empty">{ul.length ? tx("没有匹配的用户") : tx("还没有用户")}</div></td></tr>}
          {filtered.map((u) => {
            const nm = u.displayName || u.username
            return (
              <tr key={u.id}>
                <td><span className="cli"><span className="ava" style={{ background: avaColor(nm) }}>{nm.slice(0, 1)}</span><span className="nm">{nm}{u.isSuper && <span className="chip src-ext" style={{ marginLeft: 6, fontSize: 14.5 }}>{tx("超级")}</span>}</span></span></td>
                <td className="mono">{u.username}</td>
                <td>{orgName(u.orgId)}</td>
                <td>{u.isSuper ? <span className="chip src-ext">{tx("全部权限")}</span> : roleName(u.roleId)}</td>
                <td><span className={'status-dot ' + (u.isActive ? 'on' : 'off')}><i />{u.isActive ? tx("启用") : tx("停用")}</span></td>
                <td className="muted nowrap">{u.lastLogin ? new Date(u.lastLogin).toLocaleString(getLocale()) : '—'}</td>
                <td><div className="admin-row-actions"><button className="admin-text-action" onClick={() => setEdit({ user: u })}>{tx("编辑")}</button></div></td>
              </tr>
            )
          })}
        </tbody>
      </table></div></div>
      {edit && <UserEditor user={edit.user} orgs={ol} roles={rl} onClose={() => setEdit(null)} onDone={() => { setEdit(null); users.reload() }} />}
    </section>
  )
}

function UserEditor({ user, orgs, roles, onClose, onDone }) {
  const uiLocale = useLocale();
  const formId = useId()
  const isNew = !user
  const [username, setUsername] = useState(user ? user.username : '')
  const [displayName, setDisplayName] = useState(user ? user.displayName : '')
  const [password, setPassword] = useState('')
  const [orgId, setOrgId] = useState(user ? user.orgId || '' : '')
  const [roleId, setRoleId] = useState(user ? user.roleId || '' : '')
  const [isActive, setIsActive] = useState(user ? user.isActive : true)
  const [posSel, setPosSel] = useState(user ? (user.positions || []) : [])
  const [posCat, setPosCat] = useState([])
  const [domSel, setDomSel] = useState(user ? (user.domains || []) : [])
  const [domCat, setDomCat] = useState([])
  const [mgrOpen, setMgrOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const opts = orgOptions(orgs)
  const nm = displayName || username || '?'
  const loadDomains = () => api.domains().then((d) => setDomCat(d || [])).catch(() => setDomCat([]))
  useEffect(() => {
    api.positions().then((p) => setPosCat(p || [])).catch(() => setPosCat([]))
    loadDomains()
  }, [])
  const togglePos = (id) => setPosSel((a) => a.includes(id) ? a.filter((x) => x !== id) : [...a, id])
  const toggleDom = (id) => setDomSel((a) => a.includes(id) ? a.filter((x) => x !== id) : [...a, id])

  async function save() {
    if (isNew && (!username.trim() || !password)) { toast(tx("请填账号与初始密码")); return }
    if (!orgId) { toast(tx("请选择所属部门")); return }
    setBusy(true)
    try {
      if (isNew) await api.createUser({ username: username.trim(), password, displayName: displayName.trim(), orgId, roleId: roleId || null, positions: posSel, domains: domSel })
      else {
        const body = { displayName: displayName.trim(), orgId, roleId: roleId || null, isActive, positions: posSel, domains: domSel }
        if (password) body.password = password
        await api.updateUser(user.id, body)
      }
      toast(tx("已保存")); onDone()
    } catch (e) { toast(tx("保存失败：") + e.message) }
    setBusy(false)
  }

  return (
    <Modal title={isNew ? tx("新建用户") : tx("编辑用户")} icon="users" onClose={onClose}
      foot={<>
        <button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? tx("保存中…") : tx("保存")}</button>
      </>}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 2 }}>
        {isNew
          ? <span className="ava ava-placeholder" aria-hidden="true"><Icon name="users" style={{ width: 22, height: 22 }} /></span>
          : <span className="ava" style={{ width: 46, height: 46, borderRadius: '50%', fontSize: 19, background: 'linear-gradient(135deg, var(--c-blue), var(--c-green))' }}>{nm.slice(0, 1)}</span>}
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{isNew ? tx("新用户") : nm}</div>
          {!isNew && <div className="muted" style={{ fontSize: 14.5 }}>{user && user.isSuper && nm !== tx("超级管理员") ? tx("超级管理员") : '@' + username}</div>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1 }}><label className="f-lbl" htmlFor={`${formId}-username`}>{tx("账号")}</label><input id={`${formId}-username`} className="f-in" value={username} disabled={!isNew} required={isNew} onChange={(e) => setUsername(e.target.value)} placeholder={tx("登录账号")} /></div>
        <div style={{ flex: 1 }}><label className="f-lbl" htmlFor={`${formId}-name`}>{tx("姓名")}</label><input id={`${formId}-name`} className="f-in" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={tx("显示名")} /></div>
      </div>
      <div><label className="f-lbl" htmlFor={`${formId}-password`}>{isNew ? tx("初始密码") : tx("重置密码（留空不改）")}</label><input id={`${formId}-password`} className="f-in" type="password" value={password} required={isNew} onChange={(e) => setPassword(e.target.value)} placeholder={isNew ? tx("设置初始密码") : tx("不改则留空")} /></div>
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1 }}><label className="f-lbl" id={`${formId}-org-label`} htmlFor={`${formId}-org`}>{tx("所属部门")}</label>
          <SelectMenu searchable id={`${formId}-org`} aria-labelledby={`${formId}-org-label`} required className="f-in" value={orgId} onChange={(e) => setOrgId(e.target.value)}><option value="">{tx("— 选择部门 —")}</option>{opts.map((o) => <option key={o.id} value={o.id} data-path={o.path}>{o.label}</option>)}</SelectMenu>
        </div>
        <div style={{ flex: 1 }}><label className="f-lbl" id={`${formId}-role-label`} htmlFor={`${formId}-role`}>{tx("角色（权限）")}</label>
          <SelectMenu id={`${formId}-role`} aria-labelledby={`${formId}-role-label`} className="f-in" value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={user && user.isSuper}><option value="">{tx("— 无角色 —")}</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</SelectMenu>
        </div>
      </div>
      <div><div className="f-lbl" id={`${formId}-positions-label`}>{tx("职业画像（可多选，用于理解需求与推荐工作场景，不授予系统权限）")}</div>
        <div className="posgrid" role="group" aria-labelledby={`${formId}-positions-label`}>
          {posCat.length === 0 && <span className="muted" style={{ fontSize: 14.5 }}>{tx("暂无职业画像")}</span>}
          {posCat.map((p) => (
            <button type="button" key={p.id} className={'poschip' + (posSel.includes(p.id) ? ' on' : '')} aria-pressed={posSel.includes(p.id)} onClick={() => togglePos(p.id)}>{tx(p.name)}</button>
          ))}
        </div>
      </div>
      <div><div className="f-lbl" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span id={`${formId}-domains-label`}>{tx("负责领域 / 模块（可多选，分配需求时优先选择对应负责人）")}</span><button type="button" className="linkbtn" style={{ marginLeft: 'auto' }} onClick={() => setMgrOpen(true)}>{tx("管理领域")}</button>
        </div>
        <div className="posgrid" role="group" aria-labelledby={`${formId}-domains-label`}>
          {domCat.length === 0 && <span className="muted" style={{ fontSize: 14.5 }}>{tx("暂无领域，点「管理领域」新建")}</span>}
          {domCat.map((d) => (
            <button type="button" key={d.id} className={'poschip' + (domSel.includes(d.id) ? ' on' : '')} aria-pressed={domSel.includes(d.id)} onClick={() => toggleDom(d.id)}>{tx(d.name)}</button>
          ))}
        </div>
      </div>
      {mgrOpen && <DomainManager domains={domCat} onClose={() => setMgrOpen(false)}
        onChanged={() => loadDomains().then(() => setDomSel((a) => a))} />}
      {!isNew && !user.isSuper && (
        <div><div className="f-lbl" id={`${formId}-status-label`}>{tx("账号状态")}</div>
          <div className="seg" role="group" aria-labelledby={`${formId}-status-label`}><button type="button" className={'s' + (isActive ? ' on' : '')} aria-pressed={isActive} onClick={() => setIsActive(true)}>{tx("启用")}</button><button type="button" className={'s' + (!isActive ? ' on' : '')} aria-pressed={!isActive} onClick={() => setIsActive(false)}>{tx("停用")}</button></div>
        </div>
      )}
    </Modal>
  )
}

// Manage responsibility domains from the user editor.
function DomainManager({ domains, onClose, onChanged }) {
  const uiLocale = useLocale();
  const formId = useId()
  const [list, setList] = useState(domains || [])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingDel, setPendingDel] = useState(null)   // Domain awaiting deletion confirmation.
  const refresh = async () => { const d = await api.domains().catch(() => null); if (d) setList(d); onChanged && onChanged() }
  async function add() {
    const n = name.trim(); if (!n) return
    setBusy(true)
    try { await api.createDomain({ name: n, sort: (list.length + 1) }); setName(''); await refresh() }
    catch (e) { toast(tx("新建失败：") + e.message) }
    setBusy(false)
  }
  async function rename(d) {
    const nn = (d._edit != null ? d._edit : d.name).trim(); if (!nn || nn === d.name) { setList((a) => a.map((x) => x.id === d.id ? { ...x, _edit: undefined } : x)); return }
    try { await api.updateDomain(d.id, { name: nn }); await refresh() }
    catch (e) { toast(tx("改名失败：") + e.message) }
  }
  async function del(d) {
    try { await api.deleteDomain(d.id); await refresh() }
    catch (e) { toast(tx("删除失败：") + e.message) }
  }
  return (
    <Modal title={tx("管理领域 / 模块")} icon="grid" onClose={onClose}
      foot={<button className="btn btn-primary" onClick={onClose}>{tx("完成")}</button>}>
      <p className="muted" style={{ fontSize: 14.5, marginTop: 0 }}>{tx("领域是负责的业务块（支付、订单、前端等）。给成员标记领域后，分配需求时会优先选择对应负责人。")}</p>
      <label className="f-lbl" htmlFor={`${formId}-new-domain`}>{tx("领域名称")}</label>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <input id={`${formId}-new-domain`} className="f-in" value={name} onChange={(e) => setName(e.target.value)} placeholder={tx("新领域名，如 支付 / 订单")}
          onKeyDown={(e) => { if (e.key === 'Enter') add() }} />
        <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={add}>{tx("添加")}</button>
      </div>
      {list.length === 0 && <div className="empty">{tx("还没有领域")}</div>}
      {list.map((d) => (
        <div key={d.id} className="domrow">
          <label className="f-lbl" htmlFor={`${formId}-domain-${encodeURIComponent(d.id)}`}>{tx("领域名称")}</label>
          <input id={`${formId}-domain-${encodeURIComponent(d.id)}`} className="f-in" value={d._edit != null ? d._edit : d.name}
            onChange={(e) => setList((a) => a.map((x) => x.id === d.id ? { ...x, _edit: e.target.value } : x))}
            onBlur={() => rename(d)} onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }} />
          <div className="admin-row-actions"><button className="admin-text-action danger" onClick={() => setPendingDel(d)}>{tx("删除")}</button></div>
        </div>
      ))}
      {pendingDel && <Confirm title={tx("删除领域")} text={tx("确定删除领域「{0}」？已打此领域标签的成员/需求会失去该标签。", [pendingDel.name])} danger confirmText={tx("删除")} onConfirm={async () => { await del(pendingDel); setPendingDel(null) }} onClose={() => setPendingDel(null)} />}
    </Modal>
  )
}
