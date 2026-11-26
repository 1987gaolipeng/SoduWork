import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { translateText as tx, useLocale } from '../i18n.js'
import { validateAssignment, validatePlan } from './quota-model.js'

export function useQuotaImpactPreview({ draft, config, member, onConflict }) {
  const [result, setResult] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const request = useMemo(() => {
    try {
      return member
        ? { body: validateAssignment(member, draft, config.models, config.revision), memberId: member.id }
        : { body: { revision: config.revision, plan: validatePlan(draft, config.models) } }
    } catch (error) {
      return { invalid: error.message }
    }
  }, [draft, config, member])
  useEffect(() => {
    if (request.invalid) return
    let active = true
    const timer = setTimeout(async () => {
      try {
        const data = request.memberId
          ? await api.previewQuotaMember(request.memberId, request.body)
          : await api.previewQuotaPlan(request.body)
        if (active) setResult({ request, data })
      } catch (error) {
        if (!active) return
        setResult({ request, error: error.message, conflict: error.status === 409 })
        if (error.status === 409) onConflict(true)
      }
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [request, attempt, onConflict])
  if (request.invalid) return { invalid: request.invalid }
  if (result?.request !== request) return { pending: true }
  return { ...result, retry: () => { setResult(null); setAttempt(value => value + 1) } }
}

export function QuotaImpactPreview({ impact, trial = false, isNew = false, member = false }) {
  const locale = useLocale(), { data } = impact
  const number = value => value.toLocaleString(locale)
  const limit = value => value === null ? tx('不限额') : number(value)
  return <section className="qm-latest qm-impact" aria-label={tx('影响预览')} aria-live="polite">
    <h3>{tx('影响预览')}</h3>
    {impact.invalid && <span>{tx(impact.invalid)}</span>}
    {impact.pending && <span>{tx('正在计算影响…')}</span>}
    {impact.error && !impact.conflict && <div role="alert">{tx(impact.error)} <button type="button" className="btn btn-ghost" onClick={impact.retry}>{tx('重试')}</button></div>}
    {data && <>
      {!trial && !isNew && !member && data.scopeLimited && <p>{tx('此预览仅统计你可管理的成员。保存后，套餐变更对所有已分配成员生效。')}</p>}
      <dl>
        <dt>{tx('现有受影响成员')}</dt><dd>{number(data.affectedMembers)}</dd>
        <dt>{tx('每人总额度（Tokens）')}</dt><dd>{!isNew && <>{limit(data.previousLimit)} → </>}{limit(data.newLimit)}</dd>
        {trial ? <><dt>{tx('新用户领取时可用（Tokens）')}</dt><dd>{limit(data.remaining)}</dd></> : <>
          <dt>{tx('本期已用合计（Tokens）')}</dt><dd>{number(data.used)}</dd>
          <dt>{tx('调整后剩余合计（Tokens）')}</dt><dd>{limit(data.remaining)}</dd>
        </>}
        {!trial && <><dt>{tx('调整后所有平台模型均暂停的成员')}</dt><dd>{number(data.pausedMembers)}</dd></>}
        {!trial && !member && data.modelLimitedMembers > 0 && <><dt>{tx('仅部分模型额度耗尽的成员')}</dt><dd>{number(data.modelLimitedMembers)}</dd></>}
      </dl>
      {!trial && !isNew && <span>{tx('按预览时的用量计算。')}</span>}
      {trial && <span>{data.reason ? tx('新用户领取后，平台模型请求将暂停。') : tx('新用户领取后，可发起平台模型请求。')}</span>}
      {(member || trial) && data.reason && <span>{data.reason === 'trial_expired' ? tx('试用已到期') : data.reason === 'model_exhausted' ? tx('模型额度已用完') : tx('额度已用完')}</span>}
      {member && data.period && <span>{data.period === 'trial' ? tx('一次性试用') : data.period}</span>}
      {(member || trial) && data.models?.length > 0 && <details>
        <summary>{tx('{0} 个模型额度', [data.models.length])}</summary>
        {data.models.map(row => <p key={JSON.stringify([row.provider, row.model])}>{row.provider} / {row.model} · {tx('已使用 {0} / {1} Tokens', [number(row.used), number(row.limit)])} · {row.exceeded ? tx('模型额度已用完') : tx('模型剩余 {0} Tokens', [number(row.remaining)])}</p>)}
        {data.restrictModels && <span>{tx('仅限所列模型')}</span>}
      </details>}
    </>}
  </section>
}
