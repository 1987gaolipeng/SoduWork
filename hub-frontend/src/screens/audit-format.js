import { localeMap, translateText as tx } from '../i18n.js'
import { actionLabels } from '../locales/audit.js'

const ACTIONS = localeMap(() => ({
  'task.dispatch': { label: "下发需求", c: 'var(--c-blue)' },
  'task.dispatch.sub': { label: "分配需求给下属", c: 'var(--c-blue)' },
  'task.advance': { label: '推进流转', c: 'var(--ok)' },
  'task.reject': { label: '打回流转', c: 'var(--warn)' },
  'client.assign': { label: '分配 SoduWork 归属', c: 'var(--c-green)' },
  'client.reset_secret': { label: '重置设备密钥', c: 'var(--warn)' },
  'org.create': { label: '新建部门', c: 'var(--c-green)' },
  'org.update': { label: '编辑部门', c: 'var(--c-orange)' },
  'org.delete': { label: '删除部门', c: 'var(--crit)' },
  'role.update': { label: '改角色权限', c: 'var(--c-rose)' },
  'user.create': { label: '新建用户', c: 'var(--c-green)' },
  'user.update': { label: '修改用户', c: 'var(--c-orange)' },
  'integration.delete': { label: '删除集成源', c: 'var(--crit)' },
  'report.generate': { label: '生成团队日报', c: 'var(--c-orange)' },
  'task.nudge': { label: '催办', c: 'var(--warn)' },
  'task.agent_run': { label: 'SoduWork 执行', c: 'var(--accent)' },
  'task.ai_dispatch': { label: "安排 AI 执行", c: 'var(--accent)' },
  'plugin.import': { label: '导入插件', c: 'var(--c-blue)' },
  'plugin.publish': { label: '发布插件', c: 'var(--c-green)' },
  'plugin.approve': { label: '批准插件', c: 'var(--ok)' },
  'plugin.reject': { label: '驳回插件', c: 'var(--warn)' },
  'plugin.bind': { label: '绑定插件', c: 'var(--c-blue)' },
  'plugin.run': { label: '运行插件流程', c: 'var(--accent)' },
  'plugin.run_cancel': { label: '取消插件运行', c: 'var(--warn)', noFilter: true },
  'plugin.retry_quality': { label: '重试质量检查', c: 'var(--c-orange)', noFilter: true },
  'plugin.retry_gate': { label: '重试门禁', c: 'var(--c-orange)', noFilter: true },
  'automation.project_launch': { label: '启动自动化交付', c: 'var(--accent)' },
  'environment.create': { label: '新建环境', c: 'var(--c-green)', noFilter: true },
  'environment.update': { label: '修改环境', c: 'var(--c-orange)', noFilter: true },
  'deployment_target.create': { label: '新建发布目标', c: 'var(--c-green)', noFilter: true },
  'deployment_target.update': { label: '修改发布目标', c: 'var(--c-orange)', noFilter: true },
  'runner.enroll': { label: '接入 Runner', c: 'var(--c-green)', noFilter: true },
  'runner.revoke_key': { label: '吊销 Runner 密钥', c: 'var(--crit)', noFilter: true },
  'runner.enable': { label: '启用云主机', c: 'var(--c-green)' },
  'runner.disable': { label: '停用云主机', c: 'var(--warn)' },
  'runner.reassign': { label: '重新分配云主机', c: 'var(--c-blue)' },
  'runner.reprovision': { label: '云主机安全接入', c: 'var(--c-blue)' },
  'release.deploy_request': { label: '申请发布', c: 'var(--c-blue)' },
  'release.rollback': { label: '执行回滚', c: 'var(--warn)' },
  // Retain labels for historical audit records without active filter entries.
  'task.multica_dispatch': { label: '历史托管执行（兼容记录）', c: 'var(--offline)', noFilter: true },
  'multica.config': { label: '历史托管配置（兼容记录）', c: 'var(--offline)', noFilter: true },
  'project.create': { label: '新建工程', c: 'var(--c-green)', noFilter: true },
  'project.update': { label: '修改工程', c: 'var(--c-orange)', noFilter: true },
  'project.delete': { label: '删除工程', c: 'var(--crit)', noFilter: true },
  'project.addtask': { label: "工程添加需求", c: 'var(--c-blue)', noFilter: true },
  'llm.config': { label: '旧模型配置（已迁移）', c: 'var(--offline)', noFilter: true },
  'task.assign': { label: '收件箱分配', c: 'var(--c-blue)', noFilter: true },
  // Label retired actions in historical records instead of displaying raw slugs.
  'task.agent.takeover': { label: 'AI 接管（已下线）', c: 'var(--offline)', noFilter: true },
  'plugin.install': { label: '安装插件', c: 'var(--c-green)' },
  'plugin.upgrade': { label: '升级插件', c: 'var(--c-blue)' },
  'plugin.enable': { label: '启用插件', c: 'var(--c-green)' },
  'plugin.uninstall': { label: '卸载插件', c: 'var(--warn)' },
  'plugin.conversation_grant': { label: '对话授权连接器', c: 'var(--accent)' },
  'plugin.conversation_use': { label: '对话调用连接器', c: 'var(--accent)' },
  'team.message': { label: '团队消息', c: 'var(--c-blue)' },
}))

export function actInfo(code) {
  if (Object.hasOwn(ACTIONS, code)) return ACTIONS[code]
  const label = Object.hasOwn(actionLabels, code) ? tx(actionLabels[code])
    : code ? tx('未知操作（{0}）', [code]) : tx('未知操作')
  return { label, c: 'var(--offline)' }
}

export const FILTERS = localeMap(() => [
  ['', '全部'],
  ...Object.entries(ACTIONS).filter(([, info]) => !info.noFilter).map(([code, info]) => [code, info.label]),
])

export function fmtT(ms) {
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function auditEnvironmentLabel(environment) {
  switch (environment) {
    case 'dev': case 'development': return tx('当前 Hub 为开发环境')
    case 'qa': case 'test': case 'testing': return tx('当前 Hub 为测试环境')
    case 'staging': return tx('当前 Hub 为预发布环境')
    default: return ''
  }
}
