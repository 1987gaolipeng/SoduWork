import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, can } from '../api.js'
import { FilterInput, FilterSelect } from '../FilterControls.jsx'
import { useViewportHeight } from '../viewport-height.js'
import { useAsync, Loading, Icon, ErrorState, LiveDot, AUTO, toast, Confirm, Modal, SelectMenu } from '../ui.jsx'
import { DevFlowModal, DevFlowPreview, DevFlowSummary } from './DevFlowCfg.jsx'
import { RepoSkills } from './Skills.jsx'
import './project-governance.css'
import './project-detail.css'
import { requirementSummary, requirementStage, REQUIREMENT_LABELS } from './requirement-governance.js'

const NODE_COLOR = { todo: 'var(--ink-4)', doing: 'var(--c-blue)', done: 'var(--ok)', cancel: 'var(--offline)' }
const REPO_KIND = localeMap(() => ({ backend: '后端服务', frontend: '前端应用', mobile: '移动应用', infra: '基础设施', other: '其他模块' }))
const REQUIREMENT_STAGE_LABEL = localeMap(() => REQUIREMENT_LABELS)

function computeLevels(tasks) {
  const ids = new Set(tasks.map((t) => t.id)); const byId = {}; const memo = {}
  tasks.forEach((t) => { byId[t.id] = t })
  const level = (id, seen) => {
    if (memo[id] != null) return memo[id]
    if (seen.has(id)) return 0
    seen.add(id)
    const deps = ((byId[id] && byId[id].deps) || []).filter((x) => ids.has(x))
    memo[id] = deps.length ? Math.max(...deps.map((x) => level(x, seen))) + 1 : 0
    return memo[id]
  }
  tasks.forEach((t) => level(t.id, new Set()))
  return memo
}
function isWaiting(t, byId) { return !['closed', 'delivered'].includes(requirementStage(t)) && (t.deps || []).some((id) => byId[id] && byId[id].status !== 'done') }

function ProjectGraph({ tasks }) {
  const uiLocale = useLocale();
  if (!tasks.length) return <EmptyPanel icon="sitemap" title={tx("还没有项目需求")} text={tx("创建第一项需求后，可通过前置依赖组织串行与并行关系。")} />
  const byId = {}; tasks.forEach((t) => { byId[t.id] = t })
  const levels = computeLevels(tasks); const max = Math.max(0, ...Object.values(levels))
  const cols = Array.from({ length: max + 1 }, (_, i) => tasks.filter((t) => levels[t.id] === i))
  return <div className="pg-graph-scroll"><div className="pg-graph">
    {cols.map((col, i) => <React.Fragment key={i}>
      <section className="pg-stage">
        <header><span>{String(i + 1).padStart(2, '0')}</span><b>{tx("阶段 ")}{i + 1}</b><small>{col.length > 1 ? tx("{0} 项并行", [col.length]) : tx("顺序执行")}</small></header>
        {col.map((t) => {
          const waiting = isWaiting(t, byId); const state = t.status === 'done' ? 'done' : waiting ? 'waiting' : t.status
          const color = t.status === 'done' ? NODE_COLOR.done : waiting ? 'var(--ink-4)' : (NODE_COLOR[t.status] || NODE_COLOR.todo)
          return <article className={'pg-task-node ' + state} key={t.id} style={{ '--node-color': color }}>
            <div className="pg-task-state"><i />{t.archivedAt ? tx("已归档") : waiting ? tx("等待前置") : (REQUIREMENT_STAGE_LABEL[requirementStage(t)] || t.status)}</div>
            <b>{t.title}</b><small>{t.ownerName || tx("尚未指派执行终端")}</small>
          </article>
        })}
      </section>
      {i < cols.length - 1 && <span className="pg-stage-arrow" aria-hidden="true">→</span>}
    </React.Fragment>)}
  </div></div>
}

function EmptyPanel({ icon, title, text, action }) {
  const uiLocale = useLocale();
  return <div className="pg-empty"><span><Icon name={icon} /></span><b>{title}</b><p>{text}</p>{action}</div>
}

function Field({ label, note, children, wide }) {
  const uiLocale = useLocale();
  return <label className={'pg-field' + (wide ? ' wide' : '')}><span>{label}</span>{children}{note && <small>{note}</small>}</label>
}

function ProjectModal({ project, owners, onClose, onSave }) {
  const uiLocale = useLocale();
  const [form, setForm] = useState(project || { name: '', group: '', desc: '', repoUrl: '', ownerUserId: '' })
  const [busy, setBusy] = useState(false); const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  async function save() {
    if (!form.name.trim()) return toast(tx("请填写项目名称"))
    if (!project && !form.ownerUserId) return toast(tx("请选择项目负责人"))
    if (form.repoUrl && !/^https?:\/\//.test(form.repoUrl)) return toast(tx("代码地址要以 http(s):// 开头"))
    const payload = { name: form.name.trim(), group: form.group.trim(), desc: form.desc.trim(), repoUrl: form.repoUrl.trim() }
    if (!project) payload.ownerUserId = form.ownerUserId
    setBusy(true); try { await onSave(payload) } catch (e) { toast(tx("项目没有保存：") + e.message) } finally { setBusy(false) }
  }
  return <Modal scope="project-governance" title={project ? tx("编辑项目信息") : tx("新建项目")} icon="box" wide onClose={onClose} foot={<><button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button><button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? tx("保存中…") : project ? tx("保存项目") : tx("创建项目")}</button></>}>
    <div className="pg-modal-intro"><b>{project ? tx("维护项目资产的基本身份") : tx("先建立项目，再逐步接入仓库、流程与发布环境")}</b><span>{tx("这里登记的是业务项目；前端、后端等代码资产在项目内作为独立仓库管理。")}</span></div>
    <div className="pg-form-grid">
      <Field label={tx("项目名称")}><input autoFocus className="f-in" value={form.name || ''} onChange={set('name')} placeholder={tx("例如：示例社区")} /></Field>
      <Field label={tx("业务分组")}><input className="f-in" value={form.group || ''} onChange={set('group')} placeholder={tx("例如：内部产品")} /></Field>
      {!project && <Field label={tx("项目负责人")} wide><SelectMenu className="f-in" value={form.ownerUserId || ''} onChange={set('ownerUserId')}><option value="">{tx("选择负责人…")}</option>{owners.map((o) => <option value={o.id} key={o.id}>{o.name}{o.username ? ` · ${o.username}` : ''}</option>)}</SelectMenu></Field>}
      <Field label={tx("项目说明")} wide><textarea className="f-in" rows="3" value={form.desc || ''} onChange={set('desc')} placeholder={tx("说明项目服务对象、业务目标与交付边界")} /></Field>
      <Field label={tx("主代码地址（可选）")} note={tx("多个代码仓库请在项目详情中分别登记")} wide><input className="f-in" value={form.repoUrl || ''} onChange={set('repoUrl')} placeholder="https://gitlab.example.com/team/project" /></Field>
    </div>
  </Modal>
}

function AddTaskModal({ pid, tasks, clients, onClose, onDone }) {
  const uiLocale = useLocale();
  const [title, setTitle] = useState(''); const [target, setTarget] = useState(''); const [deps, setDeps] = useState([]); const [busy, setBusy] = useState(false)
  const toggle = (id) => setDeps((x) => x.includes(id) ? x.filter((v) => v !== id) : [...x, id])
  async function add() {
    if (!title.trim()) return toast(tx("请填写需求标题"))
    if (!target) return toast(tx("请选择接收需求的 SoduWork"))
    setBusy(true); try { await api.addProjectTask(pid, { title: title.trim(), target, deps, triageStage: 'intake' }); onDone() } catch (e) { toast(tx("需求没有创建：") + e.message) } finally { setBusy(false) }
  }
  return <Modal scope="project-governance" title={tx("添加项目需求")} icon="ticket" wide onClose={onClose} foot={<><button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button><button className="btn btn-primary" disabled={busy} onClick={add}>{tx("创建需求")}</button></>}>
    <div className="pg-form-grid"><Field label={tx("需求标题")} wide><input autoFocus className="f-in" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tx("例如：完成前端交互开发与自测")} /></Field><Field label={tx("接收终端")} wide><SelectMenu className="f-in" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">{tx("选择 SoduWork…")}</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name || c.id}{c.online ? '' : tx(" · 离线")}</option>)}</SelectMenu></Field></div>
    {tasks.length > 0 && <section className="pg-dependencies"><b>{tx("前置需求")}</b><p>{tx("新需求进入需求池待整理；澄清后设为待交付。选定的前置需求交付后，才能安排执行。")}</p><div>{tasks.map((t) => <button type="button" key={t.id} className={deps.includes(t.id) ? 'on' : ''} onClick={() => toggle(t.id)}><i />{t.title}</button>)}</div></section>}
  </Modal>
}

function ProjectOwner({ project, owners, onSaved }) {
  const uiLocale = useLocale();
  const [value, setValue] = useState(project.ownerUserId || ''); const [busy, setBusy] = useState(false)
  useEffect(() => setValue(project.ownerUserId || ''), [project.ownerUserId])
  async function save() { if (!value) return toast(tx("请选择项目负责人")); setBusy(true); try { const r = await api.updateProject(project.id, { ownerUserId: value }); toast(((r.pendingRerouted || {}).requests || 0) ? tx("负责人已更新，待审批事项已重新分配") : tx("负责人已更新")); onSaved() } catch (e) { toast(tx("负责人没有保存：") + e.message) } finally { setBusy(false) } }
  return <section className="pg-owner-panel"><span className="pg-owner-avatar">{(project.ownerName || tx("未")).slice(0, 1)}</span><div><small>{tx("项目负责人")}</small><b>{project.ownerName || tx("尚未设置")}</b><p>{tx("负责业务判断、审阅与最终验收，不代替 AI 编写和修改代码。")}</p></div>{can('task.dispatch') && <div className="pg-owner-edit"><SelectMenu className="f-in" value={value} onChange={(e) => setValue(e.target.value)}><option value="">{tx("选择负责人…")}</option>{owners.map((o) => <option value={o.id} key={o.id}>{o.name}{o.username ? ` · ${o.username}` : ''}</option>)}</SelectMenu><button className="btn btn-primary btn-sm" disabled={busy || !value || value === project.ownerUserId} onClick={save}>{busy ? tx("保存中…") : tx("更新")}</button></div>}</section>
}

function RepoEditor({ repo, isNew, dfDefault, dfSteps, onCancel, onSave }) {
  const uiLocale = useLocale();
  const [form, setForm] = useState(repo); const [tab, setTab] = useState('base'); const [flowOpen, setFlowOpen] = useState(false); const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  async function save() { if (!form.name.trim()) return toast(tx("请填写仓库名称")); setBusy(true); try { await onSave(form) } catch (e) { toast(tx("仓库没有保存：") + e.message) } finally { setBusy(false) } }
  const flowKeys = Object.values(form.devFlow || {}).filter((v) => Array.isArray(v) ? v.length : String(v || '').trim()).length
  const tabs = [['base', tx("仓库信息")], ['delivery', tx("AI 交付")], ['flow', tx("研发规则")], ['skills', tx("能力配置")]]
  return <div className="pg-repo-editor">
    <header><button className="btn btn-ghost btn-sm" onClick={onCancel}><Icon name="chevron-left" />{tx("返回仓库列表")}</button><div><small>{isNew ? tx("新建仓库") : tx("仓库设置")}</small><h3>{isNew ? tx("登记代码仓库") : form.name}</h3><p>{tx("把代码位置、交付策略和 AI 工作方法配置在同一个资产上下文中。")}</p></div><span className="ml-auto" /><button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? tx("保存中…") : tx("保存配置")}</button></header>
    <nav className="pg-subtabs">{tabs.map(([id, label]) => <button className={tab === id ? 'on' : ''} onClick={() => setTab(id)} key={id}>{label}{id === 'flow' && flowKeys > 0 ? <i>{flowKeys}</i> : null}</button>)}</nav>
    <div className="pg-editor-body">
      {tab === 'base' && <><div className="pg-section-title"><b>{tx("代码资产身份")}</b><span>{tx("这些信息用于定位仓库和构建真实工作目录。")}</span></div><div className="pg-form-grid">
        <Field label={tx("仓库名称")}><input autoFocus className="f-in" value={form.name || ''} onChange={set('name')} placeholder={tx("例如：Web 前端")} /></Field><Field label={tx("模块类型")}><SelectMenu className="f-in" value={form.kind || 'other'} onChange={set('kind')}>{Object.entries(REPO_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</SelectMenu></Field>
        <Field label={tx("Git 仓库地址")} wide><input className="f-in" value={form.gitUrl || ''} onChange={set('gitUrl')} placeholder="https://gitlab.example.com/team/repo.git" /></Field><Field label={tx("基线分支")}><input className="f-in" value={form.branch || ''} onChange={set('branch')} placeholder="main" /></Field><Field label={tx("工作目录内的相对子目录")}><input className="f-in" value={form.localDir || ''} onChange={set('localDir')} placeholder={tx("例如：apps/web")} /></Field>
        <Field label={tx("运行与验证说明")} wide><textarea className="f-in" rows="4" value={form.note || ''} onChange={set('note')} placeholder={tx("告诉 AI 如何启动、测试和验收这个模块，例如：npm run dev；npm test")} /></Field>
      </div></>}
      {tab === 'delivery' && <><div className="pg-section-title"><b>{tx("AI 完成后的交付动作")}</b><span>{tx("工作副本与合并副本必须隔离，避免未提交改动污染交付。")}</span></div><div className="pg-delivery-status"><StatusChip ok={form.serverDir && form.mergeBranch} label={form.serverDir && form.mergeBranch ? tx("自动合并至 {0}", [form.mergeBranch]) : tx("尚未启用自动合并")} /><StatusChip ok={form.aiWorkDir} label={form.aiWorkDir ? tx("支持服务端自动执行") : tx("仅支持在线终端执行")} /></div><div className="pg-form-grid"><Field label={tx("服务端干净仓库路径")} wide><input className="f-in" value={form.serverDir || ''} onChange={set('serverDir')} placeholder={tx("用于合并的干净仓库副本路径")} /></Field><Field label={tx("目标分支")}><input className="f-in" value={form.mergeBranch || ''} onChange={set('mergeBranch')} placeholder="develop / main" /></Field><Field label={tx("AI 自动执行工作目录")}><input className="f-in" value={form.aiWorkDir || ''} onChange={set('aiWorkDir')} placeholder={tx("必须与上面的合并仓库分开")} /></Field></div><div className="pg-callout"><Icon name="shield" /><div><b>{tx("交付判定")}</b><span>{tx("配置前两项后，AI push 成功不等于交付；SoduWork 会在合并成功后才关闭本阶段，冲突则转为可处理异常。")}</span></div></div></>}
      {tab === 'flow' && <><div className="pg-section-title"><b>{tx("该仓库的研发规则")}</b><span>{tx("只配置例外项，其余继承企业默认流程。")}</span></div><div className="pg-flow-panel"><div><small>{tx("当前生效策略")}</small><DevFlowSummary cfg={form.devFlow} inherit={dfDefault} steps={dfSteps} /></div><div><button className="btn btn-ghost" onClick={() => setFlowOpen(true)}><Icon name="pencil" />{tx("编辑覆盖项")}</button>{!isNew && <DevFlowPreview cfg={form.devFlow} repoId={repo.id} />}</div></div>{flowOpen && <DevFlowModal value={form.devFlow || {}} inherit={dfDefault} defaultSteps={dfSteps} repoId={repo.id} title={tx("研发规则 · ") + (form.name || tx("新仓库"))} onClose={() => setFlowOpen(false)} onSave={(v) => { setForm({ ...form, devFlow: v }); setFlowOpen(false); toast(tx("规则已更新，保存仓库后生效")) }} />}</>}
      {tab === 'skills' && <>{isNew ? <EmptyPanel icon="plug" title={tx("保存仓库后配置能力")} text={tx("企业 Skill 会默认继承；仓库创建后可在这里增加或取消专属能力。")} /> : <RepoSkills repoId={repo.id} repoName={form.name} />}</>}
    </div>
    <footer><span>{tx("配置变更会影响后续安排执行，不会修改仓库中的代码。")}</span><button className="btn btn-ghost" onClick={onCancel}>{tx("取消")}</button><button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? tx("保存中…") : tx("保存配置")}</button></footer>
  </div>
}

function StatusChip({ ok, label }) {
  const uiLocale = useLocale(); return <span className={'pg-status-chip ' + (ok ? 'ok' : 'muted')}><i />{label}</span> }

function CatalogRepoModal({ pid, clients, onClose, onDone }) {
  const uiLocale = useLocale();
  const [integrations, setIntegrations] = useState([])
  const [sourceId, setSourceId] = useState('')
  const [clientId, setClientId] = useState((clients.find((c) => c.online) || clients[0] || {}).id || '')
  const [catalog, setCatalog] = useState([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(null)
  const [branches, setBranches] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ name: '', kind: 'other', branch: '', mergeBranch: '', localDir: '' })
  const sources = integrations.filter((item) => String(item.type || '').toLowerCase() === 'gitlab')
  const canSync = can('integration.manage')

  useEffect(() => {
    api.integrations().then((items) => {
      const usable = (items || []).filter((item) => String(item.type || '').toLowerCase() === 'gitlab' && item.enabled !== false)
      setIntegrations(usable)
      if (usable[0]) setSourceId(usable[0].id)
      else setLoading(false)
    }).catch((e) => { setLoading(false); toast(tx("代码源没有加载：") + e.message) })
  }, [])

  const loadCatalog = useCallback(async (iid) => {
    if (!iid) { setCatalog([]); setLoading(false); return }
    setLoading(true)
    try {
      const result = await api.repositoryCatalog(iid)
      setCatalog(result.items || [])
    } catch (e) {
      setCatalog([])
      toast(tx("仓库目录没有加载：") + e.message)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    setSelected(null); setBranches([]); setQuery('')
    loadCatalog(sourceId)
  }, [sourceId, loadCatalog])

  async function choose(row) {
    setSelected(row)
    const branch = row.defaultBranch || 'main'
    setForm({ name: row.displayName || row.fullName, kind: 'other', branch, mergeBranch: branch, localDir: '' })
    setBranches([branch])
    if (!clientId) return
    try {
      const result = await api.repositoryBranches(row.id, clientId)
      const values = result.items || []
      setBranches(values.length ? values : [branch])
    } catch (e) { toast(tx("分支列表暂不可用，可继续使用默认分支：") + e.message) }
  }

  async function sync() {
    if (!sourceId) return toast(tx("请先接入 GitLab 代码源"))
    if (!clientId) return toast(tx("请选择保存了代码账号的 SoduWork"))
    setSyncing(true)
    try {
      const result = await api.syncRepositoryCatalog(sourceId, clientId)
      await loadCatalog(sourceId)
      toast(tx("仓库目录已同步：") + result.total + tx(" 个仓库"))
    } catch (e) { toast(tx("仓库目录同步失败：") + e.message) } finally { setSyncing(false) }
  }

  async function save() {
    if (!selected) return toast(tx("请选择要加入项目的仓库"))
    if (!form.branch.trim()) return toast(tx("请选择工作分支"))
    setBusy(true)
    try {
      await api.addRepoFromCatalog(pid, {
        catalogId: selected.id, name: form.name.trim(), kind: form.kind,
        branch: form.branch.trim(), mergeBranch: (form.mergeBranch || form.branch).trim(),
        localDir: form.localDir.trim(),
      })
      toast(tx("代码仓库与项目分支已建立映射"))
      onDone()
    } catch (e) { toast(tx("仓库没有加入项目：") + e.message) } finally { setBusy(false) }
  }

  const shown = catalog.filter((row) => !query.trim() || [row.fullName, row.displayName].some((v) => String(v || '').toLowerCase().includes(query.trim().toLowerCase())))
  return <Modal scope="project-governance" title={tx("从远程仓库目录添加")} icon="box" wide onClose={onClose} foot={<><button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button><button className="btn btn-primary" disabled={busy || !selected} onClick={save}>{busy ? tx("正在添加…") : tx("添加到项目")}</button></>}>
    <div className="pg-catalog-lead"><div><b>{tx("选择真实代码资产，再指定这个项目使用的分支")}</b><span>{tx("同一个远程仓库可以服务多个项目；每个项目独立保存工作分支、合并目标与研发规则。")}</span></div>{canSync && <button className="btn btn-ghost btn-sm" disabled={syncing || !sourceId} onClick={sync}><Icon name="refresh" />{syncing ? tx("同步中…") : tx("同步目录")}</button>}</div>
    <div className="pg-catalog-source">
      <Field label={tx("代码源")}><SelectMenu className="f-in" value={sourceId} onChange={(e) => setSourceId(e.target.value)}><option value="">{tx("选择 GitLab…")}</option>{sources.map((item) => <option key={item.id} value={item.id}>{item.name} · {String(item.type).toUpperCase()}</option>)}</SelectMenu></Field>
      <Field label={tx("用于读取的代码账号")}><SelectMenu className="f-in" value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">{tx("选择 SoduWork…")}</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name || client.id}{client.online ? tx(" · 在线") : tx(" · 离线")}</option>)}</SelectMenu></Field>
    </div>
    {!sources.length ? <EmptyPanel icon="plug" title={tx("还没有可用代码源")} text={tx("请先在「系统集成」接入 GitLab，然后回到这里同步仓库目录。")} /> : <div className="pg-catalog-layout">
      <section className="pg-catalog-browser">
        <FilterInput className="pg-catalog-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tx("搜索仓库名称或路径")} />
        <div className="pg-catalog-list">{loading ? <Loading /> : shown.length ? shown.map((row) => <button type="button" key={row.id} className={selected && selected.id === row.id ? 'on' : ''} onClick={() => choose(row)}><span className="pg-catalog-provider">{'GL'}</span><span><b>{row.displayName || row.fullName}</b><small>{row.fullName}</small></span><em>{row.defaultBranch || 'main'}</em></button>) : <div className="pg-catalog-none"><b>{tx("目录里还没有仓库")}</b><span>{canSync ? tx("选择代码账号后点击“同步目录”。") : tx("请联系平台管理员同步企业仓库目录。")}</span></div>}</div>
      </section>
      <section className={'pg-catalog-config' + (selected ? '' : ' empty')}>
        {selected ? <><header><small>PROJECT BRANCH MAPPING</small><b>{selected.fullName}</b><span>{tx("这里只定义该项目如何使用这个仓库，不会修改远程代码。")}</span></header>
          <Field label={tx("在项目中的名称")}><input className="f-in" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label={tx("工程类型")}><SelectMenu className="f-in" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{Object.entries(REPO_KIND).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</SelectMenu></Field>
          <Field label={tx("工作分支")}><input className="f-in" list="pg-catalog-branches" value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value, mergeBranch: form.mergeBranch === form.branch ? e.target.value : form.mergeBranch })} /><datalist id="pg-catalog-branches">{branches.map((branch) => <option value={branch} key={branch} />)}</datalist></Field>
          <Field label={tx("合并目标")}><input className="f-in" list="pg-catalog-branches" value={form.mergeBranch} onChange={(e) => setForm({ ...form, mergeBranch: e.target.value })} /></Field>
          <Field label={tx("工作区相对子目录")} note={tx("留空时按仓库与分支自动生成")}><input className="f-in" value={form.localDir} onChange={(e) => setForm({ ...form, localDir: e.target.value })} placeholder={tx("例如 apps/web")} /></Field>
        </> : <div className="pg-catalog-prompt"><Icon name="box" /><b>{tx("先选择一个仓库")}</b><span>{tx("随后在这里确认项目分支和工程角色。")}</span></div>}
      </section>
    </div>}
  </Modal>
}

function CopyRepoModal({ repo, pid, projects, onClose, onDone }) {
  const uiLocale = useLocale();
  const targets = (projects || []).filter((project) => project.id !== pid)
  const [form, setForm] = useState({ projectId: targets[0] ? targets[0].id : '', name: repo.name, branch: repo.branch || 'main', mergeBranch: repo.mergeBranch || repo.branch || 'main', localDir: '' })
  const [busy, setBusy] = useState(false)
  async function save() {
    if (!form.projectId) return toast(tx("请选择目标项目"))
    if (!form.branch.trim()) return toast(tx("请填写目标项目使用的分支"))
    setBusy(true)
    try {
      await api.copyRepo(repo.id, form)
      toast(tx("仓库映射已复制，发布环境与服务端路径未复制"))
      onDone()
    } catch (e) { toast(tx("仓库映射没有复制：") + e.message) } finally { setBusy(false) }
  }
  return <Modal scope="project-governance" title={tx("复制仓库映射 · ") + repo.name} icon="copy" onClose={onClose} foot={<><button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button><button className="btn btn-primary" disabled={busy || !targets.length} onClick={save}>{busy ? tx("复制中…") : tx("复制到项目")}</button></>}>
    <div className="pg-modal-intro"><b>{tx("复用远程仓库，不复制环境和运行路径")}</b><span>{tx("目标项目可选择自己的工作分支；发布目标、服务端目录和 AI 工作目录需要按目标环境单独配置。")}</span></div>
    {targets.length ? <div className="pg-form-grid">
      <Field label={tx("目标项目")} wide><SelectMenu autoFocus className="f-in" value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>{targets.map((project) => <option value={project.id} key={project.id}>{project.name}{project.group ? ' · ' + project.group : ''}</option>)}</SelectMenu></Field>
      <Field label={tx("项目内名称")}><input className="f-in" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
      <Field label={tx("工作分支")}><input className="f-in" value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} /></Field>
      <Field label={tx("合并目标")}><input className="f-in" value={form.mergeBranch} onChange={(e) => setForm({ ...form, mergeBranch: e.target.value })} /></Field>
      <Field label={tx("工作区相对子目录")}><input className="f-in" value={form.localDir} onChange={(e) => setForm({ ...form, localDir: e.target.value })} placeholder={tx("留空时自动生成")} /></Field>
    </div> : <EmptyPanel icon="box" title={tx("没有其他项目可选")} text={tx("先创建目标项目，再复制这条仓库映射。")} />}
  </Modal>
}

function RepoSection({ pid, repos, loading, reload, clients, projects }) {
  const uiLocale = useLocale();
  const [editing, setEditing] = useState(null); const [isNew, setIsNew] = useState(false); const [del, setDel] = useState(null); const [copying, setCopying] = useState(null); const [catalogOpen, setCatalogOpen] = useState(false); const [dfDefault, setDfDefault] = useState(null); const [dfSteps, setDfSteps] = useState([])
  useEffect(() => { api.devFlow().then((r) => { setDfDefault(r.cfg); setDfSteps(r.defaultSteps || []) }).catch(() => setDfDefault(null)) }, [])
  const blank = { name: '', kind: 'other', localDir: '', branch: 'main', gitUrl: '', note: '', serverDir: '', mergeBranch: '', aiWorkDir: '', devFlow: {} }
  if (editing) return <RepoEditor repo={editing} isNew={isNew} dfDefault={dfDefault} dfSteps={dfSteps} onCancel={() => { setEditing(null); setIsNew(false) }} onSave={async (form) => { if (isNew) await api.addRepo(pid, form); else await api.updateRepo(editing.id, form); await reload(); setEditing(null); setIsNew(false); toast(isNew ? tx("代码仓库已登记") : tx("仓库配置已保存")) }} />
  const openCatalog = () => setCatalogOpen(true)
  return <section className="pg-work-panel"><header className="pg-panel-head"><div><h3>{tx("代码仓库")}</h3><p>{tx("管理项目分支、研发规则与交付配置。")}</p></div>{can('task.dispatch') && <div className="pg-repo-head-actions"><button className="btn btn-ghost" onClick={() => { setEditing(blank); setIsNew(true) }}>{tx("手动登记")}</button><button className="btn btn-primary" onClick={openCatalog}><Icon name="plus" />{tx("从仓库目录添加")}</button></div>}</header>
    {loading ? <Loading /> : repos.length === 0 ? <EmptyPanel icon="box" title={tx("还没有项目代码映射")} text={tx("从 GitLab 仓库目录选择仓库和分支，需求才能准确落到对应工程。")} action={can('task.dispatch') ? <button className="btn btn-primary" onClick={openCatalog}>{tx("从仓库目录添加")}</button> : null} /> : <div className="pg-repo-list">{repos.map((r) => {
      const retired = r.scm === 'gerrit'
      const merged = !retired && r.serverDir && r.mergeBranch; const released = (r.deployTargets || []).length > 0
      const customFlow = Object.values(r.devFlow || {}).some((value) => Array.isArray(value) ? value.length : String(value || '').trim())
      return <article className="pg-repo-row" key={r.id}>
        <span className={'pg-repo-icon kind-' + r.kind}><Icon name={r.kind === 'infra' ? 'monitor' : 'box'} /></span>
        <div className="pg-repo-primary"><div><b>{r.name}</b><span>{REPO_KIND[r.kind] || REPO_KIND.other}</span></div><code title={r.localDir || tx("自动工作目录")}>{r.localDir || tx("自动工作目录")}</code></div>
        <div className="pg-repo-source"><small>{r.sourceRepositoryId ? tx("仓库目录映射") : tx("手动登记")}{tx(" · 工作分支 → 合并目标")}</small><b>{r.branch || 'main'} → {r.mergeBranch || r.branch || 'main'}</b>{r.gitUrl ? <a href={r.gitUrl} target="_blank" rel="noreferrer"><Icon name="external" />{tx("打开远程仓库")}</a> : <span>{tx("未设置 Git 地址")}</span>}</div>
        <div className="pg-repo-health"><span className="pg-repo-config-label">{tx("交付配置")}</span><StatusChip ok={!retired && r.gitUrl} label={retired ? tx("已停用") : r.gitUrl ? tx("代码已接入") : tx("待接入代码")} /><StatusChip ok={merged} label={merged ? tx("已配置自动合并") : tx("未配置自动合并")} /><StatusChip ok={released} label={released ? r.deployTargets.length + tx(" 个发布目标") : tx("未配置发布目标")} /><span className="pg-repo-flow-note">{tx("研发规则 · ")}{customFlow ? tx("仓库覆盖") : tx("继承企业默认")}</span></div>
        {can('task.dispatch') && <div className="pg-row-actions admin-row-actions"><button className="admin-text-action" disabled={retired} onClick={() => setCopying(r)}>{tx("复制")}</button><button className="admin-text-action" disabled={retired} onClick={() => { setEditing(r); setIsNew(false) }}>{tx("管理")}</button><button className="admin-text-action danger" onClick={() => setDel(r)}>{tx("删除")}</button></div>}
      </article>
    })}</div>}
    {catalogOpen && <CatalogRepoModal pid={pid} clients={clients || []} onClose={() => setCatalogOpen(false)} onDone={async () => { setCatalogOpen(false); await reload() }} />}
    {copying && <CopyRepoModal repo={copying} pid={pid} projects={projects || []} onClose={() => setCopying(null)} onDone={async () => { setCopying(null); await reload() }} />}
    {del && <Confirm title={tx("删除代码仓库")} text={tx("确定从项目中移除「") + del.name + tx("」？只删除 SoduWork 中的登记信息，不会修改远程代码。")} danger confirmText={tx("删除登记")} onConfirm={async () => { await api.deleteRepo(del.id); setDel(null); reload() }} onClose={() => setDel(null)} />}
  </section>
}

function AiProjectLink({ pid, current, onSaved }) {
  const uiLocale = useLocale();
  const [data, setData] = useState(null); const [value, setValue] = useState(current || ''); const [busy, setBusy] = useState(false)
  useEffect(() => { api.aiProjects().then(setData).catch(() => setData({ projects: [], reason: tx("执行底座暂不可用") })) }, [])
  useEffect(() => setValue(current || ''), [current])
  if (!data) return <Loading />
  const list = data.projects || []
  return <section className="pg-integration"><span className="pg-integration-icon"><Icon name="link" /></span><div><small>{tx("执行底座项目映射")}</small><h3>{current ? tx("已连接外部项目") : tx("当前无需额外映射")}</h3><p>{list.length ? tx("安排执行后，工单可同步进入执行底座的指定项目。") : (data.reason || tx("当前执行底座没有项目概念，需求仍可正常派发。"))}</p></div>{list.length > 0 && <div className="pg-integration-action"><SelectMenu className="f-in" value={value} onChange={(e) => setValue(e.target.value)}><option value="">{tx("不挂钩")}</option>{list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</SelectMenu>{can('task.dispatch') && <button className="btn btn-primary btn-sm" disabled={busy || value === current} onClick={async () => { setBusy(true); try { await onSaved(value); toast(tx("外部项目映射已保存")) } finally { setBusy(false) } }}>{tx("保存")}</button>}</div>}</section>
}

function ReadinessRail({ project, repos, repoStatus, onOpen }) {
  const uiLocale = useLocale();
  const items = [
    { id: 'owner', icon: 'users', label: tx("项目负责人"), detail: project.ownerName || tx("待指定负责人"), ok: !!project.ownerName, tab: 'overview' },
    { id: 'code', icon: 'box', label: tx("代码仓库"), detail: repos.length ? tx("{0} 个仓库已登记", [repos.length]) : tx("待登记仓库"), ok: repos.length > 0, tab: 'repos' },
    { id: 'delivery', icon: 'sitemap', label: tx("合并规则"), detail: repos.some((r) => r.serverDir && r.mergeBranch) ? tx("已配置自动合并") : tx("待配置合并规则"), ok: repos.some((r) => r.serverDir && r.mergeBranch), tab: 'repos' },
    { id: 'release', icon: 'monitor', label: tx("发布目标"), detail: repos.some((r) => (r.deployTargets || []).length) ? tx("已配置发布目标") : tx("待接入发布环境"), ok: repos.some((r) => (r.deployTargets || []).length), tab: 'repos' },
  ]
  return <section className="pg-readiness"><header><div><h3>{tx("交付配置")}</h3><p>{tx("查看责任归属、代码与环境准备情况。")}</p></div><span>{tx("配置状态")}</span></header><div>{items.map((item) => {
    const pending = item.id !== 'owner' && repoStatus
    return <button key={item.id} className={!pending && item.ok ? 'done' : ''} onClick={() => onOpen(item.tab)}><span><Icon name={item.icon} /></span><div><b>{item.label}</b><small>{pending || item.detail}</small></div><Icon name="chevron" /></button>
  })}</div></section>
}

function ProjectOverview({ project, repos, owners, repoStatus, onReload, onTab }) {
  const uiLocale = useLocale();
  const summary = requirementSummary(project.tasks)
  const { total, done } = summary
  const byId = Object.fromEntries(project.tasks.map((task) => [task.id, task]))
  const blocked = summary.active.filter((task) => isWaiting(task, byId)).length
  return <div className="pg-overview">
    <div className="pg-overview-grid">
      <ProjectOwner project={project} owners={owners} onSaved={onReload} />
      <section className="pg-task-summary">
        <header><h3>{tx("需求交付进度")}</h3><button className="admin-text-action" onClick={() => onTab('tasks')}>{tx("查看需求池 ")}<Icon name="chevron" /></button></header>
        <div className="pg-task-completion"><b>{done}<small> / {total}</small></b><span>{tx("需求已交付")}</span><em>{blocked}{tx(" 项等待前置需求")}</em></div>
        <div className="pg-task-progress" role="progressbar" aria-label={tx("需求交付进度")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={total ? Math.round(done / total * 100) : 0}><i style={{ width: `${total ? done / total * 100 : 0}%` }} /></div>
        <dl>{[[tx("待整理与澄清"), summary.preparing], [tx("待交付"), summary.stages.ready], [tx("交付中"), summary.stages.delivering], [tx("已关闭"), summary.closed]].map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl>
      </section>
    </div>
    <ReadinessRail project={project} repos={repos} repoStatus={repoStatus} onOpen={onTab} />
  </div>
}

function ProjectDetail({ pid, clients, owners, projects, onBack, onChanged }) {
  const uiLocale = useLocale();
  const [project, setProject] = useState(null); const [repos, setRepos] = useState([]); const [reposLoading, setReposLoading] = useState(true); const [error, setError] = useState(false); const [tab, setTab] = useState('overview'); const [taskOpen, setTaskOpen] = useState(false); const [editOpen, setEditOpen] = useState(false); const [confirmDel, setConfirmDel] = useState(false); const snapshot = useRef('')
  const [reposError, setReposError] = useState(false)
  const loadProject = useCallback(async (quiet = false) => { try { const next = await api.projectDetail(pid); const raw = JSON.stringify(next); if (snapshot.current !== raw) { snapshot.current = raw; setProject(next) } setError(false) } catch (_e) { if (!quiet) setError(true) } }, [pid])
  const loadRepos = useCallback(async () => { try { setRepos(await api.repos(pid)); setReposError(false) } catch (_e) { setReposError(true) } finally { setReposLoading(false) } }, [pid])
  useEffect(() => { snapshot.current = ''; setProject(null); setReposLoading(true); loadProject(); loadRepos(); const timer = setInterval(() => loadProject(true), AUTO.interval); return () => clearInterval(timer) }, [loadProject, loadRepos])
  if (error) return <ErrorState onRetry={() => loadProject()} />
  if (!project) return <Loading />
  const summary = requirementSummary(project.tasks)
  const { done } = summary
  const repoStatus = reposLoading ? tx("读取中…") : reposError ? tx("读取失败") : ''
  const tabs = [['overview', tx("项目概况"), null, 'grid'], ['repos', tx("代码仓库"), repoStatus ? null : repos.length, 'box'], ['tasks', tx("需求池"), project.tasks.length, 'sitemap'], ['link', tx("外部联动"), null, 'link']]
  const metrics = [
    [tx("代码仓库"), repoStatus ? '—' : repos.length, repoStatus || tx("项目内登记的代码资产")],
    [tx("需求交付进度"), `${done} / ${summary.total}`, tx("已交付 / 未关闭需求")],
    [tx("自动合并"), repoStatus ? '—' : repos.filter((repo) => repo.serverDir && repo.mergeBranch).length, repoStatus || tx("已配置合并规则的仓库")],
    [tx("发布目标"), repoStatus ? '—' : repos.reduce((total, repo) => total + (repo.deployTargets || []).length, 0), repoStatus || tx("已登记的发布目标")],
  ]
  const statusLabel = ({ active: tx("进行中"), archived: tx("已归档"), done: tx("已完成") })[project.status] || project.status || tx("进行中")
  async function saveProject(form) { await api.updateProject(pid, form); setEditOpen(false); await loadProject(); onChanged() }
  return <div className="project-governance pg-detail">
    <header className="pg-detail-head">
      <div className="pg-detail-topline"><button className="pg-back" onClick={onBack}><Icon name="chevron-left" />{tx("返回项目列表")}</button><LiveDot /></div>
      <div className="pg-detail-identity">
        <div className="pg-project-mark"><Icon name="box" /></div>
        <div className="pg-detail-title"><div className="pg-detail-name"><h2>{project.name}</h2><span className="pg-detail-state">{statusLabel}</span></div><div className="pg-detail-meta"><span>{project.group || tx("未分组")}</span><span>{tx("负责人 · ")}{project.ownerName || tx("待指定")}</span></div></div>
        <div className="pg-detail-actions"><button className="btn btn-ghost btn-sm" onClick={() => { loadProject(); loadRepos() }}><Icon name="refresh" />{tx("刷新")}</button>{can('task.dispatch') && <><button className="btn btn-ghost btn-sm" onClick={() => setEditOpen(true)}><Icon name="pencil" />{tx("编辑项目")}</button><button className="admin-text-action danger" onClick={() => setConfirmDel(true)}>{tx("删除项目")}</button></>}</div>
      </div>
      <p className="pg-detail-description">{project.desc || tx("尚未补充项目说明")}</p>
      <dl className="pg-detail-metrics">{metrics.map(([label, value, note]) => <div key={label}><dt>{label}</dt><dd>{value}<small>{note}</small></dd></div>)}</dl>
    </header>
    <nav className="pg-tabs" aria-label={tx("项目详情")}>{tabs.map(([id, label, count, icon]) => <button key={id} className={tab === id ? 'on' : ''} aria-pressed={tab === id} onClick={() => setTab(id)}><Icon name={icon} />{label}{count != null && <i>{count}</i>}</button>)}</nav>
    <main className="pg-detail-body">
      {reposError && <div className="pg-detail-warning" role="alert"><Icon name="alert" /><span>{tx("仓库配置读取失败，相关汇总暂不可用。")}</span><button className="admin-text-action" onClick={loadRepos}>{tx("重新读取")}</button></div>}
      {tab === 'overview' && <ProjectOverview project={project} repos={repos} owners={owners} repoStatus={repoStatus} onReload={() => { loadProject(); onChanged() }} onTab={setTab} />}
      {tab === 'repos' && <RepoSection pid={pid} repos={repos} loading={reposLoading} reload={loadRepos} clients={clients} projects={projects} />}
      {tab === 'tasks' && <section className="pg-work-panel"><header className="pg-panel-head"><div><h3>{tx("需求依赖")}</h3><p>{tx("按前置依赖分阶段查看需求，同阶段可并行执行。")}</p></div>{can('task.dispatch') && <button className="btn btn-primary" onClick={() => setTaskOpen(true)}><Icon name="plus" />{tx("添加需求")}</button>}</header><ProjectGraph tasks={project.tasks} /></section>}
      {tab === 'link' && <AiProjectLink pid={pid} current={project.extProjectId} onSaved={async (value) => { await api.updateProject(pid, { extProjectId: value }); loadProject(); onChanged() }} />}
    </main>
    {taskOpen && <AddTaskModal pid={pid} tasks={project.tasks} clients={clients} onClose={() => setTaskOpen(false)} onDone={() => { setTaskOpen(false); loadProject(); onChanged() }} />}
    {editOpen && <ProjectModal project={project} owners={owners} onClose={() => setEditOpen(false)} onSave={saveProject} />}
    {confirmDel && <Confirm title={tx("删除项目")} text={tx("确定删除「{0}」？项目内需求会保留，只解除项目归属。", [project.name])} danger confirmText={tx("删除项目")} onConfirm={async () => { await api.deleteProject(pid); setConfirmDel(false); onChanged(); onBack() }} onClose={() => setConfirmDel(false)} />}
  </div>
}

function ProjectRow({ project, onOpen }) {
  const uiLocale = useLocale();
  const pct = project.total ? Math.round(project.done / project.total * 100) : 0; const state = !project.total ? tx("尚未开始") : pct === 100 ? tx("已完成") : project.done ? tx("推进中") : tx("待启动")
  return <article className="pg-project-row">
    <span className={'pg-project-avatar state-' + (pct === 100 ? 'done' : project.done ? 'active' : 'idle')}><Icon name="box" /></span>
    <div className="pg-project-name"><div><b>{project.name}</b><span>{project.group || tx("未分组")}</span></div><p>{project.desc || tx("尚未补充项目说明")}</p></div>
    <div className="pg-owner-cell"><b title={tx("负责人")}>{project.ownerName || tx("待指定")}</b></div>
    <div className="pg-progress-cell"><div><span>{project.done} / {project.total}{tx(" 项完成")}</span><b>{pct}%</b></div><i aria-label={tx("需求交付进度")}><em style={{ width: pct + '%' }} /></i></div>
    <span className={'pg-project-state ' + (pct === 100 ? 'done' : '')}><i />{state}</span>
    <div className="pg-project-actions admin-row-actions">
      <button type="button" className="admin-text-action" onClick={onOpen}>{tx("查看详情")}</button>
      {project.repoUrl && <a className="admin-text-action" href={project.repoUrl} target="_blank" rel="noreferrer" title={tx("在新标签页打开主代码仓库")}>{tx("打开仓库")}</a>}
    </div>
  </article>
}

export default function Projects() {
  const listRef = useViewportHeight(180)
  const uiLocale = useLocale();
  const projects = useAsync(() => api.projects(), AUTO); const clients = useAsync(() => api.clients().catch(() => []), AUTO); const owners = useAsync(() => api.projectOwners().catch(() => []), AUTO)
  const [open, setOpen] = useState(null); const [creating, setCreating] = useState(false); const [query, setQuery] = useState(''); const [group, setGroup] = useState('all')
  if (projects.loading) return <Loading />
  if (projects.error && !projects.data) return <ErrorState onRetry={projects.reload} />
  const list = projects.data || []; const people = owners.data || []; const groups = [...new Set(list.map((p) => (p.group || '').trim() || tx("未分组")))].sort((a, b) => (a === tx("未分组")) - (b === tx("未分组")))
  if (open) return <ProjectDetail pid={open} clients={clients.data || []} owners={people} projects={list} onBack={() => setOpen(null)} onChanged={projects.reload} />
  const keyword = query.trim().toLowerCase(); const shown = list.filter((p) => (group === 'all' || (p.group || tx("未分组")) === group) && (!keyword || [p.name, p.desc, p.group, p.ownerName].some((x) => String(x || '').toLowerCase().includes(keyword))))
  async function create(form) { const r = await api.createProject(form); setCreating(false); await projects.reload(); setOpen(r.id); toast(tx("项目已创建，继续登记代码仓库")) }
  return <div className="project-governance pg-index">
    <section className="admin-filterbar pg-index-filters" aria-label={tx("项目筛选")}>
      <FilterInput type="search" aria-label={tx("搜索项目")} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tx("搜索项目、负责人或说明")} />
      <div className="admin-filter-options">
        <label className="admin-filter-field"><span>{tx("项目分组")}</span><FilterSelect
          aria-label={tx("项目分组")} value={group} resetValue="all" onChange={(e) => setGroup(e.target.value)}>
          <option value="all">{tx("全部")}</option>
          {groups.map((g) => <option key={g} value={g}>{g}</option>)}
        </FilterSelect></label>
        {can('task.dispatch') && <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" />{tx("新建项目")}</button>}
      </div>
    </section>
    <section ref={listRef} className="pg-ledger admin-viewport-list" tabIndex={0} aria-label={tx("项目与仓库")}><header><span>{tx("项目")}</span><span>{tx("负责人")}</span><span>{tx("需求交付进度")}</span><span>{tx("状态")}</span><span>{tx("操作")}</span></header>{shown.length ? shown.map((p) => <ProjectRow key={p.id} project={p} onOpen={() => setOpen(p.id)} />) : <EmptyPanel icon="search" title={tx("没有匹配的项目")} text={tx("调整搜索关键词或项目分组后再试。")} />}</section>
    {creating && <ProjectModal owners={people} onClose={() => setCreating(false)} onSave={create} />}
  </div>
}
