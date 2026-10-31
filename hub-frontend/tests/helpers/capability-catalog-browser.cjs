const assert = require('node:assert/strict')

// Use distinct device submissions and stale policy names without writing policy or
// contacting a device. Saving is covered by the real component/API mock tests.
async function checkCapabilityCatalog({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, requests, results }) {
  const keys = ['/admin/capabilities/catalog', '/admin/capabilities']
  const previous = Object.fromEntries(keys.map(key => [key, fixtures[key]]))
  const requestStart = requests.length
  const record = (name, ok, evidence) => {
    results.push({ name, ok: Boolean(ok), evidence })
    assert.ok(ok, name + ': ' + JSON.stringify(evidence))
  }
  const ghost = 'removed-skill-with-a-long-unmatched-historical-policy-name'
  const owners = ['owner-device-A-12ab34', 'owner-device-B-12ab34', 'owner-device-C-90cd56']
  const skills = [
    { name: 'available-skill', description: 'Available company capability' },
    { name: 'second-skill', description: 'Another available company capability' },
    { name: 'optional-skill', description: 'Capability that can be enabled in a draft' },
    ...Array.from({ length: 21 }, (_, index) => ({ name: 'fixture-skill-' + String(index + 1).padStart(2, '0'), description: 'Catalog capability ' + (index + 1) })),
  ].map(item => ({ ...item, scope: 'company', source: 'company', portable: true, inUse: 2 }))
  const personalSubmissions = [
    ...owners.map(ownerClientId => ({ key: 'personal:presales-style', ownerClientId, name: 'presales-style', description: 'Prepare a customer presentation using the same personal method.' })),
    { key: 'personal:unknown-device', name: 'unknown-device-skill', description: 'The source device has not been reported.' },
    ...Array.from({ length: 12 }, (_, index) => ({ key: 'personal:fixture-' + index, ownerClientId: 'fixture-device-' + String(index).padStart(6, '0'), name: 'Personal method ' + (index + 1), description: 'Another personal submission to verify independently scrollable lists.' })),
  ]
  const catalog = { cfg: { allowed: ['available-skill', 'available-skill', 'second-skill', ghost, ghost], policyVersion: 7 },
    skills, personalSubmissions, mcpTemplates: [], mcp: [], packages: [],
    summary: { skills: skills.length, personalSubmissions: personalSubmissions.length, mcpTemplates: 0 } }
  const readState = () => js('(' + function () {
    const root = document.querySelector('.cap-admin')
    const metric = root.querySelectorAll('.cap-admin-metric')[1]
    return {
      opened: Number(metric.querySelector('b').textContent), label: metric.querySelector('small').textContent.trim(),
      selected: root.querySelectorAll('.cap-admin-card[aria-pressed="true"]').length,
      cards: root.querySelectorAll('.cap-admin-card').length,
      dirty: Boolean(root.querySelector('.cap-admin-dirty')),
      saveDisabled: root.querySelector('.cap-admin-bar .btn-primary')?.disabled,
      warning: root.querySelector('.cap-admin-policy-warning')?.innerText || '',
      origins: [...root.querySelectorAll('.cap-admin-submit-list > div')].map(row => {
        const source = row.querySelector('.cap-admin-submit-origin')
        return { name: row.querySelector('b')?.textContent.trim(), source: source?.textContent.trim() || '',
          titles: [...row.querySelectorAll('[title]')].map(element => element.title).join('\n') }
      }),
      explanation: root.querySelector('.cap-admin-submissions .cap-admin-section-title')?.textContent || '',
    }
  }.toString() + ')()')
  const setSearch = async value => {
    await js('(' + function (value) {
      const input = document.querySelector('.cap-admin-search input, input.cap-admin-search')
      if (!input) throw new Error('Capability search input missing')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }.toString() + ')(' + JSON.stringify(value) + ')')
  }
  const clickSkill = async name => {
    await js('(' + function (name) {
      const button = [...document.querySelectorAll('.cap-admin-card')].find(element => element.querySelector('.cap-admin-card-title > b')?.textContent === name)
      if (!button) throw new Error('Capability card missing: ' + name)
      button.click()
    }.toString() + ')(' + JSON.stringify(name) + ')')
  }
  const readGeometry = () => js('(' + function () {
    const measure = selector => {
      const element = document.querySelector(selector), rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right, width: rect.width, height: rect.height,
        scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth, tabIndex: element.tabIndex, label: element.getAttribute('aria-label') }
    }
    return { width: innerWidth, page: document.documentElement.scrollWidth,
      discovered: measure('.cap-admin-grid'), personal: measure('.cap-admin-submit-list'),
      origins: [...document.querySelectorAll('.cap-admin-submit-origin')].slice(0, 4).map(element => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return { width: rect.width, left: rect.left, right: rect.right, scroll: element.scrollWidth, client: element.clientWidth, text: element.textContent, whiteSpace: style.whiteSpace, overflow: style.overflow, wrap: style.overflowWrap, parentBasis: getComputedStyle(element.parentElement).flexBasis, rowWrap: getComputedStyle(element.parentElement.parentElement).flexWrap }
      }) }
  }.toString() + ')()')
  const languageEvidence = {}
  try {
    for (const key of keys) fixtures[key] = catalog
    for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
      win.setSize(1280, 1000)
      await win.loadURL(origin + '/?screen=capabilities')
      await waitFor('document.querySelectorAll(".cap-admin-card").length === 24 && document.querySelectorAll(".cap-admin-submit-origin").length === 16', 'capability policy and personal source fixture')
      await changeLocale(locale)
      await waitFor('!document.querySelector(".profile-menu")', 'language picker closed before capability checks')
      const initial = await readState()
      record('capability opened count excludes duplicate and unmatched policy names ' + locale,
        initial.opened === 2 && initial.selected === 2 && !initial.dirty && initial.saveDisabled, initial)
      record('capability unmatched policy names remain visible until explicitly removed ' + locale,
        initial.warning.includes(ghost) && initial.warning.split(ghost).length === 2, initial.warning)
      const sameName = initial.origins.filter(item => item.name === 'presales-style')
      record('personal capability submissions keep all same-name device records ' + locale,
        sameName.length === 3 && new Set(sameName.map(item => item.source)).size === 3 &&
        sameName.every((item, index) => item.source.includes('SoduWork') && item.titles.includes(owners[index])), sameName)
      const unknown = initial.origins.find(item => item.name === 'unknown-device-skill')
      record('personal capability source has a visible fallback for missing devices ' + locale,
        Boolean(unknown?.source) && !unknown.source.includes('undefined') && !unknown.source.includes('null') &&
        unknown.source !== sameName[0].source, unknown)
      languageEvidence[locale] = { label: initial.label, source: sameName[0].source, unknown: unknown.source, warning: initial.warning, explanation: initial.explanation }
      const copy = Object.values(languageEvidence[locale]).join(' ')
      if (locale === 'zh-CN') record('capability source and cleanup copy matches the Chinese contract',
        initial.label === '已开放' && sameName[0].source.includes('提交设备') && unknown.source === '来源设备未知' &&
        initial.warning.includes('移除未匹配项') && initial.explanation.includes('同名 Skill') && initial.explanation.includes('按提交设备区分'), languageEvidence[locale])
      if (locale === 'en-US') record('capability source and policy copy has no Chinese fallback', !/[\u3400-\u9fff]/.test(copy), languageEvidence[locale])
      if (locale === 'ja-JP') record('capability source and policy copy uses Japanese', sameName[0].source.startsWith('提出端末：') && unknown.source === '提出端末不明' && /[\u3040-\u30ff]/.test(initial.warning), languageEvidence[locale])
      if (locale === 'ko-KR') record('capability source and policy copy uses Korean', /[\uac00-\ud7af]/.test(sameName[0].source) && /[\uac00-\ud7af]/.test(unknown.source) && /[\uac00-\ud7af]/.test(initial.warning), languageEvidence[locale])

      for (const width of [1920, 1280, 390]) {
        win.setSize(width, 1000); await sleep(150)
        await js('window.scrollTo({top:0,left:0,behavior:"instant"})')
        const geometry = await readGeometry()
        await screenshot('capability-policy-' + locale + '-' + width)
        await js('document.querySelector(".cap-admin-submit-list").scrollIntoView({block:"center",behavior:"instant"})')
        await screenshot('capability-personal-sources-' + locale + '-' + width)
        record('capability source and policy layout fits viewport ' + locale + ' ' + width,
          geometry.page <= geometry.width + 1 && geometry.origins.every(item => item.width > 0 && item.left >= -1 && item.right <= geometry.width + 1 && item.scroll <= item.client + 1), geometry)
        record('capability catalog and personal records keep separate named scroll regions ' + locale + ' ' + width,
          [geometry.discovered, geometry.personal].every(item => item.tabIndex === 0 && item.label && item.height >= 90 && item.scrollHeight > item.clientHeight && item.scrollWidth <= item.clientWidth + 1), geometry)
      }
      win.setSize(1280, 1000); await sleep(100)
      const scroll = await js('(' + function () {
        const grid = document.querySelector('.cap-admin-grid'), personal = document.querySelector('.cap-admin-submit-list')
        grid.scrollTop = 0; personal.scrollTop = 0
        grid.focus(); const gridFocused = document.activeElement === grid
        grid.scrollTop = grid.scrollHeight; const gridMoved = grid.scrollTop > 0 && personal.scrollTop === 0
        personal.focus(); const personalFocused = document.activeElement === personal
        const gridTop = grid.scrollTop
        personal.scrollTop = personal.scrollHeight
        const personalMoved = personal.scrollTop > 0 && grid.scrollTop === gridTop
        grid.scrollTop = 0; personal.scrollTop = 0
        return { gridFocused, personalFocused, gridMoved, personalMoved }
      }.toString() + ')()')
      record('capability lists remain independently scrollable and keyboard focusable ' + locale, Object.values(scroll).every(Boolean), scroll)

      await setSearch('optional-skill')
      await waitFor('document.querySelectorAll(".cap-admin-card").length === 1', 'capability filtered to one card')
      const filtered = await readState()
      record('capability filtering does not change global opened count ' + locale,
        filtered.opened === 2 && filtered.selected === 0 && filtered.cards === 1 && filtered.origins.length === 16 && !filtered.dirty, filtered)
      await clickSkill('optional-skill')
      await waitFor('document.querySelector(".cap-admin-card").getAttribute("aria-pressed") === "true"', 'filtered capability draft enabled')
      const draft = await readState()
      languageEvidence[locale].draft = draft.label
      record('capability draft count tracks the full catalog while filtered ' + locale,
        draft.opened === 3 && draft.selected === 1 && draft.dirty && !draft.saveDisabled && draft.label !== initial.label, draft)
      if (locale === 'zh-CN') record('capability draft count is explicitly pending save', draft.label === '待保存开放数', draft.label)
      await js('document.querySelectorAll(".cap-admin-tabs button")[1].click()')
      await waitFor('!document.querySelector(".cap-admin-grid")', 'connectors tab opened')
      await js('document.querySelectorAll(".cap-admin-tabs button")[0].click()')
      await waitFor('document.querySelectorAll(".cap-admin-card").length === 1', 'capabilities tab restores filter')
      const restored = await readState()
      record('capability tab roundtrip preserves filtered policy draft ' + locale, restored.opened === 3 && restored.selected === 1 && restored.dirty, restored)
      await clickSkill('optional-skill')
      await waitFor('document.querySelector(".cap-admin-card").getAttribute("aria-pressed") === "false"', 'capability draft reverted')
      const reverted = await readState()
      record('reverting a capability toggle restores the saved effective count ' + locale,
        reverted.opened === 2 && reverted.label === initial.label && !reverted.dirty && reverted.saveDisabled, reverted)
      await setSearch('no-skill-matches-this-query')
      await waitFor('!!document.querySelector(".cap-admin-empty")', 'empty capability search')
      const empty = await readState()
      record('empty capability search preserves count warning and personal sources ' + locale,
        empty.opened === 2 && empty.cards === 0 && empty.origins.length === 16 && empty.warning.includes(ghost), empty)
      await setSearch('')
      await waitFor('document.querySelectorAll(".cap-admin-card").length === 24', 'capability search cleared')
      await js('document.querySelector(".cap-admin-policy-warning button").click()')
      await waitFor('!document.querySelector(".cap-admin-policy-warning")', 'unmatched policy removal staged')
      const cleaned = await readState()
      record('removing unmatched capability entries only stages a policy change ' + locale,
        cleaned.opened === 2 && cleaned.selected === 2 && cleaned.dirty && !cleaned.saveDisabled && cleaned.label === draft.label &&
        requests.slice(requestStart).every(request => request.method === 'GET'), cleaned)
      await js('window.scrollTo({top:0,left:0,behavior:"instant"})')
      await screenshot('capability-cleanup-draft-' + locale)
      await js('document.querySelector(".cap-admin-dirty + button").click()')
      await waitFor('!!document.querySelector(".cap-admin-policy-warning") && !document.querySelector(".cap-admin-dirty")', 'capability cleanup draft discarded')
      const discarded = await readState()
      record('discarding capability cleanup restores the saved policy and effective count ' + locale,
        discarded.opened === 2 && discarded.selected === 2 && discarded.label === initial.label && discarded.saveDisabled && discarded.warning.includes(ghost), discarded)
    }
    record('capability source warning and draft labels differ in all four locales',
      ['source', 'unknown', 'warning', 'draft'].every(key => new Set(Object.values(languageEvidence).map(item => item[key])).size === 4), languageEvidence)
    record('capability acceptance never submits policy or mutates server state',
      requests.slice(requestStart).every(request => request.method === 'GET'), requests.slice(requestStart))
  } finally {
    for (const key of keys) fixtures[key] = previous[key]
    win.setSize(1280, 900)
    await changeLocale('en-US')
  }
}

module.exports = { checkCapabilityCatalog }
