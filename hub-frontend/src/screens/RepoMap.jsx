import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { useViewportHeight } from '../viewport-height.js'
import { FilterInput } from '../FilterControls.jsx'
import { useAsync, Loading, Icon, Confirm, toast, LiveDot, AUTO, SelectMenu } from '../ui.jsx'
import './repositories.css'

/*
 * Require explicit mappings from external project names to repositories; unmatched issues
 * remain unassigned rather than guessing a potentially incorrect code target.
 */
export default function RepoMap() {
  const groupsRef = useViewportHeight(340)
  const uiLocale = useLocale();
  const pend = useAsync(() => api.repoMapPending(), AUTO)
  const binds = useAsync(() => api.repoBindings(), AUTO)
  const ints = useAsync(() => api.integrations(), 0)
  const [del, setDel] = useState(null)
  const [query, setQuery] = useState('')
  if (pend.loading || binds.loading) return <Loading />
  const pending = (pend.data && pend.data.items) || []
  const repos = (pend.data && pend.data.repos) || []
  const list = (binds.data && binds.data.items) || []
  const intName = (id) => ((ints.data || []).find((x) => x.id === id) || {}).name || id
  const reload = () => { pend.reload(); binds.reload() }
  const needle = query.trim().toLowerCase()
  const shownPending = pending.filter((g) => !needle || String(g.externalRepo || '').toLowerCase().includes(needle) || (g.samples || []).some((s) => String(s.title || '').toLowerCase().includes(needle)))
  const shownBindings = list.filter((b) => !needle || [b.externalRepo, b.repoName, b.repoId].some((v) => String(v || '').toLowerCase().includes(needle)))

  return (
    <>
      <div className="toolbar integration-toolbar">
        <span className="hintline">{tx("外部平台推 bug 时带的「工程」在这儿对到 SoduWork 的工程。")}<b>{tx("对不上的 bug 不会瞎猜归属")}</b>{tx("—— 它们留在未分配池，并出现在下面「等着配映射」里。")}</span>
        <div className="integration-toolbar-actions">
          <LiveDot />
          <button className="btn btn-ghost" onClick={reload}><Icon name="refresh" />{tx("刷新")}</button>
        </div>
      </div>

      <div className="admin-filterbar"><FilterInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tx("搜索外部工程或 SoduWork 工程")} aria-label={tx("搜索外部工程或 SoduWork 工程")} /></div>

      <div ref={groupsRef} className="rm-map-groups">
        <div className="card rm-map-list">
          <div className="f-lbl" style={{ marginBottom: 8 }}>{tx("等着配映射")}{pending.length > 0 && <span className="rm-badge">{pend.data.total}{tx(" 条 bug 卡在这儿")}</span>}
          </div>
          {shownPending.length === 0
            ? <div className="empty">{tx("没有卡住的：推进来的 bug 都认出了工程（或者还没有 bug 推进来）。")}</div>
            : shownPending.map((g) => (
              <PendingRow key={g.integrationId + '|' + g.externalRepo} g={g} repos={repos}
                intName={intName(g.integrationId)} onSaved={reload} />
            ))}
        </div>

        <div className="card rm-map-list">
          <div className="f-lbl" style={{ marginBottom: 8 }}>{tx("已配的映射（")}{list.length}）</div>
          {shownBindings.length === 0
            ? <div className="empty">{tx("还没有映射。上面有 bug 卡着的时候，直接在那儿选工程就会生成一条。")}</div>
            : shownBindings.map((b) => (
              <div className="repo-row" key={b.id}>
                <span className="tag">{intName(b.integrationId)}</span>
                <code className="repo-dir" title={tx("平台上的工程标识")}>{b.externalRepo}</code>
                <span className="rm-arrow"><Icon name="chevron-right" /></span>
                <b className="repo-name">{b.repoName || b.repoId}</b>
                {b.note && <span className="repo-nogit">{b.note}</span>}
                <div className="admin-row-actions rm-row-actions">
                  <button className="admin-text-action is-danger" onClick={() => setDel(b)}>{tx("删除")}</button>
                </div>
              </div>
            ))}
        </div>

      </div>

      {del && <Confirm title={tx("删除映射")} danger confirmText={tx("删除")}
        text={tx("删掉「{0} → {1}」？之后这个平台工程推来的 bug 会重新变成\"认不出工程\"，已入库的需求不受影响。", [del.externalRepo, del.repoName || del.repoId])}
        onClose={() => setDel(null)}
        onConfirm={async () => { await api.deleteRepoBinding(del.id); toast(tx("已删除映射")); setDel(null); reload() }} />}
    </>
  )
}

function PendingRow({ g, repos, intName, onSaved }) {
  const uiLocale = useLocale();
  const [rid, setRid] = useState('')
  const [busy, setBusy] = useState(false)
  async function save() {
    if (!rid) { toast(tx("先选一个 SoduWork 工程")); return }
    setBusy(true)
    try {
      const r = await api.saveRepoBinding({ integrationId: g.integrationId, externalRepo: g.externalRepo, repoId: rid })
      /* Backfill blocked issues after mapping and report the actual affected count. */
      const n = (r && r.backfilled) || 0
      toast(n ? tx("映射已保存 · 顺手把卡着的 {0} 条 bug 归到这个工程了", [n]) : tx("映射已保存 · 之后这个工程推来的 bug 会自动归位"))
      onSaved()
    } catch (e) { toast(tx("保存失败：") + e.message) }
    setBusy(false)
  }
  return (
    <div className="rm-pend">
      <div className="rm-pend-top">
        <div className="rm-row-summary">
          <span className="tag">{intName}</span>
          <b className="repo-name">{g.externalRepo}</b>
          <span className="rm-badge">{g.count}{tx(" 条")}</span>
        </div>
      </div>
      <div className="rm-samples">
        {(g.samples || []).map((s) => <span key={s.id} title={s.title}>{s.title}</span>)}
        {g.count > (g.samples || []).length && <span className="muted">{tx("…等 ")}{g.count}{tx(" 条")}</span>}
      </div>
      <div className="rm-map-controls admin-card-actions">
        <SelectMenu className="f-in rm-map-select" aria-label={tx("选择映射的 SoduWork 工程")} value={rid} onChange={(e) => setRid(e.target.value)}>
          <option value="">{tx("对到 SoduWork 的哪个工程…")}</option>
          {repos.map((r) => <option key={r.id} value={r.id}>{r.name}{r.ready ? tx("（已配自动合并）") : ''}</option>)}
        </SelectMenu>
        <button className="admin-card-action is-primary" disabled={busy} onClick={save}>{busy ? tx("保存中…") : tx("配上")}</button>
      </div>
    </div>
  )
}

/*
 * Preview eligible batch groups and blockers before enabling automatic combined dispatch.
 */
export function AutoBatch() {
  const listRef = useViewportHeight(240)
  const uiLocale = useLocale();
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  const load = () => api.autobatch(false).then((x) => { setD(x); setErr('') }).catch((e) => setErr(e.message))
  useEffect(() => { load() }, [])
  if (err) return <div className="card"><div className="empty">{tx("拿不到：")}{err}</div></div>
  if (!d) return <Loading />
  const ready = (d.all || []).filter((g) => g.ready)
  const notReady = (d.all || []).filter((g) => !g.ready)

  return (
    <>
      <div className="toolbar integration-toolbar">
        <span className="hintline">{tx("按「负责人 + 工程」把待处理的 bug 归堆：攒够 ")}<b>{d.min}</b>{tx(" 条、或最早一条等了 ")}<b>{d.waitMin}</b>{tx(" 分钟 且至少 2 条，就合并成一单派给 AI 一次性处理。")}</span>
        <div className="integration-toolbar-actions">
          <span className={'rm-sw' + (d.enabled ? ' on' : '')}>
            {d.enabled ? tx("总开关：已开（会真派）") : tx("总开关：关（只预览）")}
          </span>
          <button className="btn btn-ghost" onClick={load}><Icon name="refresh" />{tx("刷新")}</button>
        </div>
      </div>
      {!d.enabled && <div className="card"><div className="int-hint">{tx("总开关在服务端配置里：")}<code>AUTOBATCH_ENABLED=true</code>{tx("（hub-backend/.env，改完要重启后端）。 开之前建议先在这儿确认「够条件」的那几堆是你想让 AI 动的活。")}</div></div>}

      <div ref={listRef} className="admin-viewport-list integration-batches" tabIndex={0} role="region" aria-label={tx("批量归并")}>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="f-lbl" style={{ marginBottom: 8 }}>{tx("够条件（")}{ready.length}）</div>
        {ready.length === 0
          ? <div className="empty">{tx("这一轮没有够条件的堆。")}</div>
          : ready.map((g, i) => <BatchGroup key={i} g={g} tone="on" />)}
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="f-lbl" style={{ marginBottom: 8 }}>{tx("还不够（")}{notReady.length}{tx("）· 每堆都写清了差在哪")}</div>
        {notReady.length === 0
          ? <div className="empty">{tx("没有在攒的堆。")}</div>
          : notReady.map((g, i) => <BatchGroup key={i} g={g} tone="off" />)}
      </div>
      </div>
    </>
  )
}

function BatchGroup({ g, tone }) {
  const uiLocale = useLocale();
  return (
    <div className={'rm-pend ' + tone}>
      <div className="rm-pend-top">
        <div className="rm-row-summary">
          <b className="repo-name">{g.repoName || g.repoId}</b>
          {g.extRepo && <code className="repo-dir">{g.extRepo}</code>}
          <span className="rm-badge">{(g.taskIds || []).length}{tx(" 条")}</span>
          <span className="repo-branch" title={tx("最早一条等了多久")}>{tx("等 ")}{g.oldestAgeMin}{tx(" 分钟")}</span>
        </div>
        <span className={'repo-cap rm-batch-reason' + (g.ready ? ' on' : '')} title={g.reason || ''}>{g.reason}</span>
      </div>
      <div className="rm-samples">
        {(g.titles || []).slice(0, 4).map((t, i) => <span key={i} title={t}>{t}</span>)}
        {(g.titles || []).length > 4 && <span className="muted">{tx("…共 ")}{g.titles.length}{tx(" 条")}</span>}
      </div>
      {g.aiWorkDir && <div className="rm-dir" title={tx("AI 会在这个目录里干活")}>{g.aiWorkDir}</div>}
    </div>
  )
}
