import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { translateText as tx, useLocale, localeMap, deferredMessageKey } from '../i18n.js'
import { api } from '../api.js'

export const CAPABILITY_LABELS = localeMap(() => ({ imageInput: '图片输入', toolCalling: '工具调用', streaming: '流式输出' }))
export const CAPABILITY_STATES = localeMap(() => ({ unknown: '未确认', supported: '支持', unsupported: '不支持' }))
const SOURCES = localeMap(() => ({ configured: '手动配置', 'legacy-native': '已有配置', verified: '实际检测', unknown: '未确认' }))
const STATUS = localeMap(() => ({ passed: '检测通过', failed: '检测失败', unsupported: '不支持', inconclusive: '未能确认', cancelled: '已取消', skipped: '未执行' }))
const DIAGNOSTICS = localeMap(() => ({
  request_rejected: '服务拒绝了检测请求，原因尚未确认',
  timeout: '服务响应超时，可稍后重试', temporarily_unavailable: '服务暂时不可用，可稍后重试',
  credentials_or_access: '请检查凭据及模型访问权限', model_or_endpoint_missing: '请检查模型 ID 和接口地址',
  capability_not_supported: '服务明确返回不支持此能力', request_not_accepted: '服务未接受检测请求，请检查协议配置',
  expected_output_missing: '未收到预期结果，暂不能确认能力', invalid_response: '服务响应格式无法识别',
  protocol_not_tested: '此协议暂无法自动检测', parameter_not_supported: '检测参数不被接受，能力仍未确认',
  cancelled: '检测已取消，已有证据仍保留', connection_blocked: '连接检查未通过，此项未执行',
  legacy_recheck_required: '旧版检测结果需要重新验证',
  billing_unavailable: '模型服务计费额度不可用，请检查供应商账户',
  budget_exhausted: '检测预算已用尽，能力仍未确认', response_too_large: '检测响应超过大小限制',
  response_limit: '检测响应超过大小限制', stream_interrupted: '流式响应未正常完成', stream_incomplete: '流式响应未正常完成',
  stream_error: '服务在逐步返回回复时报告错误', stream_not_observed: '未收到逐步返回的回复，暂不能确认能力',
  response_truncated: '回复提前结束，未能完成检测', content_filtered: '服务拦截了检测回复，暂不能确认能力',
  transport_interrupted: '连接中断，未能完成检测',
}))
const STAGES = localeMap(() => ({
  output: '检测阶段：检查回复内容', stream: '检测阶段：逐步接收回复',
  tool_call: '检测阶段：请求工具执行', tool_result: '检测阶段：读取工具结果',
}))
const DETAIL_DIAGNOSTICS = localeMap(() => ({
  tool_finish_reason_mismatch: '模型未按要求发起工具调用', tool_call_count_mismatch: '模型未按要求调用一次工具',
  tool_call_invalid: '未收到可用的工具调用', tool_arguments_invalid: '工具调用信息不符合检测要求',
  tool_receipt_mismatch: '模型未正确确认工具执行结果', tool_result_finish_reason_mismatch: '模型读取工具结果后未正常完成回复',
  invalid_stream_shape: '逐步返回的回复格式无法识别', expected_output_mismatch: '回复内容与检测要求不符',
}))
// Older reports lack detail codes; unknown provider values must never become UI copy.
const knownMessage = (messages, key) => typeof key === 'string' && Object.hasOwn(messages, key) ? messages[key] : ''
export function capabilityProfile(model) {
  return Object.fromEntries(Object.keys(CAPABILITY_LABELS).map(key => {
    const explicit = model.config?.capabilities?.[key]
    const legacy = key === 'imageInput' && model.config?.imageRouting === 'native'
    const supplied = model.capabilityProfile?.[key]
    return [key, explicit && explicit !== 'unknown' ? { ...supplied, state: explicit, source: 'configured' }
      : legacy ? { ...supplied, state: 'supported', source: 'legacy-native' } : supplied || { state: 'unknown', source: 'unknown' }]
  }))
}
function usesPreviousImageCheck(model, report, image) {
  const attempt = report?.checks?.imageInput
  return model?.enabled !== false && (model?.modality || 'chat') === 'chat' && model?.config?.imageRouting !== 'vision-fallback'
    && image?.source === 'verified' && image.state === 'supported' && report?.verifiedChecks?.imageInput?.status === 'passed'
    && (attempt?.status === 'unsupported' || (attempt?.status === 'inconclusive' && attempt.detailCode === 'expected_output_mismatch'))
}
export function CapabilityBadges({ model }) {
  useLocale()
  const profile = capabilityProfile(model)
  const retainedImage = usesPreviousImageCheck(model, model.capabilityCheck, profile.imageInput)
  return <div className="model-cap-badges">{Object.entries(profile).map(([key, value]) => {
    // Merged reports can contain attempts from different runs. Use this capability's record.
    const lastStatus = model.capabilityCheck?.checks?.[key]?.status ?? value.checkStatus
    const lastStatusLabel = knownMessage(STATUS, lastStatus)
    const attemptState = lastStatus === 'passed' ? 'supported' : lastStatus === 'unsupported' ? 'unsupported' : 'unknown'
    const showAttempt = key !== 'imageInput' || !retainedImage
    const divergent = showAttempt && ['supported', 'unsupported'].includes(value.state) && lastStatusLabel && attemptState !== value.state
    const showLastAttempt = showAttempt && lastStatusLabel && (divergent || attemptState === 'unknown')
    const stateLabel = knownMessage(CAPABILITY_STATES, value.state) || CAPABILITY_STATES.unknown
    let label = stateLabel
    if (divergent) {
      if (value.source === 'verified') label = tx(value.state === 'supported' ? '上次验证：支持' : '上次验证：不支持')
      else if (value.source === 'configured') label = tx('手动配置：{0}', [stateLabel])
      else if (value.source === 'legacy-native') label = tx('已有配置：{0}', [stateLabel])
    }
    return <span key={key} className={'model-cap-badge is-' + (value.state === 'supported' ? 'supported' : 'neutral')}
      title={tx(knownMessage(SOURCES, value.source) || SOURCES.unknown)}>
      {tx(CAPABILITY_LABELS[key])}<b>{label}</b>
      {showLastAttempt && <small>{tx('最近检测：{0}', [lastStatusLabel])}</small>}
      {value.conflict && <small title={tx('配置与最近检测结果不一致')}>{tx('配置冲突')}</small>}
    </span>})}</div>
}
export function CapabilityReport({ result, model, disabled }) {
  const locale = useLocale()
  if (!result) return <span className="model-cap-unchecked">{tx('能力尚未检测')}</span>
  const date = result.checkedAt ? new Date(result.checkedAt) : null
  const time = date && !Number.isNaN(date.getTime()) ? date.toLocaleString(locale) : ''
  const retainedImage = !disabled && model && usesPreviousImageCheck(model, result, capabilityProfile(model).imageInput)
  return <details className="model-cap-report"><summary>{tx('检测结果')}{time && <time dateTime={result.checkedAt}>{time}</time>}</summary>
    <dl>{Object.entries(result.checks || {}).filter(([key]) => key === 'connection' || CAPABILITY_LABELS[key]).map(([key, check]) => {
      const retained = key === 'imageInput' && retainedImage
      const rejected = retained && check.status === 'unsupported'
      const stage = knownMessage(STAGES, check.stage)
      const detail = key === 'imageInput' && check.detailCode === 'expected_output_mismatch'
        ? deferredMessageKey('未收到与图片中六位数字完全一致的回复')
        : knownMessage(DETAIL_DIAGNOSTICS, check.detailCode) || knownMessage(DIAGNOSTICS, check.code)
      return <div key={key}><dt>{CAPABILITY_LABELS[key] || tx('服务连接')}</dt>
        <dd className={'is-' + check.status}>{tx(rejected ? '本次检测未通过' : STATUS[check.status] || STATUS.inconclusive)}</dd>
        {stage && <small>{tx(stage)}</small>}
        {rejected ? <small>{tx('服务拒绝了本次图片请求。对话沿用上次通过的结果，你仍可发图。')}</small> : detail && <small>{tx(detail)}</small>}
        {retained && !rejected && <small>{tx('对话沿用上次通过的结果，你仍可发图。')}</small>}
        {result.verifiedChecks?.[key] && (result.verifiedChecks[key].status !== check.status || result.verifiedChecks[key].checkedAt !== check.checkedAt) &&
          <small><span>{tx(retained ? '上次通过' : result.verifiedChecks[key].status === 'passed' ? '上次验证：支持' : '上次验证：不支持')}</span>
            {result.verifiedChecks[key].checkedAt && <>{' '}<time dateTime={result.verifiedChecks[key].checkedAt}>{new Date(result.verifiedChecks[key].checkedAt).toLocaleString(locale)}</time></>}</small>}
      </div>})}</dl><p>{tx('检测结果仅适用于当前服务和模型配置；超时或网络异常不代表模型不支持。')}</p>
  </details>
}
export function ModelCapabilityStatus({ model, disabled, onChecked, scheduleFirstCheck, portalTarget }) {
  useLocale()
  const [busy, setBusy] = useState(false)
  const [queued, setQueued] = useState(false)
  const [result, setResult] = useState(model.capabilityCheck)
  const [error, setError] = useState(null)
  const mounted = useRef(false), inFlight = useRef(null), attempted = useRef(false)
  const current = useRef(null)
  useEffect(() => { current.current = { model, disabled } }, [model, disabled])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setResult(model.capabilityCheck) }, [model.capabilityCheck])
  function check(automatic = false) {
    if (inFlight.current || disabled) return
    attempted.current = true
    setBusy(true); setError(null)
    inFlight.current = runCheck(automatic)
    return inFlight.current
  }
  async function runCheck(automatic) {
    try {
      const response = await api.checkModelCapabilities({ providerId: model.providerId, model: model.name,
        ...(automatic && model.configRevision ? { expectedConfigRevision: model.configRevision } : {}),
        checks: ['connection', 'imageInput', 'toolCalling', 'streaming'] })
      if (!mounted.current || (model.configRevision && response.configRevision !== model.configRevision)) return
      setResult(response)
      onChecked?.(response)
    } catch (e) {
      if (mounted.current) setError(e)
    } finally {
      inFlight.current = null
      if (mounted.current) setBusy(false)
    }
  }
  useEffect(() => {
    const pending = scheduleFirstCheck?.(() => {
      if (!mounted.current || current.current.disabled || current.current.model.capabilityCheck) return
      if (attempted.current) return inFlight.current
      return check(true)
    })
    if (pending) {
      setQueued(true)
      pending.finally(() => { if (mounted.current) setQueued(false) })
    }
  }, [scheduleFirstCheck])
  const checking = busy || queued
  const revisionConflict = error?.status === 409 && (error.code === 'model_config_revision_changed' ||
    (!error.code && error.message === '模型配置在检测期间已变更，请重新检测'))
  const content = <div className="model-cap-status">
    <div className="model-cap-check-action"><button type="button" className="admin-card-action" disabled={checking || disabled}
      onClick={() => check()}>{checking ? tx('正在检测能力…') : tx('检测能力')}</button>
      <span>{tx('使用已保存的服务与模型配置')}</span></div>
    <div aria-live="polite">{checking ? <span role="status" className="model-cap-unchecked">{tx('正在检查连接、图片输入、工具调用与流式输出…')}</span>
      : <CapabilityReport result={result} model={model} disabled={disabled} />}</div>
    {error && <div className="model-cap-error" role="alert">{revisionConflict
      ? tx('模型配置已变更，请重新检测') : error.message || tx('能力检测失败，请稍后重试')}</div>}
  </div>
  // Undefined preserves inline callers; null keeps only the check lifecycle mounted.
  return portalTarget === undefined ? content : portalTarget ? createPortal(content, portalTarget) : null
}
