import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { translateText as tx } from '../i18n.js'
import { ErrorState, Loading, Modal } from '../ui.jsx'

function ImpactList({ heading, rows }) {
  return <section><h4>{heading}</h4>
    {rows.length > 0 && <ul>{rows.map(row => <li key={row.id}>
      {row.label || row.title || row.name} <code>{row.id}</code>
    </li>)}</ul>}
  </section>
}

export default function ModelProviderDeletion({ providerId, onClose, onDeleted }) {
  const [impact, setImpact] = useState(null)
  const [input, setInput] = useState('')
  const [revision, setRevision] = useState(0)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    api.modelProviderDeletionImpact(providerId).then(result => { if (active) setImpact(result) })
      .catch(error => { if (active) setLoadError(error.message) })
    return () => { active = false }
  }, [providerId, revision])

  function refresh() {
    setImpact(null)
    setInput('')
    setLoadError('')
    setRevision(previous => previous + 1)
  }

  async function remove() {
    if (saving || !impact || input !== providerId) return
    setSaving(true)
    try {
      await api.deleteModelProvider(providerId, impact.providerRevision, impact.impactRevision, input)
      onDeleted()
    } catch (error) {
      if (error.status === 409 || error.status === 428) {
        setNotice('删除影响已变化，请重新核对清单后确认')
        refresh()
      } else {
        setNotice(error.message)
      }
    } finally { setSaving(false) }
  }

  return <Modal title={tx('删除模型服务')} icon="alert" onClose={() => { if (!saving) onClose() }}
    foot={<><button className="btn btn-ghost" disabled={saving} onClick={onClose}>{tx('取消')}</button>
      <button className="btn btn-danger" disabled={saving || !impact || input !== providerId}
        onClick={remove}>{saving ? tx('处理中…') : tx('删除')}</button></>}>
    {notice && <p role="alert">{tx(notice)}</p>}
    {loadError ? <ErrorState msg={tx(loadError)} onRetry={refresh} /> : !impact ? <Loading /> : <>
      <p>{tx('删除「{0}」将永久移除该服务及其模型，此操作不可撤销。', [impact.providerName || providerId])}</p>
      <ImpactList heading={tx('将删除的模型（{0}）', [impact.models.length])} rows={impact.models} />
      <p>{tx('以下清单按共享模型名称匹配当前选择。同名模型可能也由其他服务提供。')}</p>
      {impact.scoped && <p>{tx('仅显示你有权查看的成员和需求。')}</p>}
      {impact.canListMembers
        ? <ImpactList heading={tx('已保存模型偏好的成员（{0}）', [impact.members.length])} rows={impact.members} />
        : <p>{tx('需用户管理权限才能查看成员清单。')}</p>}
      {impact.canListTasks
        ? <ImpactList heading={tx('引用模型的未完成需求（{0}）', [impact.tasks.length])} rows={impact.tasks} />
        : <p>{tx('需需求查看权限才能查看需求清单。')}</p>}
      <label><span className="f-lbl">{tx('输入服务 ID「{0}」确认删除', [providerId])}</span>
        <input className="f-in" value={input} onChange={event => setInput(event.target.value)}
          autoComplete="off" spellCheck={false} disabled={saving} /></label>
    </>}
  </Modal>
}
