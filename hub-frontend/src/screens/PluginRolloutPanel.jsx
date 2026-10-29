import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Icon, toast } from '../ui.jsx'
import './plugin-rollout.css'

const LEVEL = localeMap(() => ({
  safe: ['兼容', 'safe'],
  initial: ['兼容', 'safe'],
  review: ['需复核', 'review'],
  breaking: ['破坏性', 'breaking'],
  current: ['一致', 'current'],
}))

const STATE = localeMap(() => ({
  current: '已在目标版本',
  disabled: '绑定已停用',
  blocked: '需要修复',
  eligible: '可切换',
}))

function levelOf(item) {
  return (item.compatibility && item.compatibility.level) || 'review'
}

function Compatibility({ item }) {
  const uiLocale = useLocale();
  const level = levelOf(item)
  const label = LEVEL[level] || [level, 'review']
  return <span className={'plugin-rollout-level is-' + label[1]}>{label[0]}</span>
}

function RolloutRow({ item, checked, onChange }) {
  const uiLocale = useLocale();
  const eligible = item.state === 'eligible' && !(item.issues || []).length
  const details = (item.compatibility && (
    item.compatibility.summary || item.compatibility.reason
  )) || STATE[item.state] || ''
  return <label className={'plugin-rollout-row state-' + item.state +
    (checked ? ' is-selected' : '')}>
    <span className="plugin-rollout-check">
      <input type="checkbox" checked={checked} disabled={!eligible}
        onChange={(event) => onChange(item.id, event.target.checked)}
        aria-label={tx("选择 ") + item.scope} />
    </span>
    <span className="plugin-rollout-scope">
      <b>{item.scope}</b>
      <small>{item.scopeKind === 'project' ? tx("项目绑定") : tx("组织通用")}</small>
    </span>
    <span className="plugin-rollout-rail" aria-label={
      tx("从 ") + item.currentVersion + tx(" 切换到 ") + item.targetVersion}>
      <code>v{item.currentVersion}</code><i /><Icon name="chevron" />
      <code>v{item.targetVersion}</code>
    </span>
    <span className="plugin-rollout-reading">
      <Compatibility item={item} />
      <small>{(item.issues || []).join('；') || details || STATE[item.state]}</small>
    </span>
    <span className={'plugin-rollout-state is-' + item.state}>
      {STATE[item.state] || item.state}
    </span>
  </label>
}

export default function PluginRolloutPanel({ plugin, version, onChanged }) {
  const uiLocale = useLocale();
  const [plan, setPlan] = useState(null)
  const [selected, setSelected] = useState(new Set())
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmBreaking, setConfirmBreaking] = useState(false)

  useEffect(() => {
    let active = true
    setPlan(null); setSelected(new Set()); setError(''); setConfirmBreaking(false)
    if (!plugin || !version || version.trustState !== 'approved' || !version.enabled) {
      return () => { active = false }
    }
    setLoading(true)
    api.pluginRollout(plugin.id, version.id).then((next) => {
      if (!active) return
      setPlan(next)
      setSelected(new Set((next.items || []).filter((item) =>
        item.state === 'eligible' && !(item.issues || []).length &&
        ['safe', 'initial'].includes(levelOf(item))).map((item) => item.id)))
      setLoading(false)
    }).catch((reason) => {
      if (!active) return
      setError(reason.message || String(reason)); setLoading(false)
    })
    return () => { active = false }
  }, [plugin && plugin.id, version && version.id, version && version.enabled,
    version && version.trustState])

  const selectable = useMemo(() => (plan && plan.items || []).filter((item) =>
    item.state === 'eligible' && !(item.issues || []).length), [plan, uiLocale])
  const selectedRows = useMemo(() => selectable.filter((item) =>
    selected.has(item.id)), [selectable, selected, uiLocale])
  const includesBreaking = selectedRows.some((item) => levelOf(item) === 'breaking')
  const allSelected = selectable.length > 0 &&
    selectable.every((item) => selected.has(item.id))

  function choose(id, checked) {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(id); else next.delete(id)
      return next
    })
  }

  function chooseAll() {
    setSelected(allSelected ? new Set() : new Set(selectable.map((item) => item.id)))
  }

  async function apply() {
    if (!selectedRows.length) {
      toast(tx("先选择至少一个可切换的绑定"))
      return
    }
    if (includesBreaking && !confirmBreaking) {
      toast(tx("破坏性变更需要明确确认后才能切换"))
      return
    }
    setBusy(true); setError('')
    try {
      const result = await api.applyPluginRollout(plugin.id, {
        targetVersionId: version.id,
        bindingIds: selectedRows.map((item) => item.id),
        expectedVersions: Object.fromEntries(selectedRows.map((item) =>
          [item.id, item.currentVersionId])),
        confirmBreaking,
      })
      setPlan(result.plan); setSelected(new Set()); setConfirmBreaking(false)
      toast(tx("已原子切换 ") + result.changed + tx(" 个绑定"))
      if (onChanged) await onChanged(result.plan)
    } catch (reason) {
      setError(reason.message || String(reason))
    } finally {
      setBusy(false)
    }
  }

  if (!plugin || !version) return null
  const available = version.trustState === 'approved' && version.enabled

  return <section className="plugin-rollout-panel" aria-labelledby="plugin-rollout-title">
    <header className="plugin-rollout-head">
      <div>
        <span className="eyebrow">{tx("版本分发")}</span>
        <h3 id="plugin-rollout-title">{tx("版本切换与回退")}</h3>
        <p>{tx("先看影响，再一次性切换。任何一项体检失败，全部绑定保持不变。")}</p>
      </div>
      <span className={'plugin-rollout-target' + (available ? ' is-ready' : '')}>
        <small>{tx("目标版本")}</small><b>v{version.version}</b>
        <em>{available ? tx("可信且已启用") : tx("尚不可发布")}</em>
      </span>
    </header>

    {!available && <div className="plugin-rollout-empty">{tx("版本通过评测、审批并启用后，才可查看发布影响。")}</div>}

    {available && loading && <div className="plugin-rollout-empty">{tx("正在核对绑定与运行条件…")}</div>}
    {available && error && <div className="plugin-rollout-error" role="alert">
      <Icon name="alert" /><span><b>{tx("没有完成这次操作")}</b><small>{error}</small></span>
    </div>}

    {available && plan && <>
      <div className="plugin-rollout-summary">
        <span><small>{tx("生效绑定")}</small><b>{plan.summary.active}</b></span>
        <span><small>{tx("可切换")}</small><b>{plan.summary.eligible}</b></span>
        <span className={plan.summary.breaking ? 'has-risk' : ''}>
          <small>{tx("破坏性")}</small><b>{plan.summary.breaking}</b>
        </span>
        <span className={plan.summary.blocked ? 'has-blocker' : ''}>
          <small>{tx("待修复")}</small><b>{plan.summary.blocked}</b>
        </span>
        <button type="button" onClick={chooseAll} disabled={!selectable.length}>
          {allSelected ? tx("取消全选") : tx("选择全部可切换项")}
        </button>
      </div>

      <div className="plugin-rollout-list">
        <div className="plugin-rollout-columns" aria-hidden="true">
          <span /><span>{tx("生效范围")}</span><span>{tx("版本路径")}</span><span>{tx("兼容性与影响")}</span><span>{tx("状态")}</span>
        </div>
        {(plan.items || []).length === 0 && <div className="plugin-rollout-empty">{tx("这个插件还没有绑定到项目或组织。")}</div>}
        {(plan.items || []).map((item) => <RolloutRow key={item.id}
          item={item} checked={selected.has(item.id)} onChange={choose} />)}
      </div>

      <footer className="plugin-rollout-actions">
        <div aria-live="polite">
          <b>{selectedRows.length ? tx("已选择 ") + selectedRows.length + tx(" 个绑定") : tx("尚未选择绑定")}</b>
          <small>{tx("提交前会再次校验版本、密钥、Runner 与项目范围。")}</small>
        </div>
        {includesBreaking && <label className="plugin-rollout-confirm">
          <input type="checkbox" checked={confirmBreaking}
            onChange={(event) => setConfirmBreaking(event.target.checked)} />{tx("我已阅读破坏性影响")}</label>}
        <button className="btn btn-primary" type="button"
          disabled={busy || !selectedRows.length ||
            (includesBreaking && !confirmBreaking)} onClick={apply}>
          {busy ? tx("正在体检并切换…") : tx("体检并切换 ") + selectedRows.length + tx(" 个绑定")}
        </button>
      </footer>
    </>}
  </section>
}
