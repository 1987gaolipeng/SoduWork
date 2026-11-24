// Keep hierarchy and complete paths in the same order in both department editors.
export function orgOptions(orgs, excludeId) {
  const byParent = new Map(), ids = new Set(orgs.map(org => org.id))
  for (const org of orgs) {
    const parent = ids.has(org.parentId) ? org.parentId : ''
    if (!byParent.has(parent)) byParent.set(parent, [])
    byParent.get(parent).push(org)
  }
  const result = [], visited = new Set()
  function walk(parent, path) {
    for (const org of byParent.get(parent) || []) {
      if (visited.has(org.id) || org.id === excludeId) continue
      visited.add(org.id)
      const names = [...path, org.name]
      result.push({ id: org.id, label: '　'.repeat(path.length) + org.name, path: names.join(' / ') })
      walk(org.id, names)
    }
  }
  walk('', [])
  return result
}

export function matchesOption(label, query) {
  const text = label.normalize('NFKC').toLocaleLowerCase()
  return query.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).every(part => text.includes(part))
}

// Keep matching descendants reachable without showing a filtered or out-of-scope ancestor.
export function visibleOrgRows(orgs, matches) {
  const parents = new Map(orgs.map(row => [row.id, row.parentId]))
  const visible = orgs.filter(matches)
  const visibleIds = new Set(visible.map(row => row.id))
  return visible.map(row => {
    let parentId = row.parentId
    const visited = new Set([row.id])
    while (parentId && !visibleIds.has(parentId)) {
      if (visited.has(parentId)) { parentId = null; break }
      visited.add(parentId)
      parentId = parents.get(parentId)
    }
    return parentId === row.parentId ? row : { ...row, parentId }
  })
}
