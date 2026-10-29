// Read projections only: Hub owns requirement and execution state.
import { localeMap, translateText as tx } from '../i18n.js'
export function requirementStage(task) {
  if (task.archivedAt || task.status === 'cancel') return 'closed'
  if (task.status === 'done') return 'delivered'
  if (task.requirementStage === 'reviewing') return 'reviewing'
  if (task.status === 'doing' || task.status === 'paused') return 'delivering'
  return ['intake', 'clarifying', 'ready'].includes(task.requirementStage) ? task.requirementStage
    : ['intake', 'clarifying', 'ready'].includes(task.triageStage) ? task.triageStage : 'ready'
}

export const REQUIREMENT_LABELS = localeMap(() => ({
  intake: '收集箱', clarifying: '待补充', ready: '待开始', reviewing: '待验收',
  delivering: '进行中', delivered: '已完成', closed: '已归档',
}))

export function pluginRequirementBlocker(task) {
  if (task.canViewExecution === false || task.readOnly || task.canRunPlugin === false) return tx('无执行权限')
  if (task.archivedAt) return tx('已归档')
  const stage = requirementStage(task)
  if (stage === 'closed' || stage === 'delivered') return REQUIREMENT_LABELS[stage]
  if (stage === 'reviewing') return tx('待验收')
  if (stage === 'intake' || stage === 'clarifying') return tx('请先澄清需求')
  const turn = task.workRouting?.conversationTurn
  if (['queued', 'running', 'waiting'].includes(turn?.state)
      || ['dispatching', 'running'].includes(task.ai?.state)
      || stage === 'delivering') return tx('正在交付')
  return ''
}

export function pluginRequirementOptions(tasks, binding) {
  return tasks.filter((task) => !binding?.projectId || task.projectId === binding.projectId)
    .map((task) => ({ ...task, blockedReason: pluginRequirementBlocker(task) }))
}

export function hasExecutionIssue(task) {
  return requirementStage(task) !== 'closed' && requirementStage(task) !== 'delivered'
    && (task.ai?.state === 'failed' || task.ai?.attentionRaised === true)
}

export function isOverdue(task, now = Date.now()) {
  const stage = requirementStage(task)
  // Intake is preparation, not an overdue execution task.
  return ['ready', 'delivering', 'reviewing'].includes(stage) && !!task.due && task.due < now
}

export function requirementSummary(tasks, now = Date.now()) {
  const active = tasks.filter((task) => requirementStage(task) !== 'closed')
  const stages = { intake: 0, clarifying: 0, ready: 0, delivering: 0, reviewing: 0, delivered: 0 }
  for (const task of active) stages[requirementStage(task)]++
  const overdue = active.filter((task) => isOverdue(task, now)).length
  const failed = active.filter(hasExecutionIssue).length
  return { active, stages, total: active.length, closed: tasks.length - active.length,
    done: stages.delivered, preparing: stages.intake + stages.clarifying,
    overdue, failed, risk: active.filter((task) => isOverdue(task, now) || hasExecutionIssue(task)).length,
    rate: active.length ? Math.round(stages.delivered / active.length * 100) : 0 }
}
