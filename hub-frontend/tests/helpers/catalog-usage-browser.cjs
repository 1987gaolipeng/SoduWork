const assert = require('node:assert/strict')

// Exercise the built UI with deliberately different configuration, live and historical counts.
// No provider is probed and no model request or write is sent by this acceptance helper.
async function checkCatalogUsage({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, results }) {
  const keys = ['/admin/model-catalog', '/admin/model-runtime', '/admin/usage/overview']
  const previous = Object.fromEntries(keys.map(key => [key, fixtures[key]]))
  const record = (name, ok, evidence) => {
    results.push({ name, ok: Boolean(ok), evidence })
    assert.ok(ok, name + ': ' + JSON.stringify(evidence))
  }
  const policy = { globalConcurrent: 256, providerConcurrent: 64, keyConcurrent: 64, modelConcurrent: 64,
    userConcurrent: 8, queueSize: 128, userQueueSize: 8, queueTimeout: 30, requestTimeout: 600,
    readTimeout: 120, connectTimeout: 20, providers: {}, models: {} }
  const catalog = {
    providers: [
      { id: 'configured', name: 'Customer gateway 客户网关', enabled: true, builtin: false, baseUrl: 'https://fixture.invalid', keySet: true, keyLen: 32 },
      { id: 'missing-key', name: 'Missing credential', enabled: true, builtin: false, baseUrl: 'https://fixture.invalid', keySet: false },
      { id: 'missing-url', name: 'Missing endpoint', enabled: true, builtin: false, baseUrl: '', keySet: true, keyLen: 32 },
      { id: 'disabled', name: 'Disabled provider', enabled: false, builtin: false, baseUrl: 'https://fixture.invalid', keySet: true, keyLen: 32 },
    ],
    models: Array.from({ length: 5 }, (_, i) => ({ id: 'catalog-model-' + i, name: 'Customer model ' + i,
      providerId: i < 3 ? 'configured' : i === 3 ? 'missing-key' : 'disabled', enabled: i < 3, modality: 'chat' })),
  }
  const runtime = { running: 21, queued: 1, policy, revision: 1,
    lastHour: { waitMs: 760, started: 5, timeout: 17, queueTimeout: 6, rateLimited: 3 },
    groups: [{ provider: 'Customer gateway 客户网关', model: 'Customer model 0', running: 21, queued: 1 }],
  }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const usage = { days: 30, summary: { tokens: 1000000, sessions: 4029, requests: 628, durationMs: 3600000, costMicrousd: 1200000 },
    costQuality: { records: 4029, unknown: 0, otherCurrency: 0 },
    users: [{ userId: 'customer-member', label: '客户成员', tokens: 1000000, sessions: 4029, costMicrousd: 1200000, costKnown: true, currency: 'USD' }],
    bySource: [{ key: 'chat', label: '对话', tokens: 900000 }, { key: 'task', label: '需求执行', tokens: 100000 }],
    byAgent: [{ key: 'pi-customer', agent: 'pi', model: 'customer-model', provider: 'Customer gateway', tokens: 1000000, costMicrousd: 1200000 }],
    trend: [{ key: today, tokens: 1000000, sessions: 141, requests: 628, costMicrousd: 1200000 }],
    recent: [{ id: 'usage-record', title: '客户业务原文', user: '客户成员', sourceType: 'chat', sourceLabel: '对话', agent: 'pi', model: 'customer-model', tokens: 1000000, costMicrousd: 1200000, occurredAt: new Date().toISOString() }],
    quality: { reported: 4029, reconciled: 0, estimated: 0, unknown: 0, coveragePct: 100 },
    filters: { sources: [{ key: 'chat', label: '对话' }, { key: 'task', label: '需求执行' }], agents: ['pi'] },
  }
  const navigate = async (screen, condition, label) => {
    await win.loadURL(origin + '/?screen=' + screen)
    await waitFor(condition, label)
    await sleep(100)
  }
  const resetScroll = async () => {
    await js('window.scrollTo({top:0,left:0,behavior:"instant"})')
    await sleep(120)
  }
  const readOverview = () => js('(' + function () {
    const root = document.querySelector('.model-runtime')
    return {
      groups: [...root.querySelectorAll('.model-runtime-metrics > section')].map(e => ({ label: e.getAttribute('aria-label'), text: e.innerText })),
      catalog: [...root.querySelectorAll('.model-catalog-summary-card strong')].map(e => e.textContent.trim()),
      live: [...root.querySelectorAll('.model-runtime-live .model-load-card')].map(e => ({ value: e.querySelector('strong')?.textContent.trim(), text: e.innerText })),
      recent: [...root.querySelectorAll('.model-runtime-recent .model-runtime-stat')].map(e => ({ value: e.querySelector('strong')?.firstChild?.textContent.trim(), text: e.innerText })),
      progress: [...root.querySelectorAll('progress')].map(e => ({ value: e.value, max: e.max })),
      collapsed: root.querySelector('.model-runtime-services-body').hidden,
      control: root.querySelector('.model-runtime-services-head').getAttribute('aria-expanded'),
      statuses: [...document.querySelectorAll('.model-provider')].map(e => ({ name: e.querySelector('h3').textContent, status: e.querySelector('.model-state').textContent.trim() })),
    }
  }.toString() + ')()')
  const groupLabels = {
    'zh-CN': ['目录配置', '实时负载', '近一小时请求情况'],
    'en-US': ['Catalog configuration', 'Live load', 'Requests in the past hour'],
    'ja-JP': ['カタログの設定', '現在の負荷', '直近 1 時間のリクエスト'],
    'ko-KR': ['카탈로그 설정', '실시간 부하', '최근 1시간 요청 현황'],
  }
  const languageSnapshots = {}
  try {
    fixtures[keys[0]] = catalog; fixtures[keys[1]] = runtime; fixtures[keys[2]] = usage
    win.setSize(1280, 1000)
    await navigate('models', 'document.querySelectorAll(".model-runtime-live .model-load-card strong").length === 2 && document.querySelectorAll(".model-provider").length === 4', 'model overview fixture')
    for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
      await changeLocale(locale)
      const overview = await readOverview()
      record('catalog configuration excludes disabled and incomplete providers ' + locale,
        JSON.stringify(overview.catalog) === JSON.stringify(['4', '5', '1']), overview.catalog)
      record('live capacity and recent outcomes remain separate ' + locale,
        overview.groups.length === 3 && overview.groups.every(group => group.label) &&
        JSON.stringify(overview.live.map(item => item.value)) === JSON.stringify(['21', '1']) &&
        overview.live[0].text.includes('256') && overview.live[1].text.includes('128') &&
        /^152(?:\s*ms)?$/.test(overview.recent[0]?.value || '') &&
        JSON.stringify(overview.recent.slice(1).map(item => item.value)) === JSON.stringify(['17', '6', '3']), overview)
      record('provider cards distinguish configured missing credentials missing endpoint and disabled ' + locale,
        overview.statuses.length === 4 && new Set(overview.statuses.map(item => item.status)).size === 4 &&
        overview.statuses.some(item => item.name === 'Customer gateway 客户网关'), overview.statuses)
      record('runtime request details start collapsed ' + locale, overview.collapsed && overview.control === 'false', overview)
      languageSnapshots[locale] = overview.groups.map(group => group.label).join(' / ')
      record('model dimension labels match the selected language ' + locale, JSON.stringify(overview.groups.map(group => group.label)) === JSON.stringify(groupLabels[locale]), overview.groups)
      if (locale === 'zh-CN') {
        record('Chinese model groups explain their dimensions', JSON.stringify(overview.groups.map(group => group.label)) === JSON.stringify(['目录配置', '实时负载', '近一小时请求情况']), overview.groups)
        record('configured provider does not imply a live health probe', overview.statuses.find(item => item.name === 'Customer gateway 客户网关').status === '已配置' && overview.groups[0].text.includes('配置完整'), overview)
      }
      if (locale === 'en-US') record('model group labels have no untranslated Chinese', !/[\u3400-\u9fff]/.test(languageSnapshots[locale]), languageSnapshots[locale])
      if (locale === 'ja-JP') record('model group labels use Japanese', /[\u3040-\u30ff]/.test(languageSnapshots[locale]), languageSnapshots[locale])
      if (locale === 'ko-KR') record('model group labels use Korean', /[\uac00-\ud7af]/.test(languageSnapshots[locale]), languageSnapshots[locale])
      for (const width of [1920, 1280, 390]) {
        win.setSize(width, 1000); await sleep(140); await resetScroll()
        const layout = await js('(' + function () {
          const root = document.querySelector('.model-runtime')
          const groups = [...root.querySelectorAll('.model-runtime-metrics > section')].map(e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width } })
          return { width: innerWidth, page: document.documentElement.scrollWidth, groups, panel: root.getBoundingClientRect().width }
        }.toString() + ')()')
        const overlaps = layout.groups.some((a, i) => layout.groups.slice(i + 1).some(b =>
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1))
        record('model dimensions stay readable without overlap ' + locale + ' ' + width,
          layout.page <= width + 1 && layout.groups.length === 3 && !overlaps && layout.groups.every(group => group.left >= -1 && group.right <= width + 1 && group.width >= 220), layout)
        await screenshot('model-dimensions-' + locale + '-' + width)
      }
      await js('document.querySelector(".model-runtime-services-head").click()')
      await waitFor('document.querySelector(".model-runtime-services-head").getAttribute("aria-expanded") === "true"', 'request details expand')
      record('request details retain business identifiers ' + locale, await js('document.querySelector(".model-runtime-table").textContent.includes("Customer gateway 客户网关")'))
      await js('document.querySelector(".model-runtime-services-head").click()')
    }
    record('all four languages have distinct model dimension labels', new Set(Object.values(languageSnapshots)).size === 4, languageSnapshots)

    fixtures[keys[1]] = { ...runtime, running: 2, queued: 2, policy: { ...policy, globalConcurrent: 2, queueSize: 2 } }
    win.setSize(1280, 1000)
    await navigate('models', 'document.querySelector(".model-runtime-live .model-load-card strong")?.textContent === "2"', 'saturated capacity')
    await changeLocale('zh-CN')
    const saturated = await readOverview()
    record('full concurrent and waiting capacity has truthful bounded meters', saturated.progress.length === 2 && saturated.progress.every(item => item.value === 2 && item.max === 2), saturated)
    await resetScroll(); await screenshot('model-dimensions-full-capacity')
    fixtures[keys[1]] = { ...runtime, running: 0, queued: 0, policy: { ...policy, queueSize: 0 }, lastHour: { started: 0, waitMs: 0, timeout: 0, queueTimeout: 0, rateLimited: 0 }, groups: [] }
    await navigate('models', 'document.querySelector(".model-runtime-live .model-load-card strong")?.textContent === "0"', 'disabled queue and no requests')
    const empty = await readOverview()
    record('disabled waiting queue is explained and no samples are not zero wait', empty.live[1].text.includes('未启用排队') && empty.recent[0]?.value === '—' && empty.recent.slice(1).every(item => item.value === '0') && !JSON.stringify(empty).includes('NaN'), empty)
    await resetScroll(); await screenshot('model-dimensions-no-queue')

    for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
      await navigate('usage', 'document.querySelectorAll(".ugc-member-table tbody tr").length === 1 && !!document.querySelector(".ugc-plot svg")', 'populated usage fixture')
      await changeLocale(locale)
      const copy = await js('(' + function () {
        return { labels: [...document.querySelectorAll('.ugc-metric-head > span')].map(e => e.textContent),
          record: document.querySelector('.ugc-metric > p').textContent, share: document.querySelector('.ugc-member-table th:last-child').textContent,
          unit: document.querySelector('.ugc-metric-value > span').textContent, agent: document.querySelector('.ugc-filterbar > label:last-child > span').textContent,
          user: document.querySelector('.ugc-member b').textContent,
          lang: document.documentElement.lang, translation: document.documentElement.getAttribute('translate'),
          notranslate: document.documentElement.classList.contains('notranslate'), meta: document.querySelector('meta[name="google"]')?.content }
      }.toString() + ')()')
      record('usage keeps technical units and business names ' + locale, copy.unit === 'Tokens' && copy.agent === 'Agent' && copy.user === '客户成员', copy)
      record('app language remains active while browser translation is disabled ' + locale,
        copy.lang === locale && copy.translation === 'no' && copy.notranslate && copy.meta === 'notranslate', copy)
      if (locale === 'zh-CN') record('usage wording is correct in both screenshot locations', copy.record === '近 30 天 · 4,029 条用量记录' && copy.share === '用量占比' && copy.labels.includes('活跃成员') && !/用药|代币|积极分子/.test(JSON.stringify(copy)), copy)
      if (locale === 'en-US') record('English usage fixed copy has no Chinese fallback', !/[\u3400-\u9fff]/.test([copy.record, copy.share, ...copy.labels].join(' ')), copy)
      if (locale === 'ja-JP') record('Japanese usage fixed copy is localized', /[\u3040-\u30ff]/.test([copy.record, copy.share, ...copy.labels].join(' ')), copy)
      if (locale === 'ko-KR') record('Korean usage fixed copy is localized', /[\uac00-\ud7af]/.test([copy.record, copy.share, ...copy.labels].join(' ')), copy)
      await waitFor('!document.querySelector(".profile-menu")', 'language menu closed before chart navigation')
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      await waitFor('document.querySelector(".usage-governance")?.getAttribute("aria-busy") === "false" && document.querySelectorAll(".ugc-plot .ugc-bar").length === 30', 'usage trend data settled')
      const chartFocus = await js('(' + function () {
        const chart = document.querySelector('.ugc-plot svg')
        chart.scrollIntoView({ block: 'center' })
        chart.focus()
        return { focused: document.activeElement === chart, documentFocused: document.hasFocus(), bars: chart.querySelectorAll('.ugc-bar').length }
      }.toString() + ')()')
      record('usage trend is keyboard reachable ' + locale, chartFocus.focused && chartFocus.bars === 30, chartFocus)
      // A hidden Electron renderer can retain DOM focus without dispatching onFocus.
      // Exercise the actual keyboard contract to select the latest day explicitly.
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'END' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'END' })
      await waitFor('document.querySelector(".ugc-chart-tip")?.textContent.includes("141")', 'usage chart End key selects the latest day')
      const tooltip = await js('document.querySelector(".ugc-chart-tip").textContent')
      record('usage chart tooltip preserves record count and Tokens ' + locale, tooltip.includes('141') && tooltip.includes('Tokens') && !tooltip.includes('用药'), tooltip)
      if (locale === 'zh-CN') record('usage chart tooltip uses 用量记录', tooltip.includes('141 条用量记录'), tooltip)
      for (const width of [1920, 1280, 390]) {
        win.setSize(width, 1000); await sleep(140); await resetScroll()
        const layout = await js('(' + function () {
          const offenders = [...document.querySelectorAll('.usage-governance *')].filter(element => {
            const rect = element.getBoundingClientRect()
            if (!element.getClientRects().length || (rect.left >= -1 && rect.right <= innerWidth + 1)) return false
            for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
              if (['hidden', 'auto', 'scroll', 'clip'].includes(getComputedStyle(parent).overflowX)) return false
            }
            return true
          }).slice(0, 12).map(element => {
            const r = element.getBoundingClientRect(), style = getComputedStyle(element)
            return { tag: element.tagName, className: element.getAttribute('class'), text: element.textContent.slice(0, 100), left: r.left, right: r.right, minWidth: style.minWidth, whiteSpace: style.whiteSpace }
          })
          return { width: innerWidth, page: document.documentElement.scrollWidth, offenders }
        }.toString() + ')()')
        await screenshot('usage-copy-' + locale + '-' + width)
        record('usage copy fits viewport ' + locale + ' ' + width, layout.page <= width + 1, layout)
      }
    }
  } finally {
    for (const key of keys) fixtures[key] = previous[key]
    win.setSize(1280, 900)
    await changeLocale('en-US')
  }
}

module.exports = { checkCatalogUsage }
