import { pluginRequirementOptions } from './requirement-governance.js'
import { getLocale, translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useState } from 'react'
import { api } from '../api.js'
import { Icon, Modal, toast, SelectMenu } from '../ui.jsx'
import { LoadIssue } from './PluginOverviewParts.jsx'
import { Field, NoticeList } from './PluginDialogParts.jsx'

const NODE = localeMap(() => ({
  ai: 'AI 执行',
  ai_review: 'AI 代码审查',
  spec: '需求定版',
  quality: '质量门禁',
  validate: '制品校验',
  human_review: '人工验收',
  approval: '发布审批',
  merge: '代码合并',
  condition: '条件判断',
  deploy: '环境发布',
  deploy_chain: '发布链',
  publish: '交付完成',
  script: '受信脚本',
  tool: '工具调用',
}))

const RUN = localeMap(() => ({
  running: '运行中',
  dispatching: '正在派发',
  queued: '排队中',
  waiting_human: '等待人工',
  waiting_external: '等待环境',
  rework: '返修中',
  succeeded: '已完成',
  failed: '运行失败',
  skipped: '已跳过',
  cancelled: '已取消',
}))

const EVENT = localeMap(() => ({
  'run.started': '开始运行',
  'run.completed': '运行完成',
  'run.failed': '运行失败',
  'node.queued': '节点已排队',
  'node.started': '节点开始执行',
  'node.dispatched': '已交给执行机',
  'node.completed': '节点完成',
  'node.failed': '节点失败',
  'gate.waiting': '等待人工处理',
}))

const fmt = (ms) => ms
  ? new Date(ms).toLocaleString(getLocale(), { hour12: false }) : '—'

export function PluginRunForm({ plugin, onClose, onStarted }) {
  const uiLocale = useLocale();
  const [tasks, setTasks] = useState([])
  const bindings = (plugin.bindings || []).filter((item) => item.enabled)
  const [taskId, setTaskId] = useState('')
  const [bindingId, setBindingId] = useState((bindings[0] && bindings[0].id) || '')
  const [inputs, setInputs] = useState({})
  const [busy, setBusy] = useState(false)
  const [taskError, setTaskError] = useState('')
  const selectedBinding = bindings.find((item) => item.id === bindingId) || {}
  const eligibleTasks = pluginRequirementOptions(tasks, selectedBinding)
  const selectedTask = eligibleTasks.find((item) => item.id === taskId)
  const availableTasks = eligibleTasks.filter((item) => !item.blockedReason)
  const version = (plugin.versions || []).find((item) =>
    item.id === selectedBinding.versionId) || plugin.versions[0]
  const defs = (version && version.manifest.inputs) || []

  async function loadTasks() {
    setTaskError('')
    try {
      const rows = (await api.tasks()) || []
      setTasks(rows)
      setTaskId((old) => rows.some((item) => item.id === old)
        ? old : (rows[0] ? rows[0].id : ''))
    } catch (error) {
      setTaskError(tx("需求列表加载失败：") + (error.message || tx("请检查服务连接")))
    }
  }

  useEffect(() => { loadTasks() }, [])
  useEffect(() => {
    if (!availableTasks.some((item) => item.id === taskId)) {
      setTaskId(availableTasks[0] ? availableTasks[0].id : '')
    }
  }, [bindingId, tasks, taskId])

  async function start() {
    if (!selectedTask || selectedTask.blockedReason || !bindingId) {
      toast(selectedTask?.blockedReason ? tx(selectedTask.blockedReason) : tx("请选择可执行需求和启用绑定"))
      return
    }
    setBusy(true)
    try {
      onStarted(await api.startPluginRun(taskId, { bindingId, inputs }))
    } catch (error) {
      toast(tx("启动失败：") + error.message)
    }
    setBusy(false)
  }

  return <Modal scope="plugin-page" wide title={tx("让「{0}」处理需求", [plugin.name])} icon="send" onClose={onClose}
    foot={<><button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button>
      <button className="btn btn-primary" disabled={busy || !!taskError || !selectedTask || !!selectedTask.blockedReason || !bindingId}
        onClick={start}>{busy ? tx("正在启动…") : tx("启动工作流")}</button></>}>
    {taskError && <LoadIssue message={taskError} onRetry={loadTasks} />}
    {bindings.length === 0 && <NoticeList tone="bad" title={tx("还不能启动")}
      items={[tx("先在插件详情中建立一个已启用绑定")]} />}
    <div className="form-pair">
      <Field label={tx("要处理的需求")}><SelectMenu className="f-in" value={taskId}
        onChange={(event) => setTaskId(event.target.value)}>
        <option value="">{tx("选择需求")}</option>
        {eligibleTasks.map((item) => <option key={item.id} value={item.id} disabled={!!item.blockedReason}>
          {item.title}{item.blockedReason ? ` · ${tx(item.blockedReason)}` : ''}
        </option>)}
      </SelectMenu></Field>
      <Field label={tx("使用绑定")}><SelectMenu className="f-in" value={bindingId}
        onChange={(event) => setBindingId(event.target.value)}>
        <option value="">{tx("选择绑定")}</option>
        {bindings.map((item) => <option key={item.id} value={item.id}>
          {item.projectId ? tx("项目专属") : tx("组织通用")} · {item.config.agentKind || tx("自动")}
        </option>)}
      </SelectMenu></Field>
    </div>
    {bindingId && availableTasks.length === 0 && <NoticeList tone="warn" title={tx("没有可执行需求")}
      items={[tx("请在需求池完成澄清并设为待交付，或选择其他绑定；已归档、交付中及无执行权限的需求不能启动")]} />}
    {defs.length > 0 && <div className="plugin-inputs"><span className="eyebrow">{tx("本次输入")}</span>
      {defs.map((def) => <InputField key={def.key} def={def} value={inputs[def.key]}
        onChange={(value) => setInputs((old) => ({ ...old, [def.key]: value }))} />)}
    </div>}
    <div className="run-promise"><span>1</span><p><b>{tx("锁定版本")}</b><small>{tx("运行中不随插件升级漂移")}</small></p><i />
      <span>2</span><p><b>{tx("自动执行")}</b><small>{tx("AI 审查与质量门禁自主推进")}</small></p><i />
      <span>3</span><p><b>{tx("人在关键点决定")}</b><small>{tx("业务验收和生产审批保留给人")}</small></p>
    </div>
  </Modal>
}

function InputField({ def, value, onChange }) {
  const uiLocale = useLocale();
  const label = def.label || def.name || def.key
  const current = value == null ? def.default : value
  const title = label + (def.required ? ' *' : '')
  if (def.type === 'boolean') {
    return <label className="choice-line"><input type="checkbox" checked={!!current}
      onChange={(event) => onChange(event.target.checked)} />
      <span><b>{title}</b><small>{def.description || def.key}</small></span>
    </label>
  }
  if (def.type === 'select') {
    return <Field label={title}><SelectMenu className="f-in" value={current == null ? '' : current}
      onChange={(event) => onChange(event.target.value)}>
      <option value="">{tx("请选择")}</option>
      {(def.options || []).map((option) => <option key={option.value} value={option.value}>
        {option.label || option.value}
      </option>)}
    </SelectMenu>{def.description && <small className="plugin-input-help">{def.description}</small>}</Field>
  }
  if (def.type === 'textarea') {
    return <Field label={title}><textarea className="f-in" rows={3} value={current || ''}
      onChange={(event) => onChange(event.target.value)}
      placeholder={def.placeholder || def.description || ''} />
      {def.description && <small className="plugin-input-help">{def.description}</small>}
    </Field>
  }
  return <Field label={title}><input className="f-in" type={def.type === 'number' ? 'number' : 'text'}
    step={def.type === 'number' ? 'any' : undefined} value={current == null ? '' : current}
    onChange={(event) => onChange(def.type === 'number' && event.target.value !== ''
      ? Number(event.target.value) : event.target.value)}
    placeholder={def.placeholder || def.description || ''} />
    {def.description && <small className="plugin-input-help">{def.description}</small>}
  </Field>
}

export function RunDrawer({ run: initial, onClose }) {
  const uiLocale = useLocale();
  const [run, setRun] = useState(initial)
  const [busyNode, setBusyNode] = useState('')
  const [pollError, setPollError] = useState('')

  async function refreshRun(quiet = false) {
    try {
      setRun(await api.pluginRun(run.id))
      setPollError('')
    } catch (error) {
      setPollError(error.message || tx("无法读取最新运行状态"))
      if (!quiet) toast(tx("运行状态刷新失败：") + (error.message || tx("请检查服务连接")))
    }
  }

  useEffect(() => {
    if (!run || ['succeeded', 'failed', 'cancelled'].includes(run.state)) return undefined
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refreshRun(true)
    }, 4000)
    return () => clearInterval(timer)
  }, [run && run.id, run && run.state])

  async function retry(node) {
    setBusyNode(node.id)
    try {
      const resumeRework = String((node.diagnosis || {}).actionKey || '') === 'resume-rework'
      const out = await api.retryRunGate(run.id, node.key, { resumeRework })
      setRun(out.run)
      toast(resumeRework
        ? tx("已按审查意见回到实施环节，修复后会重新审查")
        : tx("已从「") + (node.name || node.key) + tx("」继续，历史失败证据仍保留"))
    } catch (error) {
      toast(tx("暂时不能重试：") + error.message)
    }
    setBusyNode('')
  }

  async function copyRunId() {
    try {
      await navigator.clipboard.writeText(run.id)
      toast(tx("运行编号已复制"))
    } catch (_error) { toast(tx("暂时无法复制，请稍后重试")) }
  }

  const nodes = run.nodes || []
  const failedNode = nodes.find((node) => node.state === 'failed')
  const activeNode = nodes.find((node) =>
    ['dispatching', 'queued', 'running', 'waiting_human', 'waiting_external', 'rework'].includes(node.state))
  const focusNode = failedNode || activeNode
  const completed = nodes.filter((node) => ['succeeded', 'skipped'].includes(node.state)).length
  const stateCopy = failedNode
    ? tx("停在「{0}」，按下方建议处理后可从本关重试。", [failedNode.name || failedNode.key])
    : activeNode ? tx("正在处理「{0}」，完成后会自动进入下一关。", [activeNode.name || activeNode.key])
      : run.state === 'succeeded' ? tx("所有节点均已完成，运行结果和证据已经归档。")
        : RUN[run.state] || tx("正在读取最新状态。")

  return <Modal scope="plugin-page" wide className="run-drawer" title={tx("插件运行详情")} icon="activity" onClose={onClose}>
        {pollError && <LoadIssue message={tx("运行状态可能已过期：") + pollError}
          onRetry={() => refreshRun(false)} />}
        <section className={'run-summary state-' + run.state}>
          <span className={'run-pulse state-' + run.state} /><div><small>{tx("当前结果")}</small>
            <b>{RUN[run.state] || run.state}</b><p>{stateCopy}</p></div>
          <dl><div><dt>{tx("已完成")}</dt><dd>{completed}/{nodes.length || 0}</dd></div>
            <div><dt>{tx("当前环节")}</dt><dd>{focusNode ? (focusNode.name || focusNode.key) : '—'}</dd></div></dl>
        </section>
        <section className="run-progress-section">
          <header><div><span className="eyebrow">{tx("执行进度")}</span><h4>{tx("每一关发生了什么")}</h4></div>
            <small>{tx("失败节点会自动展开恢复建议")}</small></header>
          <div className="node-run-list">{nodes.map((node) =>
            <NodeRunRow node={node} key={node.id} busy={busyNode === node.id} onRetry={retry} />)}
          </div>
        </section>
        <details className="run-technical-evidence">
          <summary><span><Icon name="shield" /><span><b>{tx("审计与技术信息")}</b><small>{tx("运行编号、路由和原始事件，排障时再查看")}</small></span></span><em>{(run.events || []).length}{tx(" 条事件")}</em></summary>
          <div className="run-id-row"><span><small>{tx("运行编号")}</small><code>{run.id}</code></span>
            <button type="button" onClick={copyRunId}>{tx("复制")}</button></div>
          <section className="evidence-section"><h4>{tx("运行时间线")}</h4>
            {(run.events || []).map((event) => <div className="event-line" key={event.id}>
              <span /><div><b>{EVENT[event.kind] || event.kind}</b><small>{fmt(event.at)}</small></div>
            </div>)}
          </section>
        </details>
  </Modal>
}

function NodeRunRow({ node, busy, onRetry }) {
  const uiLocale = useLocale();
  const output = node.output || {}
  const checks = output.checks || []
  const executor = node.executor || {}
  const requested = executor.requested || {}
  const resolved = executor.resolved || {}
  const input = node.input || {}
  const snapshot = input.contextSnapshot || {}
  const capabilities = input.capabilitySnapshot || {}
  const diagnosis = node.diagnosis || {}
  const inputKeys = snapshot.inputKeys || []
  const references = snapshot.references || []
  const capabilityItems = [
    ...((capabilities.skills || []).map((item) => 'Skill ' + item)),
    ...((capabilities.mcpServers || []).map((item) => tx("连接器 {0}", [item]))),
    ...((capabilities.runtime || []).map((item) => tx("执行能力 ") + item)),
    ...((capabilities.secrets || []).map((item) => tx("密钥 ") + item)),
    ...(capabilities.network ? [tx("网络")] : []),
  ]
  const routeVisible = executor.kind === 'ai' &&
    (requested.agentKind || resolved.agentKind || executor.assignee)
  const expanded = node.state === 'failed' ||
    ['running', 'waiting_human', 'waiting_external', 'rework'].includes(node.state)
  const hasAudit = routeVisible || (snapshot.dependencyKeys || []).length > 0 ||
    capabilityItems.length > 0 || output.log || node.error
  return <details className={'node-run-card state-' + node.state} defaultOpen={expanded}>
    <summary className={'node-run state-' + node.state}><span>{node.attempt}</span><div>
      <b>{node.name || node.key}<em>{NODE[node.type] || node.type}</em></b>
      <small>{node.state === 'failed' ? (diagnosis.title || tx("本关未通过")) : RUN[node.state] || node.state}</small>
    </div><i>{node.state === 'succeeded' ? '✓' : node.state === 'failed' ? '!' : '…'}</i></summary>
    <div className="node-run-detail">
      {diagnosis.kind && <div className={'node-failure diagnosis-' + diagnosis.kind}>
        <span className="node-failure-mark">!</span><div><b>{diagnosis.title}</b><p>{diagnosis.action}</p>
          {diagnosis.detail && <details><summary>{tx("查看技术详情")}</summary><pre>{diagnosis.detail}</pre></details>}
        </div>{diagnosis.retryable && <button disabled={busy} onClick={() => onRetry(node)}>
          {busy ? tx("正在重试…") : diagnosis.requiresFix ? tx("已修复，重试本关") : tx("重试本关")}
        </button>}
      </div>}
      {checks.length > 0 && <div className="node-run-checks">{checks.map((check, index) =>
        <span className={check.ok ? 'ok' : 'bad'} key={index}><i>{check.ok ? '✓' : '!'}</i>
          <b>{check.name || tx("检查")}</b><small>{check.detail || ''}</small>
        </span>)}
      </div>}
      {hasAudit && <details className="node-technical-audit"><summary>{tx("本关技术证据")}</summary><div>
        {routeVisible && <div className="node-route-audit"><span><small>{tx("期望路由")}</small>
          <b>{requested.agentKind || tx("自动选择")}{requested.model ? ' · ' + requested.model : ''}</b>
        </span><i>→</i><span><small>{tx("实际执行")}</small>
          <b>{resolved.host || executor.host || resolved.agentKind || executor.assignee}
            {resolved.model ? ' · ' + resolved.model : ''}</b>
        </span>{executor.fallbackReason && <em>{executor.fallbackReason}</em>}</div>}
        {(snapshot.dependencyKeys || []).length > 0 && <div className="node-context-audit">
          <Icon name="link" /><span>
            <b>{inputKeys.length ? tx("接收输入：") + inputKeys.join('、')
              : tx("接收上游：") + snapshot.dependencyKeys.join('、')}</b>
            <small>{references.length ? references.map((item) =>
              item.fromNode + '.' + item.outputKey).join(' · ') + ' · ' : ''}{tx("上下文快照 ")}{String(snapshot.checksum || '').slice(0, 10)}
              {snapshot.truncated ? tx(" · 已按上限截断") : ''}</small>
          </span>
        </div>}
        {capabilityItems.length > 0 && <div className="node-capability-audit"><Icon name="shield" />
          <span><b>{tx("本关最小权限")}</b><small>{capabilityItems.join(' · ')}</small></span>
        </div>}
        {(output.log || node.error) && <div className="node-run-log"><pre>{output.log || node.error}</pre></div>}
      </div></details>}
    </div>
  </details>
}
