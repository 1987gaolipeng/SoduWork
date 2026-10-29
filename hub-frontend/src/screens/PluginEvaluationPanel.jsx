import { getLocale, translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Icon, Modal, SelectMenu } from '../ui.jsx'

const FALLBACK_KINDS = localeMap(() => ([
  { key: 'hosted', name: '托管智能体', modelPick: false },
  { key: 'local:pi', name: 'Pi', modelPick: true },
  { key: 'local:opencode', name: 'OpenCode', modelPick: true },
  { key: 'local:codex', name: 'Codex', modelPick: false },
]))

const fmt = (ms) => ms
  ? new Date(ms).toLocaleString(getLocale(), { hour12: false })
  : '—'

function friendlyError(message) {
  const text = String(message || '').trim()
  if (!text) return ''
  if (/当前电脑上的在线 Agent|没有满足.*在线 Agent|没有可用.*执行机/.test(text)) {
    return tx("没有找到满足本次验证要求的在线执行机。SoduWork 会自动使用组织内可用的 Runner；请确认任一执行机在线并已安装所需 Agent，随后重试。")
  }
  return text
}

export function PublicationEvaluationPanel({
  version, data, busy, onStart, onReview, onCancel,
}) {
  const uiLocale = useLocale();
  const [launchCase, setLaunchCase] = useState(null)
  const cases = ((version.capabilities || {}).evaluationCases || [])
  const items = (data && data.items) || []
  const gate = (data && data.gate) || {}
  const capabilities = version.capabilities || {}
  const needsSetup = Boolean((capabilities.secrets || []).length ||
    capabilities.network || (capabilities.mcpServers || []).length ||
    (capabilities.runtime || []).some((item) => ['browser', 'computer'].includes(item)))
  const runs = cases.map((caseItem) => ({
    caseItem,
    run: items.find((item) => item.caseKey === caseItem.key),
  }))
  const active = runs.some(({ run }) => run && ['queued', 'running'].includes(run.state))
  const readyCount = Number(gate.readyCount || runs.filter(({ run }) =>
    run && run.state === 'completed' && run.verdict === 'pending' &&
    ((run.result || {}).contract || {}).ok).length)
  const completedCount = Number(gate.passedCount || 0) + readyCount
  const next = runs.find(({ run }) => !run || run.verdict === 'failed' ||
    ['failed', 'cancelled'].includes(run.state) ||
    (run.state === 'completed' && !((run.result || {}).contract || {}).ok))
  const summary = gate.ok
    ? { state: 'done', icon: 'check', title: tx("质量验证已通过"),
      detail: tx("{0} 项代表性场景均有可追溯证据", [gate.caseCount || cases.length]) }
    : gate.readyForApproval
      ? { state: 'ready', icon: 'shield', title: tx("验证完成，等待发布确认"),
        detail: tx("点击“审核通过”时会一并确认这些证据，不需要再逐项点通过") }
      : active
        ? { state: 'active', icon: 'activity', title: tx("正在自动验证"),
          detail: tx("SoduWork 已选择合适的 Agent 与执行机，完成后会自动更新") }
        : { state: 'pending', icon: 'activity', title: tx("还需完成自动验证"),
          detail: tx("{0}/{1} 项完成；默认由平台自动选择 Agent、模型和执行机", [completedCount, gate.caseCount || cases.length]) }

  async function begin(caseItem) {
    if (!caseItem) return
    if (needsSetup) setLaunchCase(caseItem)
    else await onStart(caseItem, {})
  }

  return <section className="publication-evaluation">
    <div className={'evaluation-brief is-' + summary.state}>
      <span className="evaluation-brief-mark"><Icon name={summary.icon} /></span>
      <div className="evaluation-brief-copy">
        <span className="eyebrow">{tx("自动质量验证")}</span>
        <h3>{summary.title}</h3>
        <p>{summary.detail}</p>
      </div>
      <span className="evaluation-brief-count">
        <b>{completedCount}</b><small>/{gate.caseCount || cases.length}{tx(" 项完成")}</small>
      </span>
      {!active && next && <button className="btn btn-primary"
        disabled={busy === 'start:' + next.caseItem.key}
        onClick={() => begin(next.caseItem)}>
        <Icon name="activity" />
        {busy === 'start:' + next.caseItem.key ? tx("正在启动…") :
          needsSetup ? tx("配置并验证") : tx("开始自动验证")}
      </button>}
      {active && <span className="evaluation-live"><i />{tx("执行中")}</span>}
    </div>
    {cases.length === 0 && <div className="evaluation-empty">
      <Icon name="alert" />
      <span>
        <b>{tx("这个版本没有代表性评测")}</b>
        <small>{tx("仍可由管理员明确承担风险后启用，但不会显示为“已验证”。建议下一版本随包声明用例与验收标准。")}</small>
      </span>
    </div>}
    {cases.length > 0 && <details className="evaluation-details"
      defaultOpen={!gate.ok && !gate.readyForApproval}>
      <summary><span>{tx("查看验证场景与证据")}</span><small>{cases.length}{tx(" 项")}</small><Icon name="chevron" /></summary>
      <div className="evaluation-cases">
        {runs.map(({ caseItem, run }) => <EvaluationCase
          key={caseItem.key}
          caseItem={caseItem}
          run={run}
          busy={busy}
          needsSetup={needsSetup}
          onStart={() => begin(caseItem)}
          onAdvanced={() => setLaunchCase(caseItem)}
          onReview={onReview}
          onCancel={onCancel}
        />)}
      </div>
    </details>}
    {launchCase && <EvaluationLaunchModal
      version={version}
      caseItem={launchCase}
      busy={busy === 'start:' + launchCase.key}
      onClose={() => setLaunchCase(null)}
      onStart={async (options) => {
        if (await onStart(launchCase, options)) setLaunchCase(null)
      }}
    />}
  </section>
}

function EvaluationCase({
  caseItem, run, busy, needsSetup, onStart, onAdvanced, onReview, onCancel,
}) {
  const uiLocale = useLocale();
  const [note, setNote] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const active = run && ['queued', 'running'].includes(run.state)
  const contract = (run && run.result && run.result.contract) || {}
  const artifacts = (run && run.result && run.result.artifacts) || []
  const ready = Boolean(run && run.state === 'completed' &&
    run.verdict === 'pending' && contract.ok)
  const stateLabel = !run ? tx("尚未运行") : ({
    queued: tx("正在排队"),
    running: tx("正在执行"),
    completed: ready ? tx("验证完成") : tx("需要检查"),
    failed: tx("执行失败"),
    cancelled: tx("已取消"),
  }[run.state] || run.state)
  const verdictLabel = run && run.verdict === 'passed'
    ? tx("已通过")
    : run && run.verdict === 'failed' ? tx("未通过") : stateLabel

  return <article className={'evaluation-case ' +
    (run && run.verdict === 'passed' ? 'passed' : ready ? 'ready' : '')}>
    <div className="evaluation-case-top">
      <span className="evaluation-case-index"><Icon name="check" /></span>
      <div><b>{caseItem.name}</b><small>{caseItem.instruction}</small></div>
      <span className={'evaluation-state ' +
        (ready ? 'ready' : (run && run.verdict) || (run && run.state) || '')}>
        {verdictLabel}
      </span>
    </div>
    <div className="evaluation-criteria">
      {(caseItem.criteria || []).map((item, index) =>
        <span key={index}>{index + 1}<b>{item}</b></span>)}
    </div>
    {run && <div className="evaluation-execution">
      <span><small>{tx("执行者")}</small><b>{(run.executor || {}).assigneeName || run.agentKind || tx("等待调度")}</b></span>
      <span><small>{tx("运行位置")}</small><b>{(run.executor || {}).host || tx("正在确认")}</b></span>
      <span><small>{tx("结果契约")}</small><b>{contract.ok ? tx("已满足") : active ? tx("执行中") : tx("需要检查")}</b></span>
      <span><small>{tx("开始时间")}</small><b>{fmt(run.startedAt || run.createdAt)}</b></span>
    </div>}
    {artifacts.length > 0 && <div className="evaluation-artifacts">
      {artifacts.map((item) => <span key={item.id} title={item.sha256 || ''}>
        <Icon name="file" />
        <b>{item.filename}</b>
        <small>{item.fetched
          ? Math.max(1, Math.round(item.size / 1024)) + ' KB · ' + item.sha256.slice(0, 10)
          : tx("取回失败")}</small>
      </span>)}
    </div>}
    {run && !active && (contract.blockers || []).length > 0 &&
      <div className="evaluation-blockers">
        {contract.blockers.map((item) => <span key={item}>{item}</span>)}
      </div>}
    {run && run.error && <div className="evaluation-error">
      <b>{tx("这次验证没有启动成功")}</b><span>{friendlyError(run.error)}</span>
    </div>}
    <div className="evaluation-actions">
      {!active && !ready && (!run || run.verdict !== 'passed') && <>
        <button className="btn btn-primary" disabled={busy === 'start:' + caseItem.key}
          onClick={onStart}>
          {busy === 'start:' + caseItem.key ? tx("正在启动…") :
            run ? tx("重新验证") : needsSetup ? tx("配置并验证") : tx("自动验证")}
        </button>
        {!needsSetup && <button className="btn btn-quiet" onClick={onAdvanced}>{tx("高级设置")}</button>}
      </>}
      {active && <>
        <span className="evaluation-live"><i />{tx("Agent 正在执行，页面会自动更新")}</span>
        <button className="btn btn-ghost" disabled={busy === 'cancel:' + run.id}
          onClick={() => onCancel(run)}>{tx("停止")}</button>
      </>}
      {ready && <>
        <span className="evaluation-ready-note"><Icon name="check" />{tx("已满足结果契约，发布审核时一并确认")}</span>
        {!rejecting && <button className="btn btn-quiet"
          onClick={() => setRejecting(true)}>{tx("发现问题")}</button>}
        {rejecting && <>
          <input value={note} onChange={(event) => setNote(event.target.value)}
            placeholder={tx("说明需要修改的问题…")} maxLength={1200} autoFocus />
          <button className="btn btn-quiet" onClick={() => setRejecting(false)}>{tx("取消")}</button>
          <button className="btn btn-danger" disabled={!note.trim() || busy === 'review:' + run.id}
            onClick={async () => {
              await onReview(run, 'failed', note.trim())
              setRejecting(false)
            }}>{tx("标记未通过")}</button>
        </>}
      </>}
    </div>
  </article>
}

function EvaluationLaunchModal({ version, caseItem, busy, onClose, onStart }) {
  const uiLocale = useLocale();
  const capabilities = version.capabilities || {}
  const firstNode = ((version.workflow || {}).nodes || [])
    .find((node) => ['ai', 'ai_review'].includes(node.type)) || {}
  const defaults = firstNode.config || {}
  const declaredSecrets = capabilities.secrets || []
  const external = Boolean(capabilities.network || (capabilities.mcpServers || []).length ||
    (capabilities.runtime || []).some((item) => ['browser', 'computer'].includes(item)))
  const [catalog, setCatalog] = useState({
    agents: [], kinds: [], models: [], defaultModel: '', reason: '',
  })
  const [secrets, setSecrets] = useState([])
  const [agentKind, setAgentKind] = useState(defaults.agentKind || '')
  const [runnerId, setRunnerId] = useState('')
  const [model, setModel] = useState(defaults.model || '')
  const [runnerTags, setRunnerTags] = useState((defaults.runnerTags || []).join('、'))
  const [secretRefs, setSecretRefs] = useState({})
  const [confirmExternal, setConfirmExternal] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [loading, setLoading] = useState(true)
  const kinds = catalog.kinds.length ? catalog.kinds : FALLBACK_KINDS
  const selectedKind = kinds.find((item) => item.key === agentKind)
  const ownModel = Boolean(selectedKind && selectedKind.modelPick === false)
  const models = useMemo(() => [...new Set([
    catalog.defaultModel, ...(catalog.models || []), model,
  ].filter(Boolean))], [catalog, model, uiLocale])
  const requiredRuntime = useMemo(
    () => [...(capabilities.runtime || [])], [version.id, capabilities.runtime, uiLocale])
  const machines = useMemo(() => {
    const rows = new Map()
    for (const agent of (catalog.agents || [])) {
      if (!agent.runnerId) continue
      const id = String(agent.runnerId)
      const current = rows.get(id) || {
        id, label: agent.machineLabel || agent.host || id,
        host: agent.host || '', capabilities: agent.capabilities || {}, agents: [],
      }
      current.agents.push(agent)
      rows.set(id, current)
    }
    return [...rows.values()].map((machine) => {
      const available = new Set((machine.capabilities || {}).available || [])
      return { ...machine,
        missing: requiredRuntime.filter((key) => !available.has(key)) }
    })
  }, [catalog.agents, requiredRuntime, uiLocale])
  const selectedMachine = machines.find((item) => item.id === runnerId)
  const effectiveKind = agentKind || defaults.agentKind || ''

  function supportsKind(machine, kind = effectiveKind) {
    if (!kind) return true
    if (!kind.startsWith('local:')) return false
    const cli = kind.slice('local:'.length)
    return machine.agents.some((item) => item.cli === cli)
  }

  function machineReason(machine) {
    if (machine.missing.length) return tx("缺少：") + machine.missing.join('\u3001')
    if (!supportsKind(machine)) return tx("没有所选 Agent")
    return machine.agents.map((item) => item.cliName || item.cli)
      .filter(Boolean).join('\u3001')
  }

  useEffect(() => {
    let live = true
    Promise.allSettled([
      api.aiAgents(),
      declaredSecrets.length ? api.secretReferences() : Promise.resolve([]),
    ]).then(([agentResult, secretResult]) => {
      if (!live) return
      const failed = []
      if (agentResult.status === 'fulfilled') {
        const value = agentResult.value || {}
        setCatalog({
          agents: value.agents || [],
          kinds: value.kinds || [],
          models: value.models || [],
          defaultModel: value.defaultModel || '',
          reason: value.reason || '',
        })
      } else failed.push(tx("Agent 与模型目录"))
      if (secretResult.status === 'fulfilled') {
        setSecrets((secretResult.value || []).filter((item) => item.enabled !== false))
      } else failed.push(tx("密钥引用"))
      setLoadError(failed.length ? failed.join('、') + tx("加载失败，请重试") : '')
      setLoading(false)
    })
    return () => { live = false }
  }, [version.id])

  function setSecret(name, value) {
    setSecretRefs((old) => {
      const next = { ...old }
      if (value) next[name] = value
      else delete next[name]
      return next
    })
  }

  async function submit() {
    const missing = declaredSecrets.filter((name) => !secretRefs[name])
    if (missing.length) {
      setSubmitError(tx("请先为以下密钥选择安全引用：") + missing.join('、'))
      return
    }
    if (external && !confirmExternal) {
      setSubmitError(tx("请确认本次只连接测试数据和可安全操作的环境"))
      return
    }
    setSubmitError('')
    await onStart({
      agentKind,
      runnerId,
      model: ownModel ? '' : model,
      runnerTags: [...new Set(String(runnerTags || '').split(/[，,、]/)
        .map((item) => item.trim()).filter(Boolean))].slice(0, 12),
      secretRefs,
      confirmExternalAccess: confirmExternal,
    })
  }

  return <Modal scope="plugin-page"
    title={tx("验证设置 · ") + caseItem.name}
    icon="shield"
    onClose={onClose}
    foot={<>
      <button className="btn btn-ghost" onClick={onClose} disabled={busy}>{tx("返回")}</button>
      <button className="btn btn-primary" onClick={submit}
        disabled={busy || loading || Boolean(loadError) ||
          (!machines.length && agentKind !== 'hosted')}>
        {busy ? tx("正在准备验证…") : tx("开始验证")}
      </button>
    </>}
  >
    <div className="evaluation-launch-intro">
      <span className="evaluation-launch-mark"><Icon name="check" /></span>
      <div><b>{caseItem.instruction}</b>
        <small>{tx("平台会自动选择组织内可用的执行资源；只有特殊能力、密钥或外部访问需要在这里确认。")}</small></div>
    </div>
    {loadError && <div className="evaluation-error">{loadError}</div>}
    <div className="evaluation-launch-grid evaluation-launch-routing">
      <label><span>{tx("执行机")}</span>
        <SelectMenu className="f-in" value={runnerId}
          onChange={(event) => setRunnerId(event.target.value)}>
          <option value="">{tx("自动选择合适的在线执行机")}</option>
          {machines.map((machine) => {
            const ready = !machine.missing.length && supportsKind(machine)
            return <option key={machine.id} value={machine.id} disabled={!ready}>
              {machine.label}{machine.host && machine.host !== machine.label
                ? ' \u00b7 ' + machine.host : ''}{' \u00b7 '}{machineReason(machine)}
            </option>
          })}
        </SelectMenu>
      </label>
      <label><span>{tx("执行 Agent")}</span>
        <SelectMenu className="f-in" value={agentKind} onChange={(event) => {
          const value = event.target.value
          setAgentKind(value)
          if (selectedMachine && !supportsKind(
            selectedMachine, value || defaults.agentKind || '')) setRunnerId('')
        }}>
          <option value="">{tx("继承插件声明 / 自动选择")}</option>
          {kinds.map((item) => <option key={item.key} value={item.key}
            disabled={Boolean(selectedMachine && !supportsKind(selectedMachine, item.key))}>
            {item.name}
          </option>)}
        </SelectMenu>
      </label>
      <label><span>{tx("模型")}</span>
        <SelectMenu className="f-in" value={model} disabled={ownModel}
          onChange={(event) => setModel(event.target.value)}>
          <option value="">{ownModel ? tx("此 Agent 使用自己的模型") : tx("继承插件或组织默认模型")}</option>
          {models.map((item) => <option key={item} value={item}>{item}</option>)}
        </SelectMenu>
      </label>
    </div>
    <label className="evaluation-launch-tags"><span>{tx("执行机标签（可选）")}</span>
      <input className="f-in" value={runnerTags} onChange={(event) => setRunnerTags(event.target.value)}
        placeholder={tx("例如：研发、Windows、内网；用逗号分隔")} />
    </label>
    <div className={'evaluation-machine-state ' + (machines.length ? '' : 'is-empty')}>
      <Icon name={machines.length ? 'monitor' : 'alert'} />
      <span>{selectedMachine
        ? `${selectedMachine.label} \u00b7 ${machineReason(selectedMachine)}`
        : machines.length
          ? tx("{0} 台在线执行机，SoduWork 将按能力与负载自动选择", [machines.length])
          : catalog.reason || tx("当前组织没有可用于评测的在线执行机，请先启动 Runner")}</span>
    </div>
    {declaredSecrets.length > 0 && <section className="evaluation-launch-secrets">
      <div><b>{tx("本次运行密钥")}</b><small>{tx("只保存引用关系；密钥值不会进入插件、评测记录或管理端。")}</small></div>
      {declaredSecrets.map((name) => <label key={name}>
        <span><Icon name="key" /><b>{name}</b></span>
        <SelectMenu className="f-in" value={secretRefs[name] || ''}
          onChange={(event) => setSecret(name, event.target.value)}>
          <option value="">{tx("选择安全引用")}</option>
          {secrets.map((item) =>
            <option key={item.id} value={item.id}>{item.name} · {item.locator}</option>)}
        </SelectMenu>
      </label>)}
    </section>}
    {external && <label className="evaluation-external-confirm">
      <input type="checkbox" checked={confirmExternal}
        onChange={(event) => setConfirmExternal(event.target.checked)} />
      <span><b>{tx("确认外部访问边界")}</b>
        <small>{tx("本次会使用网络、连接器、浏览器或电脑能力；连接的是测试数据和可安全操作的环境。")}</small></span>
    </label>}
    {submitError && <div className="evaluation-error">{submitError}</div>}
  </Modal>
}
