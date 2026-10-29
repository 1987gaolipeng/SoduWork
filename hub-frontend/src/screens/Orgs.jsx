import { getLocale, translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useMemo, useState, useId } from 'react'
import { orgOptions } from '../org-options.js'
import { api, can } from '../api.js'
import { FilterInput } from '../FilterControls.jsx'
import { useViewportHeight } from '../viewport-height.js'
import { useAsync, Loading, Icon, Modal, Confirm, toast, SelectMenu } from '../ui.jsx'
import './org-governance.css'


function TeamModuleScopeCard({ children }) {
  const uiLocale = useLocale();
  const scope = useAsync(() => api.teamModuleScope().catch(() => null))
  const [busy, setBusy] = useState(false)
  const value = (scope.data && scope.data.scope) || 'managers'
  async function apply(next) {
    if (busy || next === value) return
    setBusy(true)
    try {
      await api.setTeamModuleScope(next)
      toast(next === 'everyone' ? tx("「团队」已对全员开放") : tx("「团队」已收口为负责人及以上可见"))
      await scope.reload()
    } catch (e) { toast(tx("没改成：") + (e.message || tx("请稍后再试"))) }
    setBusy(false)
  }
  return <section className="og-scope-card">
    <div className="og-scope-copy"><b>{tx("客户端「团队」模块可见范围")}</b>
      <span>{tx("团队看板（成员、负载、安排执行）是管理视角；口径改动实时生效，客户端下次拉取能力时应用。")}</span></div>
    <div className="og-scope-settings" aria-busy={scope.loading}>
      {children}
      <div className="og-scope-seg" role="group" aria-label={tx("团队模块可见范围")}>
        <button className={!scope.loading && value === 'managers' ? 'on' : ''} disabled={busy || scope.loading}
          aria-pressed={!scope.loading && value === 'managers'}
          onClick={() => apply('managers')}>{tx("部门负责人及以上")}</button>
        <button className={!scope.loading && value === 'everyone' ? 'on' : ''} disabled={busy || scope.loading}
          aria-pressed={!scope.loading && value === 'everyone'}
          onClick={() => apply('everyone')}>{tx("全员可见")}</button>
      </div>
    </div>
  </section>
}

const AVATAR_COLORS = ['var(--accent)', 'var(--ok)', 'var(--warn)', 'var(--crit)', 'var(--text-purple)']
function avatarColor(value) {
  let hash = 0
  for (const char of (value || '?')) hash = (hash * 31 + char.charCodeAt(0)) % 997
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}

function buildTree(list) {
  const byParent = {}
  const byId = {}
  list.forEach((org) => {
    byId[org.id] = org
    const key = org.parentId || ''
    ;(byParent[key] = byParent[key] || []).push(org)
  })
  Object.values(byParent).forEach((rows) => rows.sort((a, b) =>
    (Number(a.sort) || 0) - (Number(b.sort) || 0) || a.name.localeCompare(b.name, getLocale())))
  return { byParent, byId, roots: byParent[''] || [] }
}

function descendantIds(id, byParent) {
  const found = new Set()
  const stack = [...(byParent[id] || [])]
  while (stack.length) {
    const row = stack.pop()
    if (found.has(row.id)) continue
    found.add(row.id)
    stack.push(...(byParent[row.id] || []))
  }
  return found
}

function pathTo(org, byId) {
  const path = []
  let current = org
  while (current) {
    path.unshift(current)
    current = current.parentId ? byId[current.parentId] : null
  }
  return path
}

export default function Orgs() {
  const workspaceRef = useViewportHeight(420)
  const uiLocale = useLocale();
  const orgs = useAsync(() => api.orgs())
  const users = useAsync(() => api.users().catch(() => []))
  const [selectedId, setSelectedId] = useState('')
  const [expanded, setExpanded] = useState(null)
  const [query, setQuery] = useState('')
  const [modal, setModal] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)

  const list = orgs.data || []
  const people = users.data || []
  const { byParent, byId, roots } = useMemo(() => buildTree(list), [orgs.data, uiLocale])
  const memberCounts = useMemo(() => {
    const counts = new Map()
    people.forEach((user) => counts.set(user.orgId, (counts.get(user.orgId) || 0) + 1))
    return counts
  }, [users.data, uiLocale])
  const selected = byId[selectedId] || roots[0] || list[0] || null

  useEffect(() => {
    if (!list.length) setSelectedId('')
    else if (!selectedId || !list.some((org) => org.id === selectedId)) setSelectedId((roots[0] || list[0]).id)
  }, [orgs.data, selectedId])

  if (orgs.loading || users.loading) return <Loading />

  const directMembers = selected ? people.filter((user) => user.orgId === selected.id) : []
  const children = selected ? (byParent[selected.id] || []) : []
  const descendants = selected ? descendantIds(selected.id, byParent) : new Set()
  const allMemberCount = selected ? people.filter((user) => user.orgId === selected.id || descendants.has(user.orgId)).length : 0
  const path = selected ? pathTo(selected, byId) : []
  const activePeople = people.filter((user) => user.isActive).length

  const visibleIds = new Set()
  const keyword = query.trim().toLowerCase()
  if (keyword) {
    list.filter((org) => org.name.toLowerCase().includes(keyword)).forEach((org) => {
      let current = org
      while (current) {
        visibleIds.add(current.id)
        current = current.parentId ? byId[current.parentId] : null
      }
    })
  } else list.forEach((org) => visibleIds.add(org.id))

  const isOpen = (id) => keyword || expanded === null || expanded.has(id)
  const toggle = (id) => setExpanded((current) => {
    const next = current === null ? new Set(list.map((org) => org.id)) : new Set(current)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const reload = () => Promise.all([orgs.reload(), users.reload()])

  async function removeOrg() {
    await api.deleteOrg(pendingDelete.id)
    toast(tx("部门已删除"))
    setPendingDelete(null)
    await reload()
  }

  function TreeNode({ org, depth = 0 }) {
  const uiLocale = useLocale();
    if (!visibleIds.has(org.id)) return null
    const childRows = (byParent[org.id] || []).filter((child) => visibleIds.has(child.id))
    const open = isOpen(org.id)
    return <div className="og-tree-node">
      <div className={'og-tree-row' + (selected && selected.id === org.id ? ' selected' : '')}
        style={{ '--tree-depth': depth }} role="treeitem" tabIndex="0" aria-level={depth + 1}
        aria-selected={Boolean(selected && selected.id === org.id)}
        aria-expanded={childRows.length ? Boolean(open) : undefined}
        onClick={() => setSelectedId(org.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setSelectedId(org.id)
          }
        }}>
        <button className={'og-tree-toggle' + (childRows.length ? (open ? ' open' : '') : ' leaf')}
          aria-label={open ? tx("收起子部门") : tx("展开子部门")} onClick={(event) => { event.stopPropagation(); childRows.length && toggle(org.id) }}>
          <Icon name="chevron" />
        </button>
        <span className="og-tree-mark"><Icon name="building" /></span>
        <span className="og-tree-name" title={org.name}>{org.name}</span>
      </div>
      {childRows.length > 0 && open && <div className="og-tree-children">
        {childRows.map((child) => <TreeNode key={child.id} org={child} depth={depth + 1} />)}
      </div>}
    </div>
  }

  const summary = <dl className="og-summary" aria-label={tx("组织汇总")}>
      <div><dt>{tx("部门")}</dt><dd>{list.length}</dd></div>
      <div><dt>{tx("成员")}</dt><dd>{people.length}</dd></div>
      <div><dt>{tx("启用账号")}</dt><dd>{activePeople}</dd></div>
    </dl>

  return <div className="org-governance">
    {can('org.manage') ? <TeamModuleScopeCard>{summary}</TeamModuleScopeCard> : summary}

    <section ref={workspaceRef} className="og-workbench">
      <aside className="og-directory">
        <header>
          <div><b>{tx("组织树")}</b><span>{roots.length}{tx(" 个顶级部门")}</span></div>
          {can('org.manage') && <button className="btn btn-primary btn-sm og-create-department" onClick={() => setModal({ parentId: '' })}><Icon name="plus" />{tx("新建顶级部门")}</button>}
        </header>
        <div className="og-directory-filter">
          <FilterInput className="og-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tx("查找部门")} />
          <div className="og-tree-tools">
            <button title={tx("全部折叠")} onClick={() => setExpanded(new Set())}><span>−</span></button>
            <button title={tx("全部展开")} onClick={() => setExpanded(null)}><span>+</span></button>
          </div>
        </div>
        <div className="og-tree" role="tree">
          {roots.length === 0
            ? <div className="og-tree-empty"><Icon name="building" /><b>{tx("还没有组织")}</b><span>{tx("创建第一个顶级部门后开始搭建组织。")}</span></div>
            : roots.map((root) => <TreeNode key={root.id} org={root} />)}
          {roots.length > 0 && visibleIds.size === 0 && <div className="og-tree-empty"><Icon name="search" /><b>{tx("没有匹配的部门")}</b><span>{tx("换一个关键词继续查找。")}</span></div>}
        </div>
      </aside>

      <main className="og-detail" tabIndex={0} role="region" aria-label={tx("部门详情")}>
        {!selected ? <div className="og-no-selection"><Icon name="building" /><b>{tx("选择一个部门")}</b><span>{tx("部门信息、下属部门和直属成员会显示在这里。")}</span></div> : <>
          <header className="og-detail-head">
            <div className="og-breadcrumb">{path.map((item, index) => <React.Fragment key={item.id}>{index > 0 && <i>/</i>}<button title={item.name} onClick={() => setSelectedId(item.id)}>{item.name}</button></React.Fragment>)}</div>
            <div className="og-title-row">
              <span className="og-dept-icon"><Icon name="building" /></span>
              <div><h2 title={selected.name}>{selected.name}</h2></div>
            </div>
            <div className="og-detail-toolbar">
              <dl className="og-facts">
                <div><dt>{directMembers.length}</dt><dd>{tx("直属成员")}</dd></div>
                <div><dt>{children.length}</dt><dd>{tx("下属部门")}</dd></div>
                <div><dt>{descendants.size}</dt><dd>{tx("全部下级部门")}</dd></div>
                <div><dt>{allMemberCount}</dt><dd>{tx("管辖成员")}</dd></div>
              </dl>
              <div className="og-detail-actions admin-row-actions">
                {can('org.manage') && <button className="btn btn-primary btn-sm" onClick={() => setModal({ parentId: selected.id })}><Icon name="plus" />{tx("新建下属部门")}</button>}
                {can('org.manage') && <button className="admin-text-action" onClick={() => setModal({ org: selected })}>{tx("编辑")}</button>}
                {can('org.manage') && <button className="admin-text-action danger" disabled={children.length > 0 || directMembers.length > 0}
                  title={children.length || directMembers.length ? tx("请先迁移下属部门和直属成员") : tx("删除部门")} onClick={() => setPendingDelete(selected)}>{tx("删除")}</button>}
              </div>
            </div>
          </header>

          <section className="og-section">
            <header><div><h3>{tx("下属部门")}</h3><p>{tx("选择部门继续向下查看组织和成员。")}</p></div><span>{children.length}</span></header>
            {children.length === 0 ? <div className="og-section-empty"><Icon name="tree" /><div><b>{tx("暂无下属部门")}</b><span>{tx("这是当前组织树中的末级部门。")}</span></div>{can('org.manage') && <button onClick={() => setModal({ parentId: selected.id })}>{tx("新建下属部门")}</button>}</div>
              : <div className="og-dept-list">{children.map((child) => {
                const childMembers = memberCounts.get(child.id) || 0
                const childBranches = descendantIds(child.id, byParent).size
                return <button key={child.id} onClick={() => setSelectedId(child.id)}>
                  <span className="og-list-icon"><Icon name="building" /></span>
                  <span><b title={child.name}>{child.name}</b><small>{childBranches ? tx("{0} 个下级部门", [childBranches]) : tx("末级部门")}</small></span>
                  <em>{childMembers}{tx(" 名直属成员")}</em><Icon name="chevron" />
                </button>
              })}</div>}
          </section>

          <section className="og-section og-members">
            <header><div><h3>{tx("直属成员")}</h3><p>{tx("这里只展示直接归属于当前部门的成员。")}</p></div><span>{directMembers.length}</span></header>
            {directMembers.length === 0 ? <div className="og-section-empty"><Icon name="users" /><div><b>{tx("暂无直属成员")}</b><span>{tx("可在“用户管理”中调整成员所属部门。")}</span></div></div>
              : <div className="og-member-list">{directMembers.map((user) => {
                const name = user.displayName || user.username
                return <article key={user.id}><span className="og-avatar" style={{ '--avatar-color': avatarColor(name) }}>{name.slice(0, 1)}</span><div><b title={name}>{name}</b><small title={'@' + user.username}>@{user.username}</small></div>{user.isSuper && <span className="og-role">{tx("超级管理员")}</span>}<span className={'og-user-state ' + (user.isActive ? 'on' : 'off')}><i />{user.isActive ? tx("启用") : tx("停用")}</span></article>
              })}</div>}
          </section>
        </>}
      </main>
    </section>

    {modal && <OrgModal spec={modal} orgs={list} onClose={() => setModal(null)} onDone={async (id) => { setModal(null); await orgs.reload(); if (id) setSelectedId(id) }} />}
    {pendingDelete && <Confirm title={tx("删除部门")} danger confirmText={tx("删除部门")} text={tx("确定删除「{0}」？删除后无法恢复。", [pendingDelete.name])} onConfirm={removeOrg} onClose={() => setPendingDelete(null)} />}
  </div>
}

function OrgModal({ spec, orgs, onClose, onDone }) {
  const uiLocale = useLocale();
  const formId = useId()
  const editing = !!spec.org
  const [name, setName] = useState(editing ? spec.org.name : '')
  const [parentId, setParentId] = useState(editing ? (spec.org.parentId || '') : (spec.parentId || ''))
  const [busy, setBusy] = useState(false)
  const options = orgOptions(orgs, editing ? spec.org.id : null)

  async function save() {
    if (!name.trim()) return toast(tx("请填写部门名称"))
    setBusy(true)
    try {
      let result
      if (editing) result = await api.updateOrg(spec.org.id, { name: name.trim(), parentId })
      else result = await api.createOrg({ name: name.trim(), parentId: parentId || null })
      toast(editing ? tx("部门信息已保存") : tx("部门已创建"))
      onDone((result && result.id) || (editing ? spec.org.id : ''))
    } catch (error) { toast(tx("部门没有保存：") + error.message) }
    finally { setBusy(false) }
  }

  return <Modal className="org-editor" title={editing ? tx("编辑部门") : tx("新建部门")} icon="building" onClose={onClose}
    foot={<><button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button><button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? tx("保存中…") : editing ? tx("保存部门") : tx("创建部门")}</button></>}>
    <div className="og-modal-copy"><b>{editing ? tx("调整部门身份与组织位置") : tx("把新部门放到正确的管理范围内")}</b><span>{tx("成员不会随部门自动移动，需要在用户管理中单独调整归属。")}</span></div>
    <label className="og-modal-field"><span>{tx("部门名称")}</span><input className="f-in" value={name} onChange={(event) => setName(event.target.value)} placeholder={tx("例如：产品研发中心")} autoFocus /></label>
    <div className="og-modal-field"><span id={`${formId}-parent-label`}>{tx("上级部门")}</span><SelectMenu searchable aria-labelledby={`${formId}-parent-label`} className="f-in" value={parentId} onChange={(event) => setParentId(event.target.value)}><option value="">{tx("作为顶级部门")}</option>{options.map((option) => <option key={option.id} value={option.id} data-path={option.path}>{option.label}</option>)}</SelectMenu></div>
  </Modal>
}
