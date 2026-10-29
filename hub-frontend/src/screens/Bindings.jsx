import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useState } from 'react'
import { api } from '../api.js'
import { useViewportHeight } from '../viewport-height.js'
import { useAsync, Loading, Icon, SourceChip, ClientCell, Modal, Confirm, toast, LiveDot, AUTO } from '../ui.jsx'

export default function Bindings() {
  const listRef = useViewportHeight(240)
  const uiLocale = useLocale();
  const bindings = useAsync(() => api.bindings(), AUTO)
  const unassigned = useAsync(() => api.unassigned(), AUTO)
  const clients = useAsync(() => api.clients(), AUTO)
  const ints = useAsync(() => api.integrations(), AUTO)
  const [delTarget, setDelTarget] = useState(null)   // Binding pending deletion.
  const [assignTask, setAssignTask] = useState(null) // Unassigned task pending allocation.
  if (bindings.loading || unassigned.loading || clients.loading || ints.loading) return <Loading />
  const bl = bindings.data || [], ua = unassigned.data || [], cl = clients.data || [], it = ints.data || []
  const intName = (id) => { const x = it.find((i) => i.id === id); return x ? x.name : (id || '').slice(0, 8) }

  return (
    <>
      <div className="toolbar integration-toolbar">
        <span className="hintline">{tx("外部处理人 → SoduWork 的绑定 · 未匹配的聚合需求进入未分配池，手动认领到 SoduWork")}</span>
        <div className="integration-toolbar-actions">
          <LiveDot />
          <button className="btn btn-ghost" onClick={() => { bindings.reload(); unassigned.reload() }}><Icon name="refresh" />{tx("刷新")}</button>
        </div>
      </div>
      <div ref={listRef} className="split integration-bindings admin-viewport-list" tabIndex={0} role="region" aria-label={tx("处理人绑定")}>
        <div className="card">
          <div className="card-head"><h3>{tx("处理人绑定")}</h3><span className="hint">{tx("外部处理人 → SoduWork")}</span></div>
          <div>
            {bl.length === 0 && <div className="empty">{tx("还没有绑定。ingest 进来的需求若匹配不到绑定，会进右侧未分配池。")}</div>}
            {bl.map((b) => (
              <div className="bind-row" key={b.id}>
                <span className="chip src-ext" style={{ flexShrink: 0 }}><span className="dot" />{intName(b.integrationId)}</span>
                <span className="actor">{b.externalActor}</span><span className="arrow">→</span>
                <ClientCell id={b.clientId} clients={cl} />
                <div className="admin-row-actions binding-row-actions">
                  <button className="admin-text-action is-danger" title={tx("删除绑定")} onClick={() => setDelTarget(b)}>{tx("删除")}</button>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="card unassigned">
          <div className="card-head"><h3>{tx("未分配池 · ")}{ua.length}</h3><span className="hint">{tx("无匹配绑定的聚合需求")}</span></div>
          <div>
            {ua.length === 0 && <div className="empty">{tx("没有未分配需求 🎉")}</div>}
            {ua.map((t) => (
              <div className="ua-item" key={t.id}>
                <div className="ua-top"><b>{t.title}</b>{t.urgent && <span className="flag flag-u">{tx("紧急")}</span>}</div>
                <div className="ua-meta"><SourceChip task={t} />{tx("处理人 ")}<span className="mono">{t.externalActor || '—'}</span>{tx("（未绑定）")}</div>
                <div className="ua-actions admin-card-actions"><button className="admin-card-action is-primary" onClick={() => setAssignTask(t)}>{tx("分配到 SoduWork")}</button></div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {delTarget && <Confirm title={tx("删除绑定")} danger confirmText={tx("删除")}
        text={tx("删除「{0}」→ SoduWork 的绑定？该处理人之后聚合进来的需求将进入未分配池，需再次手动认领。", [delTarget.externalActor])}
        onClose={() => setDelTarget(null)}
        onConfirm={async () => { await api.deleteBinding(delTarget.id); toast(tx("已删除绑定")); setDelTarget(null); bindings.reload() }} />}

      {assignTask && <AssignModal task={assignTask} clients={cl}
        onClose={() => setAssignTask(null)}
        onDone={() => { setAssignTask(null); unassigned.reload(); bindings.reload() }} />}
    </>
  )
}

/* Assign through device cards with an optional persistent binding. */
function AssignModal({ task, clients, onClose, onDone }) {
  const uiLocale = useLocale();
  const [cid, setCid] = useState('')
  const [makeBinding, setMakeBinding] = useState(true)
  const [busy, setBusy] = useState(false)
  const online = clients.filter((c) => c.online).length

  async function go() {
    if (!cid) { toast(tx("请先选一个 SoduWork")); return }
    setBusy(true)
    try {
      await api.assign(task.id, { client_id: cid, create_binding: makeBinding && !!task.externalActor })
      toast(tx("已分配到 SoduWork"))
      onDone()
    } catch (e) { toast(tx("失败：") + e.message) }
    setBusy(false)
  }

  return (
    <Modal title={tx("分配到 SoduWork")} icon="link" onClose={onClose}
      foot={<><button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button>
        <button className="btn btn-primary" disabled={busy || !cid} onClick={go}><Icon name="check" />{busy ? tx("分配中…") : tx("确认分配")}</button></>}>
      <div className="muted" style={{ fontSize: 14.5, marginBottom: 8 }}>{tx("把需求 ")}<b style={{ color: 'var(--ink)' }}>{task.title}</b>{tx(" 分配给一个 SoduWork 处理。")}{task.externalActor && <>{tx("处理人 ")}<span className="mono">{task.externalActor}</span>。</>}
      </div>
      <label className="f-lbl">{tx("选择 SoduWork（当前在线 ")}{online}{tx(" 台）")}</label>
      <div className="box-pick">
        {clients.length === 0 && <span className="muted">{tx("还没有注册的 SoduWork，先让一个 SoduWork 上线。")}</span>}
        {clients.map((c) => (
          <span key={c.id} className={'bp' + (cid === c.id ? ' on' : '')} onClick={() => setCid(c.id)}>
            <span className="av">{(c.name || c.id).slice(0, 1)}</span>{c.name || c.id}{!c.online && <span className="muted" style={{ fontSize: 14.5 }}>{tx("·离线")}</span>}
          </span>
        ))}
      </div>
      {task.externalActor && (
        <label className="chkline" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={makeBinding} onChange={(e) => setMakeBinding(e.target.checked)} />
          <span>{tx("顺便建绑定：以后「")}{task.externalActor}{tx("」的需求自动分到该 SoduWork")}</span>
        </label>
      )}
    </Modal>
  )
}
