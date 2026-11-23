import { getLocale, translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useState, useEffect, useId, useRef } from 'react'
import { orgOptions } from '../org-options.js'
import { api, getUser } from '../api.js'
import { FilterInput, FilterSelect } from '../FilterControls.jsx'
import { useViewportHeight } from '../viewport-height.js'
import { useAsync, Loading, Icon, Modal, Confirm, toast, SelectMenu } from '../ui.jsx'
import './admin-access-pages.css'

const AVA = ['#245cb9', '#087052', '#855209', '#b02c43', '#6246a8']
function avaColor(s) { let h = 0; for (const c of (s || '?')) h = (h * 31 + c.charCodeAt(0)) % 997; return AVA[h % AVA.length] }
const TEST_ACCOUNT_RE = /(?:^|[._'-])(?:qa(?:test)?|test(?:account|user|org)?|verify(?:ok)?|demo|deact)(?=$|[\d._'-])/i

function testAccountLabel(u) {
  if (u.isTestAccount === true) return tx("测试账号")
  if (u.isTestAccount == null && TEST_ACCOUNT_RE.test(u.username || '')) return tx("疑似测试账号")
  return ''
}

function userState(u) { return u.isActive ? 'active' : u.lastLogin ? 'disabled' : 'inactive' }

export default function Users() {
  const uiLocale = useLocale();
  const listRef = useViewportHeight()
  const users = useAsync(() => api.users())
  const orgs = useAsync(() => api.orgs())
  const roles = useAsync(() => api.roleOptions())
  const [edit, setEdit] = useState(null)
  const user = getUser()
  const account = user?.id || user?.username
  const [filters, setFilters] = useState(() => {
    const saved = window.history.state?.usersFilters
    return account && saved?.account === account && typeof saved.q === 'string' && typeof saved.dept === 'string'
      ? saved : { q: '', dept: '' }
  })
  const { q, dept, role = '', status = '', onlyTest = false } = filters
  const [selected, setSelected] = useState([])
  const [targetOrg, setTargetOrg] = useState('')
  const [pending, setPending] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState(null)
  function clearSelection() {
    setSelected([])
    setTargetOrg('')
  }
  function selectUsers(ids) {
    setFeedback(null)
    if (ids.length) setSelected(ids)
    else clearSelection()
  }
  function changeFilters(changes) {
    const next = { ...filters, ...changes }
    setFilters(next)
    clearSelection()
    setFeedback(null)
    if (account) {
      // Keep searches on this history entry so copying the URL shares only the page.
      try { window.history.replaceState({ ...window.history.state, usersFilters: { ...next, account } }, '') }
      catch { /* Filtering still works when the browser limits history writes. */ }
    }
  }
  if (users.loading || orgs.loading || roles.loading) return <Loading />
  const ul = users.data || [], ol = orgs.data || [], rl = roles.data || []
  const orgName = (id) => { const o = ol.find((x) => x.id === id); return o ? o.name : '—' }
  const roleName = (id) => { const r = rl.find((x) => x.id === id); return r ? r.name : '—' }

  const orgChoices = orgOptions(ol)
  const kw = q.trim().toLowerCase()
  const filtered = ul.filter((u) => {
    const hit = !kw || (u.displayName || '').toLowerCase().includes(kw) || (u.username || '').toLowerCase().includes(kw)
    const roleKey = u.isSuper ? ':super' : (u.roleId || ':none')
    return hit && (!dept || u.orgId === dept) && (!role || roleKey === role)
      && (!status || userState(u) === status) && (!onlyTest || testAccountLabel(u))
  })
  const active = ul.filter((u) => u.isActive).length
  const inactive = ul.filter((u) => userState(u) === 'inactive').length
  const stateLabels = { active: tx("启用"), inactive: tx("未激活"), disabled: tx("已停用") }
  const stateHints = { inactive: tx("停用且无登录记录"), disabled: tx("停用且有登录记录") }
  const selectedIds = new Set(selected)
  const selectedRows = filtered.filter(u => selectedIds.has(u.id))
  const count = selectedRows.length
  const tooMany = count > 200
  const protectedSelection = selectedRows.some(u => u.isSuper || u.id === user?.id || u.username === user?.username)
  function beginBatch(title, message, change) {
    setFeedback(null)
    setPending({ title, message, change, rows: selectedRows })
  }
  async function applyBatch() {
    setSubmitting(true)
    try {
      const result = await api.batchUpdateUsers({ ids: pending.rows.map(u => u.id), ...pending.change })
      clearSelection()
      setFeedback({ message: tx("已更新 {0} 个账号", [result.updated]) })
      await users.reload()
    } catch (error) {
      setFeedback({ error: true, message: tx("保存失败：") + error.message })
    } finally {
      setPending(null)
      setSubmitting(false)
    }
  }

  return (
    <section className="admin-access-page">
      <div className="statrow admin-access-summary user-status-summary">
        <div className="stat"><div className="sv">{ul.length}</div><div className="sl"><span className="sd" style={{ background: 'var(--c-blue)' }} />{tx("用户总数")}</div></div>
        <div className="stat"><div className="sv">{active}</div><div className="sl"><span className="sd" style={{ background: 'var(--c-green)' }} />{tx("启用中")}</div></div>
        <div className="stat" title={stateHints.inactive}><div className="sv">{inactive}</div><div className="sl"><span className="sd" style={{ background: 'var(--offline)' }} />{stateLabels.inactive}</div></div>
        <div className="stat" title={stateHints.disabled}><div className="sv">{ul.length - active - inactive}</div><div className="sl"><span className="sd" style={{ background: 'var(--offline)' }} />{stateLabels.disabled}</div></div>
      </div>
      <div className="admin-filterbar">
        <FilterInput aria-label={tx("搜索姓名或账号")} value={q} onChange={(e) => changeFilters({ q: e.target.value })} placeholder={tx("搜索姓名 / 账号")} />
        <div className="admin-filter-options">
          <FilterSelect className="f-sel" aria-label={tx("所属部门")} value={dept} onChange={(e) => changeFilters({ dept: e.target.value })}>
            <option value="">{tx("全部部门")}</option>
            {orgChoices.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </FilterSelect>
          <FilterSelect className="f-sel" aria-label={tx("角色")} value={role} onChange={(e) => changeFilters({ role: e.target.value })}>
            <option value="">{tx("全部角色")}</option>
            <option value=":super">{tx("超级管理员")}</option>
            <option value=":none">{tx("— 无角色 —")}</option>
            {rl.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </FilterSelect>
          <FilterSelect className="f-sel" aria-label={tx("状态")} value={status} onChange={(e) => changeFilters({ status: e.target.value })}>
            <option value="">{tx("全部状态")}</option>
            <option value="active">{tx("启用中")}</option>
            <option value="inactive">{tx("未激活")}</option>
            <option value="disabled">{tx("已停用")}</option>
          </FilterSelect>
          <label className="admin-filter-check"><input type="checkbox" checked={onlyTest} onChange={(e) => changeFilters({ onlyTest: e.target.checked })} />{tx("测试及疑似账号")}</label>
          <button className="btn btn-ghost" onClick={() => { clearSelection(); users.reload(); orgs.reload(); roles.reload() }}><Icon name="refresh" />{tx("刷新")}</button>
          <button className="btn btn-primary" onClick={() => setEdit({ user: null })}><Icon name="plus" />{tx("新建用户")}</button>
        </div>
      </div>
      {count > 0 && <div className="user-batch-actions">
        <span>{tx("已选 {0} 个账号", [count])}</span>
        <button className="btn btn-ghost" disabled={tooMany} onClick={() => beginBatch(tx("批量启用"), tx("确认启用所选账号？"), { isActive: true })}>{tx("批量启用")}</button>
        <button className="btn btn-ghost" disabled={tooMany || protectedSelection} onClick={() => beginBatch(tx("批量停用"), tx("确认停用所选账号？"), { isActive: false })}>{tx("批量停用")}</button>
        <SelectMenu className="f-sel" searchable aria-label={tx("目标部门")} value={targetOrg} onChange={e => setTargetOrg(e.target.value)}>
          <option value="">{tx("目标部门")}</option>
          {orgChoices.map(o => <option key={o.id} value={o.id} data-path={o.path}>{o.label}</option>)}
        </SelectMenu>
        <button className="btn btn-ghost" disabled={tooMany || !targetOrg} onClick={() => beginBatch(tx("批量更改部门"), tx("确认将所选账号移至「{0}」？", [orgChoices.find(o => o.id === targetOrg)?.path]), { orgId: targetOrg })}>{tx("批量更改部门")}</button>
        {tooMany && <span className="admin-access-note" role="status">{tx("每次最多处理 200 个账号，请缩小筛选范围或取消部分选择。")}</span>}
        {protectedSelection && <span className="admin-access-note">{tx("无法停用当前账号或超级管理员。")}</span>}
      </div>}
      {feedback && <div className="admin-access-note" role={feedback.error ? 'alert' : 'status'}>{feedback.message}</div>}
      {users.error && <div className="admin-access-note" role="alert">{users.data ? tx("刷新失败，以下显示上次成功读取的数据。") : users.error.message}</div>}
      <div className="tablewrap"><div ref={listRef} className="tscroll" tabIndex={0} role="region" aria-label={tx("用户列表")}><table>
        <thead><tr><th scope="col"><input type="checkbox" aria-label={tx("全选筛选结果")} checked={count > 0 && count === filtered.length}
          ref={el => { if (el) el.indeterminate = count > 0 && count < filtered.length }} disabled={!filtered.length}
          onChange={e => selectUsers(e.target.checked ? filtered.map(u => u.id) : [])} /></th><th scope="col">{tx("用户")}</th><th scope="col">{tx("账号")}</th><th scope="col">{tx("部门")}</th><th scope="col">{tx("角色")}</th><th scope="col">{tx("状态")}</th><th scope="col">{tx("最后登录")}</th><th scope="col" className="admin-access-actions-col">{tx("操作")}</th></tr></thead>
        <tbody>
          {filtered.length === 0 && <tr><td colSpan={8}><div className="empty">{ul.length ? tx("没有匹配的用户") : tx("还没有用户")}</div></td></tr>}
          {filtered.map((u) => {
            const nm = u.displayName || u.username
            const testLabel = testAccountLabel(u)
            const state = userState(u)
            return (
              <tr key={u.id}>
                <td><input type="checkbox" aria-label={tx("选择账号 {0}", [u.username])} checked={selectedIds.has(u.id)}
                  onChange={e => selectUsers(e.target.checked ? [...selected, u.id] : selected.filter(id => id !== u.id))} /></td>
                <td><span className="cli"><span className="ava" style={{ background: avaColor(nm) }}>{nm.slice(0, 1)}</span><span className="nm">{nm}{u.isSuper && <span className="chip src-ext" style={{ marginLeft: 6, fontSize: 14.5 }}>{tx("超级")}</span>}</span></span></td>
                <td className="mono">{u.username}{testLabel && <span className="chip src-ext" style={{ marginLeft: 6 }} title={u.isTestAccount == null ? tx("根据账号名称推测，请核对后操作。") : undefined}>{testLabel}</span>}</td>
                <td>{orgName(u.orgId)}</td>
                <td>{u.isSuper ? <span className="chip src-ext">{tx("全部权限")}</span> : roleName(u.roleId)}</td>
                <td><span className={'status-dot ' + (u.isActive ? 'on' : 'off')} title={stateHints[state]}><i />{stateLabels[state]}</span></td>
                <td className="muted nowrap">{u.lastLogin ? new Date(u.lastLogin).toLocaleString(getLocale()) : '—'}</td>
                <td><div className="admin-row-actions"><button className="admin-text-action" onClick={() => setEdit({ user: u })}>{tx("编辑")}</button></div></td>
              </tr>
            )
          })}
        </tbody>
      </table></div></div>
      {pending && <Confirm title={pending.title} confirmText={pending.title} danger={pending.change.isActive === false} focusCancel
        text={<><p>{pending.message}</p><p>{tx("已选 {0} 个账号", [pending.rows.length])}</p>
          <ul className="user-batch-preview">{pending.rows.map(u => <li key={u.id}>{u.username}</li>)}</ul>
          {pending.change.isActive === false && <p>{tx("停用后，所选账号将无法登录，现有设备会话将断开。")}</p>}</>}
        onClose={() => { if (!submitting) setPending(null) }} onConfirm={applyBatch} />}
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
  const passwordInput = useRef(null)
  const [passwordTouched, setPasswordTouched] = useState(false)
  const passwordLength = [...password].length
  const passwordInvalid = (isNew || password !== '') && (
    passwordLength < 8 || passwordLength > 128 || !/[^\p{White_Space}\u001c-\u001f]/u.test(password))
  const showPasswordError = passwordTouched && passwordInvalid
  const [orgId, setOrgId] = useState(user ? user.orgId || '' : '')
  const [roleId, setRoleId] = useState(user ? user.roleId || '' : '')
  const [isActive, setIsActive] = useState(user ? user.isActive : true)
  const initialKind = user ? (user.isTestAccount == null ? '' : String(user.isTestAccount)) : 'false'
  const [accountKind, setAccountKind] = useState(initialKind)
  const [posSel, setPosSel] = useState(user ? (user.positions || []) : [])
  const [posCat, setPosCat] = useState([])
  const [positionSearch, setPositionSearch] = useState('')
  const positionTerm = positionSearch.trim().toLocaleLowerCase()
  const visiblePositions = posCat.filter(p => !positionTerm ||
    [p.name, tx(p.name)].some(name => name.toLocaleLowerCase().includes(positionTerm)))
  const [domSel, setDomSel] = useState(user ? (user.domains || []) : [])
  const [domCat, setDomCat] = useState([])
  const [domStatus, setDomStatus] = useState('loading')
  const [mgrOpen, setMgrOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const opts = orgOptions(orgs)
  const nm = displayName || username || '?'
  const loadDomains = () => {
    setDomStatus('loading')
    return api.domains().then((d) => {
      if (!Array.isArray(d) || d.some((entry) => !entry || typeof entry.id !== 'string' || !entry.id)) {
        setDomStatus('error'); return
      }
      setDomCat(d); setDomStatus('ready')
    })
      .catch(() => setDomStatus('error'))
  }
  // A failed catalog read does not prove that any saved assignment was deleted.
  const unavailableDomains = domStatus === 'ready'
    ? [...new Set(domSel)].filter((id) => !domCat.some((d) => d.id === id)) : []
  useEffect(() => {
    api.positions().then((p) => setPosCat(p || [])).catch(() => setPosCat([]))
    loadDomains()
  }, [])
  const togglePos = (id) => setPosSel((a) => a.includes(id) ? a.filter((x) => x !== id) : [...a, id])
  const toggleDom = (id) => setDomSel((a) => a.includes(id) ? a.filter((x) => x !== id) : [...a, id])

  async function save() {
    if (isNew && !username.trim()) { toast(tx("请填账号与初始密码")); return }
    if (passwordInvalid) {
      setPasswordTouched(true)
      passwordInput.current?.focus()
      return
    }
    if (!orgId) { toast(tx("请选择所属部门")); return }
    setBusy(true)
    try {
      const marker = accountKind === '' ? null : accountKind === 'true'
      if (isNew) await api.createUser({ username: username.trim(), password, displayName: displayName.trim(), orgId, roleId: roleId || null, positions: posSel, domains: domSel, isTestAccount: marker })
      else {
        const body = { displayName: displayName.trim(), orgId, roleId: roleId || null, isActive, positions: posSel, domains: domSel }
        if (accountKind !== initialKind) body.isTestAccount = marker
        if (password) body.password = password
        await api.updateUser(user.id, body)
      }
      toast(tx("已保存")); onDone()
    } catch (e) { toast(tx("保存失败：") + e.message) }
    setBusy(false)
  }

  return (
    <Modal title={isNew ? tx("新建用户") : tx("编辑用户")} icon="users" draft={[username, displayName, password, orgId, roleId, isActive, accountKind, [...posSel].sort(), [...domSel].sort()]} onClose={onClose}
      foot={dismiss => <>
        <button className="btn btn-ghost" onClick={dismiss}>{tx("取消")}</button>
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
        <div style={{ flex: 1 }}><label className="f-lbl" htmlFor={`${formId}-username`}>{tx("账号")}</label><input id={`${formId}-username`} name="managed-username" autoComplete="off" className="f-in" value={username} disabled={!isNew} required={isNew} onChange={(e) => setUsername(e.target.value)} placeholder={tx("登录账号")} /></div>
        <div style={{ flex: 1 }}><label className="f-lbl" htmlFor={`${formId}-name`}>{tx("姓名")}</label><input id={`${formId}-name`} name="managed-display-name" autoComplete="off" className="f-in" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={tx("显示名")} /></div>
      </div>
      <div className="managed-password">
        <label className="f-lbl" htmlFor={`${formId}-password`}>{isNew ? tx("初始密码") : tx("重置密码（留空不改）")}</label>
        <input ref={passwordInput} id={`${formId}-password`} name="managed-new-password" autoComplete="new-password"
          className="f-in" type="password" value={password} required={isNew}
          aria-invalid={showPasswordError} aria-describedby={`${formId}-password-hint`}
          onBlur={() => setPasswordTouched(true)} onChange={(e) => setPassword(e.target.value)}
          placeholder={isNew ? tx("设置初始密码") : tx("不改则留空")} />
        <p className="managed-password-hint" id={`${formId}-password-hint`}>
          {showPasswordError && <strong aria-hidden="true">! </strong>}{tx("使用 8–128 个字符，不能全为空白。")}
        </p>
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1 }}><label className="f-lbl" id={`${formId}-org-label`} htmlFor={`${formId}-org`}>{tx("所属部门")}</label>
          <SelectMenu searchable id={`${formId}-org`} aria-labelledby={`${formId}-org-label`} required className="f-in" value={orgId} onChange={(e) => setOrgId(e.target.value)}><option value="">{tx("— 选择部门 —")}</option>{opts.map((o) => <option key={o.id} value={o.id} data-path={o.path}>{o.label}</option>)}</SelectMenu>
        </div>
        <div style={{ flex: 1 }}><label className="f-lbl" id={`${formId}-role-label`} htmlFor={`${formId}-role`}>{tx("角色（权限）")}</label>
          <SelectMenu id={`${formId}-role`} aria-labelledby={`${formId}-role-label`} className="f-in" value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={user && user.isSuper}><option value="">{tx("— 无角色 —")}</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</SelectMenu>
        </div>
      </div>
      <div><label className="f-lbl" id={`${formId}-kind-label`} htmlFor={`${formId}-kind`}>{tx("账号标识")}</label>
        <SelectMenu id={`${formId}-kind`} aria-labelledby={`${formId}-kind-label`} className="f-in" value={accountKind} onChange={e => setAccountKind(e.target.value)}>
          <option value="false">{tx("正式账号")}</option><option value="true">{tx("测试账号")}</option><option value="">{tx("未指定（按账号名称提示）")}</option>
        </SelectMenu>
      </div>
      <div><div className="f-lbl" id={`${formId}-positions-label`}>{tx("职业画像（可多选，用于理解需求与推荐工作场景，不授予系统权限）")}</div>
        <input type="search" className="f-in" aria-label={tx("搜索职业画像")} placeholder={tx("搜索职业画像")} value={positionSearch} onChange={e => setPositionSearch(e.target.value)} />
        <div className="posgrid" role="group" aria-labelledby={`${formId}-positions-label`}>
          {posCat.length === 0 && <span className="muted" style={{ fontSize: 14.5 }}>{tx("暂无职业画像")}</span>}
          {posCat.length > 0 && !visiblePositions.length && <span className="muted" role="status">{tx("没有匹配的职业画像")}</span>}
          {visiblePositions.map((p) => (
            <button type="button" key={p.id} className={'poschip' + (posSel.includes(p.id) ? ' on' : '')} aria-pressed={posSel.includes(p.id)} onClick={() => togglePos(p.id)}>{tx(p.name)}</button>
          ))}
        </div>
      </div>
      <div><div className="f-lbl" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span id={`${formId}-domains-label`}>{tx("负责领域 / 模块（可多选，分配需求时优先选择对应负责人）")}</span><button type="button" className="linkbtn" style={{ marginLeft: 'auto' }} onClick={() => setMgrOpen(true)}>{tx("管理领域")}</button>
        </div>
        {domStatus === 'error' && <div className="muted" role="status">{tx("领域列表加载失败，请重试。")} <button type="button" className="linkbtn" onClick={loadDomains}>{tx("重试")}</button></div>}
        {unavailableDomains.length > 0 && <div className="muted" role="status">{tx("部分已选领域已不存在，请点击对应项移除后再保存。")}</div>}
        <div className="posgrid" role="group" aria-labelledby={`${formId}-domains-label`}>
          {domStatus === 'loading' && <span className="muted">{tx("加载中…")}</span>}
          {domStatus === 'ready' && domCat.length === 0 && <span className="muted" style={{ fontSize: 14.5 }}>{tx("暂无领域，点「管理领域」新建")}</span>}
          {domCat.map((d) => (
            <button type="button" key={d.id} className={'poschip' + (domSel.includes(d.id) ? ' on' : '')} aria-pressed={domSel.includes(d.id)} onClick={() => toggleDom(d.id)}>{tx(d.name)}</button>
          ))}
          {unavailableDomains.map((id) => (
            <button type="button" key={id} className="poschip on" aria-pressed={true} onClick={() => toggleDom(id)}>{tx("已不存在的领域：{0}", [id])}</button>
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
    <Modal title={tx("管理领域 / 模块")} icon="grid" dirty={!!name || list.some(row => row._edit != null && row._edit !== row.name)} onClose={onClose}
      foot={dismiss => <button className="btn btn-primary" onClick={dismiss}>{tx("完成")}</button>}>
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
