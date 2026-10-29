import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useState } from 'react'
import { api } from '../api.js'
import { useViewportHeight } from '../viewport-height.js'
import { useAsync, Loading, Icon, Modal, Confirm, toast } from '../ui.jsx'
import './admin-access-pages.css'
import './role-card-actions.css'

export default function Roles() {
  const listRef = useViewportHeight(180)
  const uiLocale = useLocale();
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
        <span className="admin-access-note">{tx("分配角色即授予对应权限；系统内置角色不可删除。")}</span>
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
              <div className="role-card-perms">
                {r.permissions.length === 0 && <span className="muted" style={{ fontSize: 14.5 }}>{tx("无权限")}</span>}
                {r.permissions.slice(0, 6).map((k) => { const p = catalog.find((c) => c.key === k); return <span key={k} className="chip src-ext" style={{ fontSize: 14.5 }}>{p ? p.label : k}</span> })}
                {r.permissions.length > 6 && <span className="chip" style={{ fontSize: 14.5, background: 'var(--surface-2)', color: 'var(--ink-3)' }}>+{r.permissions.length - 6}</span>}
              </div>
              <footer className="role-card-actions admin-card-actions">
                <button type="button" className="admin-card-action is-primary" onClick={() => setEdit({ role: r })}><Icon name="pencil" />{tx("编辑权限")}</button>
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

function RoleEditor({ role, catalog, onClose, onDone }) {
  const uiLocale = useLocale();
  const [name, setName] = useState(role ? role.name : '')
  const [keys, setKeys] = useState(new Set(role ? role.permissions : []))
  const [busy, setBusy] = useState(false)
  const groups = [...new Set(catalog.map((c) => c.group))]
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
    <Modal title={role ? tx("编辑角色") : tx("新建角色")} icon="shield" wide onClose={onClose}
      foot={<>
        <span className="muted" style={{ fontSize: 14.5, marginRight: 'auto' }}>{tx("已选 ")}{keys.size} / {catalog.length}{tx(" 项权限")}</span>
        <button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? tx("保存中…") : tx("保存")}</button>
      </>}>
      <div><label className="f-lbl">{tx("角色名")}</label><input className="f-in" value={name} onChange={(e) => setName(e.target.value)} placeholder={tx("例：部门管理员 / 只读观察员")} autoFocus /></div>
      <div>
        <label className="f-lbl">{tx("权限点（按分组勾选）")}</label>
        {groups.map((g) => (
          <div key={g} className="permgroup">
            <div className="permgroup-head">
              <span className="pg-name">{g}</span>
              <span className="pg-all" onClick={() => toggleGroup(g)}>{allOn(g) ? tx("取消全选") : tx("全选")}</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {catalog.filter((c) => c.group === g).map((c) => (
                <span key={c.key} className={'bp' + (keys.has(c.key) ? ' on' : '')} onClick={() => toggle(c.key)} style={{ cursor: 'pointer' }}>{keys.has(c.key) ? '✓ ' : ''}{c.label}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}
