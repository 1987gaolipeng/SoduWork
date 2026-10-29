/* Decorative brand atmosphere. No application data or work status is rendered. */
export function mountLandingParticles(canvas) {
  const context = canvas.getContext('2d')
  if (!context) return () => {}
  const host = canvas.parentElement
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let width = 0, height = 0, frame = 0, visible = true, disposed = false, last = -Infinity, phase = 0
  let points = [], pointer = null

  function draw(time = 0) {
    frame = 0
    if (disposed || !visible || document.hidden) return
    if (time - last >= 1000 / 30) {
      const dt = Math.min(50, Number.isFinite(last) ? time - last : 0)
      last = time
      if (!motion.matches) phase += dt * .00006
      context.clearRect(0, 0, width, height)
      const color = getComputedStyle(canvas).getPropertyValue('--particle-color').trim() || '107, 92, 185'
      const positions = points.map(point => {
        let x = point.x * width + Math.sin(phase + point.seed) * 14
        let y = point.y * height + Math.cos(phase * .7 + point.seed) * 12
        if (pointer && !motion.matches) {
          const dx = x - pointer.x, dy = y - pointer.y, d = Math.hypot(dx, dy)
          if (d > 0 && d < 150) { x += dx / d * (1 - d / 150) * 12; y += dy / d * (1 - d / 150) * 12 }
        }
        return { x, y, r: point.r }
      })
      for (let i = 0; i < positions.length; i++) {
        const a = positions[i]
        for (let j = i + 1; j < positions.length; j++) {
          const b = positions[j], distance = Math.hypot(a.x - b.x, a.y - b.y)
          if (distance < 105) {
            context.strokeStyle = `rgba(${color},${(1 - distance / 105) * .13})`
            context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke()
          }
        }
        context.fillStyle = `rgba(${color},.34)`
        context.beginPath(); context.arc(a.x, a.y, a.r, 0, Math.PI * 2); context.fill()
      }
    }
    if (!motion.matches) frame = requestAnimationFrame(draw)
  }
  function stop() { if (frame) cancelAnimationFrame(frame); frame = 0 }
  function resume() { stop(); last = -Infinity; draw() }
  function resize() {
    const rect = host.getBoundingClientRect()
    width = rect.width; height = rect.height
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5)
    canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio))
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    const count = Math.min(70, Math.max(24, Math.floor(width * height / 15500)))
    points = Array.from({ length: count }, (_, index) => ({
      x: ((index * .61803398875) % 1), y: ((index * .41421356237 + .12) % 1),
      seed: index * 2.4, r: index % 5 === 0 ? 2 : 1.1,
    }))
    resume()
  }
  const onVisibility = () => { if (document.hidden) stop(); else resume() }
  const onPointer = event => {
    const rect = host.getBoundingClientRect()
    pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  const onLeave = () => { pointer = null }
  const sizeObserver = new ResizeObserver(resize)
  sizeObserver.observe(host)
  const viewObserver = new IntersectionObserver(entries => {
    visible = entries[0]?.isIntersecting ?? false
    if (visible) resume(); else stop()
  })
  viewObserver.observe(host)
  document.addEventListener('visibilitychange', onVisibility)
  motion.addEventListener('change', resume)
  host.addEventListener('pointermove', onPointer, { passive: true })
  host.addEventListener('pointerleave', onLeave)
  resize()
  return () => {
    disposed = true; stop(); sizeObserver.disconnect(); viewObserver.disconnect()
    document.removeEventListener('visibilitychange', onVisibility)
    motion.removeEventListener('change', resume)
    host.removeEventListener('pointermove', onPointer); host.removeEventListener('pointerleave', onLeave)
  }
}
