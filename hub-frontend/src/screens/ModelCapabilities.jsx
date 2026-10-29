import React, { useEffect, useRef, useState } from 'react'
import { translateText as tx, useLocale, localeMap } from '../i18n.js'
import { api } from '../api.js'

export const CAPABILITY_LABELS = localeMap(() => ({ imageInput: '图片输入', toolCalling: '工具调用', streaming: '流式输出' }))
export const CAPABILITY_STATES = localeMap(() => ({ unknown: '未确认', supported: '支持', unsupported: '不支持' }))
const SOURCES = localeMap(() => ({ configured: '手动配置', 'legacy-native': '已有配置', verified: '实际检测', unknown: '未确认' }))
const STATUS = localeMap(() => ({ passed: '检测通过', failed: '检测失败', unsupported: '不支持', inconclusive: '未能确认' }))
const DIAGNOSTICS = localeMap(() => ({
  timeout: '服务响应超时，可稍后重试', temporarily_unavailable: '服务暂时不可用，可稍后重试',
  credentials_or_access: '请检查凭据及模型访问权限', model_or_endpoint_missing: '请检查模型 ID 和接口地址',
  capability_not_supported: '服务明确返回不支持此能力', request_not_accepted: '服务未接受检测请求，请检查协议配置',
  expected_output_missing: '未收到预期结果，暂不能确认能力', invalid_response: '服务响应格式无法识别',
  protocol_not_tested: '当前协议尚不支持自动检测，请手动配置',
}))
export function capabilityProfile(model) {
  return Object.fromEntries(Object.keys(CAPABILITY_LABELS).map(key => {
    const explicit = model.config?.capabilities?.[key]
    const legacy = key === 'imageInput' && model.config?.imageRouting === 'native'
    return [key, model.capabilityProfile?.[key] || {
      state: explicit && explicit !== 'unknown' ? explicit : legacy ? 'supported' : 'unknown',
      source: explicit && explicit !== 'unknown' ? 'configured' : legacy ? 'legacy-native' : 'unknown',
    }]
  }))
}
export function CapabilityBadges({ model }) {
  useLocale()
  return <div className="model-cap-badges">{Object.entries(capabilityProfile(model)).map(([key, value]) =>
    <span key={key} className={'model-cap-badge is-' + (value.state === 'supported' ? 'supported' : 'neutral')}
      title={tx(SOURCES[value.source] || SOURCES.unknown)}>
      {tx(CAPABILITY_LABELS[key])}<b>{tx(CAPABILITY_STATES[value.state] || CAPABILITY_STATES.unknown)}</b>
    </span>)}</div>
}
export function CapabilityReport({ result }) {
  const locale = useLocale()
  if (!result) return <span className="model-cap-unchecked">{tx('能力尚未检测')}</span>
  const date = result.checkedAt ? new Date(result.checkedAt) : null
  const time = date && !Number.isNaN(date.getTime()) ? date.toLocaleString(locale) : ''
  return <details className="model-cap-report"><summary>{tx('检测结果')}{time && <time dateTime={result.checkedAt}>{time}</time>}</summary>
    <dl>{Object.entries(result.checks || {}).filter(([key]) => key === 'connection' || CAPABILITY_LABELS[key]).map(([key, check]) =>
      <div key={key}><dt>{CAPABILITY_LABELS[key] || tx('服务连接')}</dt>
        <dd className={'is-' + check.status}>{tx(STATUS[check.status] || STATUS.inconclusive)}</dd>
        {DIAGNOSTICS[check.code] && <small>{tx(DIAGNOSTICS[check.code])}</small>}
      </div>)}</dl><p>{tx('检测结果仅适用于当前服务和模型配置；超时或网络异常不代表模型不支持。')}</p>
  </details>
}
export function ModelCapabilityStatus({ model, disabled, onChecked }) {
  useLocale()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(model.capabilityCheck)
  const [error, setError] = useState('')
  const mounted = useRef(false), inFlight = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setResult(model.capabilityCheck) }, [model.capabilityCheck])
  async function check() {
    if (inFlight.current || disabled) return
    inFlight.current = true; setBusy(true); setError('')
    try {
      const response = await api.checkModelCapabilities({ providerId: model.providerId, model: model.name,
        checks: ['connection', 'imageInput', 'toolCalling', 'streaming'] })
      if (!mounted.current) return
      setResult(response)
      onChecked?.(response)
    } catch (e) {
      if (mounted.current) setError(e.message || tx('能力检测失败，请稍后重试'))
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return <div className="model-cap-status">
    <div className="model-cap-check-action"><button type="button" className="admin-card-action" disabled={busy || disabled}
      onClick={check}>{busy ? tx('正在检测能力…') : tx('检测能力')}</button>
      <span>{tx('使用已保存的服务与模型配置')}</span></div>
    <div aria-live="polite">{busy ? <span role="status" className="model-cap-unchecked">{tx('正在检查连接、图片输入、工具调用与流式输出…')}</span>
      : <CapabilityReport result={result} />}</div>
    {error && <div className="model-cap-error" role="alert">{error}</div>}
  </div>
}
