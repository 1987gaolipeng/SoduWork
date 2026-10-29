import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Icon, Modal, toast, SelectMenu } from '../ui.jsx'
import { PluginBindingToolAccess } from './PluginBindingToolAccess.jsx'
import { LoadIssue } from './PluginOverviewParts.jsx'
import { Field, NoticeList } from './PluginDialogParts.jsx'

export { Field } from './PluginDialogParts.jsx'

const NODE = localeMap(() => ({
  ai: 'AI 执行',
  ai_review: 'AI 代码审查',
}))

const FALLBACK_KINDS = localeMap(() => ([
  { key: 'hosted', name: '托管智能体', modelPick: false },
  { key: 'local:pi', name: 'Pi', modelPick: true },
  { key: 'local:opencode', name: 'OpenCode', modelPick: true },
  { key: 'local:codex', name: 'Codex', modelPick: false },
]))

function executionOf(raw = {}) {
  return { ...raw, ...(raw.execution || {}) }
}

function overrideState(config = {}) {
  return Object.fromEntries(Object.entries(config.nodeOverrides || {})
    .map(([key, value]) => [key, executionOf(value)]))
}

export function bindingRouteSummary(config = {}) {
  const base = executionOf(config)
  const count = Object.keys(config.nodeOverrides || {}).length
  const kind = (FALLBACK_KINDS.find((item) => item.key === base.agentKind) || {}).name ||
    base.agentKind || tx("自动选择 Agent")
  return [kind, base.model || '', count ? tx("{0} 个节点单独配置", [count]) : tx("全部节点沿用默认")]
    .filter(Boolean).join(' · ')
}

export function AgentChoice({ value, onChange, kinds = [], label = tx("AI 执行器"), inherit = false }) {
  const uiLocale = useLocale();
  const rows = kinds.length ? kinds : FALLBACK_KINDS
  return <Field label={label}><SelectMenu className="f-in" value={value}
    onChange={(event) => onChange(event.target.value)}>
    <option value="">{inherit ? tx("沿用流程默认") : tx("自动选择在线执行机")}</option>
    {rows.map((item) => <option value={item.key} key={item.key}>{item.name}</option>)}
  </SelectMenu></Field>
}

function ModelChoice({ value, onChange, models, inherit = false, disabled = false }) {
  const uiLocale = useLocale();
  return <Field label={tx("模型")}><SelectMenu className="f-in" value={value} disabled={disabled}
    onChange={(event) => onChange(event.target.value)}>
    <option value="">{disabled ? tx("此 Agent 使用自己的模型")
      : inherit ? tx("沿用流程默认模型") : tx("跟随组织默认模型")}</option>
    {models.map((name) => <option value={name} key={name}>{name}</option>)}
  </SelectMenu></Field>
}

export function BindingForm({ plugin, binding, onClose, onSaved }) {
  const uiLocale = useLocale();
  const versions = (plugin.versions || []).filter((item) =>
    (item.trustState === 'approved' && item.enabled) || item.id === (binding && binding.versionId))
  const initialConfig = (binding && binding.config) || {}
  const initial = executionOf(initialConfig)
  const [versionId, setVersionId] = useState((binding && binding.versionId) ||
    (versions[0] && versions[0].id) || '')
  const [projectId, setProjectId] = useState((binding && binding.projectId) || '')
  const [agentKind, setAgentKind] = useState(initial.agentKind || '')
  const [model, setModel] = useState(initial.model || '')
  const [fallbackMode, setFallbackMode] = useState(initial.fallbackMode || 'best-effort')
  const [routeMode, setRouteMode] = useState(initial.agentKind ? 'fixed' : 'auto')
  const [runnerTags, setRunnerTags] = useState((initial.runnerTags || []).join('、'))
  const [nodeOverrides, setNodeOverrides] = useState(() => overrideState(initialConfig))
  const [projects, setProjects] = useState([])
  const [catalog, setCatalog] = useState({ kinds: [], models: [], defaultModel: '' })
  const [readiness, setReadiness] = useState(null)
  const [busy, setBusy] = useState(false)
  const [confirmBreaking, setConfirmBreaking] = useState(false)
  const [secretRefs, setSecretRefs] = useState(() => ({ ...((binding && binding.secretRefs) || {}) }))
  const [mcpTools, setMcpTools] = useState(() => ({ ...((initialConfig && initialConfig.mcpTools) || {}) }))
  const [mcpState, setMcpState] = useState({ ready: true, loading: false, error: '' })
  const [mcpRiskConfirmed, setMcpRiskConfirmed] = useState(Boolean(initialConfig.mcpHighRiskApproved))
  const [availableSecrets, setAvailableSecrets] = useState([])
  const [catalogError, setCatalogError] = useState('')
  const version = versions.find((item) => item.id === versionId) || versions[0] || {}
  const declaredSecrets = (version.capabilities && version.capabilities.secrets) || []
  const declaredMcpServers = (version.capabilities && version.capabilities.mcpServers) || []
  const upgrade = binding && binding.versionId !== versionId
    ? ((binding.upgradeOptions || {})[versionId] || null) : null
  const breakingUpgrade = upgrade && upgrade.level === 'breaking'
  const aiNodes = (((version.workflow || {}).nodes) || [])
    .filter((item) => ['ai', 'ai_review'].includes(item.type))
  const kinds = catalog.kinds.length ? catalog.kinds : FALLBACK_KINDS
  const kindMap = Object.fromEntries(kinds.map((item) => [item.key, item]))
  const currentModels = Object.values(nodeOverrides).map((item) => item.model).filter(Boolean)
  const models = [...new Set([catalog.defaultModel, ...(catalog.models || []), model, ...currentModels]
    .filter(Boolean))]

  async function loadBindingCatalogs() {
    setCatalogError('')
    const [projectResult, agentResult, secretResult] = await Promise.allSettled([
      api.projects(), api.aiAgents(), api.secretReferences(),
    ])
    const failed = []
    if (projectResult.status === 'fulfilled') setProjects(projectResult.value || [])
    else failed.push(tx("项目目录"))
    if (agentResult.status === 'fulfilled') {
      const agents = agentResult.value || {}
      setCatalog({
        kinds: agents.kinds || [],
        models: agents.models || [],
        defaultModel: agents.defaultModel || '',
      })
    } else failed.push(tx("Agent 与模型目录"))
    if (secretResult.status === 'fulfilled') {
      setAvailableSecrets((secretResult.value || []).filter((item) => item.enabled !== false))
    } else failed.push(tx("密钥引用"))
    if (failed.length) setCatalogError(failed.join('、') + tx("加载失败；为避免保存错误配置，已暂停提交"))
  }

  useEffect(() => { loadBindingCatalogs() }, [])
  useEffect(() => {
    const keys = new Set(aiNodes.map((item) => item.key))
    setNodeOverrides((old) => Object.fromEntries(Object.entries(old)
      .filter(([key]) => keys.has(key))))
  }, [versionId])
  useEffect(() => {
    setConfirmBreaking(false)
    setMcpTools({ ...((binding && binding.versionId === versionId && binding.config && binding.config.mcpTools) || {}) })
    setMcpRiskConfirmed(Boolean(binding && binding.versionId === versionId && binding.config && binding.config.mcpHighRiskApproved))
  }, [versionId])
  useEffect(() => {
    const allowed = new Set(declaredSecrets)
    setSecretRefs((old) => Object.fromEntries(Object.entries(old)
      .filter(([key]) => allowed.has(key))))
  }, [versionId])

  function setSecretRef(name, value) {
    setSecretRefs((old) => {
      const next = { ...old }
      if (value) next[name] = value
      else delete next[name]
      return next
    })
  }

  function setNode(key, field, value) {
    setNodeOverrides((old) => {
      const next = { ...(old[key] || {}) }
      if (value) next[field] = value
      else delete next[field]
      const copy = { ...old }
      if (Object.keys(next).length) copy[key] = next
      else delete copy[key]
      return copy
    })
  }

  function chooseRouteMode(next) {
    setRouteMode(next)
    if (next === 'auto') {
      setAgentKind('')
      setModel('')
      setFallbackMode('best-effort')
    }
  }

  function tagArray(value) {
    return [...new Set(String(value || '').split(/[，,、]/)
      .map((item) => item.trim()).filter(Boolean))].slice(0, 20)
  }

  function configBody() {
    const config = { fallbackMode }
    if (routeMode === 'fixed' && agentKind) config.agentKind = agentKind
    if (routeMode === 'fixed' && model && !(agentKind && kindMap[agentKind] && kindMap[agentKind].modelPick === false)) {
      config.model = model
    }
    const tags = tagArray(runnerTags)
    if (tags.length) config.runnerTags = tags
    const overrides = {}
    aiNodes.forEach((node) => {
      const raw = nodeOverrides[node.key] || {}
      const execution = {}
      if (raw.agentKind) execution.agentKind = raw.agentKind
      if (raw.model && !(raw.agentKind && kindMap[raw.agentKind] &&
        kindMap[raw.agentKind].modelPick === false)) execution.model = raw.model
      if (raw.fallbackMode) execution.fallbackMode = raw.fallbackMode
      const nodeTags = tagArray(raw.runnerTags)
      if (nodeTags.length) execution.runnerTags = nodeTags
      if (Object.keys(execution).length) overrides[node.key] = { execution }
    })
    if (Object.keys(overrides).length) config.nodeOverrides = overrides
    if (Object.keys(mcpTools).length) config.mcpTools = mcpTools
    if (mcpRiskConfirmed) config.mcpHighRiskApproved = true
    return config
  }

  async function save() {
    if (!versionId) return
    if (routeMode === 'fixed' && !agentKind) {
      toast(tx("请选择要固定使用的 Agent 底座"))
      return
    }
    setBusy(true)
    setReadiness(null)
    try {
      const config = configBody()
      const check = await api.simulatePluginVersion(versionId, { projectId, config, secretRefs })
      setReadiness(check)
      if (!check.ok) {
        toast(tx("绑定前体检发现阻断项"))
        setBusy(false)
        return
      }
      const body = {
        versionId, projectId, config, secretRefs,
        enabled: binding ? binding.enabled : true,
        confirmBreaking,
      }
      if (binding) await api.updatePluginBinding(binding.id, body)
      else await api.bindPlugin(plugin.id, body)
      toast(binding ? tx("节点执行配置已保存") : tx("绑定已启用"))
      onSaved()
    } catch (error) {
      toast((binding ? tx("保存失败：") : tx("绑定失败：")) + error.message)
    }
    setBusy(false)
  }

  const defaultOwnModel = routeMode === 'fixed' && agentKind && kindMap[agentKind] &&
    kindMap[agentKind].modelPick === false
  const overrideCount = Object.keys(nodeOverrides).length
  return <Modal scope="plugin-page" wide title={`${binding ? tx("调整") : tx("启用")}「${plugin.name}」`} icon="link"
    onClose={onClose} foot={<><button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button>
      <button className="btn btn-primary"
        disabled={busy || !versionId || !!catalogError || !mcpState.ready || mcpState.loading ||
          (routeMode === 'fixed' && !agentKind) || (breakingUpgrade && !confirmBreaking)} onClick={save}>
        {busy ? tx("正在检查可用性…") : binding ? tx("检查并保存") : tx("检查并启用")}
      </button></>}>
    <p className="plugin-modal-intro">{tx("确定使用范围和执行策略即可启用。SoduWork 会在保存前检查 Agent、Runner、权限与连接，避免错误配置影响执行。")}</p>
    <div className="binding-setup-steps" aria-label={tx("启用流程")}>
      <span><i>1</i><b>{tx("使用范围")}</b><small>{tx("给谁使用")}</small></span>
      <span><i>2</i><b>{tx("执行策略")}</b><small>{tx("怎么完成")}</small></span>
      <span><i>3</i><b>{tx("就绪检查")}</b><small>{tx("能否运行")}</small></span>
    </div>
    {catalogError && <LoadIssue message={catalogError} onRetry={loadBindingCatalogs} />}
    <section className="binding-setup-section">
      <header><i>1</i><span><b>{tx("开放给谁")}</b><small>{tx("组织通用适合公共办公能力；研发流程通常绑定到具体项目。")}</small></span></header>
      <div className="form-pair">
        <Field label={tx("使用范围")}><SelectMenu className="f-in" value={projectId}
          onChange={(event) => setProjectId(event.target.value)}>
          <option value="">{tx("组织内所有需求")}</option>
          {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </SelectMenu></Field>
        <Field label={tx("使用版本")}><SelectMenu className="f-in" value={versionId}
          onChange={(event) => setVersionId(event.target.value)}>
          {versions.map((item) => <option key={item.id} value={item.id}>v{item.version}</option>)}
        </SelectMenu></Field>
      </div>
    </section>
    {upgrade && <CompatibilityNotice data={upgrade} confirm={confirmBreaking}
      onConfirm={setConfirmBreaking} />}
    <section className="binding-setup-section">
      <header><i>2</i><span><b>{tx("选择执行策略")}</b><small>{tx("推荐让 SoduWork 根据在线状态与能力自动选择；只有合规或专机要求时才固定底座。")}</small></span></header>
      <div className="binding-route-choice" role="radiogroup" aria-label={tx("执行策略")}>
        <button type="button" role="radio" aria-checked={routeMode === 'auto'}
          className={routeMode === 'auto' ? 'on' : ''} onClick={() => chooseRouteMode('auto')}>
          <Icon name="sparkle" /><span><b>{tx("智能选择")}</b><small>{tx("自动使用满足要求且在线的 Agent 与 Runner")}</small></span><em>{tx("推荐")}</em>
        </button>
        <button type="button" role="radio" aria-checked={routeMode === 'fixed'}
          className={routeMode === 'fixed' ? 'on' : ''} onClick={() => chooseRouteMode('fixed')}>
          <Icon name="settings" /><span><b>{tx("固定底座")}</b><small>{tx("指定 Agent 和模型，适合有明确运行约束的流程")}</small></span>
        </button>
      </div>
      {routeMode === 'auto' && <div className="binding-auto-route"><Icon name="check" /><span>
        <b>{tx("已采用企业推荐策略")}</b><small>{tx("执行时自动选择可用底座；底座临时离线时不会让整条流程卡死。")}</small>
      </span></div>}
      {routeMode === 'fixed' && <div className="route-grid binding-fixed-route">
        <AgentChoice value={agentKind} onChange={setAgentKind} kinds={kinds} />
        <ModelChoice value={model} onChange={setModel} models={models} disabled={defaultOwnModel} />
        <Field label={tx("指定底座不可用时")}><SelectMenu className="f-in" value={fallbackMode}
          onChange={(event) => setFallbackMode(event.target.value)}>
          <option value="best-effort">{tx("切换到可用底座")}</option>
          <option value="strict">{tx("暂停并等待处理")}</option>
        </SelectMenu></Field>
      </div>}
      {routeMode === 'fixed' && <details className="route-advanced"><summary>{tx("限定执行机（可选）")}</summary>
        <input className="f-in" value={runnerTags} onChange={(event) => setRunnerTags(event.target.value)}
          placeholder={tx("例如：研发、Windows、内网；用逗号分隔")} />
      </details>}
    </section>
    <section className="binding-setup-section binding-readiness-section">
      <header><i>3</i><span><b>{tx("补齐运行条件")}</b><small>{tx("只显示这个插件真正需要的连接和密钥；其余条件由 SoduWork 自动检查。")}</small></span></header>
      {declaredSecrets.length === 0 && declaredMcpServers.length === 0 && <div className="binding-auto-route"><Icon name="shield" /><span>
        <b>{tx("无需额外配置")}</b><small>{tx("保存时仍会检查版本、在线 Runner、模型和项目权限。")}</small>
      </span></div>}
      {declaredSecrets.length > 0 && <section className="plugin-secret-section">
        <div className="route-section-head"><span><b>{tx("运行密钥")}</b><small>{tx("只选择安全引用，不会显示或写入密钥明文。")}</small></span><i>{declaredSecrets.length}{tx(" 项")}</i></div>
        <div className="plugin-secret-list">{declaredSecrets.map((name) => {
          const selected = availableSecrets.find((item) => item.id === secretRefs[name])
          return <label className="plugin-secret-row" key={name}><span><Icon name="key" /><b>{name}</b>
            <small>{selected ? selected.name + ' · ' + selected.locator : tx("尚未映射，检查时会阻止启用")}</small>
          </span><SelectMenu className="f-in" value={secretRefs[name] || ''}
            onChange={(event) => setSecretRef(name, event.target.value)}>
            <option value="">{tx("选择密钥引用")}</option>
            {availableSecrets.map((item) => <option key={item.id} value={item.id}>
              {item.name} · {item.locator}
            </option>)}
          </SelectMenu></label>
        })}</div>
        {availableSecrets.length === 0 && <p className="plugin-secret-empty">{tx("还没有可用引用，请先在环境配置中接入并测试运行凭据。")}</p>}
      </section>}
      {declaredMcpServers.length > 0 && <PluginBindingToolAccess versionId={versionId}
        servers={declaredMcpServers} value={mcpTools} onChange={setMcpTools} onState={setMcpState}
        riskConfirmed={mcpRiskConfirmed} onRiskConfirmed={setMcpRiskConfirmed} />}
    </section>
    {aiNodes.length > 0 && <details className="binding-node-advanced" defaultOpen={overrideCount > 0}>
      <summary><span><Icon name="settings" /><span><b>{tx("高级：逐节点指定 Agent 或模型")}</b><small>{tx("大多数企业流程不需要设置；只有个别节点有特殊要求时再展开。")}</small></span></span><em>{overrideCount ? tx("{0} 个节点已调整", [overrideCount]) : tx("按需设置")}</em></summary>
      <section className="node-route-section">
        <div className="route-section-head"><span><b>{tx("节点执行路由")}</b><small>{tx("留空即沿用上面的流程策略。")}</small></span><i>{aiNodes.length}{tx(" 个 AI 节点")}</i></div>
        <div className="node-route-list">{aiNodes.map((node, index) => {
          const pref = nodeOverrides[node.key] || {}
          const ownModel = pref.agentKind && kindMap[pref.agentKind] &&
            kindMap[pref.agentKind].modelPick === false
          return <div className="node-route-row" key={node.key}>
            <span className="node-route-id"><i>{String(index + 1).padStart(2, '0')}</i><span>
              <b>{node.name || node.key}</b><small>{NODE[node.type] || node.type}</small>
            </span></span>
            <div className="node-route-controls">
              <AgentChoice value={pref.agentKind || ''}
                onChange={(value) => setNode(node.key, 'agentKind', value)} kinds={kinds} inherit />
              <ModelChoice value={pref.model || ''}
                onChange={(value) => setNode(node.key, 'model', value)} models={models} inherit disabled={ownModel} />
              <Field label={tx("不可用时")}><SelectMenu className="f-in" value={pref.fallbackMode || ''}
                onChange={(event) => setNode(node.key, 'fallbackMode', event.target.value)}>
                <option value="">{tx("沿用流程默认")}</option>
                <option value="best-effort">{tx("切换到可用底座")}</option>
                <option value="strict">{tx("暂停并等待处理")}</option>
              </SelectMenu></Field>
            </div>
            <details className="route-advanced"><summary>{tx("限定执行机")}</summary>
              <input className="f-in" value={pref.runnerTags || ''}
                onChange={(event) => setNode(node.key, 'runnerTags', event.target.value)}
                placeholder={tx("留空沿用流程默认")} />
            </details>
          </div>
        })}</div>
      </section>
    </details>}
    {readiness && <RoutePreview routes={readiness.agentRoutes || []} kinds={kinds} />}
    {readiness && !readiness.ok && <NoticeList tone="bad" title={tx("暂不能启用")}
      items={readiness.blockers || []} />}
    <div className="credential-note"><Icon name="shield" /><p>{tx("检查过程不会开始执行。凭据不写入插件；真正运行时，只向对应 Runner 注入当前节点所需的最小权限。")}</p></div>
  </Modal>
}

export function CompatibilityNotice({ data, confirm = false, onConfirm = null }) {
  const uiLocale = useLocale();
  const changes = (data && data.changes) || []
  const versionText = data.fromVersion
    ? 'v' + data.fromVersion + ' → v' + data.toVersion : 'v' + data.toVersion
  return <section className={'compatibility-strip level-' + (data.level || 'safe')}>
    <span className="compatibility-signal"><Icon name={data.level === 'breaking'
      ? 'alert' : data.level === 'review' ? 'shield' : 'check'} /></span>
    <span className="compatibility-copy"><b>{data.summary}</b><small>{versionText} · {changes.length}{tx(" 项变化")}</small></span>
    {changes.length > 0 && <details><summary>{tx("查看影响")}</summary><ul>
      {changes.slice(0, 8).map((item, index) => <li key={item.code + index}>{item.message}</li>)}
    </ul></details>}
    {data.level === 'breaking' && onConfirm && <label className="compatibility-confirm">
      <input type="checkbox" checked={confirm}
        onChange={(event) => onConfirm(event.target.checked)} />
      <span>{tx("我已查看影响，确认升级这个绑定")}</span>
    </label>}
  </section>
}

function RoutePreview({ routes, kinds }) {
  const uiLocale = useLocale();
  if (!routes.length) return null
  const names = Object.fromEntries(kinds.map((item) => [item.key, item.name]))
  return <section className="route-preview">
    <div className="route-section-head"><span><b>{tx("逐节点预检结果")}</b><small>{tx("这里展示模拟解析出的真实去向，不会开始执行")}</small></span></div>
    {routes.map((row) => <span className={row.ok ? 'ok' : 'bad'} key={row.nodeKey}>
      <i>{row.ok ? '✓' : '!'}</i><b>{row.nodeName}</b>
      <small>{names[row.requested.agentKind] || row.requested.agentKind}
        {row.requested.model ? ` · ${row.requested.model}` : ''} → {row.ok
          ? row.resolved.name : tx("没有可用执行机")}{row.fallback ? tx(" · 已降级") : ''}</small>
    </span>)}
  </section>
}
