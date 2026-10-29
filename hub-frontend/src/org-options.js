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
