import { translateText as tx, localeMap, getLocale } from '../i18n.js'
const AGENT_NAMES = {
  pi: 'Pi', opencode: 'OpenCode', codex: 'Codex', claude: 'Claude Code',
  'codex-harness': 'Codex Harness', 'claude-code': 'Claude Code',
}

export const numeric = (value) => Math.max(0, Number(value) || 0)
export const precise = (value) => numeric(value).toLocaleString(getLocale())
export const count = (value) => new Intl.NumberFormat(getLocale(), {
  notation: numeric(value) >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1,
}).format(numeric(value))

export function money(value, empty = tx("待对账")) {
  const amount = numeric(value) / 1000000
  if (!amount) return empty
  if (amount < 0.01) return '< $0.01'
  return '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function duration(ms) {
  const mins = numeric(ms) / 60000
  if (!mins) return tx("0 分钟")
  if (mins < 1) return tx("< 1 分钟")
  if (mins < 60) return Math.round(mins) + tx(" 分钟")
  const hours = mins / 60
  return (hours < 10 ? hours.toFixed(1) : Math.round(hours)) + tx(" 小时")
}

export function when(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(getLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export const agentName = (key) => AGENT_NAMES[String(key || '').toLowerCase()] || key || tx("未知 Agent")
export const ratio = (value, total) => total > 0 ? Math.min(100, numeric(value) * 100 / total) : 0
export const share = (value, total) => {
  const percent = ratio(value, total)
  return percent > 0 && percent < 1 ? '<1%' : Math.round(percent) + '%'
}

// These labels are system enums. Unknown source names remain business data.
const SCENE_LABELS = localeMap(() => ({
  chat: '对话', task: '需求执行', workflow: '自动化工作流', automation: '定时自动化', system: '平台运行',
}))
export const sceneLabel = (key, label) => Object.hasOwn(SCENE_LABELS, key) ? SCENE_LABELS[key] : label || key || '—'

export const sceneColor = (key) => ({
  chat: 'var(--accent)', task: 'var(--ok)', workflow: 'var(--warn)',
  automation: 'var(--ugc-secondary)', system: 'var(--ink-3)',
})[key] || 'var(--surface-3)'

// Preserve the full API range, including a 90-day selection. Missing calendar
// buckets between returned dates have no ledger records, not a positive bar.
// The range is anchored to the current Beijing calendar day so refreshing the
// page does not silently change the number of displayed days at local midnight.
export function calendarTrend(points, days = 30) {
  const valid = points.filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.key || ''))
  if (!valid.length) return []
  const byDate = new Map(valid.map((item) => [item.key, item]))
  const count = Math.max(1, Math.min(365, Number(days) || 30))
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  const last = Date.parse(today + 'T00:00:00Z')
  const first = last - (count - 1) * 86400000
  const rows = []
  for (let day = first; day <= last; day += 86400000) {
    const key = new Date(day).toISOString().slice(0, 10)
    rows.push(byDate.get(key) || { key, tokens: 0, costMicrousd: 0, requests: 0, sessions: 0 })
  }
  return rows
}
