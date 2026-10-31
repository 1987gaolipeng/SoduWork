import React, { useState } from 'react'
import { translateText as tx, useLocale } from '../i18n.js'
import { api } from '../api.js'
import { Modal, SelectMenu, toast } from '../ui.jsx'
import AllowanceFields, { TotalLimitField } from './QuotaAllowanceFields.jsx'
import { allowanceDraft, validateAllowance, validatePlan, replacePlan, validateAssignment } from './quota-model.js'

function Snapshot({ value, latest = false }) {
  const locale = useLocale()
  if (!value) return null
  return <div className="qm-latest"><b>{latest ? tx('服务器最新设置') : tx('额度详情')}</b>
    <span>{value.name || ''} · {value.totalLimit === null ? tx('不限额') : Number(value.totalLimit || 0).toLocaleString(locale) + ' Tokens'}</span>
    {(value.models || []).map(row => <span key={row.provider + '/' + row.model}>{row.provider} / {row.model} · {Number(row.limit).toLocaleString(locale)}</span>)}
    <span>{value.restrictModels ? tx('仅允许使用上面列出的模型') : tx('其他模型共用总额度')}</span>
  </div>
}

function EditorFeedback({ error, conflict, refreshed, latest, onRefresh, busy }) {
  return <>
    {error && <div className="qm-feedback" role="alert"><p>{error}</p>{conflict && <button className="btn btn-ghost" disabled={busy} onClick={onRefresh}>{tx('保留草稿，载入最新版本')}</button>}</div>}
    {refreshed && <><p className="qm-note">{tx('你的草稿已保留。请对照最新设置，确认后覆盖此项。')}</p><Snapshot value={latest} latest /></>}
  </>
}

export function PlanEditor({ plan, config, onConfig, onClose, onSaved }) {
  useLocale()
  const [draft, setDraft] = useState(() => plan ? { ...plan, ...allowanceDraft(plan) } : {
    id: 'plan_' + crypto.randomUUID().replaceAll('-', '').slice(0, 16), name: '', description: '', durationDays: 0, ...allowanceDraft({ totalLimit: 1000000 }),
  })
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [conflict, setConflict] = useState(false), [refreshed, setRefreshed] = useState(false)
  const trial = draft.id === 'trial'
  async function save() {
    setError('')
    try {
      const value = validatePlan(draft, config.models)
      setBusy(true)
      const saved = await api.saveQuotaPlans(replacePlan(config, value))
      onConfig({ ...saved, models: config.models }); onSaved(); onClose(); toast(tx('额度设置已保存'))
    } catch (e) {
      setConflict(e.status === 409)
      setError(e.status === 409 ? tx('其他管理员已修改此配置。草稿已保留，请先载入最新版本。') : tx(e.message))
    } finally { setBusy(false) }
  }
  async function refresh() {
    setBusy(true)
    try { const next = await api.quotaPlans(); onConfig(next); setConflict(false); setError(''); setRefreshed(true) }
    catch (e) { setError(tx(e.message)) }
    finally { setBusy(false) }
  }
  return <Modal title={plan ? tx('编辑套餐') : tx('新建套餐')} icon="ticket" wide className="qm-editor" onClose={() => { if (!busy) onClose() }}
    foot={<><button className="btn btn-ghost" disabled={busy} onClick={onClose}>{tx('取消')}</button><button className="btn btn-primary" disabled={busy || conflict} onClick={save}>{busy ? tx('保存中…') : refreshed ? tx('覆盖此项并保存') : tx('保存套餐')}</button></>}>
    <p className="qm-note">{trial ? tx('注册后自动领取一次。修改只影响之后注册的新用户，已有试用不会延长或重置。') : tx('每个自然月重新计算。修改立即生效，切换套餐或调整额度不会清空已用量。')}</p>
    <label className="qm-field"><span>{tx('套餐名称')}</span><input className="f-in" value={draft.name} maxLength={60} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
    <label className="qm-field"><span>{tx('套餐说明')}</span><input className="f-in" value={draft.description} maxLength={300} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
    {trial && <label className="qm-field"><span>{tx('试用有效天数')}</span><input className="f-in" type="number" min="1" max="365" step="1" value={draft.durationDays} onChange={e => setDraft({ ...draft, durationDays: e.target.value })} /></label>}
    <AllowanceFields value={draft} onChange={value => setDraft({ ...draft, ...value })} choices={config.models} trial={trial} />
    <EditorFeedback {...{ error, conflict, refreshed, busy }} latest={config.plans.find(row => row.id === draft.id)} onRefresh={refresh} />
  </Modal>
}

export function MemberEditor({ member, config, onClose, onSaved }) {
  useLocale()
  const [current, setCurrent] = useState(member)
  const [draft, setDraft] = useState(() => ({ mode: member.assignment.mode, planId: member.assignment.planId || '', custom: allowanceDraft(member.assignment.custom || { totalLimit: 1000000 }) }))
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [conflict, setConflict] = useState(false), [refreshed, setRefreshed] = useState(false)
  const plans = config.plans.filter(row => row.id !== 'trial' || current.assignment.hasTrial)
  const selected = plans.find(row => row.id === draft.planId)
  async function save() {
    setError('')
    try {
      const body = validateAssignment(current, draft, config.models)
      setBusy(true); await api.assignQuota(current.id, body); onSaved(); onClose(); toast(tx('成员额度已保存'))
    } catch (e) {
      setConflict(e.status === 409)
      setError(e.status === 409 ? tx('其他管理员已修改此配置。草稿已保留，请先载入最新版本。') : tx(e.message))
    } finally { setBusy(false) }
  }
  async function refresh() {
    setBusy(true)
    try { const next = await api.quotaMember(current.id); setCurrent(next); setConflict(false); setError(''); setRefreshed(true) }
    catch (e) { setError(tx(e.message)) }
    finally { setBusy(false) }
  }
  return <Modal title={tx('分配成员额度')} icon="users" wide className="qm-editor" onClose={() => { if (!busy) onClose() }}
    foot={<><button className="btn btn-ghost" disabled={busy} onClick={onClose}>{tx('取消')}</button><button className="btn btn-primary" disabled={busy || conflict} onClick={save}>{busy ? tx('保存中…') : refreshed ? tx('覆盖此项并保存') : tx('保存分配')}</button></>}>
    <div className="qm-member-identity"><b>{member.displayName || member.username}</b><span>{member.username}</span></div>
    <p className="qm-note">{tx('调整后立即生效，当前周期已用量保留；新注册试用只能领取一次。')}</p>
    {current.quota.models?.some(row => row.unattributedUsed > 0) && <p className="qm-help">{tx('部分旧版用量未记录服务商，已计入同模型额度；真实总用量只计算一次。')}</p>}
    <label className="qm-field"><span>{tx('额度规则')}</span><SelectMenu aria-label={tx('额度规则')} value={draft.mode} onChange={e => setDraft({ ...draft, mode: e.target.value })}>
      <option value="inherit">{tx('恢复原有规则')}</option><option value="plan">{tx('使用套餐')}</option><option value="custom">{tx('个人自定义')}</option>
    </SelectMenu></label>
    {draft.mode === 'inherit' && <p className="qm-help">{tx('恢复此前的个人月度上限；没有个人设置时，使用原有账号的默认月度额度。')}</p>}
    {draft.mode === 'plan' && <><label className="qm-field"><span>{tx('选择套餐')}</span><SelectMenu aria-label={tx('选择套餐')} value={draft.planId} onChange={e => setDraft({ ...draft, planId: e.target.value })}>
      <option value="">{tx('选择套餐')}</option>{plans.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
    </SelectMenu></label>{selected?.id !== 'trial' && <Snapshot value={selected} />}{selected?.id === 'trial' && <p className="qm-help">{tx('恢复原试用记录，原到期时间和已用量不变。')}</p>}</>}
    {draft.mode === 'custom' && <AllowanceFields value={draft.custom} choices={config.models} onChange={custom => setDraft({ ...draft, custom })} />}
    <EditorFeedback {...{ error, conflict, refreshed, busy }} onRefresh={refresh}
      latest={{ name: current.assignment.mode === 'inherit' ? tx('恢复原有规则') : current.quota.planName || tx('个人自定义'), totalLimit: current.quota.totalLimited ? current.quota.limit : null, models: current.quota.models, restrictModels: current.quota.restrictModels }} />
  </Modal>
}

export function DefaultEditor({ config, onConfig, onClose, onSaved }) {
  useLocale()
  const [limit, setLimit] = useState(config.defaultLimit)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [conflict, setConflict] = useState(false), [refreshed, setRefreshed] = useState(false)
  async function save() {
    setError('')
    try {
      const value = validateAllowance({ totalLimit: limit, models: [], restrictModels: false }, []).totalLimit
      setBusy(true)
      const next = await api.saveQuotaPlans({ revision: config.revision, plans: config.plans, defaultLimit: value })
      onConfig({ ...next, models: config.models }); onSaved(); onClose(); toast(tx('额度设置已保存'))
    } catch (e) { setConflict(e.status === 409); setError(e.status === 409 ? tx('其他管理员已修改此配置。草稿已保留，请先载入最新版本。') : tx(e.message)) }
    finally { setBusy(false) }
  }
  async function refresh() {
    setBusy(true)
    try { onConfig(await api.quotaPlans()); setError(''); setConflict(false); setRefreshed(true) }
    catch (e) { setError(tx(e.message)) }
    finally { setBusy(false) }
  }
  return <Modal title={tx('原有账号默认额度')} icon="settings" className="qm-editor" onClose={() => { if (!busy) onClose() }}
    foot={<><button className="btn btn-ghost" disabled={busy} onClick={onClose}>{tx('取消')}</button><button className="btn btn-primary" disabled={busy || conflict} onClick={save}>{busy ? tx('保存中…') : refreshed ? tx('覆盖此项并保存') : tx('保存')}</button></>}>
    <p className="qm-note">{tx('仅适用于未分配套餐、未设个人额度的原有账号。新注册用户使用试用套餐。')}</p>
    <TotalLimitField value={limit} onChange={setLimit} /><p className="qm-help">{tx('按自然月生效；0 暂停 AI，选择不限额则不设总上限。')}</p>
    <EditorFeedback {...{ error, conflict, refreshed, busy }} latest={{ totalLimit: config.defaultLimit }} onRefresh={refresh} />
  </Modal>
}
