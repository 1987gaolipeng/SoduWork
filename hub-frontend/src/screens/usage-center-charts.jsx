import { translateText as tx, localeMap, useLocale } from '../i18n.js'
import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Icon } from '../ui.jsx'
import { calendarTrend, count, money, numeric, precise, ratio, sceneColor, sceneLabel, share } from './usage-center-format.js'

export function PanelHead({ icon, title, description, meta, children }) {
  const uiLocale = useLocale();
  return <header className="ugc-panel-head"><div className="ugc-panel-title"><span className="ugc-panel-icon"><Icon name={icon} /></span>
    <div><h3>{title}</h3>{description && <p>{description}</p>}</div></div>{children || (meta && <span className="ugc-badge">{meta}</span>)}</header>
}

export function Empty({ text, note = tx("新的会话、需求和自动化用量会显示在这里。") }) {
  const uiLocale = useLocale();
  return <div className="ugc-empty"><Icon name="activity" /><b>{text}</b><span>{note}</span></div>
}

const METRICS = localeMap(() => ({
  tokens: { label: 'Token 用量', unit: 'Tokens' },
  costMicrousd: { label: '已知成本', unit: 'USD' },
  requests: { label: '模型请求', unit: '次' },
}))
const shortDate = (key) => String(key).slice(5).replace('-', '/')

export function TrendPanel({ points, days, recent = [] }) {
  const uiLocale = useLocale();
  const rows = useMemo(() => calendarTrend(points, days), [points, days, uiLocale])
  const [metric, setMetric] = useState('tokens')
  const [active, setActive] = useState(null)
  const [width, setWidth] = useState(640)
  const plot = useRef(null)
  const gradientId = useId().replace(/:/g, '')
  const isCost = metric === 'costMicrousd'
  const values = rows.map((row) => numeric(row[metric]) / (isCost ? 1000000 : 1))
  const peak = Math.max(0, ...values)
  const sum = values.reduce((a, b) => a + b, 0)
  const activeDays = rows.filter(row => numeric(row.sessions) > 0).length
  const peakDay = rows[values.indexOf(peak)]?.key
  const concentrated = rows.length > 1 && peak > 0 && peak > sum / 2
  const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
  const peakRecords = concentrated ? recent.filter(row => {
    const time = Date.parse(row.occurredAt)
    return Number.isFinite(time) && dayFormat.format(time) === peakDay
  }) : []
  const unit = METRICS[metric].unit
  const step = 10 ** Math.floor(Math.log10(Math.max(isCost ? .01 : 1, peak / 4)))
  const rawTick = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10].find((n) => n * step >= peak / 4) * step
  const tick = isCost ? Math.max(.01, rawTick) : Math.max(1, Math.ceil(rawTick))
  const ceiling = tick * 4
  const height = 230, left = 56, right = 16, top = 18, bottom = 28
  const baseline = height - bottom, plotWidth = width - left - right
  const slot = plotWidth / Math.max(1, rows.length)
  const barWidth = Math.min(16, slot * .68)
  const x = (i) => left + slot * (i + .5)
  const y = (value) => baseline - value / ceiling * (baseline - top)
  const selected = active == null || !rows.length ? null : Math.min(active, rows.length - 1)
  const labels = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])].filter((i) => i >= 0)
  const display = (value) => isCost ? money(value * 1000000, rows.some(row => row.knownUsd) ? '$0.00' : '—') : count(value)
  const selectedRow = rows[selected]
  const selectedValue = selectedRow && (isCost
    ? money(selectedRow.costMicrousd, selectedRow.knownUsd ? '$0.00' : '—')
    : precise(metric === 'tokens' ? selectedRow.tokensExact ?? selectedRow.tokens : selectedRow.requests))
  const axis = (value) => isCost ? '$' + (value >= 1000 ? count(value) : value.toLocaleString('en-US', { maximumFractionDigits: 2 })) : count(value)

  useEffect(() => {
    if (!plot.current) return undefined
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)))
    observer.observe(plot.current)
    return () => observer.disconnect()
  }, [rows.length])
  useEffect(() => setActive(null), [points])

  function inspect(event) {
    const bounds = event.currentTarget.getBoundingClientRect()
    setActive(Math.max(0, Math.min(rows.length - 1, Math.floor(((event.clientX - bounds.left) / bounds.width * width - left) / slot))))
  }
  function keyDown(event) {
    if (event.key === 'Escape') { setActive(null); return }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    setActive((i) => event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : Math.max(0, Math.min(rows.length - 1, (i ?? rows.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1))))
  }

  return <section className={'ugc-panel ugc-trend-panel' + (isCost ? ' is-cost' : '')}>
    <PanelHead icon="activity" title={tx("每日消耗趋势")} description={tx("近 {0} 天 · 按北京时间归集", [days])}>
      <div className="ugc-chart-tabs" role="group" aria-label={tx("趋势指标")}>{Object.entries(METRICS).map(([key, item]) =>
        <button type="button" key={key} aria-pressed={metric === key} onClick={() => { setMetric(key); setActive(null) }}>{item.label}</button>)}</div>
    </PanelHead>
    <div className="ugc-trend-summary"><span><i />{METRICS[metric].label}<small>{tx("单位：")}{unit}</small></span>
      <span>{tx("合计 ")}<b>{display(sum)}</b><em />{tx("单日最高 ")}<b>{display(peak)}</b></span></div>
    {!rows.length ? <Empty text={tx("暂无消耗趋势")} note={tx("调整筛选条件，或在产生用量后查看每日变化。")} /> :
      <div className="ugc-plot" ref={plot}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" tabIndex="0" aria-label={tx("{0}趋势，共 {1} 个日期；使用左右方向键查看，Home 和 End 跳到首尾。{2}", [METRICS[metric].label, rows.length, selectedRow ? `${selectedRow.key}，${selectedValue} ${unit}。` : ''])}
          onMouseMove={inspect} onMouseLeave={() => setActive(null)} onFocus={() => setActive(rows.length - 1)} onBlur={() => setActive(null)} onKeyDown={keyDown}>
          <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--chart-color)" stopOpacity=".95" /><stop offset="100%" stopColor="var(--chart-color)" stopOpacity=".55" /></linearGradient></defs>
          {[0, 1, 2, 3, 4].map((i) => <g className="ugc-plot-grid" key={i}><line x1={left} x2={width - right} y1={y(ceiling * i / 4)} y2={y(ceiling * i / 4)} /><text x={left - 10} y={y(ceiling * i / 4) + 4} textAnchor="end">{axis(ceiling * i / 4)}</text></g>)}
          {values.map((value, i) => <rect key={rows[i].key} className={'ugc-bar' + (selected === i ? ' is-active' : '') + (value ? '' : ' is-zero')}
            x={x(i) - barWidth / 2} y={value ? y(value) : baseline - 2} width={barWidth} height={value ? baseline - y(value) : 2} rx={Math.min(3, barWidth / 3)} fill={value ? `url(#${gradientId})` : 'var(--surface-3)'} />)}
          {labels.map((i) => <text className="ugc-plot-date" key={i} x={x(i)} y={height - 4} textAnchor={i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle'}>{shortDate(rows[i].key)}</text>)}
        </svg>
        {selected != null && <div className={'ugc-chart-tip ' + (selected < rows.length / 2 ? 'from-left' : 'from-right')} style={{ left: x(selected) / width * 100 + '%' }}>
          <span>{selectedRow.key}</span><b>{selectedValue}<small>{' '}{unit}</small></b>
          <small>{numeric(rows[selected].sessions) ? tx("{0} 条用量记录", [precise(rows[selected].sessions)]) : tx("当天暂无用量记录")}</small></div>}
      </div>}
    {activeDays > 0 && activeDays < rows.length && <p className="ugc-chart-note">{tx("所选 {0} 天中有 {1} 天产生了记录。", [rows.length, activeDays])}</p>}
    {concentrated && <details className="ugc-chart-note" key={peakDay}>
      <summary>{tx("超过一半的用量集中在 {0}，查看当天的最近记录", [peakDay])}</summary>
      {peakRecords.length ? <ul>{peakRecords.map(row => <li key={row.id}>{row.title || tx("AI 使用")} · {isCost ? money(row.costMicrousd, row.costKnown && row.currency === 'USD' ? '$0.00' : '—') : count(row[metric])} {unit}</li>)}</ul>
        : <p>{tx("最近记录中没有这一天的明细。")}</p>}
    </details>}
    <p className="ugc-chart-note">{isCost ? tx("仅展示已知价格的成本；未计价的用量仍会计入 Token。") : tx("悬停查看每日数据，或聚焦图表后使用方向键。")}</p>
  </section>
}

export function SceneLedger({ rows, total, selected, onSelect }) {
  const uiLocale = useLocale();
  let offset = 0
  const main = rows.find((row) => numeric(row.tokens) > 0)
  return <section className="ugc-panel ugc-scenes">
    <PanelHead icon="grid" title={tx("场景分布")} description={tx("按 Token 用量占比")} meta={tx("{0} 个场景", [rows.length])} />
    {!rows.length ? <Empty text={tx("暂无场景用量")} /> : <div className="ugc-scene-body">
      <div className="ugc-scene-overview"><div className="ugc-donut" role="img" aria-label={rows.map((row) => `${sceneLabel(row.key, row.label)} ${share(row.tokens, total)}`).join('，')}>
        <svg viewBox="0 0 120 120" aria-hidden="true"><circle className="ugc-donut-track" cx="60" cy="60" r="48" />
          {rows.map((row) => { const size = ratio(row.tokens, total), start = offset; offset += size
            return size > 0 && <circle key={row.key} cx="60" cy="60" r="48" pathLength="100" stroke={sceneColor(row.key)} strokeDasharray={`${size} ${100 - size}`} strokeDashoffset={-start} /> })}</svg>
        <span><b>{count(total)}</b><small>Tokens</small></span></div>
        <div className="ugc-scene-lead"><small>{main ? tx("主要用量场景") : tx("尚无 Token 用量")}</small><b title={main ? sceneLabel(main.key, main.label) : undefined}>{main ? sceneLabel(main.key, main.label) : '—'}</b><span>{main ? share(main.tokens, total) : '0%'}<small>{tx("占当前范围")}</small></span></div></div>
      <div className="ugc-scene-list">{rows.map((row) => <button type="button" key={row.key} aria-pressed={selected === row.key}
        onClick={() => onSelect(selected === row.key ? '' : row.key)} style={{ '--scene-color': sceneColor(row.key) }}>
        <i /><b title={sceneLabel(row.key, row.label)}>{sceneLabel(row.key, row.label)}</b><span title={`${precise(row.tokensExact ?? row.tokens)} Tokens`}>{count(row.tokens)}</span><em>{share(row.tokens, total)}</em><Icon name="chevron" />
      </button>)}</div>
      <p className="ugc-chart-note">{tx("选择场景，查看对应成员与模型用量。")}</p>
    </div>}
  </section>
}
