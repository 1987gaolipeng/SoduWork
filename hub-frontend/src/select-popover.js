// Native top-layer popovers escape overflow clipping while remaining inside the
// dialog's DOM focus boundary. No portal or separate modal focus stack is needed.
export function registerSelectPopover({ open, enabled, triggerRef, popupRef }) {
    if (!open || !enabled) return undefined
    const popup = popupRef.current, trigger = triggerRef.current
    if (!popup || !trigger) return undefined
    const place = () => {
      const rect = trigger.getBoundingClientRect()
      const viewport = window.visualViewport
      const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0
      const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight
      const below = top + height - rect.bottom - 14, above = rect.top - top - 14
      const upwards = below < 240 && above > below
      const available = Math.max(80, upwards ? above : below)
      const menuWidth = Math.min(rect.width, width - 24)
      Object.assign(popup.style, {
        width: `${menuWidth}px`, maxHeight: `${Math.min(340, available)}px`,
        left: `${Math.max(left + 12, Math.min(rect.left, left + width - menuWidth - 12))}px`,
        top: 'auto', bottom: 'auto',
      })
      popup.style.top = `${upwards ? rect.top - popup.getBoundingClientRect().height - 6 : rect.bottom + 6}px`
    }
    popup.showPopover()
    place()
    const observer = new ResizeObserver(place)
    observer.observe(trigger)
    observer.observe(popup)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
      if (popup.matches(':popover-open')) popup.hidePopover()
    }
}
