// Both the card and chart summarize the same Beijing-calendar-day buckets.
// Missing series is unavailable data; a populated all-zero series is zero activity.
export function summarizeTrend(trend, metric) {
  const values = trend.map(day => {
    const value = Number(day[metric])
    return Number.isFinite(value) ? Math.max(0, value) : 0
  })
  if (!values.length) return { values, total: null, average: null, peak: null }
  const total = values.reduce((sum, value) => sum + value, 0)
  return { values, total, average: Math.round(total / values.length * 10) / 10, peak: Math.max(...values) }
}
