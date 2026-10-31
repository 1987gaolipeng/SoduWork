import { getLocale, translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useId, useRef, useState } from 'react'
import { Icon } from '../ui.jsx'
import { summarizeTrend } from './insights-metrics.js'

const METRICS = localeMap(() => ({
  aiSessions: { label: 'AI 会话', unit: '场' },
  tasksCreated: { label: "新建需求", unit: '项' },
  activeClients: { label: '活跃设备', unit: '台' },
}))
const shortDate = (value) => String(value || '').slice(5).replace('-', '/')
const number = (value) => Number(value || 0).toLocaleString(getLocale())
const axisNumber = (value) => value >= 10000 ? tx("{0}万", [number(Math.round(value / 1000) / 10)]) : number(value)

export function UsageTrend({ trend }) {
  const uiLocale = useLocale();
  const [metric, setMetric] = useState('aiSessions')
  const [active, setActive] = useState(null)
  const [width, setWidth] = useState(640)
  const plotRef = useRef(null)
  const gradientId = useId().replace(/:/g, '')
  const meta = METRICS[metric]
  const { values, average, peak: seriesPeak } = summarizeTrend(trend, metric)
  const peak = seriesPeak ?? 0
  const step = 10 ** Math.floor(Math.log10(Math.max(1, peak / 4)))
  const tickSize = Math.max(1, [1, 2, 3, 5, 10].find((size) => size * step >= peak / 4) * step)
  const ceiling = tickSize * 4
  const height = 226, left = 40, right = 14, top = 18, bottom = 28
  const plotWidth = width - left - right, baseline = height - bottom
  const x = (i) => left + (values.length > 1 ? i / (values.length - 1) : 0.5) * plotWidth
  const y = (value) => baseline - value / ceiling * (baseline - top)
  const points = values.map((value, i) => `${x(i)},${y(value)}`).join(' ')
  const selected = active == null ? null : Math.min(active, values.length - 1)
  const ticks = [...new Set([0, Math.floor((values.length - 1) / 3), Math.floor((values.length - 1) * 2 / 3), values.length - 1])].filter((i) => i >= 0)

  useEffect(() => {
    if (!plotRef.current) return undefined
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)))
    observer.observe(plotRef.current)
    return () => observer.disconnect()
  }, [values.length])

  function inspect(event) {
    if (!values.length) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const fraction = ((event.clientX - bounds.left) / bounds.width * width - left) / plotWidth
    setActive(Math.max(0, Math.min(values.length - 1, Math.round(fraction * (values.length - 1)))))
  }
  function onKeyDown(event) {
    if (event.key === 'Escape') { setActive(null); return }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !values.length) return
    event.preventDefault()
    setActive((previous) => {
      if (event.key === 'Home') return 0
      if (event.key === 'End') return values.length - 1
      return Math.max(0, Math.min(values.length - 1, (previous ?? values.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1)))
    })
  }

  return <section className="ops-panel oi-panel oi-usage">
    <header className="oi-panel-header">
      <div className="oi-panel-title"><span className="oi-panel-icon"><Icon name="activity" /></span><div><h3>{tx("使用趋势")}</h3><p>{tx("近 30 个自然日（北京时间 UTC+8，含今天）")}</p></div></div>
      <div className="oi-trend-tabs" role="group" aria-label={tx("趋势指标")}>
        {Object.entries(METRICS).map(([key, item]) => <button key={key} type="button" aria-pressed={metric === key}
          onClick={() => { setMetric(key); setActive(null) }}>{item.label}</button>)}
      </div>
    </header>
    <div className="oi-trend-summary"><span><i />{meta.label}<small>{tx("单位：")}{meta.unit}</small></span>
      <span>{tx("日均 ")}<b>{average == null ? '—' : number(average)}</b><em />{tx("单日最高 ")}<b>{seriesPeak == null ? '—' : number(seriesPeak)}</b></span></div>
    {values.length === 0 ? <div className="oi-chart-empty"><Icon name="activity" /><b>{tx("暂无趋势数据")}</b><span>{tx("开始使用 SoduWork 后，这里会展示每日变化。")}</span></div> :
      <div className="oi-trend-plot" ref={plotRef}>
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" tabIndex="0" role="img"
          aria-label={tx("{0}每日趋势，使用左右方向键查看日期，Home 和 End 跳到首尾。{1}", [meta.label, selected != null && selected >= 0 ? `${shortDate(trend[selected].date)}，${number(values[selected])}${meta.unit}。` : ''])}
          onMouseMove={inspect} onMouseLeave={() => setActive(null)} onFocus={() => setActive(values.length - 1)} onBlur={() => setActive(null)} onKeyDown={onKeyDown}>
          <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".21" /><stop offset="100%" stopColor="var(--accent)" stopOpacity=".015" /></linearGradient></defs>
          {[0, 1, 2, 3, 4].map((tick) => <g key={tick} className="oi-plot-grid"><line x1={left} x2={width - right} y1={y(ceiling * tick / 4)} y2={y(ceiling * tick / 4)} /><text x={left - 10} y={y(ceiling * tick / 4) + 4} textAnchor="end">{axisNumber(ceiling * tick / 4)}</text></g>)}
          {peak > 0 && <polygon points={`${x(0)},${baseline} ${points} ${x(values.length - 1)},${baseline}`} fill={`url(#${gradientId})`} />}
          <polyline className={'oi-trend-line' + (peak ? '' : ' is-zero')} points={points} />
          {values.length === 1 && peak > 0 && <circle className="oi-trend-dot" cx={x(0)} cy={y(values[0])} r="3" />}
          {ticks.map((i) => <text key={i} className="oi-plot-date" x={x(i)} y={height - 5} textAnchor={i === 0 ? 'start' : i === values.length - 1 ? 'end' : 'middle'}>{shortDate(trend[i].date)}</text>)}
          {selected != null && selected >= 0 && <g><line className="oi-trend-guide" x1={x(selected)} x2={x(selected)} y1={top} y2={baseline} /><circle className="oi-trend-dot" cx={x(selected)} cy={y(values[selected])} r="4" /></g>}
        </svg>
        {selected != null && selected >= 0 && <div className={'oi-trend-tooltip' + (selected < values.length / 2 ? ' from-left' : ' from-right')}
          style={{ left: `${x(selected) / width * 100}%` }}><span>{shortDate(trend[selected].date)} · {meta.label}</span><b>{number(values[selected])}<small>{meta.unit}</small></b></div>}
      </div>}
    <p className="oi-chart-foot">{peak ? tx("悬停查看每日数据，也可聚焦图表后使用方向键。") : values.length ? tx("当前统计周期内暂无使用记录。") : tx("暂无趋势数据")}</p>
  </section>
}
