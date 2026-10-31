import { translateText as tx } from '../i18n.js'

// The Hub composes operations overview copy server-side in zh-CN
// (hub-backend/app/services/operations.py): blocker titles/details and the
// topology labels. Two shapes are templated — the failed-run count and the
// database-unavailable exception name — so their dynamic part is captured
// before translation and re-inserted afterwards, keeping user data verbatim.
// Everything else resolves by exact catalog match; renamed or new backend copy
// passes through untouched, like the access catalogs.
const FAILED_RUNS = /^(\d+) (.+)$/
const DB_UNAVAILABLE = /^数据库不可用：(.+)$/

export function operationsText(source) {
  const text = String(source ?? '').trim()
  const runs = FAILED_RUNS.exec(text)
  if (runs) return tx('{0} ' + runs[2], [runs[1]])
  const database = DB_UNAVAILABLE.exec(text)
  if (database) return tx('数据库不可用：{0}', [database[1]])
  return tx(text)
}
