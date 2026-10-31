const assert = require('node:assert/strict')

async function checkInsightsUsage({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, results }) {
  const usageKey = '/admin/usage/overview', insightsKey = '/admin/operations/insights'
  const previousUsage = fixtures[usageKey], previousInsights = fixtures[insightsKey]
  const record = (name, ok, evidence) => {
    results.push({ name, ok, evidence })
    assert.ok(ok, name + ': ' + JSON.stringify(evidence))
  }
  const fieldTypography = async selector => {
    await js(`document.querySelector(${JSON.stringify(selector + ' .select-menu-trigger')}).click()`)
    await waitFor(`!!document.querySelector(${JSON.stringify(selector + ' [role=option]')})`, 'dropdown typography')
    const typography = await js(`(() => {
      const field=document.querySelector(${JSON.stringify(selector)});
      const style=selector=>{const s=getComputedStyle(field.querySelector(selector));return Object.fromEntries(
        ['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','color','marginTop','marginBottom'].map(k=>[k,s[k]]))};
      return {label:style(':scope > span'),value:style('.select-menu-trigger > span'),
        selectedOption:style('[role=option][aria-selected=true]'),option:style('[role=option][aria-selected=false]')};
    })()`)
    await js(`document.querySelector(${JSON.stringify(selector + ' .select-menu-trigger')}).click()`)
    return typography
  }
  fixtures[usageKey] = {
    ...previousUsage,
    users: Array.from({ length: 12 }, (_, i) => ({ userId: 'user-' + i, label: 'Member ' + i, sessions: 10, tokens: 10000, costMicrousd: 20000 })),
    byAgent: Array.from({ length: 30 }, (_, i) => ({ key: 'model-' + i, agent: 'pi', model: 'Model ' + i, provider: 'Fixture Provider', tokens: 10000, costMicrousd: 20000 })),
  }
  fixtures[insightsKey] = { plugins: Array.from({ length: 30 }, (_, i) => ({
    pluginId: 'plugin-' + i, key: 'plugin-' + i, name: 'Plugin ' + (i + 1), enabled: true,
    category: i < 18 ? 'dev' : 'office', installs: 2, runs30d: i < 28 ? 30 - i : 0,
    conversationUses30d: 0, successRate: 100,
  })) }
  try {
    win.setSize(1920, 1080)
    await win.loadURL(origin + '/?screen=usage')
    await waitFor('document.querySelectorAll(".ugc-agent-list > button").length === 30', 'populated usage ledgers')
    await changeLocale('zh-CN')
    const referenceTypography = await fieldTypography('.ugc-filterbar > label:first-child')
    for (const size of [[1920,1080], [3840,1919], [1366,768], [1100,900], [390,844]]) {
      win.setSize(...size); await sleep(180)
      const geometry = await js(`(() => {
        const panel=document.querySelector('.ugc-agents'), list=panel.querySelector('.ugc-agent-list');
        const p=panel.getBoundingClientRect(), r=list.getBoundingClientRect(); list.scrollTop=100;
        return {gap:p.bottom-r.bottom,height:r.height,total:list.scrollHeight,scroll:list.scrollTop,
          panelHeight:p.height,viewport:[innerWidth,innerHeight],pageWidth:document.documentElement.scrollWidth};
      })()`)
      record('agent ledger fills its panel and scrolls at ' + size.join('×'), geometry.gap<=2 && geometry.height>150 &&
        geometry.scroll>0 && geometry.total>geometry.height && geometry.pageWidth<=geometry.viewport[0]+1 &&
        (size[0]>1100 || geometry.height<=geometry.viewport[1]*.6), geometry)
      await js(`document.querySelector('.ugc-agent-list').scrollTop=0;document.querySelector('.ugc-agents').scrollIntoView({block:'center'})`)
      await screenshot('usage-agent-ledger-' + size[0])
    }
    // A short member page must resize the adjacent ledger without overflowing it.
    win.setSize(1920,1080); await sleep(180)
    await js(`document.querySelector('.ugc-members .ugc-pager button:last-child').click()`)
    await waitFor('document.querySelectorAll(".ugc-member-table tbody tr").length === 4', 'short member page')
    const lastPage = await js(`(() => {const p=document.querySelector('.ugc-agents'),l=p.querySelector('.ugc-agent-list');return {gap:p.getBoundingClientRect().bottom-l.getBoundingClientRect().bottom,height:l.clientHeight,total:l.scrollHeight}})()`)
    record('agent ledger follows a shorter member page', lastPage.gap<=2 && lastPage.total>lastPage.height, lastPage)

    await win.loadURL(origin + '/?screen=insights')
    await waitFor('!!document.querySelector(".oi-plugins .list-pager")', 'plugin usage')
    await changeLocale('zh-CN')
    for (const selector of ['.oi-plugin-filter', '.oi-plugin-sort']) {
      const typography = await fieldTypography(selector)
      record('plugin dropdown text matches usage reference ' + selector,
        JSON.stringify(typography)===JSON.stringify(referenceTypography), { referenceTypography, typography })
    }
    const choose = async label => {
      await js(`document.querySelector('.oi-plugin-filter .select-menu-trigger').click()`)
      await waitFor('!!document.querySelector(".oi-plugin-filter [role=option]")', 'plugin filter options')
      await js(`[...document.querySelectorAll('.oi-plugin-filter [role=option]')].find(e=>e.textContent.startsWith(${JSON.stringify(label)})).click()`)
    }
    record('plugin tabs replaced with one dropdown', await js('!!document.querySelector(".oi-plugin-filter .select-menu-trigger") && !document.querySelector(".oi-filters")'))
    await js(`document.querySelector('.oi-plugins .list-pager button:last-child').click()`)
    await choose('研发与交付')
    await waitFor('document.querySelector(".oi-plugins .list-pager").innerText.includes("1 / 2")', 'category returns to first page')
    record('category immediately filters plugin rows', await js(`[...document.querySelectorAll('.oi-plugins tbody .cat')].every(e=>e.textContent==='研发与交付')`))
    await choose('已安装未使用')
    await waitFor('document.querySelectorAll(".oi-plugins tbody tr").length === 2', 'unused plugins')
    record('unused filter replaces category condition', await js(`[...document.querySelectorAll('.oi-plugins tbody .cat')].every(e=>e.textContent==='办公文稿')`))
    await choose('办公文稿')
    await waitFor('document.querySelectorAll(".oi-plugins tbody tr").length === 12', 'category clears unused condition')
    await js(`document.querySelector('.oi-plugin-filter .filter-clear').click()`)
    await waitFor('document.querySelector(".oi-plugins .list-pager").innerText.includes("1 / 3")', 'clear restores all plugins')
    record('plugin dropdown clear restores all categories', await js('!document.querySelector(".oi-plugin-filter .has-clear")'))
    for (const size of [[1920,1080], [1280,720], [390,844]]) {
      win.setSize(...size); await sleep(180)
      await js(`document.querySelector('.oi-plugin-filter').scrollIntoView({block:'center'});document.querySelector('.oi-plugin-filter .select-menu-trigger').click()`)
      const menu = await js(`(() => {const e=document.querySelector('.oi-plugin-filter .select-menu-popover'),r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,options:e.querySelectorAll('[role=option]').length,controlTops:[...document.querySelector('.oi-plugin-tools').children].map(e=>e.getBoundingClientRect().top)}})()`)
      record('plugin filter dropdown fits viewport at ' + size[0], menu.options===4 && menu.left>=0 && menu.right<=menu.width && menu.top>=0 && menu.bottom<=menu.height, menu)
      if (size[0]>=1280) record('plugin search and dropdowns align at ' + size[0], Math.max(...menu.controlTops)-Math.min(...menu.controlTops)<=1, menu.controlTops)
      await screenshot('plugin-filter-dropdown-' + size[0])
      await js(`document.querySelector('.oi-plugin-filter .select-menu-trigger').click()`)
    }
    await changeLocale('en-US')
  } finally {
    fixtures[usageKey] = previousUsage
    fixtures[insightsKey] = previousInsights
  }
}

async function checkInsightsMetricDefinitions({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, results }) {
  const key = '/admin/operations/insights', previous = fixtures[key]
  const record = (name, ok, evidence) => {
    results.push({ name, ok: Boolean(ok), evidence })
    assert.ok(ok, name + ': ' + JSON.stringify(evidence))
  }
  // Deliberately disagree with the rolling counter: 98 calendar-day sessions vs 102 rolling sessions.
  const trend = Array.from({ length: 30 }, (_, index) => ({
    date: '2026-10-' + String(index + 1).padStart(2, '0'),
    aiSessions: index === 29 ? 11 : 3, tasksCreated: 2, tasksDone: 0, activeClients: 1,
    automationRuns: 0, automationFailed: 0, automationCompleted: 0, automationSucceeded: 0, automationRunning: 0,
  }))
  const plugin = (id, fields) => ({ pluginId: id, key: id, name: id, enabled: true, category: 'dev', installs: 1,
    runs30d: 0, conversationUses30d: 0, succeeded30d: 0, failed30d: 0, successRate: null, ...fields })
  const fixture = {
    trend, output: { aiSessions30d: 102, tasksCreated30d: 60, tasksDone30d: 0, deployments30d: 0 },
    adoption: { activeClients7d: 1, activeClientsPrev7d: 1, activeClients30d: 1, clientsTotal: 1 },
    plugins: [plugin('Conversation-only plugin', { conversationUses30d: 176 }),
      plugin('Failed workflow plugin', { runs30d: 2, failed30d: 2, successRate: 0 }), plugin('Unused plugin', {})],
  }
  const expectedCopy = {
    'zh-CN': { calendar: '自然日', today: '含今天', noTrend: '暂无趋势数据',
      header: '仅统计已结束的流程运行，不包含对话调用。',
      empty: '暂无已结束的流程运行；成功率仅统计流程运行，不包含对话调用。' },
    'en-US': { calendar: 'calendar days', today: 'including today', noTrend: 'No trend data yet',
      header: 'Only finished workflow runs are counted; conversation calls are excluded.',
      empty: 'No finished workflow runs yet. Success rate covers workflow runs only, excluding conversation calls.' },
    'ja-JP': { calendar: '暦日', today: '本日を含む', noTrend: '推移データはまだありません',
      header: '終了したワークフローの実行のみを集計し、会話からの呼び出しは含めません。',
      empty: '終了したワークフローの実行はまだありません。成功率はワークフローの実行のみを対象とし、会話からの呼び出しは含めません。' },
    'ko-KR': { calendar: '달력 기준', today: '오늘 포함', noTrend: '아직 추이 데이터가 없습니다',
      header: '종료된 워크플로 실행만 집계하며 대화 호출은 포함하지 않습니다.',
      empty: '아직 종료된 워크플로 실행이 없습니다. 성공률은 워크플로 실행만 집계하며 대화 호출은 포함하지 않습니다.' },
  }
  const snapshots = {}
  const navigate = async () => {
    await win.loadURL(origin + '/?screen=insights')
    await waitFor('document.querySelectorAll(".oi-plugins tbody tr").length === 3 && document.querySelectorAll(".oi-stat").length === 4', 'insights metric fixtures')
    await sleep(120)
  }
  const readMetrics = async () => js('(' + function () {
    const card = document.querySelectorAll('.oi-stat')[2]
    const values = [...document.querySelectorAll('.oi-trend-summary > span:last-child b')]
    const sub = card.querySelector('.oi-stat-sub')
    const chart = document.querySelector('.oi-usage')
    return {
      total: card.querySelector('.oi-stat-line b').textContent.trim(), sub: sub.textContent.trim(),
      subTitle: sub.title, subTabIndex: sub.tabIndex, subDescription: sub.getAttribute('aria-label'),
      average: values[0]?.textContent.trim(), peak: values[1]?.textContent.trim(), scope: chart.querySelector('.oi-panel-header').textContent,
      empty: Boolean(chart.querySelector('.oi-chart-empty')), plot: Boolean(chart.querySelector('.oi-trend-plot')),
      text: card.textContent + ' ' + chart.textContent,
    }
  }.toString() + ')()')
  const readRates = async () => js('(' + function () {
    const describe = cell => {
      const target = cell.hasAttribute('title') ? cell : cell.querySelector('[title]')
      const focus = target?.tabIndex >= 0 ? target : cell.tabIndex >= 0 ? cell : cell.querySelector('[tabindex="0"]')
      const references = (focus?.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
        .map(id => document.getElementById(id)?.textContent || '').join(' ')
      return { text: cell.textContent.trim(), title: target?.title || '', tabIndex: focus?.tabIndex ?? -1,
        description: focus?.getAttribute('aria-label') || references || '', focusable: Boolean(focus) }
    }
    return {
      header: describe(document.querySelector('.oi-table th:nth-child(6)')),
      rows: [...document.querySelectorAll('.oi-table tbody tr')].map(row => ({
        name: row.querySelector('.oi-plugin-name b').textContent, rate: describe(row.querySelector('td:nth-child(6)')),
        conversations: row.querySelector('td:nth-child(5)').textContent.trim(), runs: row.querySelector('td:nth-child(4)').textContent.trim(),
      })),
    }
  }.toString() + ')()')
  try {
    fixtures[key] = fixture
    win.setSize(1280, 1000)
    await navigate()
    for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
      await changeLocale(locale)
      const expected = expectedCopy[locale]
      const metrics = await readMetrics()
      record('insights calendar totals and daily average agree ' + locale,
        metrics.total === '98' && /3[.,]3/.test(metrics.sub) && /^3[.,]3$/.test(metrics.average) && metrics.plot,
        metrics)
      record('insights calendar window identifies timezone and includes today ' + locale,
        metrics.scope.includes('UTC+8') && metrics.scope.includes(expected.calendar) && metrics.scope.includes(expected.today), metrics.scope)
      record('insights average explains actual dates and denominator ' + locale,
        metrics.subTitle.includes('2026-10-01') && metrics.subTitle.includes('2026-10-30') && metrics.subTitle.includes('30') &&
        metrics.subTitle.includes(expected.calendar) && metrics.subTitle.includes(expected.today) && metrics.subTabIndex === 0 &&
        metrics.subDescription.includes(metrics.subTitle), metrics)
      const rates = await readRates()
      const conversation = rates.rows.find(row => row.name === 'Conversation-only plugin')
      const failed = rates.rows.find(row => row.name === 'Failed workflow plugin')
      const unused = rates.rows.find(row => row.name === 'Unused plugin')
      record('conversation use has no invented workflow success rate ' + locale,
        conversation.conversations === '176' && conversation.runs === '0' && conversation.rate.text === '—' && unused.rate.text === '—', rates)
      record('failed workflows retain a real zero-percent rate ' + locale, failed.rate.text === '0%', failed)
      record('workflow success definitions match all localized copy ' + locale,
        rates.header.title === expected.header && rates.header.description.includes(expected.header) &&
        [conversation.rate, unused.rate].every(item => item.title === expected.empty && item.description === expected.empty), rates)
      const explanations = [rates.header, conversation.rate, unused.rate]
      record('workflow success rate has hover and keyboard explanations ' + locale,
        explanations.every(item => item.title.trim().length > 10 && item.tabIndex === 0 && item.focusable && item.description.trim().length > 10), rates)
      if (locale === 'en-US') record('insights definitions have no untranslated Chinese in English',
        !/[\u3400-\u9fff]/u.test([metrics.sub, metrics.scope, ...explanations.flatMap(item => [item.title, item.description])].join(' ')),
        { metrics, explanations })
      snapshots[locale] = { scope: metrics.scope, header: rates.header.title, empty: conversation.rate.title }
      for (const width of [1280, 1920, 390]) {
        win.setSize(width, 1000)
        await sleep(180)
        // The document owns page scrolling; aligning the cards to y=0 puts them under the sticky topbar.
        await js('window.scrollTo({top:0,left:0,behavior:"instant"})')
        await waitFor('(document.scrollingElement?.scrollTop || 0) === 0', 'calendar screenshot page top')
        await sleep(120)
        const layout = await js('(' + function () {
          const metrics = document.querySelector('.oi-metrics'), wrap = document.querySelector('.oi-table-wrap')
          return { width: innerWidth, page: document.documentElement.scrollWidth, metrics: metrics.scrollWidth,
            metricsWidth: metrics.clientWidth, table: wrap.scrollWidth, tableViewport: wrap.clientWidth }
        }.toString() + ')()')
        record('insights metric definitions fit viewport ' + locale + ' ' + width,
          layout.page <= layout.width + 1 && layout.metrics <= layout.metricsWidth + 1, layout)
        await screenshot('insights-calendar-' + locale + '-' + width)
        const focused = await js('(' + function () {
          const row = [...document.querySelectorAll('.oi-table tbody tr')].find(row => row.querySelector('.oi-plugin-name b').textContent === 'Conversation-only plugin')
          const cell = row.querySelector('td:nth-child(6)')
          const target = cell.tabIndex >= 0 ? cell : cell.querySelector('[tabindex="0"]')
          target?.focus()
          target?.scrollIntoView({ block: 'center', inline: 'nearest' })
          const r = target?.getBoundingClientRect()
          return { focused: Boolean(target && document.activeElement === target), title: target?.title || cell.title,
            left: r?.left, right: r?.right, width: innerWidth }
        }.toString() + ')()')
        record('null workflow rate is keyboard reachable ' + locale + ' ' + width,
          focused.focused && focused.title.length > 10 && focused.left >= -1 && focused.right <= focused.width + 1, focused)
        await screenshot('insights-plugin-rate-' + locale + '-' + width)
      }
      // A populated zero window is measured inactivity, while absent trend data is unknown.
      fixtures[key] = { ...fixture, trend: trend.map(day => ({ ...day, aiSessions: 0 })) }
      await navigate()
      const zero = await readMetrics()
      record('insights zero calendar window is a measured zero ' + locale,
        zero.total === '0' && /(^|\D)0(\D|$)/.test(zero.sub) && zero.average === '0' && zero.plot && !/NaN|Infinity/.test(zero.text), zero)
      fixtures[key] = { ...fixture, trend: [] }
      await navigate()
      const empty = await readMetrics()
      record('insights absent trend does not reuse rolling total or invent zero ' + locale,
        empty.total === '—' && empty.sub === expected.noTrend && empty.average === '—' && empty.peak === '—' &&
        empty.empty && !empty.plot && !/NaN|Infinity/.test(empty.text), empty)
      await js('window.scrollTo({top:0,left:0,behavior:"instant"})')
      await waitFor('(document.scrollingElement?.scrollTop || 0) === 0', 'empty calendar screenshot page top')
      await sleep(120)
      await screenshot('insights-calendar-empty-' + locale)
      fixtures[key] = fixture
      await navigate()
    }
    for (const field of ['scope', 'header', 'empty']) record('insights ' + field + ' is translated in all four languages',
      new Set(Object.values(snapshots).map(value => value[field])).size === 4, snapshots)
    // Use an independent populated page so pagination and fixed copy are checked without changing the metric fixtures above.
    const localizedPageCopy = {
      'ja-JP': {
        unit: '件', chart: '利用状況の推移', tabs: ['AI 会話', '新規課題', 'アクティブなデバイス'],
        tabUnits: ['件', '件', '台'], plugins: 'プラグインの利用状況',
        headers: ['プラグイン', 'カテゴリ', 'インストール数', 'ワークフロー実行（30日間）', '会話からの呼び出し', '成功率', '最終利用'],
        pager: ['1 / 2 ページ · 全 13 件', '2 / 2 ページ · 全 13 件'],
        previous: '前のページ', next: '次のページ', pagerLabel: 'プラグイン利用状況のページ切り替え',
      },
      'ko-KR': {
        unit: '회', chart: '사용 추이', tabs: ['AI 대화', '새 요청', '활성 기기'],
        tabUnits: ['회', '건', '대'], plugins: '플러그인 사용',
        headers: ['플러그인', '분류', '설치 수', '워크플로 실행(30일)', '대화 호출', '성공률', '최근 사용'],
        pager: ['1 / 2페이지 · 총 13개', '2 / 2페이지 · 총 13개'],
        previous: '이전 페이지', next: '다음 페이지', pagerLabel: '플러그인 사용 페이지 이동',
      },
    }
    const businessPlugins = Array.from({ length: 13 }, (_, index) => plugin('External plugin ' + String(index + 1).padStart(2, '0'), {
      runs30d: 13 - index, succeeded30d: 13 - index, successRate: 100,
    }))
    fixtures[key] = { ...fixture, plugins: businessPlugins }
    win.setSize(1280, 1000)
    for (const [locale, expected] of Object.entries(localizedPageCopy)) {
      await win.loadURL(origin + '/?screen=insights')
      await waitFor('document.querySelectorAll(".oi-plugins tbody tr").length === 12 && !!document.querySelector(".oi-plugins .list-pager")', 'localized plugin pagination fixtures')
      await changeLocale(locale)
      const copy = await js('(' + function () {
        const pager = document.querySelector('.oi-plugins .list-pager')
        return {
          unit: document.querySelector('.oi-stat:nth-child(3) .oi-stat-unit').textContent.trim(),
          chart: document.querySelector('.oi-usage h3').textContent.trim(),
          tabs: [...document.querySelectorAll('.oi-trend-tabs button')].map(button => button.textContent.trim()),
          plugins: document.querySelector('.oi-plugins h3').textContent.trim(),
          headers: [...document.querySelectorAll('.oi-plugins th')].map(cell => cell.textContent.trim()),
          businessNames: [...document.querySelectorAll('.oi-plugin-name b')].map(name => name.textContent),
          pager: pager.querySelector(':scope > span').textContent.trim(), label: pager.getAttribute('aria-label'),
          buttons: [...pager.querySelectorAll('button')].map(button => button.getAttribute('aria-label')),
        }
      }.toString() + ')()')
      record('insights AI unit chart title and tabs use selected language ' + locale,
        copy.unit === expected.unit && copy.chart === expected.chart && JSON.stringify(copy.tabs) === JSON.stringify(expected.tabs), copy)
      record('insights plugin title and all column headings use selected language ' + locale,
        copy.plugins === expected.plugins && JSON.stringify(copy.headers) === JSON.stringify(expected.headers), copy)
      record('insights business plugin names remain verbatim ' + locale,
        JSON.stringify(copy.businessNames) === JSON.stringify(businessPlugins.slice(0, 12).map(item => item.name)), copy.businessNames)
      record('insights pagination labels use selected language ' + locale,
        copy.pager === expected.pager[0] && copy.label === expected.pagerLabel &&
        JSON.stringify(copy.buttons) === JSON.stringify([expected.previous, expected.next]), copy)
      for (let index = 0; index < expected.tabs.length; index++) {
        await js('document.querySelectorAll(".oi-trend-tabs button")[' + index + '].click()')
        const metric = await js('(' + function () {
          const selected = document.querySelector('.oi-trend-tabs button[aria-pressed="true"]')
          return { tab: selected.textContent.trim(), unit: document.querySelector('.oi-trend-summary > span:first-child small').textContent.trim() }
        }.toString() + ')()')
        record('insights chart unit follows localized metric ' + locale + ' ' + index,
          metric.tab === expected.tabs[index] && metric.unit.endsWith(expected.tabUnits[index]) && !/sessions|items|devices/i.test(metric.unit), metric)
      }
      await js('document.querySelectorAll(".oi-trend-tabs button")[0].click()')
      await js('document.querySelector(".oi-plugins .list-pager button:last-child").click()')
      await waitFor('document.querySelectorAll(".oi-plugins tbody tr").length === 1', 'localized second plugin page')
      const pageTwo = await js('(' + function () {
        const pager = document.querySelector('.oi-plugins .list-pager')
        return { text: pager.querySelector(':scope > span').textContent.trim(), name: document.querySelector('.oi-plugin-name b').textContent,
          previousEnabled: !pager.querySelector('button:first-child').disabled, nextDisabled: pager.querySelector('button:last-child').disabled }
      }.toString() + ')()')
      record('insights translated pagination keeps working and preserves business names ' + locale,
        pageTwo.text === expected.pager[1] && pageTwo.name === businessPlugins[12].name && pageTwo.previousEnabled && pageTwo.nextDisabled, pageTwo)
      await js('document.querySelector(".oi-plugins .list-pager").scrollIntoView({block:"center"})')
      await sleep(120)
      await screenshot('insights-localized-pagination-' + locale)
    }
  } finally {
    fixtures[key] = previous
    win.setSize(1280, 900)
    await changeLocale('en-US')
    await win.loadURL(origin + '/?screen=insights')
    await waitFor('!!document.querySelector(".oi-page:not(.oi-skeleton)")', 'restore insights fixtures')
  }
}

module.exports = { checkInsightsUsage, checkInsightsMetricDefinitions }
