import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useState } from 'react'
import { api } from '../api.js'
import { useViewportHeight } from '../viewport-height.js'
import { useAsync, Loading, Icon, Modal, Confirm, toast, LiveDot, AUTO } from '../ui.jsx'

function ago(ms) {
  if (!ms) return '—'
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return s + tx(" 秒前")
  if (s < 3600) return Math.floor(s / 60) + tx(" 分钟前")
  if (s < 86400) return Math.floor(s / 3600) + tx(" 小时前")
  return Math.floor(s / 86400) + tx(" 天前")
}
async function copyText(value) {
  try {
    if (navigator.clipboard) { await navigator.clipboard.writeText(value); return true }
  } catch (_) { /* Use the fallback copy path when Clipboard API is unavailable over HTTP. */ }
  const node = document.createElement('textarea')
  node.value = value
  node.setAttribute('readonly', '')
  node.style.position = 'fixed'
  node.style.opacity = '0'
  document.body.appendChild(node)
  node.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(node)
  return ok
}

/* Health precedence: disabled, fetch failure, never fetched, then healthy or awaiting push. */
function health(i, pull, catalog) {
  if (i.type === 'gerrit') return { label: tx("已停用"), tone: 'off' }
  if (!i.enabled) return { label: tx("已停用"), tone: 'off' }
  if (catalog) {
    if (i.repositorySyncOk === false) return { label: tx("目录异常"), tone: 'crit' }
    if (!i.repositorySyncAt) return { label: tx("目录未同步"), tone: 'idle' }
    return { label: tx("目录正常"), tone: 'ok' }
  }
  if (pull) {
    if (i.lastPullOk === false) return { label: tx("拉取异常"), tone: 'crit' }
    if (!i.lastPullAt) return { label: tx("从未拉取"), tone: 'idle' }
    return { label: tx("正常"), tone: 'ok' }
  }
  if (i.lastIngestAt || (i.taskCount || 0) > 0) return { label: tx("接收中"), tone: 'ok' }
  return { label: tx("等待推送"), tone: 'idle' }
}

/* Integration metadata describes pull support and type-specific fields; secrets are configured separately. */
const TYPES = localeMap(() => ({
  generic: { label: '通用 Push', desc: "外部平台把需求信封 POST 到 /api/v1/ingest", pull: false, fields: [] },
  github: {
    label: 'GitHub', desc: '仓库目录与按仓库 Issue 同步', pull: false, catalog: true, fields: [
      { key: 'base_url', label: 'GitHub API 地址（可选）', ph: 'https://api.github.com' },
    ],
  },
  gitlab: {
    label: 'GitLab', desc: 'Issues 增量拉取 + 仓库目录同步', pull: true, catalog: true, fields: [
      { key: 'base_url', label: 'GitLab 地址', ph: 'https://gitlab.example.com' },
      { key: 'project', label: "需求拉取项目（可选）", ph: '123 或 group/proj' },
    ],
  },
  ticket: { label: '工单系统', desc: "Push 工单为统一需求", pull: false, fields: [] },
  /*
   * Testing integrations push issues to /api/v1/webhooks/{integrationId}; fieldMap aligns
   * external names before project and owner mapping and batch dispatch.
   */
  testplat: {
    label: '智能化测试平台', desc: 'bug 按工程+负责人推过来（webhook）', pull: false,
    webhook: true, fields: [],
  },
}))
const typeInfo = (t) => t === 'gerrit' ? { label: 'Gerrit', desc: tx("已停用"), retired: true, pull: false, fields: [] } : TYPES[t] || { label: t, desc: tx("自定义来源"), pull: false, fields: [] }

export default function Integrations() {
  const listRef = useViewportHeight(180)
  const uiLocale = useLocale();
  const ints = useAsync(() => api.integrations(), AUTO)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(null)
  const [delTarget, setDelTarget] = useState(null)
  const [rotateTarget, setRotateTarget] = useState(null)
  const [tokenReveal, setTokenReveal] = useState(null)
  if (ints.loading) return <Loading />
  const list = ints.data || []

  return (
    <>
      <div className="toolbar integration-toolbar">
        <span className="hintline">{tx("接入企业系统与代码源：")}<b>GitHub / GitLab</b>{tx(" 的固定拉取账号在「仓库目录」配置并测试连接；同步目录后，可按仓库开启 Issue 自动同步并关联成员账号。")}</span>
        <div className="integration-toolbar-actions">
          <LiveDot />
          <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" />{tx("新建集成源")}</button>
        </div>
      </div>
      {list.length === 0 && <div className="card"><div className="empty">{tx("还没有集成源。点右上「新建集成源」，选类型（通用/GitHub/GitLab/工单）并拿到接入令牌。")}</div></div>}
      <div ref={listRef} className="intgrid admin-viewport-list" tabIndex={0} role="region" aria-label={tx("接入源")}>
        {list.map((i) => <IntCard key={i.id} i={i} onChanged={ints.reload} onEdit={setEditing}
          onDelete={setDelTarget} onRotate={setRotateTarget} />)}
      </div>
      {creating && <IntForm onClose={() => setCreating(false)} onSaved={(result) => {
        setCreating(false); if (result?.ingestToken) setTokenReveal(result); ints.reload()
      }} />}
      {editing && <IntForm initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); ints.reload() }} />}
      {delTarget && <Confirm title={tx("删除集成源")} danger confirmText={tx("删除")}
        text={tx("确定删除「{0}」？已入库的需求会保留（来源变孤儿），接入令牌立即失效。", [delTarget.name])}
        onClose={() => setDelTarget(null)}
        onConfirm={async () => { await api.deleteIntegration(delTarget.id); toast(tx("已删除集成源")); setDelTarget(null); ints.reload() }} />}
      {rotateTarget && <Confirm title={tx("轮换接入令牌")} danger confirmText={tx("轮换令牌")}
        text={tx("轮换「{0}」的接入令牌？旧令牌会立即失效，外部系统必须同步更新。", [rotateTarget.name])}
        onClose={() => setRotateTarget(null)}
        onConfirm={async () => {
          try {
            const result = await api.rotateIntegrationToken(rotateTarget.id)
            setRotateTarget(null); setTokenReveal(result); ints.reload()
          } catch (e) { toast(tx("轮换失败：") + e.message) }
        }} />}
      {tokenReveal && <TokenReveal value={tokenReveal} onClose={() => setTokenReveal(null)} />}
    </>
  )
}

function TokenReveal({ value, onClose }) {
  const uiLocale = useLocale();
  async function copy() {
    const ok = await copyText(value.ingestToken || '')
    toast(ok ? tx("接入令牌已复制") : tx("复制失败，请手动选中复制"))
  }
  return (
    <Modal title={tx("保存接入令牌")} icon="key" onClose={onClose}
      foot={<><button className="btn btn-ghost" onClick={onClose}>{tx("我已保存")}</button><button className="btn btn-primary" onClick={copy}><Icon name="copy" />{tx("复制令牌")}</button></>}>
      <div className="int-hint" style={{ marginBottom: 12 }}>{tx("这是「")}{value.name}{tx("」的接入令牌，")}<b>{tx("只展示这一次")}</b>{tx("。请现在复制到外部系统；丢失后只能安全轮换，SoduWork 不会再次回显原值。")}</div>
      <label className="f-lbl">X-Ingest-Token</label>
      <input className="f-in" value={value.ingestToken || ''} readOnly autoFocus
        onFocus={(e) => e.currentTarget.select()} style={{ fontFamily: 'var(--mono)' }} />
    </Modal>
  )
}

function IntCard({ i, onChanged, onEdit, onDelete, onRotate }) {
  const uiLocale = useLocale();
  const info = typeInfo(i.type)
  const [pulling, setPulling] = useState(false)
  async function toggle() { try { await api.toggleIntegration(i.id, !i.enabled); onChanged() } catch (e) { toast(tx("失败：") + e.message) } }
  async function pull() {
    setPulling(true)
    try { const r = await api.pullIntegration(i.id); toast(tx("拉取完成") + (r && r.upserted != null ? tx("：入库 {0} 条", [r.upserted]) : '')); onChanged() }
    catch (e) { toast(tx("拉取失败：") + e.message) }
    setPulling(false)
  }
  const cfgChips = info.fields.filter((f) => i.config && i.config[f.key]).map((f) => i.config[f.key])
  const cursor = i.cursor && Object.keys(i.cursor).length ? i.cursor : null
  const h = health(i, info.pull, info.catalog)
  const syncAt = info.catalog ? i.repositorySyncAt : info.pull ? i.lastPullAt : i.lastIngestAt
  const repositoryOnly = i.type === 'github'
  const endpointPath = repositoryOnly ? tx('仓库目录 · 按仓库同步 Issue') : info.pull ? tx("/api/v4/…/issues（增量）")
    : info.webhook ? '/api/v1/webhooks/' + i.id : '/api/v1/ingest'
  const syncSummary = ago(syncAt)
    + (info.catalog && i.repositorySyncOk && i.repositorySyncCount ? tx(" · {0} 个仓库", [i.repositorySyncCount])
      : info.pull && i.lastPullOk && i.lastPullCount ? tx(" · {0} 条", [i.lastPullCount]) : '')

  return (
    <div className={'intcard' + (i.enabled ? '' : ' off')}>
      <div className="int-top">
        <span className="int-ico"><Icon name={['gitlab', 'github'].includes(i.type) ? 'plug' : i.type === 'ticket' ? 'ticket' : 'webhook'} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="int-name">
            <span className="int-name-text" title={i.name}>{i.name || tx("未命名集成源")}</span>
            <span className={'int-health h-' + h.tone} title={(info.catalog ? i.repositorySyncError : i.lastPullError) || ''}><i />{h.label}</span>
          </div>
          <div className="int-type">{info.label}{info.pull && <span className="pullbadge">{tx("可拉取")}</span>}</div>
        </div>
        <button className={'toggle' + (i.enabled ? '' : ' off')} title={info.retired ? tx("已停用") : i.enabled ? tx("已启用（点击停用）") : tx("已停用（点击启用）")} disabled={info.retired && !i.enabled} onClick={toggle} />
      </div>
      {h.tone === 'crit' && (info.catalog ? i.repositorySyncError : i.lastPullError) && <div className="int-err" title={(info.catalog ? i.repositorySyncError : i.lastPullError) || ''}><Icon name="alert" />{info.catalog ? i.repositorySyncError : i.lastPullError}</div>}
      {cfgChips.length > 0 && <div className="int-cfg">{cfgChips.map((c, idx) => <span key={idx} className="cfgchip" title={c}>{c}</span>)}</div>}
      <div className="endpoint">
        <span className="m">{info.pull || repositoryOnly ? 'PULL' : 'POST'}</span>
        <span className="integration-endpoint-path" title={endpointPath}>{endpointPath}</span>
        {/* Show credentials only on creation or rotation; ordinary lists expose configuration status. */}
        <span className="tok" title={tx("安全起见，完整令牌不会再次回显")}>{i.ingestTokenSet ? tx("令牌已配置") : tx("令牌未配置")}</span>
      </div>
      {repositoryOnly && <div className="int-hint">{tx("在「仓库目录」配置固定拉取账号，再按仓库开启 Issue 同步。")}</div>}
      <div className="int-stats">
        <div><span className="k">{tx("已入库")}</span><div className="v">{i.taskCount ?? 0}</div></div>
        <div><span className="k">{info.catalog ? tx("目录同步") : info.pull ? tx("最近拉取") : tx("最近接收")}</span><div className="v" title={syncSummary} style={{ fontSize: 14.5, color: 'var(--ink-2)' }}>{syncSummary}</div></div>
        {cursor && <div><span className="k">{tx("拉取游标")}</span><div className="v" style={{ fontSize: 14.5, color: 'var(--ink-2)', fontFamily: 'var(--mono)' }}>{cursor.updated_after ? String(cursor.updated_after).slice(0, 10) : tx("有")}</div></div>}
      </div>
      <div className="int-actions admin-card-actions">
        {info.pull && <button className="admin-card-action is-primary" disabled={pulling} onClick={pull}>{pulling ? tx("拉取中…") : tx("立即拉取")}</button>}
        <button className={'admin-card-action' + (info.pull ? '' : ' is-primary')} disabled={info.retired} onClick={() => onEdit(i)}>{tx("编辑")}</button>
        <button className="admin-card-action" disabled={info.retired} onClick={() => onRotate(i)}>{tx("轮换令牌")}</button>
        <button className="admin-card-action is-danger" onClick={() => onDelete(i)}>{tx("删除")}</button>
      </div>
    </div>
  )
}

/*
 * Map external issue fields using optional dotted paths, falling back to built-in aliases.
 * Require unique identity, owner, and project mappings.
 */
const FM_KEYS = localeMap(() => ([
  ['external_id', 'bug 唯一标识', 'bugId / bugCode / id'],
  ['title', '标题', 'summary / bugTitle'],
  ['note', '描述·复现步骤', 'description / steps'],
  ['status', '状态', 'bugStatus / state'],
  ['assignee', '负责人（谁修）', 'fixUser.account / handler'],
  ['ext_repo', '工程（在哪个仓库改）', 'systemName / project'],
  ['severity', '严重级别', 'bugLevel / priority'],
  ['reporter', '提出者', 'creator / submitter'],
  ['external_url', '原文链接', 'webUrl / link'],
]))

function FieldMapEditor({ value, onChange, editing, id }) {
  const uiLocale = useLocale();
  const fm = value && typeof value === 'object' ? value : {}
  const set = (k, v) => {
    const next = { ...fm }
    if (v.trim()) next[k] = v.trim(); else delete next[k]
    onChange(next)
  }
  return (
    <div>
      <label className="f-lbl">{tx("字段对照（留空＝用内置别名，识别不到再填）")}</label>
      <div className="int-hint" style={{ marginBottom: 8 }}>{tx("平台把 bug ")}<b>POST</b>{tx(" 到 ")}<code>/api/v1/webhooks/{editing && id ? id : tx("{创建后生成的集成id}")}</code>{tx("， 请求头带 ")}<b>X-Ingest-Token</b>{tx("（创建完成时只展示一次；丢失后从卡片安全轮换）。 载荷可单条、也可 ")}<code>{'{items:[…]}'}</code>。
        <br />{tx("★三样缺一不可：")}<b>{tx("bug 唯一标识")}</b>{tx("（否则没法幂等）· ")}<b>{tx("负责人")}</b>{tx("（决定落到谁手上）·")}<b>{tx("工程")}</b>{tx("（决定在哪个仓库改；还要在「工程映射」里把它对到 SoduWork 的工程）。")}</div>
      {FM_KEYS.map(([k, label, ph]) => (
        <div key={k} className="fm-row">
          <span className="fm-k">{label}</span>
          <input className="f-in" value={fm[k] || ''} onChange={(e) => set(k, e.target.value)}
            placeholder={tx("平台上的字段名，如 ") + ph} />
        </div>
      ))}
    </div>
  )
}

function IntForm({ initial, onClose, onSaved }) {
  const uiLocale = useLocale();
  const editing = !!initial
  const [name, setName] = useState(initial ? initial.name : '')
  const [type, setType] = useState(initial ? initial.type : 'generic')
  const [config, setConfig] = useState(initial ? { ...(initial.config || {}) } : {})
  const [busy, setBusy] = useState(false)
  const info = typeInfo(type)
  const setCfg = (k, v) => setConfig((c) => ({ ...c, [k]: v }))

  async function save() {
    if (!name.trim()) { toast(tx("请填集成源名称")); return }
    setBusy(true)
    try {
      const result = editing ? await api.updateIntegration(initial.id, { config })
        : await api.createIntegration({ name: name.trim(), type, config })
      toast(editing ? tx("已保存配置") : tx("已创建，接入令牌已生成"))
      onSaved(result)
    } catch (e) { toast(tx("失败：") + e.message) }
    setBusy(false)
  }

  return (
    <Modal title={editing ? tx("编辑集成源") : tx("新建集成源")} icon="plug" onClose={onClose}
      foot={<><button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button><button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? tx("保存中…") : (editing ? tx("保存配置") : tx("创建"))}</button></>}>
      <div><label className="f-lbl">{tx("名称")}</label>
        <input className="f-in" value={name} onChange={(e) => setName(e.target.value)} disabled={editing} placeholder={tx("如：研发工单 / 产品需求池 / 客服工单")} autoFocus /></div>
      <div><label className="f-lbl">{tx("类型")}{editing && <span className="muted">{tx(" · 已创建不可改")}</span>}</label>
        <div className="typegrid">
          {Object.entries(TYPES).map(([k, v]) => (
            <div key={k} className={'typecard' + (type === k ? ' on' : '') + (editing && type !== k ? ' dim' : '')}
              onClick={() => { if (!editing) { setType(k); setConfig({}) } }}>
              <b>{v.label}{v.pull && <span className="pullbadge sm">{tx("可拉取")}</span>}</b>
              <span>{v.desc}</span>
            </div>
          ))}
        </div>
      </div>
      {info.fields.length > 0 && <div><label className="f-lbl">{info.label}{tx(" 配置")}</label>
        {info.fields.map((f) => (
          <input key={f.key} className="f-in" style={{ marginBottom: 8 }} value={config[f.key] || ''}
            onChange={(e) => setCfg(f.key, e.target.value)} placeholder={f.label + '：' + f.ph} />
        ))}
        {info.catalog && <div className="int-hint">{tx("保存代码源后，进入「仓库目录」配置固定拉取账号并测试连接，再同步仓库。Issue 自动同步在各仓库单独开启。")}</div>}
      </div>}
      {type === 'testplat' && <FieldMapEditor value={config.fieldMap} onChange={(v) => setCfg('fieldMap', v)} editing={editing} id={initial && initial.id} />}
    </Modal>
  )
}
