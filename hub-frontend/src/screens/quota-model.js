import { deferredMessageKey } from '../i18n.js'

export const MAX_TOKENS = 10000000000000

export function modelKey(row) {
  return JSON.stringify([row.provider || '', row.model || ''])
}

export function allowanceDraft(value = {}) {
  return {
    totalLimit: value.totalLimit ?? null,
    models: (value.models || []).map(row => ({ ...row })),
    restrictModels: !!value.restrictModels,
  }
}

function tokenNumber(value) {
  if (value === null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 && number <= MAX_TOKENS ? number : null
}

// Validation returns stable authored message keys; the UI localizes them once.
export function validateAllowance(draft, choices) {
  const totalLimit = draft.totalLimit === null ? null : tokenNumber(draft.totalLimit)
  if (draft.totalLimit !== null && totalLimit === null) throw Error(deferredMessageKey('请输入 0 到 10,000,000,000,000 的整数'))
  if (draft.models.length > 100) throw Error(deferredMessageKey('最多可设置 100 个模型额度'))
  const seen = new Set(), available = new Set(choices.map(modelKey))
  const models = draft.models.map(row => {
    const key = modelKey(row), limit = tokenNumber(row.limit)
    if (!row.provider || !row.model || !available.has(key)) throw Error(deferredMessageKey('请选择目录中可用的模型'))
    if (seen.has(key)) throw Error(deferredMessageKey('同一个模型只能设置一条额度'))
    if (limit === null) throw Error(deferredMessageKey('请输入 0 到 10,000,000,000,000 的整数'))
    seen.add(key)
    return { provider: row.provider, model: row.model, limit }
  })
  if (draft.restrictModels && !models.length) throw Error(deferredMessageKey('仅允许所列模型时，请至少添加一个模型'))
  return { totalLimit, models, restrictModels: !!draft.restrictModels }
}

export function validatePlan(draft, choices) {
  const allowance = validateAllowance(draft, choices)
  const name = draft.name.trim(), description = draft.description.trim()
  if (!name || name.length > 60) throw Error(deferredMessageKey('请填写套餐名称，最多 60 字'))
  if (description.length > 300) throw Error(deferredMessageKey('套餐说明最多 300 字'))
  const trial = draft.id === 'trial', durationDays = Number(draft.durationDays)
  if (trial && (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 365)) throw Error(deferredMessageKey('试用时长应为 1 到 365 天'))
  if (trial && !(allowance.totalLimit > 0)) throw Error(deferredMessageKey('试用套餐需要设置大于 0 的总额度'))
  return { id: draft.id, name, description, period: trial ? 'once' : 'monthly', durationDays: trial ? durationDays : 7, ...allowance }
}

export function replacePlan(config, plan) {
  const exists = config.plans.some(row => row.id === plan.id)
  return {
    revision: config.revision,
    plans: exists ? config.plans.map(row => row.id === plan.id ? plan : row) : [...config.plans, plan],
    defaultLimit: config.defaultLimit,
  }
}

export function validateAssignment(member, draft, choices) {
  const body = { revision: member.assignment.revision, mode: draft.mode }
  if (draft.mode === 'plan') {
    if (!draft.planId || (draft.planId === 'trial' && !member.assignment.hasTrial)) throw Error(deferredMessageKey('请选择可分配的套餐'))
    body.planId = draft.planId
  } else if (draft.mode === 'custom') body.custom = validateAllowance(draft.custom, choices)
  else if (draft.mode !== 'inherit') throw Error(deferredMessageKey('请选择额度规则'))
  return body
}

export function usagePercent(quota) {
  if (!quota.totalLimited || quota.limit <= 0) return 0
  return Math.min(100, Math.max(0, (quota.used / quota.limit) * 100))
}
