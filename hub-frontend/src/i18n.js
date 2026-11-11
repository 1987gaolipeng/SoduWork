import { useSyncExternalStore } from 'react'
import { dictionary } from './locales/shell.js'
import { messages } from './locales/messages.js'
import { messagesByLocale } from './locales/extra-languages.js'
import { serverMessages } from './locales/server-messages.js'

export const LOCALES = Object.freeze({ 'zh-CN': '简体中文', 'en-US': 'English', 'ja-JP': '日本語', 'ko-KR': '한국어' })
const STORAGE_KEY = 'soduwork.locale'
const SOURCE_LOCALE = 'zh-CN'
const FALLBACK = 'en-US'
const FALLBACKS = Object.freeze({ 'zh-CN': 'zh-CN', 'en-US': 'en-US', 'ja-JP': 'en-US', 'ko-KR': 'en-US' })
const subscribers = new Set()
const missing = new Set()
let locale = readLocale()

// Accepts tags, not just the four exact values: `zh`, `ZH-hans-sg`, `zh_CN`,
// `ja`, `ko` all resolve deterministically. ICU-dependent parsing is avoided so
// results never depend on the host. Traditional tags map to zh-CN: simplified
// copy is more readable than English for those users, and Traditional Chinese
// should be a first-class locale in its own issue rather than a silent remap.
export function normalizeLocale(value) {
  const raw = String(value || '').trim()
  if (LOCALES[raw]) return raw
  const tag = raw.replace(/_/g, '-').toLowerCase()
  const [primary] = tag.split('-').filter(Boolean)
  if (primary === 'en') return 'en-US'
  if (primary === 'ja') return 'ja-JP'
  if (primary === 'ko' || primary === 'kr') return 'ko-KR'
  // zh, zh-CN, zh-SG, zh-MY, zh-CHS, zh-Hans, zh-TW, zh-HK, zh-Hant…
  if (primary === 'zh') return SOURCE_LOCALE
  return FALLBACK
}
function fallbackLocale(value) { return FALLBACKS[normalizeLocale(value)] || FALLBACK }

// Only a browser knows the user's preferred language. Node/SSR runtimes expose a
// global `navigator` (Node 21+) whose value comes from the build machine's
// locale, so the host is gated on `window`; a server render gets no preference.
function browserPreferences() {
  if (typeof window === 'undefined') return {}
  const nav = typeof navigator === 'undefined' ? null : navigator
  if (!nav) return {}
  return { languages: nav.languages, language: nav.language }
}

// Pure locale detection: every input is a parameter, so callers and tests never
// touch globals and results cannot depend on the host machine.
// Order: the user's saved pick wins, then the browser preference list, then the
// single `language` value, then the documented fallback. Unsupported tags are
// skipped so a later supported entry in the list still wins.
export function detectLocale({ stored, languages, language } = {}) {
  const saved = String(stored ?? '').trim()
  if (saved) return normalizeLocale(saved)
  for (const tag of [...(Array.isArray(languages) ? languages : []), language]) {
    const text = String(tag ?? '').trim()
    if (!text) continue
    const resolved = normalizeLocale(text)
    if (resolved !== FALLBACK || text.toLowerCase().startsWith('en')) return resolved
  }
  return FALLBACK
}

// Browser preference alone, or null when no browser locale is available.
export function browserLocale() {
  const prefs = browserPreferences()
  if (!prefs.languages && !prefs.language) return null
  return detectLocale(prefs)
}

// A language the user saved explicitly always wins; otherwise follow the
// browser so a first-time Chinese user does not land on an English console.
function readLocale() {
  let stored = ''
  try { stored = String(localStorage.getItem(STORAGE_KEY) || '') } catch { /* Private browsing or Node without storage. */ }
  return detectLocale({ stored, ...browserPreferences() })
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

export function serverMessage(message, fallback = '', value = getLocale()) {
  if (!message || typeof message !== 'object') return String(message ?? fallback)
  const key = String(message.key || '')
  const row = Object.hasOwn(serverMessages, key) ? serverMessages[key] : null
  if (!row) return String(message.fallback || fallback)
  const index = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR'].indexOf(normalizeLocale(value))
  const params = message.params && typeof message.params === 'object' ? message.params : {}
  return (row[index] || row[1]).replace(/\{([a-zA-Z0-9_]+)\}/g,
    (token, name) => Object.hasOwn(params, name) ? String(params[name] ?? '') : token)
}

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
