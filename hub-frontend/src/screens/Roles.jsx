import { translateText as tx, useLocale } from '../i18n.js'
import React, { useState } from 'react'
import { api } from '../api.js'
import { useViewportHeight } from '../viewport-height.js'
import { useAsync, Loading, Icon, Modal, Confirm, toast } from '../ui.jsx'
import './admin-access-pages.css'
import './role-card-actions.css'

export default function Roles() {
  const listRef = useViewportHeight(180)
  useLocale()
  const roles = useAsync(() => api.roles())
  const perms = useAsync(() => api.permissions())
  const users = useAsync(() => api.users().catch(() => []))
  const [edit, setEdit] = useState(null)
  const [del, setDel] = useState(null)
  if (roles.loading || perms.loading) return <Loading />
  const list = roles.data || [], catalog = perms.data || [], us = users.data || []
  const memberCount = (rid) => us.filter((u) => u.roleId === rid).length

  async function doDelete() {
    await api.deleteRole(del.id)
    toast(tx("已删除角色「") + del.name + '」')
    setDel(null); roles.reload()
  }

  return (
    <section className="admin-access-page">
      <div className="statrow admin-access-summary">
        <div className="stat"><div className="sv">{list.length}</div><div className="sl"><span className="sd" style={{ background: 'var(--c-blue)' }} />{tx("角色总数")}</div></div>
        <div className="stat"><div className="sv">{catalog.length}</div><div className="sl"><span className="sd" style={{ background: 'var(--c-green)' }} />{tx("可分配权限点")}</div></div>
        <div className="stat"><div className="sv">{list.filter((r) => !r.isSystem).length}</div><div className="sl"><span className="sd" style={{ background: 'var(--c-orange)' }} />{tx("自定义角色")}</div></div>
      </div>
      <div className="admin-filterbar">
        <span className="admin-access-note">{tx("内置角色的名称和权限只读。可通过自定义角色授予其他权限。")}</span>
        <div className="admin-filter-actions"><button className="btn btn-primary" onClick={() => setEdit({ role: null })}><Icon name="plus" />{tx("新建角色")}</button></div>
      </div>
      <div ref={listRef} className="intgrid admin-viewport-list" tabIndex={0} role="region" aria-label={tx("角色权限")}>
        {list.map((r) => {
          const mc = memberCount(r.id)
          return (
            <div key={r.id} className="intcard role-card">
              <div className="int-top">
                <span className="int-ico"><Icon name="shield" /></span>
                <div style={{ flex: 1 }}>
                  <div className="int-name">{r.name}{r.isSystem && <span className="chip src-ext" style={{ marginLeft: 6, fontSize: 14.5 }}>{tx("内置")}</span>}</div>
                  <div className="int-type">{r.permissions.length}{tx(" 项权限 · ")}{mc}{tx(" 名成员")}</div>
                </div>
              </div>
              <RolePermissions role={r} catalog={catalog} />
              <footer className="role-card-actions admin-card-actions">
                <button type="button" className="admin-card-action is-primary" onClick={() => setEdit({ role: r })}><Icon name={r.isSystem ? "shield" : "pencil"} />{r.isSystem ? tx("查看权限") : tx("编辑权限")}</button>
                {!r.isSystem && <div className="role-card-danger-group"><button type="button" className="admin-card-action is-danger" onClick={() => (mc ? toast(tx("仍有 ") + mc + tx(" 名成员在用，不能删")) : setDel(r))}><Icon name="trash" />{tx("删除角色")}</button></div>}
              </footer>
            </div>
          )
        })}
      </div>
      {edit && <RoleEditor role={edit.role} catalog={catalog} onClose={() => setEdit(null)} onDone={() => { setEdit(null); roles.reload() }} />}
      {del && <Confirm title={tx("删除角色")} danger confirmText={tx("删除")} text={tx("确定删除角色「{0}」？", [del.name])} onConfirm={doDelete} onClose={() => setDel(null)} />}
    </section>
  )
}

function PermissionInfo({ permission }) {
  const risk = { low: tx("低风险"), medium: tx("中风险"), high: tx("高风险") }[permission.risk]
  return <>
    <b>{tx(permission.label || permission.key)}</b>
    {risk && <small>{risk}</small>}
    {permission.description && <span>{tx(permission.description)}</span>}
  </>
}

function RolePermissions({ role, catalog }) {
  const [expanded, setExpanded] = useState(false)
  const keys = role.permissions || []
  return <div className="role-card-perms">
    {!keys.length && <span className="muted">{tx("无权限")}</span>}
    {(expanded ? keys : keys.slice(0, 6)).map(key => {
      const permission = catalog.find(item => item.key === key) || { key }
      return expanded
        ? <div key={key} className="role-permission-info"><PermissionInfo permission={permission} /></div>
        : <span key={key} className="chip src-ext">{tx(permission.label || key)}</span>
    })}
    {keys.length > 0 && <button type="button" className="chip" aria-expanded={expanded}
      onClick={() => setExpanded(!expanded)}>{expanded ? tx("收起权限") : keys.length > 6 ? tx("展开其余 {0} 项权限", [keys.length - 6]) : tx("查看权限")}</button>}
  </div>
}

function RoleEditor({ role, catalog, onClose, onDone }) {
  useLocale()
  const readOnly = Boolean(role?.isSystem)
  const [name, setName] = useState(role ? role.name : '')
  const [keys, setKeys] = useState(new Set(role ? role.permissions : []))
  const [busy, setBusy] = useState(false)
  const visible = readOnly ? catalog.filter(permission => keys.has(permission.key)) : catalog
  const groups = [...new Set(visible.map((c) => c.group))]
  const toggle = (k) => setKeys((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n })
  const groupKeys = (g) => catalog.filter((c) => c.group === g).map((c) => c.key)
  const allOn = (g) => groupKeys(g).every((k) => keys.has(k))
  const toggleGroup = (g) => setKeys((s) => { const n = new Set(s); const gk = groupKeys(g); if (gk.every((k) => n.has(k))) gk.forEach((k) => n.delete(k)); else gk.forEach((k) => n.add(k)); return n })

  async function save() {
    if (!name.trim()) { toast(tx("请填角色名")); return }
    setBusy(true)
    try {
      const body = { name: name.trim(), permissions: [...keys] }
      if (role) await api.updateRole(role.id, body); else await api.createRole(body)
      toast(tx("已保存")); onDone()
    } catch (e) { toast(tx("保存失败：") + e.message) }
    setBusy(false)
  }

  return (
    <Modal title={readOnly ? tx("查看权限") : role ? tx("编辑角色") : tx("新建角色")} icon="shield" wide draft={readOnly ? undefined : [name, [...keys].sort()]} onClose={onClose}
      foot={dismiss => <>
        <span className="muted" style={{ fontSize: 14.5, marginRight: 'auto' }}>{tx("已选 ")}{keys.size} / {catalog.length}{tx(" 项权限")}</span>
        <button className="btn btn-ghost" onClick={dismiss}>{readOnly ? tx("关闭") : tx("取消")}</button>
        {!readOnly && <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? tx("保存中…") : tx("保存")}</button>}
      </>}>
      {readOnly ? <div><b>{role.name}</b><p>{tx("内置角色的名称和权限只读。可通过自定义角色授予其他权限。")}</p></div>
        : <div><label className="f-lbl">{tx("角色名")}</label><input className="f-in" value={name} onChange={(e) => setName(e.target.value)} placeholder={tx("例：部门管理员 / 只读观察员")} autoFocus /></div>}
      <div>
        <label className="f-lbl">{readOnly ? tx("查看权限") : tx("权限点（按分组勾选）")}</label>
        {groups.map((g) => (
          <div key={g} className="permgroup">
            <div className="permgroup-head">
              <span className="pg-name">{tx(g)}</span>
              {!readOnly && <button type="button" className="pg-all" onClick={() => toggleGroup(g)}>{allOn(g) ? tx("取消全选") : tx("全选")}</button>}
            </div>
            <div className="role-permission-list">
              {visible.filter(c => c.group === g).map(c => readOnly
                ? <div key={c.key} className="role-permission-info"><PermissionInfo permission={c} /></div>
                : <label key={c.key} className="role-permission-choice">
                    <input type="checkbox" checked={keys.has(c.key)} onChange={() => toggle(c.key)} />
                    <span className="role-permission-info"><PermissionInfo permission={c} /></span>
                  </label>)}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}
