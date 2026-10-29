import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useCallback, useRef, useState, useEffect } from 'react'
import { api, can } from '../api.js'
import { FilterInput, FilterSelect } from '../FilterControls.jsx'
import ListPager from '../ListPager.jsx'
import { useViewportHeight } from '../viewport-height.js'
import { Icon, Modal, toast, Confirm, SelectMenu } from '../ui.jsx'
import RunnerBoard from './RunnerBoard.jsx'
import ClientAccessPolicy from './ClientAccessPolicy.jsx'
import MailSettings from './MailSettings.jsx'
import './client-updates.css'
import './execution-network.css'

const AVA = ['#4f8ff5', '#1ec79b', '#ff9f2e', '#ef5f92', '#7c6cf0']
function avaColor(s) { let h = 0; for (const c of (s || '?')) h = (h * 31 + c.charCodeAt(0)) % 997; return AVA[h % AVA.length] }
function updateMaintenance(item) {
  const value = item && item.detail && item.detail.updateMaintenance
  return value && typeof value === 'object' ? value : null
}

const AUTH_STATES = localeMap(() => ({
  active: {
    label: '已激活',
    help: "设备身份已确认，使用短时会话安全访问需求与企业资源。",
  },
  pending: {
    label: '待激活',
    help: "选择归属用户并保存后，这台 SoduWork 才能读取需求和企业资源。",
  },
  revoked: {
    label: '已停用',
    help: '当前会话已失效；重新选择归属并保存可恢复使用。',
  },
}))
function authState(value) {
  const key = Object.hasOwn(AUTH_STATES, value) ? value : 'pending'
  return { key, ...AUTH_STATES[key] }
}

function ago(ms) {
  if (!ms) return '—'
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return s + tx(" 秒前")
  if (s < 3600) return Math.floor(s / 60) + tx(" 分钟前")
  if (s < 86400) return Math.floor(s / 3600) + tx(" 小时前")
  return Math.floor(s / 86400) + tx(" 天前")
}

const PAGE_SIZE = 25

function Pager({ page, total, onChange }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  return <ListPager page={page} pages={pages} total={total} onChange={onChange} />
}

function DeviceFleet() {
  const listRef = useViewportHeight(180)
  const uiLocale = useLocale();
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState(null)
  const [state, setState] = useState('all')
  const [form, setForm] = useState('all')
  const [page, setPage] = useState(1)
  const [draft, setDraft] = useState('')
  const [composing, setComposing] = useState(false)
  const [q, setQ] = useState('')
  const requestSeq = useRef(0)

  useEffect(() => {
    if (composing) return undefined
    const id = setTimeout(() => { setPage(1); setQ(draft.trim()) }, 260)
    return () => clearTimeout(id)
  }, [draft, composing])

  const load = useCallback(async (quiet = false) => {
    const seq = ++requestSeq.current
    if (!quiet) setLoading(true)
    try {
      const next = await api.clientsPage({ page, pageSize: PAGE_SIZE, state, form, q })
      if (seq !== requestSeq.current) return
      setData(next)
      setError('')
    } catch (e) {
      if (seq !== requestSeq.current) return
      setError(e.message || tx("终端数据没有加载出来"))
    }
    if (!quiet && seq === requestSeq.current) setLoading(false)
  }, [page, q, state, form])

  useEffect(() => {
    let alive = true
    const run = async (quiet) => { if (alive) await load(quiet) }
    run(false)
    const timer = setInterval(() => run(true), 15000)
    return () => { alive = false; clearInterval(timer) }
  }, [load])

  const items = (data && data.items) || []
  const counts = (data && data.counts) || { all: 0, online: 0, offline: 0, pending: 0, mobile: 0 }
  const filters = [['all', tx("全部终端")], ['online', tx("在线")],
    ['offline', tx("离线")], ['pending', tx("待激活")]]
  /* Manage desktop and mobile clients through the shared device identity list. */
  const isMobile = (p) => /^(android|ios|harmony)|^mobile$/i.test(String(p || ''))
  const platformLabel = (p) => {
    const value = String(p || '')
    if (/^android/i.test(value)) return 'Android'
    if (/^ios/i.test(value)) return 'iOS'
    if (/^harmony/i.test(value)) return 'HarmonyOS'
    if (/^win/i.test(value)) return 'Windows'
    if (/^(darwin|mac)/i.test(value)) return 'macOS'
    if (/^linux/i.test(value)) return 'Linux'
    return value || tx("未知系统")
  }
  return <section className="en-panel" aria-label={tx("员工终端列表")}>
    <div className="en-filters admin-filterbar">
      <FilterInput type="search" aria-label={tx("搜索终端、归属人或设备 ID")} value={draft}
        onChange={(e) => { setDraft(e.target.value); if (!e.target.value) { setQ(''); setPage(1) } }}
        onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
        placeholder={tx("搜索终端、归属人或设备 ID")} />
      <div className="admin-filter-options">
      <label className="admin-filter-field en-state-filter"><span>{tx("终端状态")}</span><FilterSelect
        aria-label={tx("终端状态")} value={state} resetValue="all" onChange={(e) => { setState(e.target.value); setPage(1) }}>
        {filters.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </FilterSelect></label>
      <label className="admin-filter-field en-form-filter"><span>{tx("终端形态")}</span><FilterSelect
        aria-label={tx("终端形态")} value={form} resetValue="all" onChange={(e) => { setForm(e.target.value); setPage(1) }}>
        {[['all', tx("全部形态")], ['desktop', tx("桌面端")], ['mobile', tx("移动端")]].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </FilterSelect></label>
      </div>
    </div>
    {error && !data && <div className="en-state bad"><Icon name="alert" /><div><b>{tx("终端数据没有加载出来")}</b><span>{error}</span></div>
      <button className="btn btn-ghost xs" onClick={() => load(false)}>{tx("重试")}</button></div>}
    {loading && !data && <div className="en-state"><span className="en-spinner" /><div><b>{tx("正在读取终端")}</b><span>{tx("只加载当前筛选和当前页")}</span></div></div>}
    {data && !items.length && <div className="en-empty"><Icon name="monitor" /><b>{tx("没有符合条件的终端")}</b>
      <span>{counts.all ? tx("换一个筛选条件或清空搜索词。") : tx("启动 SoduWork 客户端后，终端会自动登记到这里。")}</span></div>}
    {!!items.length && <div ref={listRef} className="en-table-wrap admin-viewport-list" tabIndex={0} role="region" aria-label={tx("员工终端")}><table className="en-table">
      <thead><tr><th>{tx("终端")}</th><th>{tx("归属成员")}</th><th>{tx("连接状态")}</th><th>{tx("设备身份")}</th><th>{tx("系统 / 版本")}</th><th>{tx("最后心跳")}</th><th className="admin-action-heading">{tx("操作")}</th></tr></thead>
      <tbody>{items.map((c) => {
        const auth = authState(c.authState)
        const name = c.ownerName || tx("未分配")
        return <tr key={c.id} className={c.online ? 'is-online' : ''} onDoubleClick={() => setDetail(c)}>
          <td><div className="en-device"><i /><span className="en-avatar" style={{ background: avaColor(name) }}>{name.slice(0, 1)}</span>
            <span><b title={c.name || tx("未命名终端")}>{c.name || tx("未命名终端")}</b><small className="mono" title={c.id}>{c.id}</small></span></div></td>
          <td><b className={c.ownerName ? '' : 'muted'}>{name}</b></td>
          <td><span className={'status-dot ' + (c.online ? 'on' : 'off')}><i />{c.online ? tx("在线") : tx("离线")}</span></td>
          <td><span className={'device-auth-badge ' + auth.key}>{auth.label}</span></td>
          <td><span className="en-stack"><b title={platformLabel(c.platform)}>{platformLabel(c.platform)}{isMobile(c.platform) && <em className="en-form-badge">{tx("移动端")}</em>}</b><small title={c.version ? `v${c.version}` : '—'}>v{c.version || '—'}</small></span></td>
          <td>{ago(c.lastSeen)}</td>
          <td><div className="admin-row-actions"><button className="admin-text-action" onClick={() => setDetail(c)}>{tx("管理")}</button></div></td>
        </tr>
      })}</tbody>
    </table></div>}
    {data && <Pager page={page} total={data.total || 0} onChange={setPage} />}
    {detail && <ClientDetail client={detail} onClose={() => setDetail(null)} onChanged={() => load(true)} />}
  </section>
}

export default function Clients() {
  const uiLocale = useLocale();
  const [tab, setTab] = useState('devices')
  const tabs = [['devices', tx("员工终端"), 'monitor', tx("设备身份与版本")],
    ['runners', tx("Runner 执行机"), 'activity', tx("实际执行的位置")],
    ...((can('client.assign') || can('identity.manage')) ? [['access', tx("登录与额度"), 'shield', tx("自动注册、可信设备与月度额度")]] : [])]
  return <div className="execution-network">
    <div className="en-tabs" role="tablist">{tabs.map(([key, label, icon, sub]) =>
      <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>
        <span><Icon name={icon} /></span><b title={label}>{label}</b><small title={sub}>{sub}</small></button>)}</div>
    {tab === 'devices' && <DeviceFleet />}
    {tab === 'runners' && <RunnerBoard />}
    {tab === 'access' && <><div>{can('client.assign') && <ClientAccessPolicy />}</div>{can('identity.manage') && <MailSettings />}</>}
  </div>
}

function ClientDetail({ client, onClose, onChanged }) {
  const uiLocale = useLocale();
  const [d, setD] = useState(null)
  const [notice, setNotice] = useState('')
  const [owner, setOwner] = useState(client.ownerUserId || '')
  const [busy, setBusy] = useState('')
  const [users, setUsers] = useState([])
  const [updates, setUpdates] = useState([])
  const [confirm, setConfirm] = useState(null)   // Confirmation state for destructive remote actions.

  useEffect(() => {
    let alive = true
    api.clientDetail(client.id)
      .then((next) => { if (alive) { setD(next); setOwner(next.ownerUserId || '') } })
      .catch(() => { if (alive) setD({ ...client, config: {} }) })
    if (can('client.assign')) api.users().then((list) => { if (alive) setUsers(list || []) }).catch(() => {})
    return () => { alive = false }
  }, [client.id])

  useEffect(() => {
    if (!can('client.view')) return undefined
    let alive = true
    const refresh = () => {
      if (document.hidden) return
      api.clientUpdates(client.id)
        .then((next) => { if (alive) setUpdates(next.attempts || []) })
        .catch(() => {})
    }
    refresh()
    const timer = window.setInterval(refresh, 3000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [client.id])

  async function reloadDetail() {
    const next = await api.clientDetail(client.id)
    setD(next)
    setOwner(next.ownerUserId || '')
    if (can('client.view')) api.clientUpdates(client.id)
      .then((history) => setUpdates(history.attempts || [])).catch(() => {})
    return next
  }

  async function push(body, label) {
    setBusy(label)
    try {
      const r = await api.pushClient(client.id, body)
      const delivered = Boolean(r?.delivered)
      if (delivered) {
        toast(tx("已下发（在线，已送达）"))
      } else if (body?.type === "config.patch") {
        // Configuration patches are persisted by the server and applied when the device reconnects.
        toast(tx("已保存（离线，上线后生效）"))
      } else if (body?.type === "notice") {
        // Realtime notices are not queued by the server; keep the draft so the operator can retry.
        toast(tx("设备当前离线，通知未送达，请设备上线后重试"))
      } else {
        toast(tx("设备当前离线，指令未送达，请设备上线后重试"))
      }
      onChanged && onChanged()
      return body?.type === "notice" ? delivered : true
    } catch (e) {
      toast(tx("失败：") + e.message)
      return false
    } finally { setBusy('') }
  }
  async function saveOwner() {
    setBusy('owner')
    try {
      const before = authState((d || client).authState).key
      const result = await api.assignClient(client.id, owner || null)
      await reloadDetail()
      if (!owner) toast(tx("归属已解除，设备访问已停用"))
      else if (before !== 'active' && result.authState === 'active') toast(tx("设备已激活并完成归属"))
      else toast(tx("归属已更新"))
      onChanged && onChanged()
    }
    catch (e) { toast(tx("失败：") + e.message) }
    setBusy('')
  }

  async function changeAccess(action) {
    setBusy(action)
    try {
      if (action === 'revoke') await api.revokeClient(client.id)
      else await api.resetClientEnrollment(client.id)
      await reloadDetail()
      toast(action === 'revoke' ? tx("设备访问已停用") : tx("登记已清除，等待设备重新连接"))
      onChanged && onChanged()
    } catch (e) { toast(tx("失败：") + e.message) }
    setBusy('')
  }
  async function requestUpdate() {
    setBusy('update')
    try {
      const result = await api.requestClientUpdate(client.id)
      if (result.alreadyCurrent) toast(tx("这台 SoduWork 已经是最新版本"))
      else {
        toast(result.delivered
          ? tx("升级任务已送达，客户端将安全下载并请用户确认安装")
          : tx("升级任务已排队，设备下次上线会自动领取"))
        await reloadDetail()
      }
      onChanged && onChanged()
    } catch (e) { toast(tx("升级请求失败：") + e.message) }
    setBusy('')
  }
  const updateLabel = {
    queued: tx("等待设备上线"), available: tx("发现新版本"), downloading: tx("正在下载"),
    downloaded: tx("等待安装"), waiting: tx("等待当前执行结束"), installing: tx("正在安装"), installed: tx("升级完成"),
    deferred: tx("用户稍后安装"), failed: tx("升级失败"),
  }

  const cfg = (d && d.config) || {}
  const current = d || client
  const auth = authState(current.authState)
  const ownerUnchanged = owner === (current.ownerUserId || '')
  const saveDisabled = busy === 'owner' || (!owner && ownerUnchanged) || (ownerUnchanged && auth.key === 'active')
  return (
    <>
      <Modal wide className="client-detail-modal" onClose={onClose}
        title={<span className="client-detail-heading"><span className="cli"><span className="ava">{(client.name || client.id).slice(0, 1)}</span><span className="nm">{client.name || client.id}</span></span>
          <span className={'status-dot ' + (client.online ? 'on' : 'off')}><i />{client.online ? tx("在线") : tx("离线")}</span></span>}
        foot={<>
          {can('client.update') && <button className="btn btn-primary" disabled={busy === 'update'} onClick={() => setConfirm({ title: tx("升级完整客户端"), text: client.online ? tx("系统会创建可追踪的升级任务，客户端下载并校验完整安装包后，由用户确认重启安装。确定下发？") : tx("设备当前离线。升级任务会持久排队，设备下次上线后自动领取，不会丢失。确定排队？"), confirmText: tx("确认升级"), run: requestUpdate })} title={tx("升级完整客户端")}><Icon name="external" />{tx("升级客户端")}</button>}
          {can('client.control') && <button className="btn btn-ghost" disabled={busy === 'reload'} onClick={() => setConfirm({ text: tx("将强制该 SoduWork 立即刷新，会打断用户正在做的事。确定？"), run: () => push({ type: 'command', action: 'reload' }, 'reload') })}><Icon name="refresh" />{tx("强制刷新")}</button>}
          <button className="btn btn-ghost" onClick={onClose}>{tx("关闭")}</button>
        </>}>
          {!d && <div className="muted">{tx("加载中…")}</div>}
          <div className={'device-auth-panel ' + auth.key}>
            <div className="device-auth-copy">
              <span className="device-auth-title"><i />{auth.label}</span>
              <span>{auth.help}</span>
            </div>
            {can('client.control') && auth.key === 'active' && (
              <button className="btn btn-ghost device-auth-action" disabled={busy === 'revoke'} onClick={() => setConfirm({
                title: tx("停用设备访问"),
                text: tx("这会立即让该设备的全部会话失效，但不会删除设备或需求。确定停用？"),
                confirmText: tx("确定停用"),
                run: () => changeAccess('revoke'),
              })}>{tx("停用访问")}</button>
            )}
            {can('client.control') && auth.key !== 'active' && (
              <button className="btn btn-ghost device-auth-action" disabled={busy === 'reset'} onClick={() => setConfirm({
                title: tx("重新登记设备"),
                text: tx("这会清除当前设备身份和用户归属。设备再次连接后会回到待激活状态，需要重新选择归属用户。确定继续？"),
                confirmText: tx("清除并重新登记"),
                run: () => changeAccess('reset'),
              })}>{tx("重新登记")}</button>
            )}
          </div>
          {d && (
            <div className="client-detail-facts">
              <div><div className="f-lbl">{tx("设备 ID")}</div><span className="mono">{d.id}</span></div>
              <div><div className="f-lbl">{tx("版本")}</div>{d.version || '—'}</div>
              <div><div className="f-lbl">{tx("平台")}</div>{d.platform || '—'}</div>
              <div><div className="f-lbl">{tx("需求(未完成/总)")}</div><b>{d.taskOpen}</b> / {d.taskTotal}</div>
              <div><div className="f-lbl">{tx("皮肤/视图")}</div>{(cfg.character || '?') + ' / ' + (cfg.mode || '?')}</div>
            </div>
          )}

          {can('client.assign') && (
            <div><label className="f-lbl">{tx("归属用户（决定 SoduWork 所属部门）")}</label>
              <div className="client-detail-input-action">
                <SelectMenu className="f-in" value={owner} onChange={(e) => setOwner(e.target.value)}>
                  <option value="">{tx("未分配")}</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{(u.displayName || u.username)}</option>)}
                </SelectMenu>
                <button className="btn btn-primary" disabled={saveDisabled} onClick={saveOwner}><Icon name="check" />{auth.key === 'active' ? tx("保存") : tx("激活并保存")}</button>
              </div>
            </div>
          )}

          {can('client.control') && (
            <div><label className="f-lbl">{tx("发一条通知（客户端气泡显示）")}</label>
              <div className="client-detail-input-action">
                <input className="f-in" value={notice} onChange={(e) => setNotice(e.target.value)} placeholder={tx("例：请重启一下 SoduWork 更新配置")} />
                <button className="btn btn-primary" disabled={busy === 'notice' || !notice.trim()} onClick={async () => {
                  const text = notice.trim()
                  if (!text) return
                  if (await push({ type: 'notice', text }, 'notice')) setNotice('')
                }}><Icon name="send" />{tx("发送")}</button>
              </div>
            </div>
          )}

          {can('client.control') && (
            <div><label className="f-lbl">{tx("远程设提醒强度")}</label>
              <div className="seg">{[['off', tx("关闭")], ['light', tx("轻柔")], ['strong', tx("明显")]].map(([v, l]) => (
                <span key={v} className={'s' + (cfg.remind === v ? ' on' : '')} onClick={() => push({ type: 'config.patch', patch: { remind: v } }, 'remind')}>{l}</span>
              ))}</div>
            </div>
          )}

          {can('client.control') && (
            <div><label className="f-lbl">{tx("远程换皮肤")}</label>
              <div className="seg">{[['bear-vivid', tx("玻璃")], ['box-biz', tx("五彩盒子")], ['diamond-ice', tx("钻石")]].map(([v, l]) => (
                <span key={v} className={'s' + (cfg.character === v.split('-')[0] ? ' on' : '')} onClick={() => push({ type: 'command', action: 'set-skin', payload: { skinId: v } }, 'skin')}>{l}</span>
              ))}</div>
            </div>
          )}
          {can('client.view') && (
            <div className="device-update-history">
              <label className="f-lbl">{tx("客户端升级")}</label>
              {updates.length === 0 && <div className="muted">{tx("暂无升级记录")}</div>}
              {updates.slice(0, 4).map((item) => {
                const maintenance = updateMaintenance(item)
                const blockers = maintenance && Array.isArray(maintenance.blockers)
                  ? maintenance.blockers : []
                const blockerCount = Number(maintenance && maintenance.blockerCount || blockers.length)
                return <div key={item.id} className={'device-update-row is-' + item.state}>
                  <span className={'status-dot ' + (item.state === 'installed' ? 'on' : item.state === 'failed' ? 'off' : '')}><i />
                    {updateLabel[item.state] || item.state}</span>
                  <span>{item.currentVersion || '—'} → <b>{item.targetVersion}</b></span>
                  {item.state === 'downloading' && <span>{item.progress}%</span>}
                  {item.state === 'waiting' && <div className="device-update-wait">
                    <b>{tx("已停止向这台设备派发新需求")}</b>
                    <span>{blockerCount
                      ? (tx("正在等待 ") + blockerCount + tx(" 项工作自然结束，结束后自动安装。"))
                      : tx("正在确认 Runner 与本机会话已经排空。")}</span>
                    {blockers.length > 0 && <div>{blockers.slice(0, 3).map((blocker, index) =>
                      <em key={(blocker.id || blocker.runnerId || 'blocker') + index}
                        title={blocker.title || ''}>{blocker.title || tx("正在执行的工作")}</em>)}</div>}
                  </div>}
                  {item.error && <span className="device-update-error" title={item.error}>{item.error}</span>}
                </div>
              })}
            </div>
          )}
      </Modal>
      {confirm && <Confirm title={confirm.title || tx("确认远程操作")} text={confirm.text} danger confirmText={confirm.confirmText || tx("确定下发")} onConfirm={() => { confirm.run(); setConfirm(null) }} onClose={() => setConfirm(null)} />}
    </>
  )
}
