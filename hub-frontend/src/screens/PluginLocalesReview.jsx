import React from 'react'
import { translateText as tx, useLocale } from '../i18n.js'

export default function PluginLocalesReview({ manifest = {} }) {
  useLocale()
  const languages = Object.entries(manifest.locales || {})
  return <details className="plugin-preview-section">
    <summary>{tx('语言版本')} · {languages.length ? languages.map(([id]) => id).join(' / ') : tx('旧版单语言')}</summary>
    {languages.length ? <div className="plugin-entry-list">{languages.map(([id, text]) => <div key={id} lang={id}>
      <b>{id} · {text.name}</b><p>{text.description}</p>
      {Object.entries(text.ui || {}).map(([key, entry]) => <small key={key}>{key} · {entry.title} {entry.description}</small>)}
      {(text.inputs || text.setup) && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify({ inputs: text.inputs, setup: text.setup }, null, 2)}</pre>}
    </div>)}</div> : <p>{tx('兼容旧包；新创作的应用与插件至少提供中文和英文。')}</p>}
  </details>
}
