import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useRef, useState } from 'react'
import { api, can } from '../api.js'
import { FilterInput } from '../FilterControls.jsx'
import { useViewportHeight } from '../viewport-height.js'
import { useAsync, Loading, ErrorState, Icon, Modal, toast } from '../ui.jsx'
import McpServers from './McpServers.jsx'
import SkillSharing from './SkillSharing.jsx'
import { buildSubmissionOrigins, summarizeCapabilityPolicy, sameCapabilityPolicy } from './capability-catalog-model.js'
import './capability-center.css'

export default function Skills() {
  const uiLocale = useLocale();
  const data = useAsync(() => api.capabilityCatalog())
  const [allowed, setAllowed] = useState(null)
  const [tab, setTab] = useState('skills')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null)
  const picker = useRef(null)
  // Measure the entire active body once. The two Skill sections share this
  // budget; neither list treats its sibling's changing height as page chrome.
  const workspaceMinimum = tab === 'skills' && data.data?.personalSubmissions?.length ? 760 : 460
  const workspaceRef = useViewportHeight(workspaceMinimum)

  useEffect(() => {
    if (data.data) setAllowed(new Set((data.data.cfg || {}).allowed || []))
  }, [data.data])
  if (data.error && !data.data) return <ErrorState msg={data.error.message} onRetry={data.reload} />
  if (data.loading || !allowed) return <Loading />

  const catalog = data.data || {}
  const config = catalog.cfg || {}
  const rows = catalog.skills || []
  const summary = catalog.summary || {}
  const dirty = !sameCapabilityPolicy(allowed, config.allowed || [])
  const { activeCount, unmatchedNames } = summarizeCapabilityPolicy(rows, allowed)
  const filtered = rows.filter((item) => {
    const needle = query.trim().toLowerCase()
    return !needle || [item.name, item.description, sourceLabel(item, catalog)]
      .some((value) => String(value || '').toLowerCase().includes(needle))
  })

  function toggle(name) {
    setAllowed((current) => {
      const next = new Set(current)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })
  }

  function removeUnmatched() {
    setAllowed((current) => new Set([...current].filter((name) => !unmatchedNames.includes(name))))
  }

  async function save() {
    setBusy(true)
    try {
      await api.saveCapabilityPolicy({ ...config, allowed: [...allowed] })
      toast(tx("公司开放策略已保存，员工下一次执行生效"))
      data.reload()
    } catch (error) {
      toast(tx("保存失败：") + error.message)
    }
    setBusy(false)
  }

  async function pickSkill(event) {
    const files = [...(event.target.files || [])]
    event.target.value = ''
    if (!files.length) return
    if (files.length > 30) {
      toast(tx("一次最多选择 30 个 Skill 包"))
      files.length = 30
    }
    setBusy(true)
    const items = await Promise.all(files.map(async (file) => {
      try { return { file, ...(await api.preflightCapabilitySkill(file)) } }
      catch (error) { return { file, error: error.message } }
    }))
    setPreview({ items })
    setBusy(false)
  }

  async function importSkill() {
    const seen = new Set()
    const candidates = (preview?.items || []).filter((item) => {
      const name = String(item.skill?.name || '')
      if (!name || item.error || seen.has(name)) return false
      seen.add(name)
      return true
    })
    if (!candidates.length) return
    setBusy(true)
    const failed = []
    let imported = 0
    for (const item of candidates) {
      try {
        await api.importCapabilitySkill(item.file)
        imported += 1
      } catch (error) {
        failed.push({ ...item, importError: error.message })
      }
    }
    toast(tx("已导入 ") + imported + tx(" 个 Skill") +
      (failed.length ? '，' + failed.length + tx(" 个失败") : tx("，开放后员工可用")))
    setPreview(failed.length ? { items: failed } : null)
    data.reload()
    setBusy(false)
  }

  return (
    <div className="cap-admin">
      <section className="cap-admin-metrics" aria-label={tx("能力汇总")}>
        <Metric value={summary.skills ?? rows.length} label={tx("已发现 Skill")} />
        <Metric value={activeCount} label={dirty ? tx("待保存开放数") : tx("已开放")} tone="ok" />
        <Metric value={summary.personalSubmissions || 0} label={tx("个人提交")} />
        <Metric value={summary.mcpTemplates || 0} label={tx("推荐连接器")} />
      </section>

      <div className="cap-admin-bar">
        <div className="cap-admin-tabs">
          <button className={tab === 'skills' ? 'on' : ''} onClick={() => setTab('skills')}>Skill</button>
          <button className={tab === 'mcp' ? 'on' : ''} onClick={() => setTab('mcp')}>{tx("连接器")}</button>
        </div>
        {tab === 'skills' && (
          <>
            <FilterInput className="cap-admin-search" value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder={tx("搜索名称、用途或来源")} />
            <span className="ml-auto" />
            <input ref={picker} type="file" multiple accept=".zip,.skill,application/zip"
              hidden onChange={pickSkill} />
            {can('integration.manage') && (
              <button className="btn btn-ghost btn-sm" onClick={() => picker.current?.click()}>
                <Icon name="plus" />{tx("导入公司 Skill")}</button>
            )}
            {dirty && <><span className="cap-admin-dirty">{tx("开放策略有改动")}</span>
              <button className="btn btn-ghost btn-sm" disabled={busy}
                onClick={() => setAllowed(new Set(config.allowed || []))}>{tx("放弃改动")}</button></>}
            <button className="btn btn-primary btn-sm" disabled={busy || !dirty} onClick={save}>
              {busy ? tx("保存中…") : tx("保存开放策略")}
            </button>
          </>
        )}
      </div>

      {tab === 'skills' && unmatchedNames.length > 0 && (
        <section className="cap-admin-policy-warning" aria-label={tx("未匹配的开放项")}>
          <div className="cap-admin-policy-warning-head">
            <div><b>{tx("有 {0} 个开放项未匹配到当前目录", [unmatchedNames.length])}</b>
              <p>{tx("这些名称不计入已开放数量。可能已删除、改名或暂时不可见；请核对后移除，保存后生效。")}</p></div>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={removeUnmatched}>
              {tx("移除未匹配项")}</button>
          </div>
          <div className="cap-admin-unmatched-names" role="region" tabIndex={0} aria-label={tx("未匹配名称列表，可滚动")}>
            {unmatchedNames.map((name) => <code key={name}>{name}</code>)}
          </div>
        </section>
      )}
      {tab === 'skills' && can('integration.manage') && <SkillSharing onPublished={data.reload} />}
      <div ref={workspaceRef} className="cap-admin-workspace"
        style={{ '--capability-min-height': `${workspaceMinimum}px` }}>
        {tab === 'skills' ? (
          <SkillCatalog rows={filtered} allowed={allowed} legacy={catalog} onToggle={toggle}
            submissions={catalog.personalSubmissions || []} />
        ) : (
          <McpArea templates={catalog.mcpTemplates || []} />
        )}
      </div>

      {preview && (
        <ImportPreview value={preview} busy={busy} existing={new Set(rows.map((item) => item.name))}
          onClose={() => setPreview(null)} onImport={importSkill} />
      )}
    </div>
  )
}

function Metric({ value, label, tone = '' }) {
  const uiLocale = useLocale();
  return <span className={'cap-admin-metric ' + tone}><b>{Number(value || 0)}</b><small>{label}</small></span>
}

function SkillCatalog({ rows, allowed, legacy, onToggle, submissions }) {
  const uiLocale = useLocale();
  const origins = buildSubmissionOrigins(submissions)
  return (
    <div className={'cap-admin-body cap-admin-skill-body' + (submissions.length ? ' has-personal' : '')}>
      <section className="cap-admin-discovered">
        <div className="cap-admin-section-title">
          <div><b>{tx("已发现的 Skill")}</b><span>{tx("自动扫描 SoduWork 内置、公司导入与标准技能目录")}</span></div>
          <em>{rows.length}{tx(" 项")}</em>
        </div>
        {rows.length === 0 ? (
          <div className="cap-admin-empty"><b>{tx("没有匹配的 Skill")}</b><span>{tx("导入标准技能包，或调整搜索条件。")}</span></div>
        ) : (
          <div className="cap-admin-grid" role="region" aria-label={tx("能力列表，可滚动")} tabIndex="0">
            {rows.map((item) => {
              const on = allowed.has(item.name)
              return (
                <button key={item.name} className={'cap-admin-card' + (on ? ' on' : '')}
                  onClick={() => onToggle(item.name)} aria-pressed={on}>
                  <span className="cap-admin-card-icon" aria-hidden="true"><b>{String(item.name || 'S').slice(0, 1).toUpperCase()}</b></span>
                  <span className="cap-admin-card-main">
                    <span className="cap-admin-card-title"><b title={item.name}>{item.name}</b>
                      <em title={sourceLabel(item, legacy)}>{sourceLabel(item, legacy)}</em></span>
                    <span className="cap-admin-card-desc" title={item.description || tx("暂无用途说明")}>{item.description || tx("暂无用途说明")}</span>
                    <span className="cap-admin-passport">
                      <i className={on ? 'ok' : ''}>{on ? tx("已开放") : tx("未开放")}</i>
                      <i>{item.inUse || 0}{tx(" 台 SoduWork 在用")}</i>
                      {!item.portable && <i title={tx("目标 Runner 也必须安装同名 Skill；建议导入公司能力库固化版本")}>{tx("需执行机同名能力")}</i>}
                      {item.compatibility && <i title={item.compatibility}>{tx("有环境要求")}</i>}
                    </span>
                  </span>
                  <span className="cap-admin-switch" />
                </button>
              )
            })}
          </div>
        )}
      </section>

      {submissions.length > 0 && (
        <section className="cap-admin-submissions">
          <div className="cap-admin-section-title">
            <div><b>{tx("员工个人 Skill")}</b><span>{tx("仅本人可用；同名 Skill 请按提交设备区分。")}</span></div>
            <em>{submissions.length}{tx(" 项")}</em>
          </div>
          <div className="cap-admin-submit-list" role="region" aria-label={tx("员工个人 Skill 列表，可滚动")} tabIndex={0}>
            {submissions.map((item) => {
              const origin = origins.get(item.ownerClientId)
              return (
                <div key={JSON.stringify([item.key, item.ownerClientId])}>
                  <span className="cap-admin-submit-copy"><b title={item.name}>{item.name}</b>
                    <small title={item.description}>{item.description}</small>
                    <small className="cap-admin-submit-origin" title={origin?.title || tx("来源设备未知")}>
                      {origin ? tx("提交设备：{0}", [origin.label]) : tx("来源设备未知")}
                    </small>
                  </span>
                  <em>{tx("个人作用域")}</em>
                </div>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}

function McpArea({ templates }) {
  const uiLocale = useLocale();
  return (
    <div className="cap-admin-body cap-admin-mcp-body" role="region" aria-label={tx("连接器")} tabIndex={0}>
      <div className="cap-admin-principle">
        <span><b>{tx("目录")}</b><small>{tx("自动出现，不自动授权")}</small></span>
        <i>→</i><span><b>{tx("配置并测一下")}</b><small>{tx("验证真实工具清单")}</small></span>
        <i>→</i><span><b>{tx("员工按需选择")}</b><small>{tx("执行时只注入最小集合")}</small></span>
      </div>
      <McpServers templates={templates} />
    </div>
  )
}

function ImportPreview({ value, busy, existing, onClose, onImport }) {
  const uiLocale = useLocale();
  const items = value.items || []
  const seen = new Set()
  const ready = items.filter((item) => {
    const name = String(item.skill?.name || '')
    if (!name || item.error || seen.has(name)) return false
    seen.add(name)
    return true
  })
  return (
    <Modal wide title={tx("导入公司 Skill")} icon="plug" onClose={onClose}
      foot={<>
        <button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button>
        <span className="ml-auto" />
        <button className="btn btn-primary" disabled={busy || !ready.length} onClick={onImport}>
          {busy ? tx("正在导入…") : tx("导入 ") + ready.length + tx(" 个 Skill")}
        </button>
      </>}>
      <div className="cap-admin-import">
        <span className="eyebrow">{tx("预检通过")}</span>
        <h3>{ready.length}{tx(" 个 Skill 可以进入公司能力库")}</h3>
        <p>{tx("已完成包结构、SKILL.md 和路径安全检查。导入后仍保持未开放，由管理员统一发布。")}</p>
        <div className="cap-skill-import-list">
          {items.map((item, index) => {
            const skill = item.skill || {}
            const duplicatePick = skill.name && items.slice(0, index).some((x) => x.skill?.name === skill.name)
            return (
              <div key={(item.file?.name || '') + index} className={'cap-skill-import-row' +
                (item.error || item.importError || duplicatePick ? ' bad' : '')}>
                <span><b>{skill.name || item.file?.name || tx("未命名包")}</b>
                  {item.sameVersion && <em>{tx("内容与当前版本一致")}</em>}
                  {!item.sameVersion && skill.name && existing.has(skill.name) && <em>{tx("更新公司版本")}</em>}
                  {item.willPause && <em>{tx("更新后暂停开放")}</em>}
                  {duplicatePick && <em>{tx("本次重复，跳过")}</em>}</span>
                <small>{item.error || item.importError || skill.description || tx("暂无说明")}</small>
                {skill.name && <i>{skill.fileCount || 0}{tx(" 个文件 · ")}{formatBytes(skill.unpackedBytes)} ·
                  {skill.hasScripts ? tx(" 含脚本，需审查") : tx(" 无脚本")}</i>}
              </div>
            )
          })}
        </div>
        <div className="int-hint">{tx("导入只进入公司能力库，")}<b>{tx("不会自动开放给员工")}</b>{tx("。请核对名称、说明和脚本后再保存开放策略。")}</div>
      </div>
    </Modal>
  )
}

function sourceLabel(item, data) {
  if (item.source) return item.source
  if (item.scope === 'company') return tx("公司能力库")
  const root = String(item.root || '')
  if (root === data.homeRoot) return tx("本机技能库")
  if (/[\\/][.]claude[\\/]/.test(root)) return 'Claude Code'
  if (/[\\/][.]codex[\\/]/.test(root)) return 'Codex'
  if (/[\\/][.]pi[\\/]/.test(root)) return 'Pi'
  if (/[\\/][.]agents[\\/]/.test(root)) return tx("通用目录")
  return tx("SoduWork 内置")
}

function formatBytes(value) {
  const size = Number(value || 0)
  if (size < 1024) return size + ' B'
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
  return (size / 1024 / 1024).toFixed(1) + ' MB'
}

/* Project-level Skill selection remains a narrow override editor. */
export function RepoSkills({ repoId, repoName }) {
  const uiLocale = useLocale();
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api.skills().then((result) => {
      setData(result)
      const own = ((result.cfg || {}).byRepo || {})[repoId]
      setSelected(own ? new Set(own) : null)
    }).catch(() => setData({ skills: [], cfg: {} }))
  }, [repoId])
  if (!data) return null
  const all = data.skills || []
  const company = (data.cfg || {}).allowed || []
  const own = selected !== null
  const shown = own ? [...selected] : company

  async function save(next) {
    setBusy(true)
    try {
      const config = { ...(data.cfg || {}) }
      const byRepo = { ...(config.byRepo || {}) }
      if (next === null) delete byRepo[repoId]
      else byRepo[repoId] = [...next]
      config.byRepo = byRepo
      const result = await api.saveSkills(config)
      setData({ ...data, cfg: result.cfg })
      setSelected(next)
      setOpen(false)
      toast(next === null ? tx("这个工程已改回公司默认") : tx("工程能力已保存"))
    } catch (error) { toast(tx("保存失败：") + error.message) }
    setBusy(false)
  }

  return (
    <>
      <div className="df-line">
        <b className="df-title">Skill</b>
        <span className="df-sum">
          {shown.length === 0 && <span className="df-chip">{tx("未配置")}</span>}
          {shown.map((name) => <span key={name} className={'df-chip' + (own ? ' own' : '')}>{name}</span>)}
          {!own && shown.length > 0 && <span className="df-chip">{tx("公司默认")}</span>}
        </span>
        <span className="ml-auto" />
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
          <Icon name="pencil" />{tx("配置")}</button>
      </div>
      {open && (
        <Modal wide title={'Skill · ' + (repoName || tx("这个工程"))} icon="plug" onClose={() => setOpen(false)}
          foot={<>
            <button className="btn btn-ghost" disabled={busy} onClick={() => save(null)}>{tx("改回公司默认")}</button>
            <span className="ml-auto" /><button className="btn btn-ghost" onClick={() => setOpen(false)}>{tx("取消")}</button>
            <button className="btn btn-primary" disabled={busy}
              onClick={() => save(selected || new Set(company))}>{busy ? tx("保存中…") : tx("保存")}</button>
          </>}>
          <div className="int-hint" style={{ marginBottom: 10 }}>{tx("工程配置会覆盖个人选择，但仍只能使用公司已经开放的 Skill。")}</div>
          <div className="intgrid">
            {all.filter((item) => company.includes(item.name)).map((item) => {
              const current = selected || new Set(company)
              const on = current.has(item.name)
              return (
                <label key={item.name} className={'sk-card' + (on ? ' on' : '')}>
                  <div className="sk-top"><span className="chk-inline sk-name">
                    <input type="checkbox" checked={on} onChange={() => {
                      const next = new Set(current)
                      next.has(item.name) ? next.delete(item.name) : next.add(item.name)
                      setSelected(next)
                    }} /><b>{item.name}</b>
                  </span></div>
                  <div className="sk-desc">{item.description}</div>
                </label>
              )
            })}
          </div>
        </Modal>
      )}
    </>
  )
}
