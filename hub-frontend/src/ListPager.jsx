import React from 'react'
import { translateText as tx, useLocale } from './i18n.js'
import './list-pager.css'

export default function ListPager({ page, pages, total, unit = tx('条'), onChange, label = tx('列表分页') }) {
  useLocale()
  if (pages <= 1) return null
  return <footer className="list-pager" aria-label={label}>
    <span>{tx('第 {0} / {1} 页 · 共 {2} {3}', [page, pages, total, unit])}</span>
    <div>
      <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label={tx('上一页')}>‹ {tx('上一页')}</button>
      <button type="button" disabled={page >= pages} onClick={() => onChange(page + 1)} aria-label={tx('下一页')}>{tx('下一页')} ›</button>
    </div>
  </footer>
}
