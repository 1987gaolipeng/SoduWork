import React, { useId } from 'react'
import { translateText as tx, useLocale } from '../i18n.js'
import { Icon, SelectMenu } from '../ui.jsx'
import { MAX_TOKENS, modelKey } from './quota-model.js'

export function TotalLimitField({ value, onChange, trial = false }) {
  useLocale()
  const id = useId()
  return <div className="qm-total-fields">
    <label className="qm-field" htmlFor={id + '-mode'}><span>{tx('总 Token 额度')}</span>
      <SelectMenu id={id + '-mode'} aria-label={tx('总额度规则')} value={value === null ? 'unlimited' : 'limited'}
        onChange={event => onChange(event.target.value === 'unlimited' ? null : '')}>
        <option value="limited">{tx('设置上限')}</option>
        {!trial && <option value="unlimited">{tx('不限额')}</option>}
      </SelectMenu>
    </label>
    {value !== null && <label className="qm-field" htmlFor={id + '-limit'}><span>{tx('Token 数量')}</span>
      <input id={id + '-limit'} className="f-in" aria-label={tx('Token 数量')} type="number" min={trial ? 1 : 0} max={MAX_TOKENS} step="1"
        value={value} onChange={event => onChange(event.target.value)} />
    </label>}
  </div>
}

export default function QuotaAllowanceFields({ value, onChange, choices, trial = false }) {
  useLocale()
  const id = useId()
  const updateModel = (index, next) => onChange({ ...value, models: value.models.map((row, i) => i === index ? { ...row, ...next } : row) })
  return <div className="qm-allowance-fields">
    <TotalLimitField value={value.totalLimit} trial={trial} onChange={totalLimit => onChange({ ...value, totalLimit })} />
    <p className="qm-help">{tx('所有设备合并计量；总额度与模型额度同时生效，0 表示暂停使用。')}</p>
    <div className="qm-model-heading"><h3>{tx('按模型设置额度')}</h3>
      <button type="button" className="btn btn-ghost" disabled={value.models.length >= 100 || !choices.length}
        onClick={() => onChange({ ...value, models: [...value.models, { provider: '', model: '', limit: '' }] })}><Icon name="plus" />{tx('添加模型额度')}</button>
    </div>
    {!choices.length && <p className="qm-note">{tx('模型目录暂无可选模型，请先配置模型服务。')}</p>}
    {!value.models.length && <p className="qm-help">{tx('未单独设置的模型共用总额度。')}</p>}
    {value.models.map((row, index) => {
      const key = modelKey(row), selected = choices.some(choice => modelKey(choice) === key)
      return <div className="qm-model-row" key={index}>
        <label className="qm-field" htmlFor={id + '-model-' + index}><span>{tx('模型')}</span>
          <SelectMenu searchable searchPlaceholder={tx('搜索模型或服务商')} emptyText={tx('没有匹配的模型')} id={id + '-model-' + index} aria-label={tx('模型 {0}', [index + 1])} value={row.model ? key : ''}
            onChange={event => { const choice = choices.find(item => modelKey(item) === event.target.value); if (choice) updateModel(index, { provider: choice.provider, model: choice.model }) }}>
            <option value="">{tx('选择模型')}</option>
            {row.model && !selected && <option value={key} disabled>{row.model} · {tx('目录中已不可用')}</option>}
            {choices.map(choice => <option key={modelKey(choice)} value={modelKey(choice)}
              disabled={value.models.some((item, i) => i !== index && modelKey(item) === modelKey(choice))}>
              {choice.label || choice.model} · {choice.providerName || choice.provider}
            </option>)}
          </SelectMenu>
        </label>
        <label className="qm-field" htmlFor={id + '-cap-' + index}><span>{tx('模型 Token 上限')}</span>
          <input className="f-in" id={id + '-cap-' + index} type="number" min="0" max={MAX_TOKENS} step="1"
            value={row.limit} onChange={event => updateModel(index, { limit: event.target.value })} />
        </label>
        <button type="button" className="btn btn-ghost qm-remove" aria-label={tx('移除模型 {0}', [index + 1])}
          onClick={() => onChange({ ...value, models: value.models.filter((_, i) => i !== index) })}><Icon name="trash" /></button>
      </div>
    })}
    <label className="qm-checkbox"><input type="checkbox" checked={value.restrictModels}
      onChange={event => onChange({ ...value, restrictModels: event.target.checked })} /><span>{tx('仅允许使用上面列出的模型')}</span></label>
    <p className="qm-help">{tx('关闭时，其他模型仍可使用总额度；开启时，未列出的模型不可使用。')}</p>
  </div>
}
