import { useLayoutEffect, useState } from 'react'

// Reserve everything above and below a list, including wrapped filters and
// pagination. The minimum keeps a usable list when the page genuinely is tall.
export function availableListHeight({ viewport, top, tail, minimum = 160 }) {
  return Math.max(minimum, Math.floor(viewport - top - Math.max(0, tail)))
}

export function observeViewportHeight(element, minimum = 160) {
  const content = element.closest('.content')
  if (!content) return undefined
  const visualViewport = window.visualViewport
  let frame = 0
  const measure = () => {
    frame = 0
    if (!element.isConnected || !element.getClientRects().length) return
    const rect = element.getBoundingClientRect()
    const height = availableListHeight({
      // Monitor scaling is already reflected in CSS pixels. Pinch zoom should
      // magnify the page without making its scroll regions shrink underneath it.
      viewport: visualViewport?.scale === 1
        ? Math.min(window.innerHeight, visualViewport.height) : window.innerHeight,
      top: rect.top + window.scrollY,
      tail: content.getBoundingClientRect().bottom - rect.bottom,
      minimum,
    })
    const value = `${height}px`
    if (element.style.getPropertyValue('--viewport-list-height') !== value) {
      element.style.setProperty('--viewport-list-height', value)
    }
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure)
  }
  // Ancestors include the page's summaries and filters. Observing their size
  // also catches lazy data, font loading, filter wrapping, and tab changes.
  const observer = new ResizeObserver(schedule)
  for (let node = element; node; node = node.parentElement) {
    observer.observe(node)
    if (node === content) break
  }
  window.addEventListener('resize', schedule)
  visualViewport?.addEventListener('resize', schedule)
  measure()
  return () => {
    observer.disconnect()
    window.removeEventListener('resize', schedule)
    visualViewport?.removeEventListener('resize', schedule)
    cancelAnimationFrame(frame)
    element.style.removeProperty('--viewport-list-height')
  }
}

export function useViewportHeight(minimum = 160) {
  const [element, setElement] = useState(null)
  useLayoutEffect(() => {
    if (element) return observeViewportHeight(element, minimum)
    return undefined
  }, [element, minimum])
  return setElement
}
