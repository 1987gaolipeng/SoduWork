// Keep an index on our same-document entries so a blocked Back or Forward
// can return to the original entry without losing either side of the stack.
const positionKey = 'soduworkAdminPosition'

export function createAdminHistory(onChange, canLeave) {
  const { history, location } = window
  const position = () => history.state?.[positionKey]
  let current = position() ?? 0
  let seenHash = location.hash
  let seenPosition = current
  let blocked = null

  function observe() {
    seenHash = location.hash
    seenPosition = position()
  }

  function write(hash, push) {
    if (hash === location.hash && position() === current) return
    blocked = null
    const url = location.pathname + location.search + hash
    if (push) history.pushState({ [positionKey]: ++current }, '', url)
    else history.replaceState({ ...history.state, [positionKey]: current }, '', url)
    observe()
    onChange(location.hash)
  }

  function replay(move) {
    if (blocked === move && move.restored && move.approved && !move.replaying) {
      move.replaying = true
      history.go(move.to - current)
    }
  }

  function traverse() {
    // A new fragment typed in the address bar has no application state.
    if (position() == null) history.replaceState({ ...history.state, [positionKey]: current + 1 }, '')
    const next = position()
    if (seenPosition === next && seenHash === location.hash) return
    observe()
    if (blocked && next === current && !blocked.restored) {
      blocked.restored = true
      replay(blocked)
      return
    }
    if (next !== current && !(blocked?.replaying && next === blocked.to)) {
      const move = { to: next, restored: false, approved: false, replaying: false }
      blocked = move
      if (!canLeave(() => { move.approved = true; replay(move) })) {
        history.go(current - next)
        return
      }
    }
    blocked = null
    current = next
    onChange(location.hash)
  }

  return {
    replace: hash => write(hash, false),
    push: hash => write(hash, true),
    listen() {
      write(location.hash, false)
      window.addEventListener('popstate', traverse)
      window.addEventListener('hashchange', traverse)
      return () => {
        window.removeEventListener('popstate', traverse)
        window.removeEventListener('hashchange', traverse)
      }
    },
  }
}
