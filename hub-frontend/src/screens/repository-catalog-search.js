// The Hub applies search before limiting each repository catalog response.
const windowSize = 1000

function matches(row, needle) {
  return !needle || [row.fullName, row.displayName].some(value =>
    String(value || '').toLowerCase().includes(needle))
}

export function catalogRows(pages, query = '') {
  const needle = query.toLowerCase()
  const rows = pages.flatMap(page => page.items.filter(row => matches(row, needle)))
  return [...new Map(rows.map(row => [row.id, row])).values()]
}

export function catalogSearchView(pages, query, result) {
  const capped = pages.some(page => page.items.length >= windowSize)
  if (query && capped && result?.pages === pages && result.query === query) {
    return { ...result, capped, loading: false }
  }
  return { rows: catalogRows(pages, query), failures: [], capped, loading: Boolean(query && capped) }
}

export function scheduleCatalogSearch(pages, query, fetchPage, publish) {
  if (!query || !pages.some(page => page.items.length >= windowSize)) return
  let active = true
  const timer = setTimeout(async () => {
    const results = await Promise.allSettled(pages.map(async page => {
      if (page.items.length < windowSize) return page
      const response = await fetchPage(page.id, query)
      return { ...page, items: response.items || [] }
    }))
    if (!active) return
    const failures = []
    const searched = results.map((result, index) => {
      if (result.status === 'fulfilled') return result.value
      const page = pages[index]
      failures.push([page.name, result.reason?.message || String(result.reason)].filter(Boolean).join(' · '))
      return page
    })
    publish({ pages, query, rows: catalogRows(searched, query), failures })
  }, 250)
  return () => { active = false; clearTimeout(timer) }
}
