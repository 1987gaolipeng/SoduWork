import { getLocale, translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useId, useRef, useState } from 'react'
import { api, getUser } from '../api.js'
import { orgOptions } from '../org-options.js'
import { FilterSelect } from '../FilterControls.jsx'
import { useViewportHeight } from '../viewport-height.js'
import { Confirm, Icon, Loading, Modal, toast } from '../ui.jsx'
import './org-memory.css'

const FIELDS = localeMap(() => ([
  ['summary', '摘要'], ['goal', '共同目标'], ['decisions', '已确认的决定'],
  ['constraints', '组织约束'], ['pending', '待跟进'], ['outcomes', '累积结果'],
]))
const ORG_MEMORY_KEY = 'default'
const blank = () => ({ id: '', key: ORG_MEMORY_KEY, title: '组织共同记忆', fields: Object.fromEntries(FIELDS.map(([key]) => [key, ''])), revision: 1 })

function splitAutomaticSummary(value) {
  const text = String(value || '').trim().replace(/^团队共享工作记忆\s*\n?/u, '').trim()
  if (!text) return []
  if (!/^\s*-\s+/m.test(text)) return [{ title: '', body: text }]
  const firstBullet = text.search(/^\s*-\s+/m)
  const bulletText = firstBullet >= 0 ? text.slice(firstBullet) : text
  const chunks = bulletText.split(/\n(?=\s*-\s+)/).map((chunk) => chunk.trim()).filter(Boolean)
  return chunks.map((chunk) => {
    const lines = chunk.split('\n')
    const title = (lines.shift() || '').replace(/^\s*-\s*/, '').trim()
    return { title, body: lines.join('\n').trim() }
  })
}

function Editor({ value, setValue, onSave, onClose, busy }) {
  const uiLocale = useLocale();
  const formId = useId()
  const setField = (key, next) => setValue({ ...value, fields: { ...value.fields, [key]: next } })
  return <Modal wide className="om-dialog" icon="memory" title={tx("补充与修正")} onClose={onClose}
    foot={<><span className="modal-foot-note">{tx("自动记忆会持续更新，补充内容将单独保留。")}</span><button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>{tx("取消")}</button><button type="submit" form={formId} className="btn btn-primary" disabled={busy}>{busy ? tx("保存中…") : tx("保存组织记忆")}</button></>}>
    <form id={formId} className="om-editor" onSubmit={(e) => { e.preventDefault(); onSave() }}>
    <label className="om-wide"><span>{tx("记忆名称")}</span><input required maxLength="240" value={value.title} onChange={(e) => setValue({ ...value, title: e.target.value })} placeholder={tx("组织共同记忆")} /></label>
    {FIELDS.map(([key, label]) => <label key={key} className={key === 'summary' ? 'om-wide' : ''}><span>{label}</span><textarea maxLength={key === 'summary' ? 6000 : 3000} rows={key === 'summary' ? 5 : 3} value={value.fields[key] || ''} onChange={(e) => setField(key, e.target.value)} /></label>)}
    </form>
  </Modal>
}

export default function OrgMemory() {
  useLocale()
  const listRef = useViewportHeight(180)
  // undefined means not loaded; null means this organization has no current memory.
  const [current, setCurrent] = useState(undefined)
  const [editing, setEditing] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const request = useRef(0)
  const mutating = useRef(false)
  // Cross-organization browsing stays a superadministrator capability: scoped
  // org.manage accounts are rejected by the server for other organizations.
  const me = getUser()
  const canBrowseOrgs = !!(me && me.isSuper)
  const [orgs, setOrgs] = useState([])
  const [orgId, setOrgId] = useState((me && me.orgId) || '')
  function switchOrg(next) {
    if (mutating.current || next === orgId) return
    setEditing(null)
    setPendingDelete(null)
    setCurrent(undefined)
    setError('')
    setOrgId(next)
  }
  async function load() {
    const version = ++request.current
    try {
      const data = await api.orgMemories({ orgId: orgId || undefined })
      const records = (data.items || []).filter((item) => !item.archived)
      // An old server must not silently choose a record for the user to overwrite.
      if (records.length > 1) throw new Error(tx("组织记忆数据需要合并，请更新服务后重新加载。"))
      if (!mounted.current || version !== request.current) return
      setCurrent(records[0] || null); setError('')
    } catch (e) {
      if (mounted.current && version === request.current) setError(e.message || tx("组织记忆加载失败"))
    }
  }
  useEffect(() => {
    mounted.current = true
    load()
    return () => { mounted.current = false; ++request.current }
  }, [orgId])
  useEffect(() => {
    if (!canBrowseOrgs) return
    api.orgs().then((rows) => {
      const list = rows || []
      if (!mounted.current) return
      setOrgs(list)
      if (!orgId && list[0]) setOrgId(list[0].id)
    }).catch(() => { if (mounted.current) setOrgs([]) })
  }, [])
  async function save() {
    if (!editing || mutating.current) return
    mutating.current = true; ++request.current; setBusy(true)
    try {
      const body = { title: editing.title, fields: editing.fields, confirmed: true }
      if (editing.id) body.revision = editing.revision
      else if (orgId) body.orgId = orgId
      const result = editing.id ? await api.updateOrgMemory(editing.id, body) : await api.createOrgMemory(body)
      if (!mounted.current) return
      setCurrent(result.item); setError(''); setEditing(null); toast(tx("组织记忆已保存"))
    } catch (e) {
      if (mounted.current) toast(tx("保存失败：") + (e.status === 409 ? tx("组织记忆已被更新，请保留草稿，关闭编辑后重新加载。") : (e.message || tx("请稍后重试"))))
    } finally {
      mutating.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function remove(item) {
    if (mutating.current) return
    mutating.current = true; ++request.current; setBusy(true)
    try {
      await api.deleteOrgMemory(item.id)
      if (!mounted.current) return
      setCurrent(null); setPendingDelete(null); toast(tx("组织记忆已删除"))
    } catch (e) {
      if (mounted.current) toast(e.message || tx("删除失败"))
    } finally {
      mutating.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const editCurrent = () => setEditing(current ? { ...current, fields: { ...(current.fields || {}), summary: current.fields?.summary ?? '' } } : blank())
  if (error && current === undefined) return <div className="om-page"><div className="om-error" role="alert"><Icon name="alert" /><b>{tx("组织记忆没有加载出来")}</b><span>{error}</span><button className="btn btn-ghost" onClick={load}>{tx("重新加载")}</button></div></div>
  if (current === undefined) return <Loading />
  return <section className="om-page">
    <header className="om-head om-head-actions-only">
      <p className="om-description">{tx("从团队已交付的共享工作中自动积累，持续汇成一份组织记忆。")}</p>
      {canBrowseOrgs && orgs.length > 1 && <FilterSelect className="f-sel om-org-select" value={orgId}
        resetValue={(me && me.orgId) || ''} aria-label={tx("选择组织")}
        onChange={(event) => switchOrg(event.target.value)} disabled={busy || !!editing}>
        {orgOptions(orgs).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </FilterSelect>}
      <button className="btn btn-ghost" disabled={busy || !!editing} onClick={load}>{tx("重新加载")}</button>
      <button className="btn btn-primary" disabled={busy || !!error} onClick={editCurrent}><Icon name={current ? 'pencil' : 'plus'} />{tx("补充与修正")}</button>
    </header>
    {error && <div className="om-error" role="alert">{error}</div>}
    {!current ? <div className="om-empty"><Icon name="memory" /><b>{tx("等待团队工作沉淀")}</b><span>{tx("共享需求完成交付后会自动形成记忆，无需手动创建。也可以补充团队约定。")}</span><button className="btn btn-ghost" disabled={!!error} onClick={editCurrent}>{tx("补充与修正")}</button></div>
      : <div className="om-list admin-viewport-list" ref={listRef} role="region" tabIndex={0} aria-label={tx("组织记忆")}>
        <article className="om-document">
          <header className="om-document-head">
            <div className="om-card-mark"><Icon name="memory" /></div>
            <div className="om-card-body"><h3>{current.title}</h3><small>{tx("更新于 ")}{current.updatedAt ? new Date(current.updatedAt).toLocaleString(getLocale()) : tx("刚刚")}{tx("· 修订版本")}{current.revision || 1}</small></div>
            <button className="admin-card-action is-danger" disabled={busy} onClick={() => setPendingDelete(current)}>{tx("删除")}</button>
          </header>
          <div className="om-sections">
            {current.automaticSummary && <section className="om-section om-wide om-automatic"><h4>{tx("自动沉淀")} · {current.sourceCount || 0} {tx("项共享工作")}</h4>
              <div className="om-auto-list">
                {splitAutomaticSummary(current.automaticSummary).map((entry, index) => <details key={`${entry.title}-${index}`} className="om-auto-entry" open={index === 0}>
                  <summary><span className="om-auto-index">{String(index + 1).padStart(2, '0')}</span><b>{entry.title || tx("自动沉淀")}</b><span className="om-auto-chevron" aria-hidden="true">›</span></summary>
                  {entry.body && <div className="om-auto-body"><p>{entry.body}</p></div>}
                </details>)}
              </div>
            </section>}
            {FIELDS.map(([key, label]) => {
            const content = current.fields?.[key]
            return content ? <section className={'om-section' + (key === 'summary' ? ' om-wide' : '')} key={key}><h4>{label}</h4><p>{content}</p></section> : null
          })}</div>
        </article>
      </div>}
    {editing && <Editor value={editing} setValue={setEditing} onSave={save} onClose={() => { if (!mutating.current) setEditing(null) }} busy={busy} />}
    {pendingDelete && <Confirm title={tx("删除组织记忆")} text={tx("删除当前记忆并忘记已积累的工作摘要？历史归档会保留，后续新工作仍会自动形成记忆。")}
      danger confirmText={tx("删除")} onConfirm={() => remove(pendingDelete)} onClose={() => { if (!mutating.current) setPendingDelete(null) }} />}
  </section>
}
