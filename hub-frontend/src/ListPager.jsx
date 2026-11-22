import React from 'react'
import { translateText as tx, useLocale } from './i18n.js'
import './list-pager.css'

export default function ListPager({ page, pages, total, unit = tx('条'), onChange, label = tx('列表分页'),
  pageSize, onPageSizeChange, disabled = false }) {
  useLocale()
  const jumpRef = React.useRef(null)
  // Sync the jump input when page changes externally, without recreating it
  // (a key={page} input would be remounted on every page change and wipe
  // whatever the user is still typing).
  React.useEffect(() => {
    const input = jumpRef.current
    if (input && document.activeElement !== input) input.value = String(page)
  }, [page])
  if (pages <= 1 && !onPageSizeChange) return null
  function jump(event) {
    event.preventDefault()
    const target = event.currentTarget.elements.pageNumber.valueAsNumber
    if (Number.isInteger(target) && target >= 1 && target <= pages) onChange(target)
  }
  return <footer className={onPageSizeChange ? 'list-pager list-pager-full' : 'list-pager'} aria-label={label}>
    <span>{tx('第 {0} / {1} 页 · 共 {2} {3}', [page, pages, total, unit])}</span>
    <div>
      {onPageSizeChange && <label>{tx('每页条数')}
        <select value={pageSize} disabled={disabled} onChange={event => onPageSizeChange(Number(event.target.value))}>
          {[30, 50, 100].map(size => <option value={size} key={size}>{size}</option>)}
        </select></label>}
      {onPageSizeChange && <button type="button" disabled={disabled || page <= 1} onClick={() => onChange(1)}>{tx('第一页')}</button>}
      <button type="button" disabled={disabled || page <= 1} onClick={() => onChange(page - 1)} aria-label={tx('上一页')}>‹ {tx('上一页')}</button>
      <button type="button" disabled={disabled || page >= pages} onClick={() => onChange(page + 1)} aria-label={tx('下一页')}>{tx('下一页')} ›</button>
      {onPageSizeChange && <>
        <button type="button" disabled={disabled || page >= pages} onClick={() => onChange(pages)}>{tx('最后一页')}</button>
        <form onSubmit={jump}>
          <label>{tx('页码')}<input ref={jumpRef} name="pageNumber" type="number" min={1} max={pages}
            defaultValue={page} required disabled={disabled || pages <= 1} /></label>
          <button type="submit" disabled={disabled || pages <= 1}>{tx('跳转')}</button>
        </form>
      </>}
    </div>
  </footer>
}
