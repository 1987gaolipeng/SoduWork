import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useState } from 'react'
import { api } from '../api.js'
import { Icon, Modal, toast } from '../ui.jsx'
import './plugin-authoring.css'

const STARTER = "{\n  \"schemaVersion\": 1,\n  \"key\": \"my-enterprise-flow\",\n  \"version\": \"1.0.0\",\n  \"capabilities\": { \"skills\": [], \"mcpServers\": [], \"secrets\": [], \"network\": false },\n  \"workflow\": {\n    \"nodes\": [\n      { \"key\": \"understand\", \"type\": \"ai\",\n        \"config\": { \"prompt\": \"形成执行计划并写入文件\", \"timeoutSeconds\": 3600 },\n        \"outputs\": [\n          { \"key\": \"plan\", \"kind\": \"file\", \"path\": \"deliverables/plan.md\" }\n        ]},\n      { \"key\": \"implement\", \"type\": \"ai\", \"dependsOn\": [\"understand\"],\n        \"config\": { \"prompt\": \"按计划完成实现和验证\", \"timeoutSeconds\": 3600 },\n        \"inputs\": [\n          { \"key\": \"plan\", \"fromNode\": \"understand\", \"outputKey\": \"plan\" }\n        ]}\n    ]\n  }\n}"

const STEPS = localeMap(() => ([
  ['01', '客户端制作', '选择插件制作助手，完成后保存为我的插件。'],
  ['02', '本机试用', '检查参数、技能和连接，在对话中试用并继续改进。'],
  ['03', '提交审核', '选择同事可见范围，上传当前版本；个人版本不受影响。'],
  ['04', '审核并上架', '管理员核对来源、权限与使用范围，确认一次即可上架。'],
]))

function abilityText(node) {
  const cap = node.capabilities || {}
  const out = [
    ...(cap.skills || []).map((x) => `Skill ${x}`),
    ...(cap.mcpServers || []).map((x) => tx("连接器 {0}", [x])),
    ...(cap.secrets || []).map((x) => tx("密钥 {0}", [x])),
  ]
  if (cap.network) out.push(tx("网络"))
  if (['ai', 'ai_review'].includes(node.type) && node.config && node.config.timeoutSeconds) {
    out.push(tx("上限 {0} 分钟", [Math.ceil(node.config.timeoutSeconds / 60)]))
  }
  if (node.capabilities && !out.length) out.push(tx("无额外权限"))
  return out
}

export function PluginAuthorGuide({ onClose, adminOnly = false }) {
  const uiLocale = useLocale();
  const [busy, setBusy] = useState(false)

  async function download() {
    setBusy(true)
    try {
      await api.downloadPluginStarter()
      toast(tx("起步包已下载，可在客户端或代码仓库中开发"))
    } catch (error) { toast(tx("下载失败：") + error.message) }
    setBusy(false)
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(STARTER)
      toast(tx("节点契约示例已复制"))
    } catch (_error) { toast(tx("浏览器没有授予剪贴板权限，请下载起步包")) }
  }

  return <Modal scope="plugin-page" wide title={adminOnly ? tx("企业插件发布规范") : tx("插件开发与提交")} icon="pencil" onClose={onClose} foot={<>
    <button className="btn btn-ghost" onClick={onClose}>{tx("关闭")}</button>
    {!adminOnly && <button className="btn btn-primary" disabled={busy} onClick={download}><Icon name="box" />{busy ? tx("正在生成…") : tx("下载开发起步包")}</button>}
  </>}>
    <section className="author-hero">
      <span className="author-hero-mark"><Icon name="tree" /></span>
      <div><span className="eyebrow">{tx("制作 → 治理")}</span><h3>{adminOnly ? tx("员工在客户端制作，管理员在后台受控发布") : tx("在员工端制作，在管理端受控发布")}</h3><p>{adminOnly ? tx("管理员无需在后台编辑插件内容") : tx("插件内容在客户端工坊或代码仓库中编写和测试；管理端只接收不可变版本，负责预检、评测、审批、发布与回滚。")}</p></div>
    </section>
    <section className="author-boundary" aria-label={tx("插件制作与治理边界")}>
      <article>
        <span><Icon name="pencil" /></span>
        <div><small>{tx("制作区 · 客户端 / 代码仓库")}</small><b>{tx("定义方法、参数、Skill、连接器与可选流程")}</b><p>{tx("个人草稿可先在本机试用；内容确认后打包并主动提交企业审核。")}</p></div>
      </article>
      <i aria-hidden="true">→</i>
      <article>
        <span><Icon name="shield" /></span>
        <div><small>{tx("审核区 · 管理端")}</small><b>{tx("审核一次，通过后上架")}</b><p>{tx("企业提交的插件需核对来源、权限和可见范围；需要执行需求时，再配置项目、环境与执行机。")}</p></div>
      </article>
    </section>
    <div className="author-steps">{STEPS.map(([id, title, text]) => <article key={id}><i>{id}</i><b>{title}</b><p>{text}</p></article>)}</div>
    <p className="author-flow-note">{tx("本机试用验证个人对话中的效果；企业工作流的多节点执行、环境发布和人工验收，需要在授权的测试环境验证。SoduWork 平台级插件仍执行发布评测，不与企业内上传共用轻审核规则。")}</p>
    <details className="author-advanced">
      <summary>{tx("查看包协议、节点交接与安全边界")}</summary>
      <section className="author-contract">
        <div className="author-section-head"><span><b>{tx("跨 Agent 交接")}</b><small>{tx("只传声明过的输入，运行证据保存来源、校验和与截断状态")}</small></span><button onClick={copy}><Icon name="copy" />{tx("复制示例")}</button></div>
        <pre>{STARTER}</pre>
      </section>
      <div className="author-guardrails">
        <span><Icon name="shield" /><b>{tx("最小权限")}</b><small>{tx("插件声明上限，节点再取子集；未声明能力不能在运行时追加。")}</small></span>
        <span><Icon name="key" /><b>{tx("凭据独立托管")}</b><small>{tx("包里只写逻辑名称，绑定到 Runner 密钥引用，明文不进入插件版本。")}</small></span>
        <span><Icon name="activity" /><b>{tx("失败可恢复")}</b><small>{tx("节点超时和配置、授权、环境、产出错误分类展示；修复后从失败节点续跑。")}</small></span>
      </div>
    </details>
  </Modal>
}

export function WorkflowContractPanel({ nodes = [], compact = false }) {
  const uiLocale = useLocale();
  if (!nodes.length) return null
  return <section className={'workflow-contract-panel' + (compact ? ' compact' : '')}>
    <div className="author-section-head"><span><b>{tx("节点协议")}</b><small>{tx("输入、产出和能力是版本快照的一部分")}</small></span><i>{nodes.length}{tx("契约")}</i></div>
    <div className="workflow-contract-list">{nodes.map((node, index) => {
      const inputs = node.inputs || []; const outputs = node.outputs || []; const abilities = abilityText(node)
      return <article key={node.key}>
        <span className="contract-node-id">{String(index + 1).padStart(2, '0')}</span>
        <span className="contract-node-name"><b>{node.name || node.key}</b><small>{node.type} · {node.key}</small></span>
        <span className="contract-node-facts">
          <small>{tx("接收")}</small><b>{inputs.length ? inputs.map((x) => `${x.fromNode}.${x.outputKey} → ${x.key}`).join(' · ') : tx("需求与运行上下文")}</b>
          <small>{tx("交付")}</small><b>{outputs.length ? outputs.map((x) => `${x.key} · ${x.kind}`).join(' · ') : tx("状态与审计证据")}</b>
        </span>
        <span className="contract-node-caps">{abilities.length ? abilities.map((x) => <i key={x}>{x}</i>) : <i>{tx("平台节点")}</i>}</span>
      </article>
    })}</div>
  </section>
}
