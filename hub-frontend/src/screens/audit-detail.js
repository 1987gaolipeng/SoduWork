import { localeMap, translateText as tx } from '../i18n.js'

/* Readable labels for detail keys surfaced by the generic fallback. */
const DETAIL_LABELS = localeMap(() => ({
  version: '版本', versions: '版本', toStage: '阶段', note: '备注', title: '标题',
  chars: '文字', files: '附件', mode: '模式', permissions: '权限', fields: '字段',
  name: '名称', setupFields: '配置', setupState: '状态', mcpServers: '连接器', personalMcpServers: '个人连接',
  count: '数量', status: '状态', state: '状态', date: '日期', provider: '平台',
  environment: '环境', channel: '渠道',
}))
/* Generic fallback for actions without a curated branch, so the details column
   shows the recorded facts instead of an em dash. Identifier or credential keys
   stay hidden; booleans and nested objects contribute no readable text. */
const DETAIL_HIDDEN = /ids?$|uri$|url$|token|secret|password|webhook|apikey/i
function summarizeDetail(d) {
  const parts = []
  for (const [key, value] of Object.entries(d || {})) {
    if (DETAIL_HIDDEN.test(key)) continue
    let text = ''
    if (typeof value === 'number') text = String(value)
    else if (typeof value === 'string') text = value.slice(0, 48)
    else if (Array.isArray(value) && value.length) text = '×' + value.length
    if (!text) continue
    parts.push(`${DETAIL_LABELS[key] || key} ${text}`)
    if (parts.length >= 4) break
  }
  return parts.join(' · ')
}
export function detailText(a) {
  const d = a.detail || {}
  const bits = []
  if (a.action === 'task.dispatch') bits.push(tx("下发 {0} 个 SoduWork", [d.dispatched ?? 0]))
  else if (a.action === 'task.dispatch.sub') bits.push(tx("「{0}」→ {1} 盒", [d.title || '', d.boxes ?? 0]))
  else if (a.action === 'task.advance') bits.push('→ ' + (d.toStage || '') + (d.via === 'admin' ? tx(" · 管理端") : tx(" · 桌宠")))
  else if (a.action === 'task.reject') bits.push(tx("打回 → ") + (d.toStage || '') + (d.note ? ' · ' + d.note : ''))
  else if (a.action === 'client.assign') bits.push(d.ownerUserId ? tx("归属到用户") : tx("解除归属"))
  else if (a.action === 'user.update') bits.push((d.fields || []).join('/') + (d.pwChanged ? tx(" +改密码") : ''))
  else if (a.action === 'role.update') bits.push(tx("权限 {0} 项", [(d.permissions || []).length]))
  else if (a.action === 'report.generate') bits.push(tx("{0} · 生成 {1} 份", [d.date || '', d.made ?? 0]) + (d.skipped ? tx("，跳过 {0} 人", [d.skipped]) : ''))
  else if (a.action === 'plugin.install' || a.action === 'plugin.upgrade' || a.action === 'plugin.enable') {
    const verbs = { 'plugin.install': tx("安装"), 'plugin.upgrade': tx("升级"), 'plugin.enable': tx("启用") }
    const fields = (d.setupFields || []).length
    bits.push(verbs[a.action] + (d.version ? ' v' + d.version : '') + (fields ? tx(" · 配置 {0} 项", [fields]) : ''))
  }
  else if (a.action === 'plugin.uninstall') bits.push(tx("已卸载"))
  else if (a.action === 'plugin.conversation_grant') bits.push(tx("授权 {0} 个插件 · {1} 个连接", [(d.pluginIds || []).length, (d.mcpServers || []).length]))
  else if (a.action === 'plugin.conversation_use') bits.push(tx("调用 {0} 个插件", [(d.pluginIds || []).length]))
  else if (a.action === 'team.message') bits.push(tx("文字 {0} 字 · 附件 {1} 个", [d.chars ?? 0, d.files ?? 0]))
  if (!bits.length) bits.push(summarizeDetail(d))
  return bits.filter(Boolean).join(' · ')
}
