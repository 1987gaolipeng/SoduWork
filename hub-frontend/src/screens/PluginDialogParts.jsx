import React from 'react'
import { useLocale } from '../i18n.js'
import { Icon } from '../ui.jsx'

export function Field({ label, children }) {
  const uiLocale = useLocale();
  return <div><label className="f-lbl">{label}</label>{children}</div>
}

export function NoticeList({ tone = '', title, items }) {
  const uiLocale = useLocale();
  if (!items || !items.length) return null
  return <div className={'plugin-notice ' + tone}>
    <Icon name={tone === 'bad' ? 'alert' : 'shield'} />
    <div><b>{title}</b>{items.map((item, index) => <span key={index}>{item}</span>)}</div>
  </div>
}
