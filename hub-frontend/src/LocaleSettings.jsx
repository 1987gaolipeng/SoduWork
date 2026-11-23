import React, { useEffect, useRef, useState } from 'react'
import { Icon, SelectMenu } from './ui.jsx'
import { localeOptions, setLocale, t, useLocale, normalizeLocaleWithRemap } from './i18n.js'
import './locale-settings.css'

function browserLanguage() {
  if (typeof navigator === 'undefined') return ''
  const nav = navigator
  const langs = Array.isArray(nav.languages) ? nav.languages : [nav.language]
  for (const tag of langs) {
    const { remapped } = normalizeLocaleWithRemap(tag)
    if (remapped) return tag
  }
  return ''
}

export default function LocaleSettings({ floating = false, inline = false }) {
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  const root = useRef(null)
  const trigger = useRef(null)
  const [remappedLang, setRemappedLang] = useState('')
  useEffect(() => {
    setRemappedLang(browserLanguage())
  }, [])
  useEffect(() => {
    if (!open) return
    const close = event => {
      if (event.type === 'keydown' && event.key === 'Escape') {
        setOpen(false)
        trigger.current?.focus()
      } else if (event.type === 'pointerdown' && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])
  const languageField = <label><span>{t('account.languageHint')}</span>
    <SelectMenu className="locale-language-select" autoFocus={!inline}
      aria-label={t('account.languageHint')} value={locale} onChange={event => setLocale(event.target.value)}>
      {localeOptions().map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
    </SelectMenu>
  </label>
  if (inline) return <div className="locale-settings is-inline">{languageField}
    {remappedLang && <p className="locale-remap-note" role="status">{t('当前系统语言为繁体中文，暂以简体中文显示。待繁体中文语言包上线后自动切换。')}</p>}
  </div>
  return <div ref={root} className={'locale-settings' + (floating ? ' is-floating' : '')}>
    <button ref={trigger} className="icon-btn locale-settings-trigger" type="button"
      onClick={() => setOpen(value => !value)} aria-expanded={open}
      aria-haspopup="dialog" aria-label={t('account.settings')} title={t('account.settings')}>
      <Icon name="settings" /><span>{t('account.settings')}</span>
    </button>
    {open && <div className="locale-settings-popover" role="dialog" aria-label={t('account.settings')}>
      <b>{t('account.settings')}</b>
      {languageField}
      {remappedLang && <p className="locale-remap-note" role="status">{t('当前系统语言为繁体中文，暂以简体中文显示。待繁体中文语言包上线后自动切换。')}</p>}
    </div>}
  </div>
}