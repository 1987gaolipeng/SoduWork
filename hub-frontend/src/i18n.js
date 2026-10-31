import { useSyncExternalStore } from 'react'
import { dictionary } from './locales/shell.js'
import { messages } from './locales/messages.js'
import { messagesByLocale } from './locales/extra-languages.js'
import quotaMessages from './locales/quota-management.js'

export const LOCALES = Object.freeze({ 'zh-CN': '简体中文', 'en-US': 'English', 'ja-JP': '日本語', 'ko-KR': '한국어' })
const STORAGE_KEY = 'soduwork.locale'
const SOURCE_LOCALE = 'zh-CN'
const FALLBACK = 'en-US'
const FALLBACKS = Object.freeze({ 'zh-CN': 'zh-CN', 'en-US': 'en-US', 'ja-JP': 'en-US', 'ko-KR': 'en-US' })
const subscribers = new Set()
const missing = new Set()
let locale = readLocale()

export function normalizeLocale(value) {
  const raw = String(value || '').trim()
  if (LOCALES[raw]) return raw
  if (raw.toLowerCase().startsWith('en')) return 'en-US'
  if (raw.toLowerCase().startsWith('ja')) return 'ja-JP'
  if (/^(ko|kr)/i.test(raw)) return 'ko-KR'
  return FALLBACK
}
function fallbackLocale(value) { return FALLBACKS[normalizeLocale(value)] || FALLBACK }
function readLocale() {
  try { return normalizeLocale(localStorage.getItem(STORAGE_KEY)) } catch { return FALLBACK }
}
export function getLocale() { return locale }
export function subscribeLocale(listener) {
  subscribers.add(listener)
  return () => subscribers.delete(listener)
}
export function useLocale() {
  return useSyncExternalStore(subscribeLocale, getLocale, () => FALLBACK)
}
export function setLocale(value) {
  const next = normalizeLocale(value)
  const changed = next !== locale
  locale = next
  try { localStorage.setItem(STORAGE_KEY, next) } catch { /* Private browsing can deny storage. */ }
  if (typeof document !== 'undefined') document.documentElement.lang = next
  if (changed) {
    subscribers.forEach(listener => listener())
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('soduwork-locale-change', { detail: { locale: next } }))
  }
  return next
}
export function t(key, fallback = key, value = getLocale()) {
  const locale = normalizeLocale(value)
  return dictionary[locale]?.[key] ?? dictionary[fallbackLocale(locale)]?.[key] ?? dictionary['en-US']?.[key] ?? dictionary[FALLBACK]?.[key] ?? fallback
}

// Mark an authored key that must remain stable until the UI presents it.
// The source audit checks this exact key in every supported translated locale.
export function deferredMessageKey(source) { return source }

// Only authored UI sources are passed here. Never translate a server value,
// user-entered title, prompt, URL, log or code, even if it equals a UI label.
// Interpolation happens after translation, preserving user data verbatim.
export function translateText(source, values = [], value = getLocale()) {
  if (typeof values === 'string') { value = values; values = [] }
  const text = String(source ?? '')
  const trimmed = text.trim()
  let translated = text
  const locale = normalizeLocale(value)
  if (locale !== SOURCE_LOCALE && /[\u3400-\u9fff]/.test(trimmed)) {
    const result = messagesByLocale[locale]?.[trimmed] ?? (locale === 'en-US' ? (quotaMessages[trimmed] ?? messages[trimmed]) : messages[trimmed])
    if (result != null) translated = text.replace(trimmed, result)
    else missing.add(trimmed)
  }
  return values.length ? translated.replace(/\{(\d+)\}/g, (token, index) => index < values.length ? String(values[index] ?? '') : token) : translated
}

// Only explicitly marked, author-owned constant maps are localized. Business
// data never passes here. Cached string values remain usable by native forms.
export function localeMap(factory) {
  const read = typeof factory === 'function' ? factory : () => factory
  let cachedLocale
  let cached
  const localize = value => {
    if (typeof value === 'string') return translateText(value)
    if (Array.isArray(value)) return value.map(localize)
    // Preserve React.lazy/element identity; cloning these would remount open
    // screens on a language change and discard unsaved forms.
    if (value && value.$$typeof) return value
    if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, localize(item)]))
    return value
  }
  const current = () => {
    if (cachedLocale !== getLocale()) { cached = localize(read()); cachedLocale = getLocale() }
    return cached
  }
  const target = read()
  return new Proxy(target, {
    get(_target, key) { return Reflect.get(current(), key) },
    ownKeys() { return Reflect.ownKeys(current()) },
    getOwnPropertyDescriptor(_target, key) {
      const descriptor = Object.getOwnPropertyDescriptor(current(), key)
      if (descriptor && key !== 'length') descriptor.configurable = true
      return descriptor
    },
  })
}
export function localeOptions() {
  return Object.entries(LOCALES).map(([value, label]) => ({ value, label }))
}
export function getMissingTranslations() { return [...missing].sort() }
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === STORAGE_KEY) setLocale(event.newValue)
})
if (typeof document !== 'undefined') document.documentElement.lang = locale
