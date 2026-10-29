import { translateText as tx, localeMap, useLocale } from './i18n.js'
import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useId } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api.js'
import { registerSelectPopover } from './select-popover.js'
import { matchesOption } from './org-options.js'
import { registerDialogLayer } from './dialog-focus.js'

/* Icons. */
const P = {
  sparkle: '<path d="M12 3l1.8 4.6L18.5 9.4 13.8 11.2 12 16l-1.8-4.8L5.5 9.4l4.7-1.8z"/><path d="M18 15l.7 1.8 1.8.7-1.8.7L18 20l-.7-1.8-1.8-.7 1.8-.7z"/>',
  grid: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  box: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M8 9.5l1.5 1.5 3-3M8 15h8"/>',
  plug: '<path d="M12 3v6M12 15v6M5.6 5.6l4.2 4.2M14.2 14.2l4.2 4.2M3 12h6M15 12h6"/><circle cx="12" cy="12" r="2.6"/>',
  link: '<path d="M9 7H6a4 4 0 0 0 0 8h3M15 17h3a4 4 0 0 0 0-8h-3M8 12h8"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  activity: '<path d="M3 12h4l2.2-6 4.2 12 2.2-6H21"/>',
  pulse: '<path d="M3 12h3l2-5 4 10 2.2-6H21"/><circle cx="3" cy="12" r="1"/>',
  chart: '<path d="M4 19V5M4 19h16"/><rect x="7" y="12" width="2.5" height="5" rx=".7"/><rect x="11" y="9" width="2.5" height="8" rx=".7"/><rect x="15" y="6" width="2.5" height="11" rx=".7"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M4 12a8 8 0 0 1 8-8 8 8 0 0 1 6.9 4M20 4v4h-4M20 12a8 8 0 0 1-8 8 8 8 0 0 1-6.9-4M4 20v-4h4"/>',
  external: '<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>',
  logout: '<path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4M14 8l4 4-4 4M18 12H9"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  ticket: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/>',
  webhook: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  tree: '<rect x="8" y="3" width="8" height="5" rx="1.2"/><rect x="3" y="16" width="7" height="5" rx="1.2"/><rect x="14" y="16" width="7" height="5" rx="1.2"/><path d="M12 8v4M6.5 16v-2h11v2"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 5.2a3.2 3.2 0 0 1 0 6M17.5 20a5.5 5.5 0 0 0-3-4.9"/>',
  shield: '<path d="M12 3l7 3v5c0 4.3-3 7.5-7 9-4-1.5-7-4.7-7-9V6l7-3z"/><path d="M9.2 12l2 2 3.6-3.6"/>',
  key: '<circle cx="8" cy="8" r="4"/><path d="M11 11l7 7M16 16l2-2M18.5 18.5l1.5-1.5"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  'chevron-left': '<path d="M15 6l-6 6 6 6"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>',
  file: '<path d="M6 2.8h8l4 4V21H6z"/><path d="M14 2.8V7h4M9 12h6M9 16h6"/>',
  memory: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h6M8 17h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/>',
  sitemap: '<rect x="9" y="3" width="6" height="4" rx="1"/><rect x="3" y="17" width="6" height="4" rx="1"/><rect x="15" y="17" width="6" height="4" rx="1"/><path d="M12 7v5M6 17v-3h12v3"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1M10 21v-3h4v3"/>',
}

/* Shared dialogs. */
const DialogAncestors = React.createContext([])
// Share Escape dismissal between Modal and custom dialogs.
export function useEscClose(onClose) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => registerDialogLayer({ onClose: () => close.current?.() }), [])
}

export function Modal({ title, icon, onClose, children, foot, footer, wide, size, scope = '', className = '' }) {
  const uiLocale = useLocale();
  const dialog = useRef(null)
  const titleId = useId()
  const ancestors = React.useContext(DialogAncestors)
  const close = useRef(onClose)
  const trigger = useRef(typeof document === 'undefined' ? null : document.activeElement)
  const dialogSize = size || (wide ? 'wide' : '')
  const actions = foot !== undefined ? foot : footer
  const maskDown = useRef(false)
  close.current = onClose
  useEffect(() => registerDialogLayer({ id: titleId, ancestors, root: dialog.current, onClose: () => close.current?.(), returnFocus: trigger.current }), [])
  const content = (
    <DialogAncestors.Provider value={[...ancestors, titleId]}>
    {/*
 * Dismiss the backdrop only when the press also began there; text selection ending outside
 * a dialog can produce a backdrop click target.
 */}
    <div className="modal-mask" style={{ zIndex: 60 + ancestors.length }}
      onMouseDown={(e) => { maskDown.current = e.target === e.currentTarget }}
      onClick={(e) => {
        e.stopPropagation()
        if (e.target === e.currentTarget && maskDown.current) onClose()
      }}>
      <div ref={dialog} className={['modal', dialogSize && `modal-${dialogSize}`, scope, className].filter(Boolean).join(' ')}
        role="dialog" aria-modal={true} aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal-head">
          {icon && <span className="int-ico" style={{ width: 26, height: 26 }}><Icon name={icon} /></span>}
          <span id={titleId} className="modal-title">{title}</span><button type="button" className="mx" aria-label={tx("关闭")} onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-foot">{actions}</div>}
      </div>
    </div>
    </DialogAncestors.Provider>
  )
  return typeof document !== 'undefined' && document.body ? createPortal(content, document.body) : content
}

/* Application confirmation dialog supports asynchronous onConfirm. */
export function Confirm({ title, text, danger, confirmText = tx("确定"), onConfirm, onClose }) {
  const uiLocale = useLocale();
  const [busy, setBusy] = useState(false)
  async function go() { setBusy(true); try { await onConfirm() } catch (e) { toast(tx("失败：") + (e.message || e)) } finally { setBusy(false) } }
  return (
    <Modal size="compact" title={title || tx("确认操作")} icon="alert" onClose={onClose}
      foot={<>
        <button className="btn btn-ghost" onClick={onClose}>{tx("取消")}</button>
        <button className={'btn ' + (danger ? 'btn-danger' : 'btn-primary')} disabled={busy} onClick={go}>{busy ? tx("处理中…") : confirmText}</button>
      </>}>
      <div className="modal-confirm-copy">{text}</div>
    </Modal>
  )
}
export function Icon({ name, ...rest }) {
  const uiLocale = useLocale();
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: P[name] || '' }} {...rest} />
  )
}

/* Theme switching. */
/*
 * Controlled dropdown preserves select value/onChange semantics while rendering options
 * in-page for consistent styling.
 */
export function SelectMenu({ value, onChange, children, className = '', disabled = false, autoFocus = false, style, id, 'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy, 'aria-describedby': ariaDescribedBy, required = false, placeholder = tx("请选择"), clearable = false, resetValue = '', clearLabel, searchable = false, searchPlaceholder = tx("搜索部门名称或路径") }) {
  const uiLocale = useLocale();
  const listboxId = React.useId()
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  const pendingFocus = useRef(null)
  const popupRef = useRef(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  useLayoutEffect(() => registerSelectPopover({ open, enabled: searchable, triggerRef, popupRef }), [open, searchable])
  const options = React.Children.toArray(children)
    .filter((child) => React.isValidElement(child) && child.type === 'option')
    .map((child) => ({
      value: child.props.value == null ? '' : String(child.props.value),
      label: React.Children.toArray(child.props.children).map((part) => {
        if (typeof part === 'string' || typeof part === 'number') return String(part)
        if (React.isValidElement(part)) return React.Children.toArray(part.props.children).join('')
        return ''
      }).join('') || placeholder,
      disabled: Boolean(child.props.disabled),
      path: child.props['data-path'] || '',
    }))
  const visibleOptions = searchable ? options.filter(option => matchesOption(option.path || option.label, query)) : options
  const current = String(value == null ? '' : value)
  const selected = options.find((option) => option.value === current)
  const canClear = clearable && !disabled && current !== String(resetValue ?? '')

  useEffect(() => {
    if (!open) return undefined
    const close = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  useEffect(() => {
    if (!disabled) return undefined
    setOpen(false)
    return undefined
  }, [disabled])

  useEffect(() => {
    if (autoFocus && !disabled) triggerRef.current?.focus()
  }, [autoFocus, disabled])

  useEffect(() => {
    if (searchable) {
      setActiveIndex(-1)
      if (!open) setQuery('')
      else triggerRef.current?.focus()
      pendingFocus.current = null
      return
    }
    if (open && pendingFocus.current !== null) {
      focusOption(pendingFocus.current)
      pendingFocus.current = null
    }
  }, [open])

  useEffect(() => {
    if (searchable && open && activeIndex >= 0) popupRef.current?.querySelectorAll('[role="option"]')[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open, searchable])

  function searchKeyDown(event) {
    if (event.isComposing || event.nativeEvent?.isComposing) return
    if (event.key === 'Enter' && open) {
      event.preventDefault(); event.stopPropagation()
      if (activeIndex >= 0 && visibleOptions[activeIndex]) choose(visibleOptions[activeIndex])
    } else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation()
      if (!open) { setOpen(true); return }
      const enabled = visibleOptions.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0)
      if (!enabled.length) return
      const position = enabled.indexOf(activeIndex)
      const next = position < 0 ? (event.key === 'ArrowUp' ? enabled.length - 1 : 0)
        : (position + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length
      setActiveIndex(enabled[next])
    }
  }

  function focusOption(index) {
    if (index >= 0) rootRef.current?.querySelectorAll('[role="option"]')[index]?.focus()
  }

  function triggerKeyDown(event) {
    if (disabled || event.isComposing || event.nativeEvent?.isComposing || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    const selectedIndex = visibleOptions.findIndex((option) => option.value === current && !option.disabled)
    const index = selectedIndex >= 0 ? selectedIndex : visibleOptions.findIndex((option) => !option.disabled)
    if (open) focusOption(index)
    else { pendingFocus.current = index; setOpen(true) }
  }

  function optionKeyDown(event, index) {
    if (event.isComposing || event.nativeEvent?.isComposing || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    const enabled = visibleOptions.map((option, i) => option.disabled ? -1 : i).filter((i) => i >= 0)
    if (!enabled.length) return
    const position = enabled.indexOf(index)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
      : (position + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length
    focusOption(enabled[next])
  }

  function menuKeyDown(event) {
    if (!open || event.isComposing || event.nativeEvent?.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation() }
    else if (event.key !== 'Tab') return
    // Keep a live focus anchor when removing the popup. Native Tab and the
    // outer modal trap then advance from the field in either direction.
    triggerRef.current?.focus()
    setOpen(false)
  }

  function choose(option) {
    if (option.disabled) return
    setOpen(false)
    triggerRef.current?.focus()
    if (onChange) onChange({ target: { value: option.value } })
  }

  return <div ref={rootRef} className={'select-menu ' + className + (open ? ' is-open' : '') + (disabled ? ' is-disabled' : '') + (canClear ? ' has-clear' : '')} style={style}
    onKeyDown={menuKeyDown} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    {searchable ? <div className="select-menu-input-wrap">
      <input ref={triggerRef} id={id} className="select-menu-trigger select-menu-input" role="combobox" disabled={disabled}
        aria-haspopup="listbox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? listboxId + '-option-' + activeIndex : undefined}
        aria-label={ariaLabel} aria-labelledby={ariaLabelledBy} aria-describedby={ariaDescribedBy} aria-required={required || undefined}
        autoComplete="off" value={open ? query : selected?.label.trim() || ''} title={selected?.path || selected?.label}
        placeholder={open ? selected?.label.trim() || searchPlaceholder : placeholder}
        onClick={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setActiveIndex(-1); setOpen(true) }} onKeyDown={searchKeyDown} />
      {open && query ? <button type="button" tabIndex={-1} className="select-menu-input-action" aria-label={tx("清空搜索")}
        onMouseDown={event => event.preventDefault()} onClick={() => { setQuery(''); setActiveIndex(-1); triggerRef.current?.focus() }}>×</button>
        : <button type="button" tabIndex={-1} className="select-menu-input-action" disabled={disabled} aria-label={ariaLabel || placeholder} aria-expanded={open}
          onMouseDown={event => event.preventDefault()} onClick={() => { triggerRef.current?.focus(); setOpen(!open) }}><i className="select-menu-caret" aria-hidden="true" /></button>}
    </div> : <button ref={triggerRef} id={id} type="button" role={required ? 'combobox' : undefined} className="select-menu-trigger" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listboxId : undefined} aria-label={ariaLabel} aria-labelledby={ariaLabelledBy} aria-describedby={ariaDescribedBy} aria-required={required || undefined}
      onKeyDown={triggerKeyDown} onClick={() => setOpen((currentOpen) => !currentOpen)}>
      <span className={!selected ? 'is-placeholder' : ''}>{selected ? selected.label : placeholder}</span>
      <i className="select-menu-caret" aria-hidden="true" />
    </button>}
    {canClear && <button type="button" className="filter-clear" aria-label={clearLabel || tx("恢复{0}默认值", [ariaLabel || placeholder])}
      title={clearLabel || tx("恢复默认值")} onClick={(event) => {
        event.preventDefault(); event.stopPropagation(); setOpen(false)
        onChange?.({ target: { value: String(resetValue ?? '') } })
        triggerRef.current?.focus()
      }}>×</button>}
    {open && <div ref={popupRef} popover={searchable ? 'manual' : undefined} className={'select-menu-popover' + (searchable ? ' select-menu-searchable' : '')}>
      <div id={listboxId} role="listbox" aria-label={ariaLabel || placeholder} aria-labelledby={ariaLabelledBy} className="select-menu-options">
        {visibleOptions.map((option, index) => <button key={option.value + '-' + index} type="button" role="option" id={listboxId + '-option-' + index} className={'select-menu-option' + (searchable && index === activeIndex ? ' is-active' : '')} disabled={option.disabled} tabIndex={-1}
          aria-selected={option.value === current} title={option.path || option.label} onMouseDown={searchable ? event => event.preventDefault() : undefined} onKeyDown={(event) => optionKeyDown(event, index)} onClick={() => choose(option)}>
          <span>{query.trim() && option.path ? option.label.trim() : option.label}</span>
          {query.trim() && option.path && <small>{option.path}</small>}
        </button>)}
      </div>
      {searchable && !visibleOptions.length && <div className="select-menu-empty" role="status">{tx("没有匹配的部门")}</div>}
    </div>}

  </div>
}

export function ThemeToggle() {
  const uiLocale = useLocale();
  const readTheme = () => {
    if (typeof document === 'undefined') return 'light'
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
  }
  const [theme, setTheme] = useState(readTheme)
  useEffect(() => {
    const sync = () => setTheme(readTheme())
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  const next = theme === 'dark' ? 'light' : 'dark'
  const label = tx("当前{0}主题，切换为{1}", [theme === "dark" ? tx("深色") : tx("浅色"), next === "dark" ? tx("深色") : tx("浅色")])
  return <button type="button" className="icon-btn theme-toggle" title={label} aria-label={label} onClick={() => {
    document.documentElement.setAttribute('data-theme', next)
    setTheme(next)
    try { localStorage.setItem('soduwork-hub-theme', next) } catch (_e) {}
  }}><Icon name={theme === 'dark' ? 'moon' : 'sun'} style={{ width: 16, height: 16 }} /></button>
}

/*
 * Navigation carries a one-time filter intent that the target page consumes through
 * takeNav after mounting.
 */
let _pendingNav = null
export function navTo(screen, params) {
  _pendingNav = { screen, params: params || {} }
  window.dispatchEvent(new CustomEvent('soduwork-hub-nav', { detail: { screen } }))
}
export function takeNav(screen) {
  if (_pendingNav && _pendingNav.screen === screen) { const p = _pendingNav.params; _pendingNav = null; return p }
  return null
}

/* ---------- toast ---------- */
export function toast(msg) { window.dispatchEvent(new CustomEvent('soduwork-hub-toast', { detail: msg })) }
export function ToastHost() {
  const uiLocale = useLocale();
  const [msg, setMsg] = useState(null)
  useEffect(() => {
    let timer
    const h = (e) => { setMsg(e.detail); clearTimeout(timer); timer = setTimeout(() => setMsg(null), 2400) }
    window.addEventListener('soduwork-hub-toast', h)
    return () => { window.removeEventListener('soduwork-hub-toast', h); clearTimeout(timer) }
  }, [])
  if (!msg) return null
  return <div className="toast">{msg}</div>
}

/* Data-loading hook. */
export function useAsync(fn, opts) {
  const interval = opts && opts.interval
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const fnRef = useRef(fn)
  const mountedRef = useRef(false)
  const busyRef = useRef(false)
  fnRef.current = fn

  /*
   * Show loading on initial fetch only, serialize requests per source, and avoid state
   * writes after unmount.
   */
  const run = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      const next = await fnRef.current()
      if (mountedRef.current) { setData(next); setError(null) }
    } catch (e) {
      if (mountedRef.current) setError(e)
    } finally {
      busyRef.current = false
      if (mountedRef.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    mountedRef.current = true
    run()
    const id = interval ? window.setInterval(run, interval) : null
    return () => {
      mountedRef.current = false
      if (id) window.clearInterval(id)
    }
  }, [run, interval])
  return { data, loading, error, reload: run }
}
const REFRESH_MS = 15000
/* Live indicator shows automatic refresh activity. */
export function LiveDot() {
  const uiLocale = useLocale();
  return <span className="livedot" title={tx("每 {0} 秒自动刷新", [REFRESH_MS / 1000])}><span className="d" />{tx("实时")}</span>
}
export const AUTO = { interval: REFRESH_MS }

/* Presentation helpers. */
export function Avatar({ name }) {
  const uiLocale = useLocale();
  return <span className="ava">{(name || '?').slice(0, 1)}</span>
}
export function ClientCell({ id, clients }) {
  const uiLocale = useLocale();
  if (!id) return <span className="muted" style={{ fontStyle: 'italic' }}>{tx("未分配")}</span>
  const c = (clients || []).find((x) => x.id === id)
  const nm = (c && c.name) || id
  // Unnamed automatically registered devices may expose only their raw identity.
  // Show a compact product label with the ID suffix and retain the full ID in the tooltip.
  if (/^u-[a-z0-9]+(-[a-z0-9]+)+$/i.test(nm)) {
    return <span className="cli" title={nm}><span className="ava" style={{ filter: 'grayscale(1)' }}>{tx("盒")}</span><span className="nm muted">SoduWork ·{nm.slice(-6)}</span></span>
  }
  return <span className="cli"><span className="ava">{nm.slice(0, 1)}</span><span className="nm">{nm}</span></span>
}
export function SourceChip({ task }) {
  const uiLocale = useLocale();
  const o = task.origin
  if (o === 'local') return <span className="chip src-local"><span className="dot" />{tx("本地新建")}</span>
  if (o === 'dispatch') return <span className="chip src-dispatch"><span className="dot" />{tx("平台下发")}</span>
  return <span className="chip src-ext"><span className="dot" />{task.source || o}</span>
}
const ST = localeMap(() => ({ todo: '待办', doing: '进行中', done: '已完成', cancel: '搁置' }))
export function StatusPill({ status }) {
  const uiLocale = useLocale();
  return <span className={'pill st-' + status}><span className="dot" />{ST[status] || status}</span>
}
export function Flags({ task }) {
  const uiLocale = useLocale();
  // Render nothing when no marker exists.
  if (!task.urgent && !task.important) return null
  return <>{task.urgent && <span className="flag flag-u">{tx("紧急")}</span>}{task.important && <span className="flag flag-i">{tx("重要")}</span>}</>
}
const PRIO_LABEL = localeMap(() => ({ low: '低', normal: '普通', high: '高', critical: '紧急' }))
export function Priority({ task }) {
  const uiLocale = useLocale();
  const p = task.priority || 'normal'
  if (p === 'normal') return <span className="muted">{tx("普通")}</span>
  return <span className={'prio prio-' + p}>{PRIO_LABEL[p]}</span>
}
export function fmtDue(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return (d.getMonth() + 1) + '/' + d.getDate()
}
export function Tags({ task }) {
  const uiLocale = useLocale();
  const tags = task.tags || []
  if (!tags.length) return null
  return <span className="tags">{tags.map((t, i) => <span key={i} className="tag">{t}</span>)}</span>
}
// Load responsibility domains for assignment and omit the selector when none exist.
export function DomainSelect({ value, onChange, label = tx("负责领域 / 模块（可选，派给负责这块的人）") }) {
  const uiLocale = useLocale();
  const [doms, setDoms] = useState(null)
  useEffect(() => { api.domains().then((d) => setDoms(d || [])).catch(() => setDoms([])) }, [])
  if (doms !== null && doms.length === 0) return null
  return (
    <div><label className="f-lbl">{label}</label>
      <SelectMenu className="f-in" value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">{tx("— 不指定领域 —")}</option>
        {(doms || []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </SelectMenu>
    </div>
  )
}
export function Loading() {
  const uiLocale = useLocale(); return <div className="center"><span className="spin" />{tx("加载中…")}</div> }
/* Searchable, scrollable device multiselect prioritizes online devices and provides selected counts, select-online, and clear actions. */
export function BoxPick({ clients, selected, onToggle, onSet }) {
  const uiLocale = useLocale();
  const [q, setQ] = useState('')
  const searchRef = useRef(null)
  const kw = q.trim().toLowerCase()
  const sorted = [...(clients || [])].sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0))
  const shown = sorted.filter((c) => !kw || (c.name || '').toLowerCase().includes(kw) || (c.id || '').toLowerCase().includes(kw))
  const onlineIds = (clients || []).filter((c) => c.online).map((c) => c.id)
  return (
    <div>
      <div className="bp-bar">
        <div className="searchbox sm filter-input"><Icon name="search" /><input ref={searchRef} aria-label={tx("搜索 SoduWork")} value={q} onChange={(e) => setQ(e.target.value)} placeholder={tx("搜索 SoduWork…")} />{q && <button type="button" className="filter-clear" aria-label={tx("清空搜索 SoduWork")} title={tx("清空")} onClick={() => { setQ(''); searchRef.current?.focus() }}>×</button>}</div>
        <span className="muted xsm">{tx("已选 ")}{selected.length}</span>
        {onSet && <a className="bp-act" onClick={() => onSet(onlineIds)}>{tx("全选在线")}</a>}
        {onSet && selected.length > 0 && <a className="bp-act" onClick={() => onSet([])}>{tx("清空")}</a>}
      </div>
      <div className="box-pick scroll">
        {shown.length === 0 && <span className="muted">{tx("无匹配 SoduWork")}</span>}
        {shown.map((c) => (
          <span key={c.id} className={'bp' + (selected.includes(c.id) ? ' on' : '')} onClick={() => onToggle(c.id)} title={c.name || c.id}>
            <span className="av">{(c.name || c.id).slice(0, 1)}</span><span className="bp-name">{c.name || c.id}</span>{!c.online && <span className="muted" style={{ fontSize: 14.5 }}>{tx("·离线")}</span>}
          </span>
        ))}
      </div>
    </div>
  )
}
/* Distinguish load failure from empty data and offer retry. */
export function ErrorState({ onRetry, msg }) {
  const uiLocale = useLocale();
  return (
    <div className="card"><div className="empty">
      <div style={{ color: 'var(--crit)', marginBottom: onRetry ? 10 : 0 }}>{msg || tx("没加载出来，后端可能没连上")}</div>
      {onRetry && <button className="btn btn-ghost" onClick={onRetry}><Icon name="refresh" />{tx("重试")}</button>}
    </div></div>
  )
}
