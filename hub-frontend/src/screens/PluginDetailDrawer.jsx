import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { lockDialogScroll } from '../dialog-focus.js'

// Secondary dialogs own Escape and focus while open. Closing them must not close the detail.
export default function PluginDetailDrawer({ title, onClose, suspended = false, children }) {
  const uiLocale = useLocale();
  const panel = useRef(null)
  const lastFocus = useRef(null)
  const close = useRef(onClose)
  close.current = onClose
  const overlayDown = useRef(false)
  useEffect(() => {
    const trigger = document.activeElement
    const releaseScroll = lockDialogScroll(document)
    panel.current?.focus()
    return () => {
      releaseScroll()
      if (trigger?.isConnected) trigger.focus()
    }
  }, [])
  useEffect(() => {
    if (suspended) {
      const dialog = [...document.querySelectorAll('.modal-mask > .modal, .auto-drawer-mask > .auto-drawer')].at(-1)
      if (!dialog) return undefined
      const attributes = ['role', 'aria-modal', 'aria-label', 'tabindex']
      const previous = attributes.map((name) => dialog.getAttribute(name))
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')
      if (!dialog.hasAttribute('aria-label')) dialog.setAttribute('aria-label', dialog.querySelector('.modal-head, .drawer-head h3')?.textContent.replace('✕', '').trim() || tx("插件操作"))
      dialog.tabIndex = -1
      ;(focusable(dialog)[0] || dialog).focus()
      const trap = (event) => trapTab(event, dialog)
      window.addEventListener('keydown', trap)
      return () => {
        window.removeEventListener('keydown', trap)
        attributes.forEach((name, index) => previous[index] === null ? dialog.removeAttribute(name) : dialog.setAttribute(name, previous[index]))
      }
    }
    if (!panel.current?.contains(document.activeElement)) {
      const target = lastFocus.current?.isConnected ? lastFocus.current : panel.current
      target?.focus()
    }
    function keydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close.current()
        return
      }
      trapTab(event, panel.current)
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [suspended])
  return createPortal(<div className="plugin-page plugin-detail-overlay"
    onMouseDown={(event) => { overlayDown.current = event.target === event.currentTarget }}
    onClick={(event) => { if (!suspended && overlayDown.current && event.target === event.currentTarget) onClose() }}>
    <section className="plugin-detail-drawer" ref={panel} tabIndex={-1} role="dialog" onFocusCapture={(event) => { lastFocus.current = event.target }}
      aria-modal={!suspended} aria-label={title || tx("插件详情")} inert={suspended ? '' : undefined}>
      <div className="plugin-detail-drawer-head"><div className="plugin-detail-drawer-heading"><span>{tx("插件详情")}</span>{title && <b title={title}>{title}</b>}</div>
        <button type="button" aria-label={tx("关闭插件详情")} onClick={onClose}>×</button>
      </div>
      <div className="plugin-detail-drawer-body">{children}</div>
    </section>
  </div>, document.body)
}

function focusable(root) {
  return [...root.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')]
    .filter((element) => element.getClientRects().length && !element.closest('[hidden], [inert]'))
}

function trapTab(event, root) {
  if (event.key !== 'Tab') return
  const elements = focusable(root)
  const first = elements[0], last = elements[elements.length - 1]
  if (!first) { event.preventDefault(); root.focus(); return }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === root || !root.contains(document.activeElement))) {
    event.preventDefault(); last.focus()
  } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
    event.preventDefault(); first.focus()
  }
}
