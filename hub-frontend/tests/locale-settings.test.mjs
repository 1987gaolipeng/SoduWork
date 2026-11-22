import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { dictionary } from '../src/locales/shell.js'
import { createComponentHarness } from './helpers/react-harness.mjs'

let moduleSequence = 0

// Keep locale detection, persistence and setters real. Only browser globals and
// the existing logic host's React subscription boundary are supplied by the test.
async function withSettings({ stored = null, languages = ['zh-TW'], language, profile = new Map(), blockedStorage = false }, check) {
  if (stored !== null) profile.set('soduwork.locale', stored)
  profile.set('legacy-profile-setting', 'retained')
  const listeners = new Map()
  const globals = {
    navigator: { languages, language: language ?? languages?.[0] },
    localStorage: {
      getItem(key) { if (blockedStorage) throw Error('Storage unavailable'); return profile.get(key) ?? null },
      setItem(key, value) { if (blockedStorage) throw Error('Storage unavailable'); profile.set(key, String(value)) },
    },
    window: {
      addEventListener(name, listener) { listeners.set(name, listener) },
      dispatchEvent() { return true },
    },
    document: { documentElement: { lang: '' }, addEventListener() {}, removeEventListener() {} },
  }
  const previous = Object.fromEntries(Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  let host
  try {
    for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value })
    const file = new URL('../src/i18n.js', import.meta.url)
    file.searchParams.set('locale-settings-case', String(++moduleSequence))
    const locale = await import(file.href)
    host = await createComponentHarness(new URL('../src/LocaleSettings.jsx', import.meta.url), {
      props: { inline: true },
      dependencies: {
        './ui.jsx': { Icon: 'svg', SelectMenu: 'select' },
        './locale-settings.css': {},
        './i18n.js': { ...locale, useLocale: () => locale.getLocale(), useLocaleSelection: () => locale.getLocaleSelection() },
      },
    })
    const refresh = () => host.render({ inline: true })
    const notices = () => {
      refresh()
      return host.nodes(node => node.props.className === 'locale-remap-note')
    }
    const choose = value => {
      host.nodes(node => node.type === 'select')[0].props.onChange({ target: { value } })
      refresh()
    }
    await check({ locale, profile, notices, choose, listeners })
    assert.equal(profile.get('legacy-profile-setting'), 'retained')
  } finally {
    host?.unmount()
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
}

for (const stored of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN']) {
  test(`saved ${stored} language does not show a browser Traditional fallback notice`, async () => {
    await withSettings({ stored }, ({ locale, profile, notices }) => {
      assert.equal(locale.getLocale(), stored)
      assert.equal(profile.get('soduwork.locale'), stored)
      assert.equal(notices().length, 0, 'an explicit saved language is not a browser fallback')
    })
  })
}

test('English-first preferences do not show a fallback for a later Traditional entry', async () => {
  await withSettings({ languages: ['en-US', 'zh-TW'] }, ({ locale, profile, notices }) => {
    assert.equal(locale.getLocale(), 'en-US')
    assert.equal(profile.has('soduwork.locale'), false)
    assert.equal(notices().length, 0)
  })
})

test('manual English selection clears a real fallback and survives reload without rewriting profile data', async () => {
  const profile = new Map()
  await withSettings({ profile }, ({ locale, notices, choose }) => {
    assert.equal(locale.getLocale(), 'zh-CN')
    assert.equal(notices().length, 1)
    choose('en-US')
    assert.equal(locale.getLocale(), 'en-US')
    assert.equal(notices().length, 0, 'the notice must follow the current manual selection')
  })
  await withSettings({ profile }, ({ locale, notices }) => {
    assert.equal(locale.getLocale(), 'en-US')
    assert.equal(profile.get('soduwork.locale'), 'en-US')
    assert.equal(notices().length, 0, 'the saved selection remains authoritative after reload')
  })
})

test('explicitly selecting the current Simplified language clears fallback and notifies once', async () => {
  await withSettings({}, ({ locale, profile, notices, choose }) => {
    assert.equal(notices().length, 1)
    let updates = 0
    const stop = locale.subscribeLocale(() => updates++)
    try {
      choose('zh-CN')
      assert.equal(locale.getLocale(), 'zh-CN')
      assert.equal(profile.get('soduwork.locale'), 'zh-CN')
      assert.equal(notices().length, 0)
      assert.equal(updates, 1, 'fallback provenance changed even though the locale code did not')
      choose('zh-CN')
      assert.equal(updates, 1, 'an unchanged explicit choice does not notify twice')
    } finally { stop() }
  })
})

for (const tag of ['zh-TW', 'zh-HK', 'zh-Hant-TW']) {
  test(`first visit with ${tag} shows the actual fallback without saving an override`, async () => {
    await withSettings({ languages: [tag] }, ({ locale, profile, notices }) => {
      assert.equal(locale.getLocale(), 'zh-CN')
      assert.equal(profile.has('soduwork.locale'), false)
      assert.equal(notices().length, 1)
      assert.equal(notices()[0].props.role, 'status')
      assert.match(notices()[0].props.children, /简体中文/)
    })
  })
}

test('single browser language still supplies the fallback when the preference list is empty', async () => {
  await withSettings({ languages: [], language: 'zh-TW' }, ({ locale, notices }) => {
    assert.equal(locale.getLocale(), 'zh-CN')
    assert.equal(notices().length, 1)
  })
})

test('a legacy stored Traditional tag remains usable and explains its effective fallback', async () => {
  await withSettings({ stored: 'zh-TW', languages: ['en-US'] }, ({ locale, profile, notices }) => {
    assert.equal(locale.getLocale(), 'zh-CN')
    assert.equal(profile.get('soduwork.locale'), 'zh-TW', 'reading an old profile must not canonicalize it')
    assert.equal(notices().length, 1)
  })
})

test('a legacy stored language alias remains authoritative without profile conversion', async () => {
  await withSettings({ stored: 'ja', languages: ['zh-TW'] }, ({ locale, profile, notices }) => {
    assert.equal(locale.getLocale(), 'ja-JP')
    assert.equal(profile.get('soduwork.locale'), 'ja')
    assert.equal(notices().length, 0)
  })
})

test('a cross-tab explicit Simplified choice clears the mounted fallback notice', async () => {
  await withSettings({}, ({ locale, profile, notices, listeners }) => {
    assert.equal(notices().length, 1)
    listeners.get('storage')({ key: 'soduwork.locale', newValue: 'zh-CN' })
    assert.equal(locale.getLocale(), 'zh-CN')
    assert.equal(profile.get('soduwork.locale'), 'zh-CN')
    assert.equal(notices().length, 0)
  })
})

test('storage restrictions do not keep a false notice after a manual language selection', async () => {
  await withSettings({ blockedStorage: true }, ({ locale, notices, choose }) => {
    assert.equal(notices().length, 1)
    choose('en-US')
    assert.equal(locale.getLocale(), 'en-US')
    assert.equal(notices().length, 0)
  })
})

test('fallback copy resolves its semantic key in every selectable language', async () => {
  await withSettings({}, ({ locale }) => {
    const key = 'account.languageFallback'
    for (const { value } of locale.localeOptions()) {
      assert.ok(Object.hasOwn(dictionary[value], key), value)
      const text = locale.t(key, undefined, value)
      assert.ok(text.trim() && text !== key, value)
      if (value !== 'zh-CN') assert.notEqual(text, dictionary['zh-CN'][key], value)
    }
  })
})

test('selection snapshots stay stable until the language or fallback provenance changes', async () => {
  await withSettings({}, ({ locale, choose }) => {
    const initial = locale.getLocaleSelection()
    assert.equal(locale.getLocaleSelection(), initial)
    choose('zh-CN')
    const explicit = locale.getLocaleSelection()
    assert.notEqual(explicit, initial)
    assert.equal(locale.getLocaleSelection(), explicit)
    choose('zh-CN')
    assert.equal(locale.getLocaleSelection(), explicit)
  })
})

test('server rendering uses a stable fallback without a browser remap notice', async () => {
  await withSettings({}, ({ locale }) => {
    function Probe() {
      const selection = locale.useLocaleSelection()
      return React.createElement('output', { 'data-locale': selection.locale, 'data-remapped': String(selection.remapped) })
    }
    assert.equal(renderToStaticMarkup(React.createElement(Probe)), '<output data-locale="en-US" data-remapped="false"></output>')
  })
})
