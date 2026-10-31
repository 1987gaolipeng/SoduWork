// Derive presentation state from the catalog without changing the saved policy.
function namesOf(values) {
  const list = Array.isArray(values) || values instanceof Set ? values : []
  return new Set([...list].filter((value) => typeof value === 'string' && value.trim()))
}

export function summarizeCapabilityPolicy(rows, allowed) {
  const discovered = namesOf((Array.isArray(rows) ? rows : []).map((row) => row?.name))
  const policy = namesOf(allowed)
  const unmatchedNames = []
  let activeCount = 0
  for (const name of policy) {
    if (discovered.has(name)) activeCount += 1
    else unmatchedNames.push(name)
  }
  return { activeCount, unmatchedNames }
}

export function sameCapabilityPolicy(a, b) {
  const first = namesOf(a)
  const second = namesOf(b)
  return first.size === second.size && [...first].every((name) => second.has(name))
}

export function buildSubmissionOrigins(submissions) {
  const ids = namesOf((Array.isArray(submissions) ? submissions : [])
    .map((item) => item?.ownerClientId))
  const lengths = new Map([...ids].map((id) => [id, Math.min(6, id.length)]))
  // A short ID can be another device's entire suffix. Keep its full ID and
  // extend the longer one; never drop a submission to resolve a collision.
  while (true) {
    const groups = new Map()
    for (const id of ids) {
      const suffix = id.slice(-lengths.get(id))
      if (!groups.has(suffix)) groups.set(suffix, [])
      groups.get(suffix).push(id)
    }
    let extended = false
    for (const group of groups.values()) {
      if (group.length < 2) continue
      for (const id of group) {
        if (lengths.get(id) < id.length) {
          lengths.set(id, lengths.get(id) + 1)
          extended = true
        }
      }
    }
    if (!extended) break
  }
  return new Map([...ids].map((id) => [id, {
    label: 'SoduWork ·' + id.slice(-lengths.get(id)),
    title: id,
  }]))
}
