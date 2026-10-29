import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { FilterInput, FilterSelect } from '../FilterControls.jsx'
import { useViewportHeight } from '../viewport-height.js'
import { Confirm, Icon, Loading, Modal, toast, SelectMenu } from '../ui.jsx'
import './work-catalog.css'

const CAP_LABEL = localeMap(() => ({
  browser: '浏览与检索',
  office: '办公文档',
  repository: '代码仓库',
  terminal: '命令与构建',
  files: '文件处理',
  computer: '操作电脑',
}))

const KIND_OPTIONS = localeMap(() => ([
  ['artifact', '通用成果'],
  ['office-artifact', '办公文件'],
  ['repository-change', '仓库变更'],
  ['prototype', '可交互原型'],
  ['evidence-report', '证据型报告'],
  ['proposal', '方案材料'],
]))

function lines(value) {
  return String(value || '').split(/[\n,，]/).map((item) => item.trim()).filter(Boolean)
}

function joinLines(value) {
  return (value || []).join('\n')
}

function orgOptions(rows) {
  const visibleIds = new Set((rows || []).map((row) => row.id))
  const children = {}
  ;(rows || []).forEach((row) => {
    const key = row.parentId && visibleIds.has(row.parentId)
      ? row.parentId : ''
    if (!children[key]) children[key] = []
    children[key].push(row)
  })
  const out = []
  const walk = (parentId, depth) => (children[parentId] || [])
    .sort((a, b) => (a.sort || 0) - (b.sort || 0))
    .forEach((row) => {
      out.push({ id: row.id, label: '　'.repeat(depth) + row.name })
      walk(row.id, depth + 1)
    })
  walk('', 0)
  return out
}

function sourceLabel(item, targetOrgId) {
  if (item.orgId === targetOrgId) return { text: tx("本组织"), tone: 'own' }
  if (item.isSystem || !item.orgId) return { text: tx("平台基线"), tone: 'base' }
  return { text: tx("上级继承"), tone: 'inherited' }
}

function Empty({ tab }) {
  const uiLocale = useLocale();
  return (
    <div className="wc-empty">
      <span><Icon name={tab === 'scenarios' ? 'sitemap' : 'users'} /></span>
      <b>{tab === 'scenarios' ? tx("还没有工作场景") : tx("还没有职业画像")}</b>
      <p>{tab === 'scenarios'
        ? tx("先定义企业里高频工作如何完成，创建需求时就能自动匹配。")
        : tx("先定义员工长期擅长什么，再在用户管理中为员工选择。")}</p>
    </div>
  )
}

export default function WorkCatalog({ me }) {
  const listRef = useViewportHeight(180)
  const uiLocale = useLocale();
  const [orgs, setOrgs] = useState([])
  const [orgId, setOrgId] = useState((me && me.orgId) || '')
  const [catalog, setCatalog] = useState(null)
  const [tab, setTab] = useState('scenarios')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [edit, setEdit] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const requestSeq = useRef(0)

  useEffect(() => {
    api.orgs().then((rows) => {
      const list = rows || []
      setOrgs(list)
      if (!orgId && list[0]) setOrgId(list[0].id)
    }).catch((error) => toast(tx("组织读取失败：") + error.message))
  }, [])

  async function load(target = orgId) {
    if (!target) return
    const seq = ++requestSeq.current
    setLoading(true)
    try {
      const next = await api.workCatalog(target)
      if (seq === requestSeq.current) setCatalog(next)
    } catch (error) {
      if (seq === requestSeq.current) toast(tx("职业场景读取失败：") + error.message)
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (orgId) load(orgId)
    return () => { requestSeq.current += 1 }
  }, [orgId])

  const professions = (catalog && catalog.professions) || []
  const scenarios = (catalog && catalog.scenarios) || []
  const workflows = (catalog && catalog.workflows) || []
  const professionName = useMemo(
    () => Object.fromEntries(professions.map((item) => [item.id, item.name])),
    [professions, uiLocale],
  )
  const keyword = query.trim().toLowerCase()
  const visibleProfessions = professions.filter((item) => !keyword ||
    [item.name, item.category, item.description, ...(item.competencies || [])]
      .join(' ').toLowerCase().includes(keyword))
  const visibleScenarios = scenarios.filter((item) => !keyword ||
    [item.name, item.category, item.description, ...(item.intentHints || [])]
      .join(' ').toLowerCase().includes(keyword))

  async function remove() {
    const item = pendingDelete
    if (!item) return
    try {
      if (item.kind === 'scenario') await api.deleteWorkScenario(item.row.id)
      else await api.deleteProfession(item.row.id)
      setPendingDelete(null)
      toast(tx("已删除"))
      await load()
    } catch (error) {
      toast(tx("删除失败：") + error.message)
    }
  }

  if (!orgId && loading) return <Loading />

  return (
    <div className="wc-page">
      <section className="wc-intro">
        <div className="wc-intro-copy">
          <span className="wc-eyebrow">{tx("企业工作语言")}</span>
          <h2>{tx("让一句需求，稳定走到可验收的结果")}</h2>
          <p>{tx("职业画像描述员工长期擅长什么；工作场景描述一类需求应该用哪些能力、流程和交付标准。它们都不等于权限，也不绑定 Pi、OpenCode、Claude Code 或 Codex。")}</p>
        </div>
        <div className="wc-intro-metrics">
          <span><b>{professions.length}</b>{tx(" 个职业画像")}</span>
          <span><b>{scenarios.filter((item) => item.enabled).length}</b>{tx(" 个可用场景")}</span>
          <span><b>{workflows.filter((item) => item.enabled).length}</b>{tx(" 条可用流程")}</span>
        </div>
      </section>

      <div className="wc-path" aria-label={tx("需求理解到交付的路径")}>
        {[
          ['01', tx("理解需求"), tx("识别意图与工程上下文")],
          ['02', tx("匹配场景"), tx("结合内容和职业画像")],
          ['03', tx("组织执行"), tx("选择能力、流程与承办者")],
          ['04', tx("固化交付"), tx("冻结验收标准和证据要求")],
        ].map((step, index) => (
          <React.Fragment key={step[0]}>
            <div className="wc-path-step"><i>{step[0]}</i><span><b>{step[1]}</b><small>{step[2]}</small></span></div>
            {index < 3 && <span className="wc-path-arrow">→</span>}
          </React.Fragment>
        ))}
      </div>

      <div className="admin-filterbar wc-toolbar">
        <FilterInput className="wc-search" value={query}
          aria-label={tx("搜索工作目录")}
          onChange={(event) => setQuery(event.target.value)} placeholder={tx("搜索名称、能力或关键词")} />
        <div className="admin-filter-options">
          <div className="admin-segmented" role="group" aria-label={tx("工作目录类型")}>
            <button aria-pressed={tab === 'scenarios'} onClick={() => setTab('scenarios')}>{tx("工作场景 ")}<span>{scenarios.length}</span>
            </button>
            <button aria-pressed={tab === 'professions'} onClick={() => setTab('professions')}>{tx("职业画像 ")}<span>{professions.length}</span>
            </button>
          </div>
          {orgs.length > 1 && <FilterSelect className="f-sel wc-org" value={orgId}
            resetValue={orgs.some((org) => org.id === me?.orgId) ? me.orgId : (orgs[0]?.id || '')}
            aria-label={tx("选择组织")} onChange={(event) => setOrgId(event.target.value)}>
            {orgOptions(orgs).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </FilterSelect>}
          <div className="admin-filter-actions">
            <button className="btn btn-ghost" onClick={() => load()}><Icon name="refresh" />{tx("刷新")}</button>
            <button className="btn btn-primary" onClick={() => setEdit({ kind: tab === 'scenarios' ? 'scenario' : 'profession', row: null })}>
              <Icon name="plus" />{tab === 'scenarios' ? tx("新建场景") : tx("新建职业")}
            </button>
          </div>
        </div>
      </div>

      {loading && !catalog ? <Loading /> : tab === 'scenarios' ? (
        <section ref={listRef} className="wc-list admin-viewport-list" tabIndex={0} aria-label={tx("工作场景")}>
          <div className="wc-list-head wc-scenario-grid">
            <span>{tx("工作类型")}</span><span>{tx("适用职业")}</span><span>{tx("能力与流程")}</span><span>{tx("交付标准")}</span><span>{tx("操作")}</span>
          </div>
          {visibleScenarios.length === 0 && <Empty tab="scenarios" />}
          {visibleScenarios.map((item) => {
            const source = sourceLabel(item, orgId)
            const flow = workflows.find((row) => row.key === item.defaultPluginKey)
            const own = item.orgId === orgId && !item.isSystem
            return (
              <div className={'wc-row wc-scenario-grid' + (!item.enabled ? ' disabled' : '')} key={item.id}>
                <div className="wc-primary">
                  <div><b>{item.name}</b><span className={'wc-source ' + source.tone}>{source.text}</span>
                    {!item.enabled && <span className="wc-source off">{tx("已停用")}</span>}</div>
                  <small>{item.category || tx("未分类")} · {item.description || tx("暂未填写说明")}</small>
                  <div className="wc-hints">{(item.intentHints || []).slice(0, 4).map((hint) => <span key={hint}>{hint}</span>)}</div>
                </div>
                <div className="wc-token-list">
                  {(item.positionIds || []).length
                    ? item.positionIds.slice(0, 4).map((id) => <span key={id}>{professionName[id] || tx("已移除职业")}</span>)
                    : <em>{tx("所有职业")}</em>}
                </div>
                <div className="wc-method">
                  <div>{(item.requiredCapabilities || []).map((capability) =>
                    <span key={capability}>{CAP_LABEL[capability] || capability}</span>)}</div>
                  <small className={flow && flow.enabled ? 'ready' : 'missing'}>
                    {item.defaultPluginKey
                      ? (flow && flow.enabled ? tx("默认流程 · ") + flow.name : tx("默认流程尚未启用"))
                      : tx("不指定默认流程")}
                  </small>
                </div>
                <div className="wc-contract">
                  <b>{(item.outputContract || {}).summary || tx("暂未定义交付摘要")}</b>
                  <small>{((item.outputContract || {}).deliverables || []).slice(0, 2).join(' · ') || tx("尚未列出成果物")}</small>
                </div>
                <div className="wc-actions"><div className="admin-row-actions">
                  {own
                    ? <>
                        <button className="admin-text-action" onClick={() => setEdit({ kind: 'scenario', row: item })}>{tx("编辑")}</button>
                        <button className="admin-text-action danger" onClick={() => setPendingDelete({ kind: 'scenario', row: item })}>{tx("删除")}</button>
                      </>
                    : <button className="admin-text-action" onClick={() => setEdit({ kind: 'scenario', row: item, copy: true })}>{tx("按企业调整")}</button>}
                </div></div>
              </div>
            )
          })}
        </section>
      ) : (
        <section ref={listRef} className="wc-list admin-viewport-list" tabIndex={0} aria-label={tx("职业画像")}>
          <div className="wc-list-head wc-profession-grid">
            <span>{tx("职业")}</span><span>{tx("专业能力")}</span><span>{tx("使用方式")}</span><span>{tx("操作")}</span>
          </div>
          {visibleProfessions.length === 0 && <Empty tab="professions" />}
          {visibleProfessions.map((item) => {
            const source = sourceLabel(item, orgId)
            const own = item.orgId === orgId && !item.isSystem
            const usedBy = scenarios.filter((scene) => (scene.positionIds || []).includes(item.id)).length
            return (
              <div className="wc-row wc-profession-grid" key={item.id}>
                <div className="wc-primary">
                  <div><b>{item.name}</b><span className={'wc-source ' + source.tone}>{source.text}</span></div>
                  <small>{item.category || tx("未分类")} · {item.description || tx("暂未填写说明")}</small>
                </div>
                <div className="wc-token-list">
                  {(item.competencies || []).length
                    ? item.competencies.map((capability) => <span key={capability}>{capability}</span>)
                    : <em>{tx("尚未填写")}</em>}
                </div>
                <div className="wc-usage"><b>{usedBy}</b><span>{tx("个工作场景适用")}</span><small>{tx("在用户管理中分配给员工")}</small></div>
                <div className="wc-actions"><div className="admin-row-actions">
                  {own && <>
                    <button className="admin-text-action" onClick={() => setEdit({ kind: 'profession', row: item })}>{tx("编辑")}</button>
                    <button className="admin-text-action danger" onClick={() => setPendingDelete({ kind: 'profession', row: item })}>{tx("删除")}</button>
                  </>}
                </div></div>
              </div>
            )
          })}
        </section>
      )}

      {edit && edit.kind === 'profession' && <ProfessionEditor row={edit.row} orgId={orgId}
        onClose={() => setEdit(null)} onDone={async () => { setEdit(null); await load() }} />}
      {edit && edit.kind === 'scenario' && <ScenarioEditor row={edit.row} copy={edit.copy}
        orgId={orgId} professions={professions} workflows={workflows}
        onClose={() => setEdit(null)} onDone={async () => { setEdit(null); await load() }} />}
      {pendingDelete && <Confirm danger title={pendingDelete.kind === 'scenario' ? tx("删除工作场景") : tx("删除职业画像")}
        text={tx("确定删除「") + pendingDelete.row.name + tx("」？正在使用的职业画像会被保护，无法误删。")}
        confirmText={tx("删除")} onConfirm={remove} onClose={() => setPendingDelete(null)} />}
    </div>
  )
}

function ProfessionEditor({ row, orgId, onClose, onDone }) {
  const uiLocale = useLocale();
  const [name, setName] = useState(row ? row.name : '')
  const [category, setCategory] = useState(row ? row.category : '')
  const [description, setDescription] = useState(row ? row.description : '')
  const [competencies, setCompetencies] = useState(joinLines(row && row.competencies))
  const [busy, setBusy] = useState(false)

  async function save() {
    if (!name.trim()) { toast(tx("请填写职业名称")); return }
    setBusy(true)
    try {
      const body = { orgId, name: name.trim(), category: category.trim(),
        description: description.trim(), competencies: lines(competencies) }
      if (row) await api.updateProfession(row.id, body)
      else await api.createProfession(body)
      toast(tx("职业画像已保存"))
      await onDone()
    } catch (error) { toast(tx("保存失败：") + error.message) }
    finally { setBusy(false) }
  }

  return (
    <Modal title={row ? tx("编辑职业画像") : tx("新建职业画像")} icon="users" onClose={onClose} wide
      foot={<><button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? tx("保存中…") : tx("保存职业")}</button></>}>
      <div className="wc-form-note">{tx("职业画像回答“这个员工长期擅长什么”，不改变他的系统权限。一个员工可以选择多个职业。")}</div>
      <div className="wc-form-two">
        <label><span>{tx("职业名称")}</span><input className="f-in" value={name} onChange={(event) => setName(event.target.value)} placeholder={tx("例如：解决方案顾问")} /></label>
        <label><span>{tx("职业类别")}</span><input className="f-in" value={category} onChange={(event) => setCategory(event.target.value)} placeholder={tx("例如：方案与咨询")} /></label>
      </div>
      <label className="wc-field"><span>{tx("职责说明")}</span><textarea className="f-in" rows={3} value={description}
        onChange={(event) => setDescription(event.target.value)} placeholder={tx("说明这个职业通常解决什么问题")} /></label>
      <label className="wc-field"><span>{tx("核心能力 ")}<i>{tx("每行一项")}</i></span><textarea className="f-in" rows={5} value={competencies}
        onChange={(event) => setCompetencies(event.target.value)} placeholder={tx("需求澄清\n方案设计\n结构化表达")} /></label>
    </Modal>
  )
}

function ScenarioEditor({ row, copy, orgId, professions, workflows, onClose, onDone }) {
  const uiLocale = useLocale();
  const source = row || {}
  const [name, setName] = useState(source.name || '')
  const [key] = useState(copy ? (source.key || '') : (source.key || ('scene-' + Date.now().toString(36))))
  const [category, setCategory] = useState(source.category || '')
  const [description, setDescription] = useState(source.description || '')
  const [positionIds, setPositionIds] = useState(source.positionIds || [])
  const [hints, setHints] = useState(joinLines(source.intentHints))
  const [capabilities, setCapabilities] = useState(joinLines(source.requiredCapabilities))
  const [pluginKey, setPluginKey] = useState(source.defaultPluginKey || '')
  const contract = source.outputContract || {}
  const [kind, setKind] = useState(contract.kind || 'artifact')
  const [summary, setSummary] = useState(contract.summary || '')
  const [deliverables, setDeliverables] = useState(joinLines(contract.deliverables))
  const [acceptance, setAcceptance] = useState(joinLines(contract.acceptance))
  const [enabled, setEnabled] = useState(source.enabled !== false)
  const [busy, setBusy] = useState(false)
  const editing = !!row && !copy && row.orgId === orgId && !row.isSystem
  const workflow = workflows.find((item) => item.key === pluginKey)
  const checks = [
    [!!name.trim(), tx("已说明这类工作叫什么")],
    [lines(hints).length > 0 || positionIds.length > 0, tx("有识别关键词或适用职业")],
    [lines(capabilities).length > 0, tx("声明了 Agent 所需能力（可选）")],
    [!pluginKey || !!(workflow && workflow.enabled), tx("默认流程当前可用")],
    [!!summary.trim() && lines(deliverables).length > 0 && lines(acceptance).length > 0, tx("交付物与验收标准完整")],
  ]

  const togglePosition = (id) => setPositionIds((current) =>
    current.includes(id) ? current.filter((item) => item !== id) : [...current, id])

  async function save() {
    if (!name.trim()) { toast(tx("请填写场景名称")); return }
    if (enabled && !lines(hints).length && !positionIds.length) {
      toast(tx("启用场景前，请配置识别关键词或适用职业")); return
    }
    if (pluginKey && !(workflow && workflow.enabled)) {
      toast(tx("默认工作流尚未启用，请先启用或选择“不指定”")); return
    }
    if (enabled && (!summary.trim() || !lines(deliverables).length || !lines(acceptance).length)) {
      toast(tx("启用场景前，请把交付摘要、成果物和验收标准补完整")); return
    }
    setBusy(true)
    try {
      const body = {
        orgId, key, name: name.trim(), category: category.trim(),
        description: description.trim(), positionIds,
        intentHints: lines(hints), requiredCapabilities: lines(capabilities),
        defaultPluginKey: pluginKey, enabled,
        outputContract: { kind, summary: summary.trim(),
          deliverables: lines(deliverables), acceptance: lines(acceptance) },
      }
      if (editing) await api.updateWorkScenario(row.id, body)
      else await api.createWorkScenario(body)
      toast(copy ? tx("企业覆盖场景已创建") : tx("工作场景已保存"))
      await onDone()
    } catch (error) { toast(tx("保存失败：") + error.message) }
    finally { setBusy(false) }
  }

  return (
    <Modal title={copy ? tx("按企业调整场景") : (editing ? tx("编辑工作场景") : tx("新建工作场景"))}
      icon="sitemap" onClose={onClose} wide
      foot={<><button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? tx("保存中…") : tx("保存场景")}</button></>}>
      <div className="wc-form-note">{tx("场景描述“一类工作怎样才算交付”。需求创建时会自动匹配，人仍可在确认卡中改选。")}</div>
      <div className="wc-form-two">
        <label><span>{tx("场景名称")}</span><input className="f-in" value={name} onChange={(event) => setName(event.target.value)} placeholder={tx("例如：客户方案编制")} /></label>
        <label><span>{tx("场景类别")}</span><input className="f-in" value={category} onChange={(event) => setCategory(event.target.value)} placeholder={tx("例如：方案与咨询")} /></label>
      </div>
      <label className="wc-field"><span>{tx("一句话说明")}</span><textarea className="f-in" rows={2} value={description}
        onChange={(event) => setDescription(event.target.value)} placeholder={tx("这类工作解决什么问题、边界是什么")} /></label>

      <div className="wc-field"><span>{tx("适用职业 ")}<i>{tx("不选表示所有职业都可使用")}</i></span>
        <div className="wc-checks">{professions.map((item) => <button type="button" key={item.id}
          className={positionIds.includes(item.id) ? 'active' : ''} onClick={() => togglePosition(item.id)}>
          <i>{positionIds.includes(item.id) ? '✓' : ''}</i>{item.name}</button>)}</div>
      </div>

      <div className="wc-form-two">
        <label><span>{tx("识别关键词 ")}<i>{tx("每行一项")}</i></span><textarea className="f-in" rows={4} value={hints}
          onChange={(event) => setHints(event.target.value)} placeholder={tx("方案\n建议书\n路线图")} /></label>
        <label><span>{tx("Agent 能力 ")}<i>{tx("使用稳定能力标识")}</i></span><textarea className="f-in" rows={4} value={capabilities}
          onChange={(event) => setCapabilities(event.target.value)} placeholder={'browser\noffice'} /></label>
      </div>

      <div className="wc-form-two">
        <label><span>{tx("默认工作流")}</span><SelectMenu className="f-in" value={pluginKey} onChange={(event) => setPluginKey(event.target.value)}>
          <option value="">{tx("不指定，直接交给 AI")}</option>
          {workflows.map((item) => <option key={item.key} value={item.key} disabled={!item.enabled}>
            {item.name}{item.enabled ? '' : tx("（未启用）")}</option>)}
        </SelectMenu></label>
        <label><span>{tx("成果形态")}</span><SelectMenu className="f-in" value={kind} onChange={(event) => setKind(event.target.value)}>
          {KIND_OPTIONS.map((item) => <option key={item[0]} value={item[0]}>{item[1]}</option>)}
        </SelectMenu></label>
      </div>

      <label className="wc-field"><span>{tx("交付摘要")}</span><input className="f-in" value={summary}
        onChange={(event) => setSummary(event.target.value)} placeholder={tx("一句话说明最终应该交回什么")} /></label>
      <div className="wc-form-two">
        <label><span>{tx("成果物 ")}<i>{tx("每行一项")}</i></span><textarea className="f-in" rows={4} value={deliverables}
          onChange={(event) => setDeliverables(event.target.value)} placeholder={tx("方案正文\n汇报材料")} /></label>
        <label><span>{tx("验收标准 ")}<i>{tx("每行一项")}</i></span><textarea className="f-in" rows={4} value={acceptance}
          onChange={(event) => setAcceptance(event.target.value)} placeholder={tx("目标和边界清楚\n关键判断有依据")} /></label>
      </div>

      <div className="wc-preflight">
        <div><b>{tx("保存前检查")}</b><span>{tx("系统会在需求创建时冻结这份交付标准")}</span></div>
        <ul>{checks.map((item, index) => <li className={item[0] ? 'ok' : 'warn'} key={index}>
          <i>{item[0] ? '✓' : '!'}</i>{item[1]}</li>)}</ul>
      </div>
      <div className="wc-enabled"><span><b>{tx("场景状态")}</b><small>{tx("停用后不再参与新需求匹配，历史需求不受影响")}</small></span>
        <button type="button" className={enabled ? 'active' : ''} onClick={() => setEnabled(!enabled)}>{enabled ? tx("已启用") : tx("已停用")}</button>
      </div>
    </Modal>
  )
}
