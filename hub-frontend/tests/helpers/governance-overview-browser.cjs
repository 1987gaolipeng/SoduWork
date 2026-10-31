// Real-renderer acceptance for governance copy, source labels, health details,
// and locale persistence. The parent server rejects writes and external traffic.
const EXPECTED = {
  'zh-CN': { title: '治理总览', sources: ['本地新建', '平台下发', '定时派活', '云端对话', '对话接力'], enabled: '已启用', disabled: '已停用' },
  'en-US': { title: 'Governance overview', sources: ['Created locally', 'Assigned by platform', 'Scheduled assignment', 'Cloud conversation', 'Conversation handoff'], enabled: 'Enabled', disabled: 'Disabled' },
  'ja-JP': { title: 'ガバナンス概要', sources: ['ローカルで作成', 'プラットフォームから割り当て', '定期割り当て', 'クラウドの会話', '会話の引き継ぎ'], enabled: '有効', disabled: '無効' },
  'ko-KR': { title: '거버넌스 개요', sources: ['로컬에서 생성', '플랫폼에서 할당', '예약 할당', '클라우드 대화', '대화 인계'], enabled: '활성화', disabled: '비활성화' },
}
async function checkGovernanceOverview({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, requests, results }) {
  const record = (name, ok, evidence) => results.push({ name, ok: Boolean(ok), evidence })
  const businessName = '甲方研发部门'
  const sourceName = '客户自定义业务来源名称必须原样保留-' + 'Long external source '.repeat(8).trim()
  const integrationNames = ['客户工单来源', '历史接入来源', '已暂停的客户来源']
  const task = (id, fields) => ({ id, title: id, status: 'todo', triageStage: 'ready', ...fields })
  const replacement = {
    '/admin/tasks': [
      task('gov-local', { origin: 'local', status: 'done' }),
      task('gov-dispatch', { origin: 'dispatch' }),
      task('gov-automation', { origin: 'automation', source: '定时派活' }),
      task('gov-cloud', { origin: 'cloud-conversation', ai: { state: 'failed' } }),
      task('gov-handoff', { origin: 'conversation-handoff', due: 1 }),
      task('gov-external', { origin: 'ticket', source: sourceName }),
    ],
    '/admin/orgs': [{ id: 'gov-org', name: businessName }],
    '/admin/users': [{ id: 'gov-user', displayName: '业务用户姓名', orgId: 'gov-org' }],
    '/admin/integrations': [
      { id: 'gov-enabled-empty', name: integrationNames[0], type: 'generic', enabled: true, taskCount: 0 },
      { id: 'gov-enabled-records', name: integrationNames[1], type: 'ticket', enabled: true, taskCount: 7, lastIngestAt: 1 },
      { id: 'gov-disabled', name: integrationNames[2], type: 'generic', enabled: false, taskCount: 0 },
    ],
    '/admin/unassigned': [],
    '/admin/delivery/board': { counts: { attention: 1 } },
  }
  const prior = new Map(Object.keys(replacement).map(key => [key, { exists: Object.hasOwn(fixtures, key), value: fixtures[key] }]))
  Object.assign(fixtures, replacement)
  const requestStart = requests.length
  const navigate = async () => {
    await win.loadURL(origin + '/?screen=overview')
    await waitFor('document.querySelectorAll(".gov-source-list article").length === 6', 'governance fixture sources')
    await waitFor('document.querySelector(".env summary")?.innerText.includes("v1.0.5")', 'governance service version')
    await sleep(120)
  }
  try {
    win.setSize(1280, 900)
    await navigate()
    for (const [locale, expected] of Object.entries(EXPECTED)) {
      await changeLocale(locale)
      await waitFor('document.querySelector(".page-title h1")?.textContent === ' + JSON.stringify(expected.title), 'governance heading ' + locale)
      const beforeReload = await js('document.querySelector(".gov-page").innerText')
      const translated = await js('(' + function () {
        const labels = [...document.querySelectorAll('.gov-source-label')]
        return {
          locale: document.documentElement.lang, saved: localStorage.getItem('soduwork.locale'),
          attention: [...document.querySelectorAll('.gov-attention-row')].map(row => ({ label: row.querySelector('b').textContent, count: row.querySelector('strong').textContent })),
          risk: document.querySelectorAll('.gov-metric > b')[2].textContent,
          attentionTotal: document.querySelector('.gov-attention > header > small').textContent,
          attentionActions: document.querySelectorAll('.gov-attention-row button').length,
          sources: labels.map(el => el.textContent),
          business: [...document.querySelectorAll('.gov-dept-name b')].map(el => el.textContent),
          integrations: [...document.querySelectorAll('.gov-integration-list article')].map(row => ({
            name: row.querySelector('b').textContent,
            state: row.querySelector('span').textContent,
            count: row.querySelector('strong').textContent,
          })),
          labels: [...document.querySelectorAll('.gov-page h3,.gov-metric>span,.gov-metric>small,.gov-dept-head>span,.gov-attention-row b,.gov-attention-row small,.gov-network-ledger span')].map(el => el.textContent),
        }
      }.toString() + ')()')
      record('governance attention contains only requirement risks ' + locale,
        translated.attention.length === 2 && translated.attention.every(row => row.count === '1') &&
        translated.risk === '2' && translated.attentionTotal.replace(/[^0-9]/g, '') === '2' && translated.attentionActions === 0,
        { rows: translated.attention, risk: translated.risk, total: translated.attentionTotal, actions: translated.attentionActions })
      record('governance does not request delivery board ' + locale,
        !requests.slice(requestStart).some(request => request.path === '/api/v1/admin/delivery/board'),
        requests.slice(requestStart).map(request => request.path))
      record('governance exact source translations ' + locale, expected.sources.every(label => translated.sources.includes(label)), translated.sources)
      record('governance preserves business text ' + locale, translated.sources.includes(sourceName) && translated.business.includes(businessName) &&
        translated.integrations.every((row, index) => row.name === integrationNames[index]), { sources: translated.sources, business: translated.business })
      record('enabled does not imply live intake ' + locale,
        translated.integrations[0].state === expected.enabled && translated.integrations[0].count.replace(/[^0-9]/g, '') === '0' &&
        translated.integrations[1].state === expected.enabled && translated.integrations[1].count.replace(/[^0-9]/g, '') === '7' &&
        translated.integrations[2].state === expected.disabled, translated.integrations)
      record('locale preference is stored ' + locale, translated.locale === locale && translated.saved === locale, { locale: translated.locale, saved: translated.saved })
      if (locale === 'en-US') record('governance English UI has no untranslated Chinese', !translated.labels.some(label => /[\u3400-\u9fff]/u.test(label)), translated.labels)
      await navigate()
      record('governance locale survives reload ' + locale,
        await js('document.documentElement.lang === ' + JSON.stringify(locale) + ' && document.querySelector(".page-title h1").textContent === ' + JSON.stringify(expected.title) +
          ' && document.querySelector(".gov-page").innerText === ' + JSON.stringify(beforeReload)))

      for (const width of [1280, 1920, 390]) {
        win.setSize(width, 1000)
        await sleep(180)
        const geometry = await js('(' + function (sourceName) {
          const label = [...document.querySelectorAll('.gov-source-label')].find(el => el.textContent === sourceName)
          const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height } }
          const sourceStyle = getComputedStyle(label)
          const summary = document.querySelector('.env summary')
          const visibleHealth = Boolean(summary.getClientRects().length)
          const healthLines = visibleHealth ? [...summary.querySelectorAll('b,small')].map(el => ({
            text: el.textContent, scroll: el.scrollWidth, client: el.clientWidth,
          })) : []
          return {
            width: innerWidth, documentWidth: document.documentElement.scrollWidth,
            source: { title: label.title, tabIndex: label.tabIndex, ellipsis: sourceStyle.textOverflow, overflow: sourceStyle.overflowX,
              nowrap: sourceStyle.whiteSpace, client: label.clientWidth, scroll: label.scrollWidth, rect: rect(label) },
            visibleHealth, healthText: summary.innerText, healthLines,
            counts: [...document.querySelectorAll('.gov-integration-list strong')].map(el => ({ whiteSpace: getComputedStyle(el).whiteSpace, rect: rect(el) })),
          }
        }.toString() + ')(' + JSON.stringify(sourceName) + ')')
        record('governance no page overflow ' + locale + ' ' + width, geometry.documentWidth <= geometry.width + 1, geometry)
        record('long source keeps full tooltip and ellipsis ' + locale + ' ' + width,
          geometry.source.title === sourceName && geometry.source.tabIndex === 0 &&
          geometry.source.ellipsis === 'ellipsis' && geometry.source.nowrap === 'nowrap' &&
          geometry.source.scroll > geometry.source.client, geometry.source)
        await js('(' + function (sourceName) {
          [...document.querySelectorAll('.gov-source-label')].find(el => el.textContent === sourceName).focus()
        }.toString() + ')(' + JSON.stringify(sourceName) + ')')
        record('long source is keyboard reachable ' + locale + ' ' + width,
          await js('document.activeElement.matches(".gov-source-label") && document.activeElement.title === ' + JSON.stringify(sourceName)))
        record('integration counts remain on one line ' + locale + ' ' + width,
          geometry.counts.every(count => count.whiteSpace === 'nowrap' && count.rect.right <= geometry.width + 1), geometry.counts)
        if (geometry.visibleHealth) {
          record('service status omits build and fits ' + locale + ' ' + width,
            geometry.healthText.includes('v1.0.5') && !geometry.healthText.includes('12345678') &&
            geometry.healthLines.every(line => line.scroll <= line.client + 1), geometry.healthLines)
          await js('document.querySelector(".env summary").click()')
          await waitFor('document.querySelector(".env").open', 'expand health details')
          const details = await js('(' + function () {
            const el = document.querySelector('.env-details'), r = el.getBoundingClientRect()
            return { text: el.innerText, left: r.left, right: r.right, width: innerWidth }
          }.toString() + ')()')
          record('full build remains available in expanded details ' + locale + ' ' + width,
            details.text.includes('v1.0.5') && details.text.includes('1234567890abcdef1234567890abcdef12345678') &&
            details.left >= -1 && details.right <= details.width + 1, details)
          if (width === 1280) await screenshot('governance-health-' + locale)
          await js('document.querySelector(".env summary").click()')
        }
        await js('window.scrollTo(0, 0)')
        await screenshot('governance-' + locale + '-' + width)
      }
      win.setSize(1280, 900)
      await sleep(120)
    }
  } finally {
    for (const [key, old] of prior) {
      if (old.exists) fixtures[key] = old.value
      else delete fixtures[key]
    }
    win.setSize(1280, 900)
    await changeLocale('en-US')
    await win.loadURL(origin + '/?screen=overview')
    await waitFor('!!document.querySelector(".gov-page")', 'restore governance fixtures')
  }
}
module.exports = { checkGovernanceOverview }
