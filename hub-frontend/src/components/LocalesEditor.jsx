import React from 'react'
import './locales-editor.css'

/*
 * Shared optional locale-map editor for administrator-authored fields. Callers provide
 * localized labels; backend localized_text validates values and the client shared
 * primitive resolves them.
 */
export default function LocalesEditor({ summary, languages, fields, value, onChange }) {
  const setLocaleField = (key, loc, next) => {
    const map = { ...(value[key] || {}) }
    if (next) map[loc] = next
    else delete map[loc]
    onChange(key, map)
  }
  return <details className="loc-block">
    <summary>{summary}</summary>
    <div className="loc-grid">
      {languages.map(([loc, label]) => <React.Fragment key={loc}>
        {fields.map((field) => field.textarea
          ? <label className="wide" key={field.key}><span>{field.label} · {label}</span>
            <textarea maxLength={field.maxLength} rows={field.rows || 3} value={(value[field.key] || {})[loc] || ''}
              onChange={(e) => setLocaleField(field.key, loc, e.target.value)} /></label>
          : <label className={field.wide ? 'wide' : ''} key={field.key}><span>{field.label} · {label}</span>
            <input maxLength={field.maxLength} value={(value[field.key] || {})[loc] || ''}
              onChange={(e) => setLocaleField(field.key, loc, e.target.value)} /></label>)}
      </React.Fragment>)}
    </div>
  </details>
}
