import { translateText as tx, localeMap, useLocale } from '../i18n.js'
/*
 * Enterprise repository catalog exposes sync health, search, and project attachment. Each
 * source uses a dedicated backend account with expandable credential controls and an
 * immediate test action.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, can } from '../api.js'
import { FilterInput } from '../FilterControls.jsx'
import { useViewportHeight } from '../viewport-height.js'
import { Icon, Loading, Modal, toast, SelectMenu } from '../ui.jsx'
import RepositoryIssueSync, { RepositoryIssueSyncStatus } from './RepositoryIssueSync.jsx'
import './project-governance.css'
import './repositories.css'

/*
 * Match shared pg-empty classes and structure so container styling correctly constrains
 * SVG icons.
 */
function EmptyPanel({ icon, title, text }) {
  const uiLocale = useLocale();
  return <div className="pg-empty"><span><Icon name={icon} /></span><b>{title}</b><p>{text}</p></div>
}

const fmtTime = (ms) => {
  if (!ms) return tx("从未同步")
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const supportsIssues = (provider) => ['gitlab', 'github'].includes(String(provider || '').toLowerCase())

const PROVIDER_META = localeMap(() => ({
  github: { mark: 'GH', label: 'GitHub', hint: '使用可读取仓库的 Personal Access Token；需要回写标签时还须有 Issue 写入权限。' },
  gitlab: { mark: 'GL', label: 'GitLab', hint: '密码或 Personal Access Token 都可以（公司 GitLab 走 LDAP 登录，SoduWork 会自动换会话）。' },
}))

export default function Repositories() {
  const listRef = useViewportHeight()
  const uiLocale = useLocale();
  const [integrations, setIntegrations] = useState([])
  const [catalog, setCatalog] = useState([])
  const [loading, setLoading] = useState(true)
  const [catalogError, setCatalogError] = useState(null)
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState('')
  const [syncing, setSyncing] = useState('')
  const [mapping, setMapping] = useState(null)   // Selected catalog row for the project-attachment dialog.

  const [issueSettings, setIssueSettings] = useState(null)
  const loadRequest = useRef(0)
  const manage = can('integration.manage')

  const sources = useMemo(() => integrations.filter(
    (i) => supportsIssues(i.type) && i.enabled !== false), [integrations, uiLocale])

  const load = useCallback(async () => {
    const request = ++loadRequest.current
    setLoading(true)
    setCatalogError(null)
    try {
      const ints = manage ? await api.integrations() : []
      if (request !== loadRequest.current) return
      setIntegrations(ints || [])
      const usable = (ints || []).filter((item) => supportsIssues(item.type))
      // Preserve per-source capacity and keep one failed source from hiding healthy repositories.
      let results
      if (usable.length) {
        const settled = await Promise.allSettled(usable.map((item) => api.repositoryCatalog(item.id)))
        if (request !== loadRequest.current) return
        results = settled.filter((result) => result.status === 'fulfilled').map((result) => result.value)
        const failures = settled.flatMap((result, index) => result.status === 'rejected'
          ? [{ id: usable[index].id, name: usable[index].name || usable[index].id, detail: result.reason?.message || String(result.reason) }]
          : [])
        if (failures.length) setCatalogError({ failures, retained: results.length === 0 })
        if (!results.length) return
      } else {
        results = [await api.repositoryCatalog()]
      }
      if (request !== loadRequest.current) return
      setCatalog([...new Map(results.flatMap((result) => result.items || []).map((row) => [row.id, row])).values()])
    } catch (e) { if (request === loadRequest.current) toast(tx("仓库目录没有加载：") + e.message) }
    finally { if (request === loadRequest.current) setLoading(false) }
  }, [manage])
  useEffect(() => { load(); return () => { loadRequest.current += 1 } }, [load])

  async function sync(sourceId) {
    setSyncing(sourceId)
    try {
      const result = await api.syncRepositoryCatalog(sourceId)
      toast(tx("仓库目录已同步：") + result.total + tx(" 个仓库"))
      await load()
    } catch (e) { toast(tx("同步失败：") + e.message) } finally { setSyncing('') }
  }

  const shown = catalog.filter((row) => {
    if (provider && String(row.provider) !== provider) return false
    const q = query.trim().toLowerCase()
    return !q || [row.fullName, row.displayName].some((v) => String(v || '').toLowerCase().includes(q))
  })
  const counts = useMemo(() => {
    const by = {}
    for (const row of catalog) by[row.provider] = (by[row.provider] || 0) + 1
    return by
  }, [catalog])
  return <section className="pg-work-panel rc-page">
    {manage && <div className="rc-sources">
      {sources.length ? sources.map((s) => <SourceCard key={s.id} source={s}
        syncing={syncing === s.id} anySyncing={!!syncing}
        onSync={() => sync(s.id)} onSaved={load} />)
        : <EmptyPanel icon="plug" title={tx("还没有代码源")} text={tx("先在「系统集成」接入 GitHub 或 GitLab，再配置拉取账号并同步仓库目录。")} />}
    </div>}

    {!loading && catalogError && <div className="rc-source-err" role="alert">
      <strong>{catalogError.retained ? tx("仓库目录读取失败，暂时保留已有目录。") : tx("部分仓库目录读取失败，以下代码源暂未显示。")}</strong>
      <ul>{catalogError.failures.map((failure) => <li key={failure.id}>{failure.name}{'：'}{failure.detail}</li>)}</ul>
      <button className="btn btn-ghost btn-sm" onClick={load}>{tx("重新加载")}</button>
    </div>}

    <div className={'rc-toolbar admin-filterbar' + (catalog.length ? '' : ' is-empty')}>
      <FilterInput className="rc-search" type="search" aria-label={tx("搜索仓库名称或路径")} value={query} onChange={(e) => setQuery(e.target.value)} disabled={!catalog.length} placeholder={tx("搜索 ") + catalog.length + tx(" 个仓库（名称 / 路径）")} />
      <div className="rc-filters admin-segmented admin-filter-options" role="group" aria-label={tx("仓库来源")}>
        <button disabled={!catalog.length} aria-pressed={provider === ''} className={provider === '' ? 'on' : ''} onClick={() => setProvider('')}>{tx("全部")}<b>{catalog.length}</b></button>
        {Object.entries(counts).map(([p, n]) => <button disabled={!catalog.length} key={p} aria-pressed={provider === p} className={provider === p ? 'on' : ''} onClick={() => setProvider(p)}>{(PROVIDER_META[p] || {}).label || p}<b>{n}</b></button>)}
      </div>
    </div>

    {loading ? <Loading /> : shown.length ? <div ref={listRef} className="rc-list" tabIndex="0" role="region" aria-label={tx("仓库列表，可滚动")}>
      <div className="rc-table-head" role="row"><span>{tx("来源")}</span><span>{tx("仓库名称 / 路径")}</span><span>{tx("默认分支")}</span><span>{tx("状态")}</span><span>{tx("操作")}</span></div>
      {shown.map((row) => <div key={row.id} className="rc-row">
        <span className={'rc-mark rc-pv-' + row.provider}>{(PROVIDER_META[row.provider] || {}).mark || '↗'}</span>
        <span className="rc-name">
          <b title={row.displayName || row.fullName}>{row.displayName || row.fullName}</b>
          <small title={row.fullName}>{row.fullName}</small>
        </span>
        <em className="rc-branch" title={row.defaultBranch || 'main'}>{row.defaultBranch || 'main'}</em>
        <span className="rc-row-state">
          {row.archived ? <i className="rc-flag">{tx("已归档")}</i> : <i className="rc-flag active">{tx("可用")}</i>}
          {supportsIssues(row.provider) && <RepositoryIssueSyncStatus value={row.issueSync} />}
        </span>
        <span className="rc-row-actions admin-row-actions">
          {manage && supportsIssues(row.provider) && <button className="admin-text-action" onClick={() => setIssueSettings(row)}>{tx("配置 Issue 同步")}</button>}
          {row.webUrl && <a className="admin-text-action" href={row.webUrl} target="_blank" rel="noreferrer">{tx("在源站打开")}</a>}
          {can('task.dispatch') && <button className="admin-text-action" onClick={() => setMapping(row)}>{tx("挂进项目")}</button>}
        </span>
      </div>)}
    </div> : (sources.length > 0 || catalog.length > 0 || !manage) ? <EmptyPanel icon="box" title={catalog.length ? tx("没有匹配的仓库") : tx("目录里还没有仓库")}
      text={catalog.length ? tx("换个关键词试试。") : manage ? tx("在上方代码源卡片配好拉取账号，点「立即同步」。") : tx("请联系管理员同步仓库目录。")} /> : null}

    {manage && issueSettings && <RepositoryIssueSync key={issueSettings.id} row={issueSettings}
      onClose={() => setIssueSettings(null)}
      onUpdated={(value) => setCatalog((items) => items.map((row) => row.id === issueSettings.id ? { ...row, issueSync: value } : row))} />}
    {mapping && <MapToProjectModal row={mapping} onClose={() => setMapping(null)}
      onDone={() => { setMapping(null); toast(tx("已挂进项目，可在「项目与仓库」里继续配置流程")) }} />}
  </section>
}

/* Source cards summarize health and expand account configuration on demand. */
function SourceCard({ source: s, syncing, anySyncing, onSync, onSaved }) {
  const uiLocale = useLocale();
  const meta = PROVIDER_META[String(s.type).toLowerCase()] || { mark: '↗', label: s.type, hint: '' }
  const [open, setOpen] = useState(false)
  const [user, setUser] = useState(s.pullAccountUser || '')
  const [secret, setSecret] = useState('')
  const isGitHub = String(s.type).toLowerCase() === 'github'
  const [kind, setKind] = useState(isGitHub ? 'token' : (s.pullAccountKind || ''))
  const pending = useRef(false)
  const active = useRef(true)
  const [probe, setProbe] = useState(null)     // {ok, detail} | {busy:true}
  const [saving, setSaving] = useState(false)
  const manage = can('integration.manage')
  const busy = saving || !!probe?.busy
  const bad = s.repositorySyncOk === false
  const base = (s.config || {}).base_url || ''
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  function draft() {
    if (!user.trim()) { toast(tx("请填用户名")); return null }
    if (!secret && !s.pullAccountSet) { toast(isGitHub ? tx("第一次配置需要填令牌") : tx("第一次配置需要填密码/令牌")); return null }
    return { user: user.trim(), secret: secret || null, kind }
  }
  function edit(setter, value) {
    if (pending.current) return
    setter(value)
    setProbe(null)
  }
  async function test() {
    if (pending.current) return
    const body = draft()
    if (!body) return
    pending.current = true
    setProbe({ busy: true })
    try {
      const result = await api.testPullAccount(s.id, body)
      if (active.current) setProbe(result)
    } catch (e) { if (active.current) setProbe({ ok: false, detail: e.message }) }
    finally { pending.current = false }
  }
  async function save() {
    if (pending.current) return
    const body = draft()
    if (!body) return
    pending.current = true
    setSaving(true)
    setProbe(null)
    try {
      await api.savePullAccount(s.id, body)
      if (!active.current) return
      toast(tx("拉取账号已保存"))
      setSecret('')
      try {
        const result = await api.testPullAccount(s.id, {})
        if (active.current) setProbe(result)
      } catch (e) {
        if (active.current) setProbe({ ok: false, detail: tx("账号已保存，但连接验证失败：") + e.message })
      }
      if (active.current) onSaved()
    } catch (e) { if (active.current) toast(tx("保存失败：") + e.message) }
    finally { pending.current = false; if (active.current) setSaving(false) }
  }

  return <article className={'rc-source' + (bad ? ' bad' : '')}>
    <div className="rc-source-main">
      <span className={'rc-mark lg rc-pv-' + String(s.type).toLowerCase()}>{meta.mark}</span>
      <div className="rc-source-id">
        <b>{s.name}</b>
        <small>{base || meta.label}</small>
      </div>
      <div className="rc-source-nums">
        <div><b>{s.repositorySyncCount || 0}</b><span>{tx("仓库")}</span></div>
        <div><b className={bad ? 'bad' : 'ok'}><i />{bad ? tx("同步失败") : s.repositorySyncAt ? tx("正常") : tx("待同步")}</b>
          <span>{fmtTime(s.repositorySyncAt)}</span></div>
      </div>
      {manage && <div className="rc-source-act">
        <button className={'rc-acct' + (s.pullAccountSet ? ' set' : '') + (open ? ' open' : '')}
          onClick={() => setOpen(!open)}
          title={s.pullAccountSet ? tx("拉取账号已配置，点开可改") : tx("还没配拉取账号，点开配置")}>
          <Icon name="key" />{s.pullAccountSet ? (s.pullAccountUser || tx("已配置")) : tx("配拉取账号")}
          <Icon name="chevron" />
        </button>
        <button className="btn btn-ghost btn-sm" disabled={anySyncing} onClick={onSync}>
          <Icon name="refresh" />{syncing ? tx("同步中…") : tx("立即同步")}</button>
      </div>}
    </div>
    {bad && <div className="rc-source-err" title={s.repositorySyncError}>{s.repositorySyncError || tx("上次同步失败")}</div>}
    {manage && open && <div className="rc-source-cfg">
      <label className="pg-field"><span>{tx("拉取账号用户名")}</span>
        <input className="f-in" value={user} disabled={busy} onChange={(e) => edit(setUser, e.target.value)} placeholder={tx("例如 gengyong.hu")} /></label>
      <label className="pg-field"><span>{tx("认证方式")}</span>
        <SelectMenu className="f-sel" value={kind} disabled={busy} onChange={(e) => edit(setKind, e.target.value)}>
          {!isGitHub && <option value="">{tx("自动识别")}</option>}
          {!isGitHub && <option value="password">{tx("登录密码")}</option>}
          <option value="token">Personal Access Token</option>
        </SelectMenu></label>
      <label className="pg-field"><span>{isGitHub ? 'Personal Access Token' : tx("密码 / 令牌")}</span>
        <input className="f-in" type="password" value={secret} disabled={busy} onChange={(e) => edit(setSecret, e.target.value)}
          placeholder={s.pullAccountSet ? tx("已配置——留空表示不改") : tx("第一次配置必填")} /></label>
      <div className="rc-cfg-actions">
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={test}>
          {probe?.busy ? tx("正在测…") : tx("测一下")}</button>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>
          {saving ? tx("保存中…") : tx("保存")}</button>
        <small>{meta.hint}</small>
      </div>
      {probe && !probe.busy && <div className={'rc-probe ' + (probe.ok ? 'ok' : 'bad')}>
        <Icon name={probe.ok ? 'check' : 'alert'} />{probe.detail || (probe.ok ? tx("通了") : tx("没通过"))}</div>}
    </div>}
  </article>
}

/* Attach catalog entries through the same addRepoFromCatalog API used by project views. */
function MapToProjectModal({ row, onClose, onDone }) {
  const uiLocale = useLocale();
  const [projects, setProjects] = useState([])
  const [pid, setPid] = useState('')
  const [branches, setBranches] = useState([row.defaultBranch || 'main'])
  const [form, setForm] = useState({
    name: row.displayName || row.fullName, kind: 'other',
    branch: row.defaultBranch || 'main', mergeBranch: row.defaultBranch || 'main', localDir: '',
  })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api.projects().then((items) => {
      setProjects(items || [])
      if ((items || [])[0]) setPid(items[0].id)
    }).catch((e) => toast(tx("项目列表没有加载：") + e.message))
    api.repositoryBranches(row.id)
      .then((r) => { if ((r.items || []).length) setBranches(r.items) })
      .catch(() => {})   // Fall back to the default branch if branch lookup is unavailable.
  }, [row.id])

  async function save() {
    if (!pid) return toast(tx("请选择项目"))
    if (!form.branch.trim()) return toast(tx("请选择工作分支"))
    setBusy(true)
    try {
      await api.addRepoFromCatalog(pid, { catalogId: row.id, ...form })
      onDone()
    } catch (e) { toast(tx("没挂上：") + e.message) } finally { setBusy(false) }
  }

  return <Modal scope="project-governance" title={tx("挂进项目：") + (row.displayName || row.fullName)} onClose={onClose} footer={
    <>
      <button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button>
      <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? tx("正在挂载…") : tx("挂进项目")}</button>
    </>
  }>
    <div className="rc-map-grid">
      <label>{tx("项目")}<SelectMenu className="f-sel" value={pid} onChange={(e) => setPid(e.target.value)}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </SelectMenu></label>
      <label>{tx("在项目里叫什么")}<input className="f-in" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      <label>{tx("工作分支（执行时从这里拉）")}<SelectMenu className="f-sel" value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value, mergeBranch: form.mergeBranch === form.branch ? e.target.value : form.mergeBranch })}>
          {branches.map((b) => <option key={b} value={b}>{b}</option>)}
        </SelectMenu></label>
      <label>{tx("合并目标分支（交付判定）")}<SelectMenu className="f-sel" value={form.mergeBranch} onChange={(e) => setForm({ ...form, mergeBranch: e.target.value })}>
          {branches.map((b) => <option key={b} value={b}>{b}</option>)}
        </SelectMenu></label>
    </div>
    <p className="rc-map-note">{tx("挂载只是登记映射，不会立即拉代码；安排执行时执行机才按需 clone。")}</p>
  </Modal>
}
