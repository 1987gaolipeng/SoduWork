import { getLocale, translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useState } from 'react'
import { api } from '../api.js'
import { useAsync, Loading, ErrorState, Icon, toast, AUTO, Confirm, SelectMenu } from '../ui.jsx'
import './runner-board.css'
import { FilterInput, FilterSelect } from '../FilterControls.jsx'
import ListPager from '../ListPager.jsx'
import { useViewportHeight } from '../viewport-height.js'
import CloudRunnerManagement, { CloudRunnerActions } from './CloudRunnerManagement.jsx'

/*
 * Distinguish client-bundled Runners from standalone execution machines. Standalone
 * machines require a service organization and per-machine revocable credentials scoped to
 * that organization subtree.
 */

async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg) }
  catch (_e) { toast(tx("复制不了，手动选中吧")) }
}

const CAPABILITY_KEYS = ['files', 'terminal', 'repository', 'browser', 'office', 'computer']
const CAPABILITY_LABELS = localeMap(() => ({
  files: '文件处理', terminal: '命令与构建', repository: '代码仓库',
  browser: '浏览与检索', office: '办公文档', computer: '操作电脑',
}))

function capabilityItems(report) {
  report = report && typeof report === 'object' ? report : {}
  const available = new Set(Array.isArray(report.available) ? report.available.map(String) : [])
  const indexed = {}
  ;(Array.isArray(report.items) ? report.items : []).forEach((item) => {
    if (!item || !item.key) return
    indexed[String(item.key)] = item
    if (item.available) available.add(String(item.key))
  })
  const extras = Object.keys(indexed).filter((key) => !CAPABILITY_KEYS.includes(key)).sort()
  return {
    reported: Number(report.reportedAt || 0) > 0,
    items: CAPABILITY_KEYS.concat(extras).map((key) => ({
      key,
      label: (indexed[key] && indexed[key].label) || CAPABILITY_LABELS[key] || key,
      detail: String((indexed[key] && indexed[key].detail) || ''),
      available: available.has(key),
      installed: indexed[key] ? !!indexed[key].installed : available.has(key),
      installable: !!(indexed[key] && indexed[key].installable),
      componentVersion: String((indexed[key] && indexed[key].componentVersion) || ''),
      targetVersion: String((indexed[key] && indexed[key].targetVersion) || ''),
    })),
  }
}

function RunnerCapabilities({ report, row, job, onInstall }) {
  const uiLocale = useLocale();
  const caps = capabilityItems(report)
  if (!caps.reported) {
    return <div className="rb-capability is-pending">
      <span>{tx("等待 Runner 1.7.0 上报")}</span><small>{tx("升级或重启后自动识别")}</small>
    </div>
  }
  const ready = caps.items.filter((item) => item.available)
  const office = caps.items.find((item) => item.key === 'office')
  const needsManagedOffice = office && office.installable &&
    (!office.componentVersion || (office.targetVersion && office.componentVersion !== office.targetVersion))
  const canInstall = !!(row && row.online && !row.embedded && needsManagedOffice)
  return <div className="rb-capability">
    <div className="rb-cap-head"><span>{ready.length}{tx(" 项可用")}</span>
      <small>{caps.items.length - ready.length ? (caps.items.length - ready.length) + tx(" 项未接入") : tx("全部就绪")}</small></div>
    <div className="rb-cap-list">{caps.items.map((item) =>
      <span key={item.key} className={'rb-cap ' + (item.available ? 'is-ready' : 'is-missing')}
        title={item.detail || (item.available ? tx("可以接收需要这项能力的需求") : tx("尚未接入这项能力"))}>
        <i />{item.label}</span>)}</div>
    {canInstall && <button className="rb-cap-install" disabled={job && job.state === 'running'}
      onClick={() => onInstall(row, 'office')}>
      {job && job.state === 'running' ? tx("正在安装…")
        : office.installed ? (office.componentVersion ? tx("升级办公组件") : tx("纳管办公组件")) : tx("安装办公组件")}
    </button>}
    {job && <div className={'rb-cap-job ' + (job.state === 'done' ? (job.ok ? 'ok' : 'bad') : 'run')}>
      {job.detail || (job.state === 'running' ? tx("正在准备组件…") : tx("安装已结束"))}</div>}
  </div>
}

function organizationOptions(items) {
  const rows = Array.isArray(items) ? items : []
  const byId = new Map(rows.map((item) => [String(item.id || ''), item]))
  return rows.map((item) => {
    const names = []
    const seen = new Set()
    let current = item
    while (current && current.id && !seen.has(current.id) && names.length < 8) {
      seen.add(current.id)
      names.unshift(String(current.name || current.id))
      current = byId.get(String(current.parentId || ''))
    }
    return { ...item, label: names.join(' / ') || String(item.name || item.id || '') }
  })
}
/* Register machine service scope and provide its credential and installation command. */
function EnrollPanel({ organizations, runner, onDone, onClose }) {
  const uiLocale = useLocale();
  const editing = !!(runner && runner.runnerId)
  const options = organizationOptions(organizations)
  const [host, setHost] = useState(editing ? (runner.label || runner.host || '') : '')
  const [tags, setTags] = useState(editing ? (runner.tags || []).join(', ') : '')
  const [orgId, setOrgId] = useState(
    (editing && runner.orgId) || (options.length === 1 ? String(options[0].id) : ''))
  const [hub, setHub] = useState('')
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState(null)
  const [osKind, setOsKind] = useState('windows')
  const selectedOrg = options.find((item) => String(item.id) === String(orgId))

  async function submit() {
    if (!orgId) { toast(tx("请先选择这台执行机服务的组织")); return }
    setBusy(true)
    try {
      const r = await api.enrollRunner({
        ...(editing ? { runnerId: runner.runnerId } : {}),
        host: host.trim(),
        tags: tags.split(/[,\s]+/).filter(Boolean),
        hub: hub.trim(),
        orgId,
      })
      setOut(r)
      onDone && onDone()
    } catch (e) { toast(tx("没生成成：") + e.message) }
    setBusy(false)
  }

  if (out) {
    const pkg = (out.packages || {})[osKind === 'windows' ? 'windows' : 'source'] || {}
    const cmd = out.commands[osKind] || ''
    return (
      <div className="rb-enroll">
        <div className="rb-enroll-head">
          <b>{host.trim() || out.runnerId}{tx(" 已登记")}</b>
          <span className="muted" style={{ fontSize: 14.5, marginLeft: 8 }}>{out.runnerId}</span>
          <button className="btn btn-ghost xs" onClick={onClose}>{tx("收起")}</button>
        </div>
        <div className="rb-scope is-assigned">
          <Icon name="tree" /><div><b>{selectedOrg ? selectedOrg.label : tx("已绑定组织")}</b>
            <small>{tx("仅该组织及下属部门可以向这台执行机安排工作")}</small></div>
        </div>
        <div className="rb-key">
          <label className="f-lbl">{tx("这台机器的钥匙")}<small>{tx("只显示这一次；命令里已经带上了，单独留存也行")}</small></label>
          <div className="rb-copyline">
            <code>{out.key}</code>
            <button className="btn btn-ghost xs" onClick={() => copy(out.key, tx("钥匙已复制"))}>{tx("复制")}</button>
          </div>
        </div>
        <div className="rb-oskind">
          <label className="admin-filter-field"><span>{tx("操作系统")}</span><SelectMenu
            aria-label={tx("操作系统")} value={osKind} onChange={(e) => setOsKind(e.target.value)}>
            <option value="windows">Windows</option><option value="linux">Linux</option>
          </SelectMenu></label>
        </div>
        <label className="f-lbl">{tx("在那台机器上跑这一条")}<small>
          {osKind === 'windows' ? tx("管理员身份的 PowerShell（不用管理员也能装，但只在你登录时在）")
            : tx("有 sudo 的终端；要 python3.10 以上")}</small></label>
        <div className="rb-cmd">
          <code>{cmd}</code>
          <button className="btn btn-ghost xs" onClick={() => copy(cmd, tx("命令已复制"))}>{tx("复制")}</button>
        </div>
        {pkg.available === false && pkg.buildable === false && (
          <div className="rb-warn"><Icon name="alert" />{tx("这台后端上没有")}{osKind === 'windows' ? ' Windows ' : tx("源码")}{tx("装机包，命令跑到下载那步会失败。 请把包放到后端的 ")}<code>hub-backend/downloads/</code>{tx(" 下。")}</div>
        )}
        {osKind === 'windows' && pkg.stale && (
          <div className="rb-warn"><Icon name="alert" />{tx("Windows 包比源码旧：装上去的执行机会少掉这期间修的东西。 在后端跑一遍 ")}<code>hub-backend/build-runner.ps1</code>{tx(" 重新打一版再装。")}</div>
        )}
        <p className="rb-hint">{tx("装完它会自己连回来，下面这张表里就能看到它上线。 安排执行/部署按标签挑机器，标签这次填的是：")}{(out.tags || []).join('、') || tx("（没填）")}</p>
      </div>
    )
  }

  return (
    <div className="rb-enroll">
      <div className="rb-enroll-head">
        <div><b>{editing ? tx("重新登记执行机") : tx("装一台新机器")}</b>
          <small>{editing ? tx("更新服务范围并生成一把新钥匙") : tx("登记服务范围后生成装机命令")}</small></div>
        <button className="btn btn-ghost xs" onClick={onClose}>{tx("取消")}</button>
      </div>
      <p className="rb-hint">{tx("给构建机、服务器、没装 SoduWork 客户端的电脑用。独立执行机必须归属一个组织， 只接受该组织及下属部门的需求，不会成为全公司的公共资源。")}</p>
      {editing && <div className="rb-warn"><Icon name="alert" />{tx("提交后旧钥匙立即作废， 需要在目标机器上使用新命令重新安装。")}</div>}
      <div className="rb-form">
        <div className="rb-wide">
          <label className="f-lbl">{tx("服务范围")}<small>{tx("选中的组织及其下属部门可以使用这台执行机")}</small></label>
          <SelectMenu className="f-in" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            <option value="">{tx("请选择组织")}</option>
            {options.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </SelectMenu>
          {!options.length && <div className="rb-org-note is-error">{tx("当前管理范围内没有可选组织，请先配置组织架构。")}</div>}
          {!!selectedOrg && <div className="rb-org-note"><Icon name="check" />
            {selectedOrg.name}{tx(" 及其下属部门将能向这台执行机安排工作")}</div>}
        </div>
        <div>
          <label className="f-lbl">{tx("叫它什么")}<small>{tx("看得懂就行，如「构建机-01」")}</small></label>
          <input className="f-in" value={host} onChange={(e) => setHost(e.target.value)}
            placeholder={tx("构建机-01")} />
        </div>
        <div>
          <label className="f-lbl">{tx("标签")}<small>{tx("安排执行/部署按标签挑机器，逗号分隔")}</small></label>
          <input className="f-in" value={tags} onChange={(e) => setTags(e.target.value)}
            placeholder="linux, intranet" />
        </div>
        <div className="rb-wide">
          <label className="f-lbl">{tx("后端地址")}<small>{tx("留空＝自动填（那台机器要能打开这个地址）")}</small></label>
          <input className="f-in" value={hub} onChange={(e) => setHub(e.target.value)}
            placeholder="http://192.0.2.40:9080" />
        </div>
      </div>
      <button className="btn btn-primary" disabled={busy || !orgId || !options.length} onClick={submit}>
        {busy ? tx("生成中…") : editing ? tx("更新并生成新命令") : tx("生成装机命令")}</button>
    </div>
  )
}

function timeAgo(value) {
  const ts = Number(value || 0)
  if (!ts) return tx("从未上报")
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - ts)
  if (seconds < 45) return tx("刚刚")
  if (seconds < 3600) return Math.floor(seconds / 60) + tx(" 分钟前")
  if (seconds < 86400) return Math.floor(seconds / 3600) + tx(" 小时前")
  if (seconds < 86400 * 7) return Math.floor(seconds / 86400) + tx(" 天前")
  return new Date(ts * 1000).toLocaleString(getLocale(), {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

function healthOf(row) {
  if (row.managementState) return { state: row.managementState, tone: 'warn',
    label: tx(row.managementState === 'pending_setup' ? '待安全接入' : '管理员已停用') }
  const health = row.health || {}
  const state = health.state || (row.online ? (row.busy ? 'busy' : 'healthy') : 'offline')
  return {
    state,
    label: health.label || (row.online ? (row.busy ? tx("执行中") : tx("健康")) : tx("离线")),
    tone: ['healthy', 'busy'].includes(state) ? 'ok'
      : ['pending', 'draining', 'unassigned'].includes(state) ? 'wait' : 'off',
  }
}

function releaseOf(row, targetVersion) {
  return row.release || {
    currentVersion: row.version || '',
    targetVersion: targetVersion || '',
    state: row.version && row.version === targetVersion ? 'current' : 'unknown',
    label: row.version && row.version === targetVersion ? tx("版本一致") : tx("版本未知"),
  }
}
function needsAttention(row, targetVersion) {
  return ['offline', 'unknown', 'disabled', 'unassigned'].includes(healthOf(row).state) ||
    ['unknown', 'upgrade_needed'].includes(releaseOf(row, targetVersion).state)
}

export default function RunnerBoard() {
  const listRef = useViewportHeight(180)
  const uiLocale = useLocale();
  const runners = useAsync(() => api.adminRunners(), AUTO)
  const [busy, setBusy] = useState('')
  const [enrolling, setEnrolling] = useState(null)
  const [componentJobs, setComponentJobs] = useState({})
  const [probes, setProbes] = useState({})
  const [q, setQ] = useState('')
  const [state, setState] = useState('all')
  const [page, setPage] = useState(1)
  const [confirm, setConfirm] = useState(null)
  const [managing, setManaging] = useState(null)
  if (runners.loading && !runners.data) return <Loading />
  if (runners.error && !runners.data) return <ErrorState msg={runners.error.message} onRetry={runners.reload} />
  const d = runners.data
  const items = (d && d.items) || []
  const summary = (d && d.summary) || {}
  const organizations = (d && d.organizations) || []
  const targetVersion = String(d && d.release && d.release.targetVersion || '')
  const keyword = q.trim().toLowerCase()
  const filtered = items.filter((r) => {
    if (state === 'online' && !r.online) return false
    if (state === 'offline' && r.online) return false
    if (state === 'draining' && r.mode !== 'draining') return false
    if (state === 'personal' && !r.ownerUserId) return false
    if (state === 'disabled' && !r.managementState) return false
    if (state === 'attention' && !needsAttention(r, targetVersion)) return false
    const haystack = [r.label, r.runnerId, r.host, r.owner, r.orgName, r.version,
      r.installSource && r.installSource.label, ...(r.tags || [])].join(' ').toLowerCase()
    return !keyword || haystack.includes(keyword)
  })
  const pageSize = 15
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, pages)
  const pageItems = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)

  async function revoke(row) {
    setBusy(row.runnerId)
    try {
      const out = await api.revokeRunnerKey(row.runnerId)
      toast(out.ok ? (out.kicked ? tx("已吊销并踢下线") : tx("已吊销（它当时不在线）")) : tx("没吊销成"))
      runners.reload()
    } catch (e) { toast(tx("没吊销成：") + e.message) }
    setBusy('')
  }
  async function remove(row) {
    setBusy(row.runnerId)
    try {
      await api.deleteRunner(row.runnerId)
      toast(tx("已删掉"))
      runners.reload()
    } catch (e) { toast(tx("删不掉：") + e.message) }
    setBusy('')
  }
  async function toggleMode(row) {
    const next = row.mode === 'accepting' ? 'draining' : 'accepting'
    setBusy(row.runnerId)
    try {
      await api.runnerMode(row.runnerId, next)
      toast(next === 'draining' ? tx("已暂停接新活（手上的活会跑完）") : tx("恢复接活"))
      runners.reload()
    } catch (e) { toast(tx("改不了：") + e.message) }
    setBusy('')
  }
  async function availability(row, enabled) {
    setBusy(row.runnerId)
    try {
      await api.cloudRunnerAvailability(row, enabled)
      toast(tx(enabled ? '云主机已启用' : '云主机已停用'))
      runners.reload()
    } catch (e) { toast(e.message) }
    finally { setBusy('') }
  }
  async function probe(row) {
    const key = row.runnerId
    setProbes((old) => ({ ...old, [key]: { state: 'running', message: tx("正在探活…") } }))
    try {
      const out = await api.adminRunnerProbe(key)
      const result = out && out.data || {}
      const ok = !!(out && out.ok)
      setProbes((old) => ({ ...old, [key]: {
        state: ok ? 'ok' : 'bad',
        message: ok ? tx("探活通过 · ") + Number(out.latencyMs || 0) + ' ms'
          : String(out && out.error || tx("探活没有通过")),
        freeBytes: Number(result.freeBytes || 0),
      } }))
      if (ok) {
        toast(tx("探活通过 · ") + Number(out.latencyMs || 0) + ' ms')
        runners.reload()
      }
    } catch (e) {
      setProbes((old) => ({ ...old, [key]: {
        state: 'bad', message: e.message || tx("探活失败"),
      } }))
    }
  }

  async function installComponent(row, key) {
    const stateKey = row.runnerId + '::' + key
    setComponentJobs((old) => ({ ...old, [stateKey]: {
      state: 'running', ok: null, detail: tx("正在连接执行机…"),
    } }))
    try {
      const start = await api.installRunnerComponent(row.runnerId, key)
      const jobId = String(start && start.data && start.data.jobId || '')
      if (!jobId) throw new Error(tx("执行机没有返回安装作业"))
      const deadline = Date.now() + 16 * 60 * 1000
      let result = null
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 900))
        const reply = await api.runnerComponentJob(row.runnerId, jobId)
        result = reply && reply.data
        if (!result) throw new Error(tx("读不到安装进度"))
        setComponentJobs((old) => ({ ...old, [stateKey]: result }))
        if (result.state === 'done') break
      }
      if (!result || result.state !== 'done') throw new Error(tx("安装等待超时"))
      if (!result.ok) throw new Error(result.detail || tx("组件没有安装成功"))
      toast(result.detail || tx("组件已安装并测通"))
      runners.reload()
    } catch (e) {
      setComponentJobs((old) => ({ ...old, [stateKey]: {
        ...(old[stateKey] || {}), state: 'done', ok: false, detail: e.message || tx("组件安装失败"),
      } }))
      toast(tx("组件安装失败：") + e.message)
    }
  }

  const authText = (s) => s === 'active' ? tx("独立密钥") : s === 'revoked' ? tx("密钥已吊销") : tx("设备身份")
  const packageStale = !!(d && d.packages && d.packages.windows && d.packages.windows.stale)

  return (
    <div className="card rb-card" aria-label={tx("Runner 执行机列表")}>
      <div className="rb-summary" aria-label={tx("执行网络概况")}>
        <div><span>{tx("已登记")}</span><b>{summary.total == null ? items.length : summary.total}</b><small>{tx("台执行机")}</small></div>
        <div><span>{tx("可接活")}</span><b>{summary.accepting || 0}</b><small>{tx("当前可调度")}</small></div>
        <div><span>{tx("执行中")}</span><b>{summary.busy || 0}</b><small>{tx("正在执行")}</small></div>
        <div className={(summary.attention || 0) ? 'needs-attention' : ''}>
          <span>{tx("需处理")}</span><b>{summary.attention || 0}</b><small>{tx("离线、待归属或版本异常")}</small></div>
        <div className="rb-target"><span>{tx("目标版本")}</span><b>{targetVersion ? 'v' + targetVersion : '—'}</b>
          <small>{tx("Hub 当前协议")}</small></div>
      </div>
      {packageStale && <div className="rb-package-warn"><Icon name="alert" />
        <span>{tx("Windows 装机包落后于当前 Runner 源码，请重新构建后再分发，避免新机器装上旧能力。")}</span>
      </div>}
      <div className="rb-filterbar">
        <FilterInput value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} placeholder={tx("搜索机器、归属、标签或 Runner ID")} />
        <div className="admin-filter-options"><label className="admin-filter-field rb-state-filter"><span>{tx("执行机状态")}</span><FilterSelect
          aria-label={tx("执行机状态")} value={state} resetValue="all" onChange={(e) => { setState(e.target.value); setPage(1) }}>{[
          ['all', tx("全部")],
          ['online', tx("在线")],
          ['attention', tx("需处理")],
          ['offline', tx("离线")],
          ['draining', tx("排空中")],
          ['personal', tx('用户云主机')],
          ['disabled', tx('管理员已停用')],
        ].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </FilterSelect></label>
        {!enrolling && <button className="btn btn-primary" onClick={() => setEnrolling({})}>
          <Icon name="plus" />{tx("装一台新机器")}</button>}
        </div>
      </div>
      {enrolling && <EnrollPanel organizations={organizations} runner={enrolling.runnerId ? enrolling : null}
        onDone={() => runners.reload()} onClose={() => setEnrolling(null)} />}
      {!filtered.length ? <p className="rb-empty">{items.length ? tx("没有符合筛选条件的执行机。") : tx("还没有执行机。")}</p> : (
        <div ref={listRef} className="admin-viewport-list" tabIndex={0} role="region" aria-label={tx("执行机")}>
          <table>
            <thead><tr><th>{tx("执行机")}</th><th>{tx("来源与归属")}</th><th>{tx("健康")}</th><th>{tx("版本")}</th>
              <th>{tx("负载")}</th><th>{tx("执行能力")}</th><th style={{ width: 220 }}>{tx("操作")}</th></tr></thead>
            <tbody>
              {pageItems.map((r) => {
                const health = healthOf(r)
                const release = releaseOf(r, targetVersion)
                const check = probes[r.runnerId]
                return (
                  <tr key={r.runnerId}>
                    <td>
                      <div className="rb-machine-name">{r.label || r.runnerId}</div>
                      <div className="rb-machine-id">{r.runnerId}</div>
                      {!!(r.tags || []).length && <div className="rb-tags">
                        {(r.tags || []).slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}
                      </div>}
                    </td>
                    <td>
                      <div className="rb-source">{r.installSource && r.installSource.label ||
                        (r.embedded ? tx("随客户端安装") : tx("独立执行机"))}</div>
                      {r.ownerUserId ? <div className="rb-scope is-assigned"><i /><div>
                        <b>{r.owner || r.ownerUserId}</b><small>{tx('用户云主机')} · {r.orgName || tx('未归属组织')}</small>
                      </div></div> : r.embedded ? <div className="rb-subline">
                        <span>{r.owner || tx("未标记归属")}</span><span>{authText(r.authState)}</span>
                      </div> : <div className={'rb-scope ' + (r.orgId ? 'is-assigned' : 'is-unassigned')}>
                        <i /><div><b>{r.orgId ? (tx("服务范围 · ") + (r.orgName || tx("已绑定组织"))) : tx("待归属 · 暂停接活")}</b>
                          <small>{r.orgId ? tx("该组织及下属部门可用") : tx("登记组织范围后才能接收需求")}</small></div>
                      </div>}
                    </td>
                    <td>
                      <span className={'rb-state ' + health.tone}><i />{health.label}</span>
                      <div className="rb-subline">{r.online ? tx("持续在线") : tx("上次在线 ") + timeAgo(r.lastSeen)}</div>
                      {check && <div className={'rb-probe-result ' + check.state}>{check.message}</div>}
                    </td>
                    <td>
                      <div className={'rb-version ' + release.state}>
                        {release.currentVersion ? 'v' + release.currentVersion : tx("未上报")}
                      </div>
                      <div className="rb-subline">
                        {release.state === 'current' ? tx("与 Hub 一致")
                          : release.state === 'ahead' ? tx("高于 Hub v") + release.targetVersion
                            : release.state === 'upgrade_needed' ? tx("目标 v") + release.targetVersion
                              : tx("目标 v") + (release.targetVersion || '—')}
                      </div>
                    </td>
                    <td>
                      <div className="rb-load">{r.busy ? r.busy + tx(" 项执行") : tx("空闲")}</div>
                      <div className="rb-subline">{r.accepting ? tx("可接收新执行")
                        : r.mode === 'draining' ? tx("正在排空") : tx("不接收新执行")}</div>
                      {!!(r.sessions || []).length && <div className="rb-session"
                        title={r.sessions[0].title}>{r.sessions[0].title}</div>}
                    </td>
                    <td><RunnerCapabilities report={r.capabilities} row={r}
                      job={componentJobs[r.runnerId + '::office']} onInstall={(row, key) => setConfirm({
                        title: tx("安装办公组件"),
                        text: tx("在「") + (row.label || row.runnerId) + tx("」上安装并测通办公文档组件？组件使用 SoduWork 审核的固定版本，失败不会替换当前版本。"),
                        run: () => { void installComponent(row, key) },
                      })} /></td>
                    <td className="rb-action-cell"><div className="rb-acts admin-row-actions">
                      <button className="admin-text-action" disabled={!r.online || (check && check.state === 'running')}
                        onClick={() => probe(r)}>{check && check.state === 'running' ? tx("探活中…") : tx("测一下")}</button>
                      {r.ownerUserId && <CloudRunnerActions row={r} busy={busy === r.runnerId}
                        onManage={(row, mode) => setManaging({ row, mode })}
                        onAvailability={(row, enabled) => setConfirm({ title: tx(enabled ? '启用云主机' : '停用云主机'),
                          text: tx(enabled ? '恢复该用户的云端执行能力。' : '停止接收新执行和续聊，正在运行的任务正常结束。用户无法自行恢复，管理员可在任务结束后重新分配。此操作不关闭服务器电源。'),
                          run: () => availability(row, enabled) })} />}
                      {!r.ownerUserId && r.online && <button className="admin-text-action" disabled={busy === r.runnerId}
                        onClick={() => toggleMode(r)}>{r.mode === 'accepting' ? tx("暂停接活") : tx("恢复接活")}</button>}
                      {!r.ownerUserId && <button className="admin-text-action" disabled={busy === r.runnerId}
                        onClick={() => setConfirm({ title: tx("重新登记执行机"), text: tx("提交新配置后旧钥匙会立即作废，「") + (r.label || r.runnerId) + tx("」需要使用新命令重装。"), run: () => setEnrolling(r) })}>{r.orgId && r.authState === 'active' ? tx("重新登记") : tx("登记并发钥匙")}</button>}
                      {!r.ownerUserId && r.authState === 'active' && <button className="admin-text-action danger" disabled={busy === r.runnerId}
                        onClick={() => setConfirm({ title: tx("吊销执行机钥匙"), text: '「' + (r.label || r.runnerId) + tx("」会立即下线，只影响这一台执行机。"), danger: true, run: () => revoke(r) })}>{tx("吊销")}</button>}
                      {!r.ownerUserId && !r.online && <button className="admin-text-action danger" disabled={busy === r.runnerId}
                        onClick={() => setConfirm({ title: tx("删除执行机"), text: tx("从列表删除「") + (r.label || r.runnerId) + tx("」，历史执行记录会保留。"), danger: true, run: () => remove(r) })}>{tx("删除")}</button>}
                    </div></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <ListPager page={safePage} pages={pages} total={filtered.length} unit={tx("台")} onChange={setPage} />
      {managing && <CloudRunnerManagement key={managing.row.runnerId + managing.mode} {...managing}
        onDone={runners.reload} onClose={() => setManaging(null)} />}
      {confirm && <Confirm title={confirm.title} text={confirm.text} danger={confirm.danger}
        confirmText={confirm.danger ? tx("确认操作") : tx("继续")} onConfirm={async () => { await confirm.run(); setConfirm(null) }}
        onClose={() => setConfirm(null)} />}
    </div>
  )
}
