import React, { useRef } from 'react'
import { translateText as tx, useLocale } from './i18n.js'
import { Icon, SelectMenu } from './ui.jsx'

// Only query controls opt in to clearing. Configuration fields keep their
// existing validation and save semantics.
export function FilterSelect({ resetValue = '', ...props }) {
  return <SelectMenu {...props} clearable resetValue={resetValue} />
}

export function FilterInput({ value = '', onChange, resetValue = '', className = '',
  clearLabel, icon = 'search', disabled = false, readOnly = false, ...inputProps }) {
  useLocale()
  const inputRef = useRef(null)
  const canClear = !disabled && !readOnly && String(value ?? '') !== String(resetValue ?? '')
  const label = inputProps['aria-label'] || inputProps.placeholder || tx('搜索条件')
  return <div className={`admin-search filter-input ${className}${disabled ? ' is-disabled' : ''}`}>
    {icon && <Icon name={icon} aria-hidden="true" />}
    <input {...inputProps} ref={inputRef} aria-label={label} value={value ?? ''}
      onChange={onChange} disabled={disabled} readOnly={readOnly} />
    {canClear && <button type="button" className="filter-clear" aria-label={clearLabel || tx('清空{0}', [label])}
      title={clearLabel || tx('清空')} onClick={(event) => {
        event.preventDefault(); event.stopPropagation()
        onChange?.({ target: { value: String(resetValue ?? '') } })
        inputRef.current?.focus()
      }}>×</button>}
  </div>
}
