import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useState } from 'react'
import { Icon, Modal } from '../ui.jsx'
import PluginAppTag from './PluginAppTag.jsx'

export function PluginRiskConfirm({ request, busy, onClose, onConfirm }) {
  const uiLocale = useLocale();
  const [note, setNote] = useState('')
  const cancelling = request.kind === 'cancel-evaluation'
  const rejecting = request.kind === 'reject-version'
  const revoking = request.kind === 'revoke-version'
  const quick = request.kind === 'quick-bind'
  const requiresNote = rejecting || revoking
  const dangerous = cancelling || requiresNote
  const version = request.version || {}
  const title = cancelling ? tx("停止这次发布评测？") : rejecting ? tx("退回给发布者修改？") : revoking ? tx("撤销这个插件版本？") : tx("缺少发布评测证据")
  const action = cancelling ? tx("停止评测") : rejecting ? tx("确认退回") : revoking ? tx("撤销版本") : quick ? tx("确认风险并启用") : tx("仍然启用")
  const copy = cancelling
    ? tx("停止后不会继续消耗执行资源；已经产生的会话、检查与证据仍会保留，便于后续复核。")
    : rejecting
      ? tx("退回后这个不可变版本不会进入企业目录。请写清需要修改的内容，发布者会在客户端看到原因，并可回到个人插件继续改进后重新提交。")
      : revoking
        ? tx("撤销后这个版本不能再启动新的执行，正在使用它的绑定会被停用；已经开始的运行和历史证据不会被删除。")
        : tx("当前版本没有代表性发布评测。启用后可以被需求和自动化调用，但平台无法证明它在典型场景下达到预期质量。")
  return <Modal scope="plugin-page" title={title} icon="alert" onClose={onClose} foot={<><button className="btn btn-ghost" disabled={busy} onClick={onClose}>{tx("返回")}</button><button className={'btn ' + (dangerous ? 'btn-danger' : 'btn-primary')} disabled={busy || (requiresNote && !note.trim())} onClick={() => onConfirm(note.trim())}>{busy ? tx("正在处理…") : action}</button></>}>
    <section className={'plugin-risk-confirm ' + (dangerous ? 'is-danger' : 'is-warning')}>
      <span className="plugin-risk-mark"><Icon name="alert" /></span>
      <div className="plugin-risk-copy">
        <span className="eyebrow">{cancelling ? 'EVALUATION CONTROL' : rejecting ? 'REVIEW FEEDBACK' : revoking ? 'VERSION CONTROL' : 'QUALITY GATE'}</span>
        <h3 className="plugin-app-heading">{request.pluginName}<PluginAppTag version={version} /></h3><p>{copy}</p>
      </div>
    </section>
    <div className="plugin-risk-facts">
      <span><small>{tx("插件版本")}</small><b>v{version.version || '—'}</b></span>
      {quick && <span><small>{tx("启用范围")}</small><b>{request.projectName || tx("当前项目")}</b></span>}
      {revoking && <span><small>{tx("受影响绑定")}</small><b>{request.bindingCount || 0}{tx(" 个将停用")}</b></span>}
      <span><small>{tx("审计记录")}</small><b>{tx("完整保留")}</b></span>
    </div>
    {requiresNote && <label className="plugin-review-note"><span>{rejecting ? tx("修改要求") : tx("撤销原因")} <b>{tx("必填")}</b></span><textarea maxLength={1200} value={note} onChange={(event) => setNote(event.target.value)} placeholder={rejecting ? tx("说明具体问题、期望修改方向和重新提交标准…") : tx("说明撤销原因和受影响范围…")} /><small>{note.length}/1200</small></label>}
    <ul className="plugin-risk-list">{cancelling ? <>
      <li>{tx("本次评测会标记为已取消，不影响已发布版本。")}</li><li>{tx("以后可以从同一评测用例重新发起。")}</li>
    </> : rejecting ? <>
      <li>{tx("发布者能看到这条反馈，但看不到管理配置或其他敏感信息。")}</li><li>{tx("原版本和审查记录保留；重新提交会生成新的不可变版本。")}</li>
    </> : revoking ? <>
      <li>{tx("新需求和自动化将不再选择这个版本。")}</li><li>{tx("需要恢复时必须重新完成质量门禁并明确启用。")}</li>
    </> : <>
      <li>{tx("建议先补充覆盖真实输入、异常路径和交付验收的评测用例。")}</li><li>{tx("本次越过质量门禁的决定会进入插件审计记录。")}</li>
    </>}</ul>
  </Modal>
}
