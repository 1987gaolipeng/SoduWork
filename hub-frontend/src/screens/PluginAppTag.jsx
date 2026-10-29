import React from 'react'
import { t, useLocale } from '../i18n.js'
import './plugin-app-tag.css'

// Review identity belongs to the selected immutable version, not its newest sibling.
export default function PluginAppTag({ version }) {
  useLocale()
  return version?.manifest?.template === 'app'
    ? <span className="plugin-app-tag">{t('plugin.type.app', '应用')}</span> : null
}
