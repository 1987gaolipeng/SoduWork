const { checkDepartmentSelect } = require('./helpers/department-select-browser.cjs')
// Isolated real-renderer checks. Every API response is local test data and
// external requests are blocked. No live accounts or production data are used.
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const { checkAdminLayout } = require('./helpers/admin-layout-browser.cjs')
const { checkOrgTreeSearch } = require('./helpers/org-tree-search-browser.cjs')
const { checkInsightsUsage, checkInsightsMetricDefinitions } = require('./helpers/insights-usage-browser.cjs')
const { checkGovernanceOverview } = require('./helpers/governance-overview-browser.cjs')
const { checkCatalogUsage } = require('./helpers/catalog-usage-browser.cjs')
const { checkCapabilityCatalog } = require('./helpers/capability-catalog-browser.cjs')
const root = path.resolve(__dirname, '..')
const output = process.env.SODUWORK_ADMIN_TEST_OUTPUT ? path.resolve(process.env.SODUWORK_ADMIN_TEST_OUTPUT) : path.resolve(root, '../outputs/i18n-2026-09-29/admin')
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, 'profile'))
app.disableHardwareAcceleration()
const user = { id: 'fixture-user', username: 'fixture-user', displayName: '新建项目', orgId: 'fixture-org', isSuper: true, permissions: [] }
const projects = [{ id: 'fixture-project', name: '保存', group: '新建项目', desc: '客户业务原文', ownerName: '新建项目', tasks: [], total: 0, done: 0 }]
projects.push(...Array.from({ length: 120 }, (_, i) => ({ ...projects[0], id: 'project-' + i, name: 'Project ' + (i + 1), group: 'Group ' + (i % 4 + 1) })))
const devices = Array.from({ length: 61 }, (_, i) => ({ id: 'device-' + i, name: 'Device ' + (i + 1), ownerName: 'Fixture user', authState: i >= 55 ? 'pending' : 'active', online: i < 50, platform: i % 3 === 2 ? 'android' : 'win32', version: '1.0', lastSeen: Date.now() }))
// System catalogs (permissions, role profiles, responsibility domains) parse straight out of the
// backend source so the admin screens render the real catalog in every locale run.
const backendSource = rel => require('node:fs').readFileSync(path.resolve(root, '../hub-backend', rel), 'utf8')
const permissionCatalog = [...backendSource('app/permissions.py').matchAll(/"key": "([^"]+)", "label": "([^"]+)", "group": "([^"]+)"/g)].map(m => ({ key: m[1], label: m[2], group: m[3] }))
const profileSource = backendSource('app/services/work_catalog.py')
const profileBlock = profileSource.slice(profileSource.indexOf('PROFILE_DEFINITIONS = ['), profileSource.indexOf('SCENARIO_DEFINITIONS = ['))
const professions = [...profileBlock.matchAll(/"id": "([^"]+)", "name": "([^"]+)", "category": "([^"]+)"/g)].map((m, i) => ({ id: m[1], name: m[2], category: m[3], sort: i + 1 }))
const domainSource = backendSource('app/services/rbac.py')
const domainBlock = domainSource.slice(domainSource.indexOf('SEED_DOMAINS = ['), domainSource.indexOf('async def seed_domains'))
const domains = [...domainBlock.matchAll(/\("([^"]+)", \d+\)/g)].map((m, i) => ({ id: 'dom-' + (i + 1), name: m[1] }))
// The operations screen renders Hub-composed zh-CN copy verbatim; parse the real strings so
// backend rewording surfaces here instead of leaking Chinese through an English fixture.
const operationsPy = backendSource('app/services/operations.py')
const backendString = (pattern) => {
  const match = operationsPy.match(pattern)
  assert.ok(match, 'operations.py drifted; update the i18n fixture: ' + pattern)
  return match[1]
}
const opsModeLabel = backendString(/"modeLabel": "([^"]+)" if bus\.enabled/)
const opsClusterNote = backendString(/"clusterNote": "([^"]+)" if bus\.enabled/)
const opsFailedSuffix = backendString(/"title": f"\{workflow\['failed'\]\} (.+)"/)
const opsFailedDetail = backendString(/"detail": "(进入[^"]+)"/)
const opsRunnerTitle = backendString(/"title": "(没有可接活的 Runner)"/)
const opsRunnerDetail = backendString(/"detail": "(请检查[^"]+)"/)
const fixtures = {
  '/admin/client-releases': { releases: Array.from({ length: 6 }, (_, i) => ({
    id: 'notes-' + i, version: '2.0.0', channel: 'stable', platform: 'linux', arch: 'x64',
    artifactName: 'SoduWork-2.0.0-fixture-' + i, enabled: true,
    notes: 'Release notes\n• Keep current work.\n<img src=x onerror=alert(1)>',
  })) },
  '/admin/client-updates/attempts': { attempts: [], counts: {} },
  '/healthz': { ok: true, version: '1.0.5', commit: '1234567890abcdef1234567890abcdef12345678', releaseTag: 'hub-v1.0.5' },
  '/admin/me': user,
  '/admin/projects': projects,
  '/admin/orgs': [{ id: 'fixture-org', name: 'Fixture organization', parentId: null }],
  '/admin/project-owner-options': [{ id: 'fixture-user', name: '新建项目', username: 'fixture-user' }],
  '/admin/clients/page': { items: [], total: 0, counts: {} },
  '/admin/operations/overview': { database: { ready: true }, hub: { ready: true, nodeId: 'fixture', service: 'Fixture Hub', version: '1.0.0', modeLabel: opsModeLabel, clusterNote: opsClusterNote }, runners: { items: [], accepting: 0 }, work: {}, requests: {},
    blockers: [
      { level: 'warning', title: '75 ' + opsFailedSuffix, detail: opsFailedDetail },
      { level: 'warning', title: opsRunnerTitle, detail: opsRunnerDetail },
    ],
    recentFailures: [{ id: 'fixture-failure', taskId: 'fixture-task', error: '', updatedAt: Date.now() }] },
  '/admin/operations/insights': { plugins: Array.from({ length: 30 }, (_, i) => ({ pluginId: 'plugin-' + i, name: 'Plugin ' + (i + 1), enabled: true, category: 'dev', installs: 2, runs30d: 30 - i, conversationUses30d: 2, succeeded30d: 30 - i, failed30d: 0, successRate: 100 })) },
  '/admin/usage/overview': { summary: {}, users: [], bySource: [], byAgent: [], recent: [], trend: [], quality: {}, days: 30 },
  '/admin/model-catalog': { providers: [{ id: 'fixture-provider', name: 'Fixture Provider', enabled: true, baseUrl: 'https://fixture.invalid', keySet: true }], models: [{ id: 'fixture-model', name: 'fixture-model', providerId: 'fixture-provider', enabled: true }] },
  '/admin/model-runtime': { running: 4, queued: 2, policy: { globalConcurrent: 16, queueSize: 32 }, lastHour: { waitMs: 500, started: 5 }, groups: Array.from({ length: 30 }, (_, i) => ({ provider: 'Fixture Provider', model: 'Model ' + i, running: 1, queued: 0 })) },
  '/admin/runners': { items: Array.from({ length: 31 }, (_, i) => ({ runnerId: 'runner-' + i, label: 'Runner ' + (i + 1), online: i < 26, mode: i >= 23 && i < 26 ? 'draining' : 'accepting', authState: 'active', orgId: 'fixture-org', orgName: 'Fixture organization', health: { state: i < 26 ? 'healthy' : 'offline', label: i < 26 ? 'Online' : 'Offline' }, release: { label: 'Current', state: 'current' }, slots: 2, running: 0 })), summary: { total: 31, online: 26, accepting: 23, attention: 5 } },
  '/admin/org-memory': { items: [] },
  '/admin/automation-templates': { items: [] },
  '/admin/plugins/categories': { items: [] },
  '/admin/plugins/governance': { items: [], plugins: [] },
  '/admin/capabilities/catalog': { cfg: { allowed: [] }, skills: [], mcp: [], packages: [] },
  '/admin/capabilities': { cfg: { allowed: [] }, skills: [], mcp: [], packages: [] },
  '/admin/audit': { items: [], total: 0 },
  '/admin/work-catalog': { professions: [], scenarios: [] },
  '/admin/permissions': permissionCatalog,
  '/admin/positions': professions,
  '/admin/domains': domains,
  '/admin/usage/runners': { runners: [] },
}
const requests = []
const consoleErrors = []
const results = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let win, server
async function js(source) { return win.webContents.executeJavaScript(source, true) }
async function waitFor(source, label, timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await js(source)) return; await sleep(50) }
  throw new Error('Timed out: ' + label)
}
async function changeLocale(locale) {
  const signedIn = await js('!!document.querySelector(".side-foot")')
  const trigger = signedIn ? '.side-foot' : '.locale-settings-trigger'
  const selector = signedIn ? '.profile-menu .locale-language-select' : '.locale-settings-popover .locale-language-select'
  if (!await js(`!!document.querySelector(${JSON.stringify(selector)})`)) await js(`document.querySelector(${JSON.stringify(trigger)}).click()`)
  await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, 'language picker')
  await js(`(()=>{const s=document.querySelector(${JSON.stringify(selector)});if(s.querySelector('.select-menu-trigger').getAttribute('aria-expanded')!=='true')s.querySelector('.select-menu-trigger').click()})()`)
  await waitFor(`!!document.querySelector(${JSON.stringify(selector + ' [role="option"]')})`, 'language options')
  const optionLabel = { 'zh-CN': '简体中文', 'en-US': 'English', 'ja-JP': '日本語', 'ko-KR': '한국어' }[locale]
  assert.ok(optionLabel, 'Unsupported fixture locale: ' + locale)
  await js(`(()=>{const option=[...document.querySelectorAll(${JSON.stringify(selector + ' [role="option"]')})].find(o=>o.textContent.trim()===${JSON.stringify(optionLabel)});if(!option)throw Error('Language option missing');option.click()})()`)
  await waitFor(`document.documentElement.lang===${JSON.stringify(locale)}`, 'locale changed')
  await sleep(120)
  await js(`document.querySelector(${JSON.stringify(trigger)}).click()`)
}
async function clickText(label) {
  return js(`(()=>{const b=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Button not found: '+${JSON.stringify(label)});b.click()})()`)
}
async function visibleChinese() {
  // The translation editor intentionally uses LOCALES' native Japanese name.
  // Exempt only that exact label; untranslated field captions still fail.
  return js(`(()=>{const values=[];const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);while(w.nextNode()){const n=w.currentNode,p=n.parentElement;if(!p||p.closest('script,style,option,textarea,pre,code')||!p.getClientRects().length)continue;const t=n.nodeValue.trim();if(t==='日本語'&&p.closest('.loc-grid label'))continue;if(/[\\u3400-\\u9fff]/.test(t)&&!['保存','新建项目','客户业务原文','新'].includes(t))values.push(t)}for(const p of document.querySelectorAll('[title],[placeholder],[aria-label]'))if(p.getClientRects().length)for(const k of ['title','placeholder','aria-label']){const t=p.getAttribute(k)||'';if(/[\\u3400-\\u9fff]/.test(t)&&!['保存','新建项目','客户业务原文','新'].includes(t))values.push(k+': '+t)}return [...new Set(values)]})()`)
}
async function screenshot(name) {
  await sleep(120)
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG())
}

async function responsiveLayout(name, dialog = false) {
  win.setSize(390, 640); await sleep(180)
  const geometry = await js(`(()=>{
    for(const a of document.getAnimations())if(a.effect?.getComputedTiming().iterations!==Infinity)a.finish();
    const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,scroll:e.scrollWidth,client:e.clientWidth}};
    const modal=document.querySelector('.modal');
    return {width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,
      modal:modal&&box(modal),head:modal&&box(modal.querySelector('.modal-head')),
      foot:modal?.querySelector('.modal-foot')&&box(modal.querySelector('.modal-foot')),
      body:modal&&box(modal.querySelector('.modal-body'))}
  })()`)
  const fits=r=>!r||(r.left>=-1&&r.right<=geometry.width+1&&r.top>=-1&&r.bottom<=geometry.height+1)
  const ok=geometry.scroll<=geometry.width+1&&(!dialog||(Boolean(geometry.modal)&&fits(geometry.modal)&&fits(geometry.head)&&fits(geometry.foot)&&geometry.body.scroll<=geometry.body.client+1))
  results.push({name:name+' at 390×640',ok,geometry})
  await screenshot(name.replace(/[^a-z0-9-]/gi,'-')+'-390')
  win.setSize(1280, 900); await sleep(120)
}
async function responsiveDialog(name) {
  await changeLocale('zh-CN'); await responsiveLayout(name+'-zh',true)
  await changeLocale('en-US'); await responsiveLayout(name+'-en',true)
}

app.whenReady().then(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
      requests.push({ method: req.method, path: url.pathname })
      if (req.method !== 'GET') { res.writeHead(405); res.end('Test is read-only'); return }
      const key = url.pathname.replace(/^\/api\/v1/, '')
      let body = Object.hasOwn(fixtures, key) ? fixtures[key] : []
      if (key === '/admin/clients') {
        const page = Number(url.searchParams.get('page') || 1), size = Number(url.searchParams.get('pageSize') || 25)
        const state = url.searchParams.get('state') || 'all', form = url.searchParams.get('form') || 'all'
        const query = (url.searchParams.get('q') || '').toLowerCase()
        const filtered = devices.filter(row => (state === 'all' || (state === 'online' ? row.online : state === 'offline' ? !row.online : row.authState === 'pending')) &&
          (form === 'all' || (form === 'mobile' ? row.platform === 'android' : row.platform !== 'android')) &&
          (!query || [row.name, row.ownerName, row.id].some(value => value.toLowerCase().includes(query))))
        body = url.searchParams.has('page') ? { items: filtered.slice((page - 1) * size, page * size), total: filtered.length, counts: { all: 61, online: 50, offline: 11, pending: 6, mobile: 20 } } : devices
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return
    }
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
    const file = path.resolve(root, 'dist', relative)
    if (!file.startsWith(path.resolve(root, 'dist') + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
    const mime = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream'
    let body = fs.readFileSync(file)
    if (relative === 'index.html') {
      const seed = url.searchParams.get('guest') ? "localStorage.removeItem('soduwork_hub_admin_token');localStorage.removeItem('soduwork_hub_admin_user');" : `localStorage.setItem('soduwork_hub_admin_token','isolated-fixture');localStorage.setItem('soduwork_hub_admin_user',${JSON.stringify(JSON.stringify(user))});sessionStorage.setItem('soduwork-hub-screen',${JSON.stringify(url.searchParams.get('screen') || 'projects')});`
      body = Buffer.from(body.toString().replace('<head>', `<head><script>${seed}if(!localStorage.getItem('soduwork.locale'))localStorage.setItem('soduwork.locale','en-US')</script>`))
    }
    res.writeHead(200, { 'Content-Type': mime }); res.end(body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const isolated = session.fromPartition('i18n-' + Date.now())
  isolated.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('data:') }))
  win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { session: isolated, offscreen: true, backgroundThrottling: false } })
  win.webContents.on('console-message', (event) => { if (/Error:|Uncaught|React error/.test(event.message)) consoleErrors.push(event.message) })
  const governanceOnly = process.env.SODUWORK_GOVERNANCE_ONLY === '1'
  const insightsOnly = process.env.SODUWORK_INSIGHTS_ONLY === '1'
  const overviewInsightsOnly = process.env.SODUWORK_GOVERNANCE_INSIGHTS_ONLY === '1'
  const catalogUsageOnly = process.env.SODUWORK_CATALOG_USAGE_ONLY === '1'
  const capabilityOnly = process.env.SODUWORK_CAPABILITY_ONLY === '1'
  if (governanceOnly || insightsOnly || overviewInsightsOnly || catalogUsageOnly || capabilityOnly) {
    if (governanceOnly || overviewInsightsOnly) await checkGovernanceOverview({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, requests, results })
    if (insightsOnly || overviewInsightsOnly) await checkInsightsMetricDefinitions({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, results })
    if (catalogUsageOnly) await checkCatalogUsage({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, results })
    if (capabilityOnly) await checkCapabilityCatalog({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, requests, results })
    results.push({ name: 'no renderer errors', ok: consoleErrors.length === 0, consoleErrors })
    results.push({ name: 'all fixture requests read-only', ok: requests.every(request => request.method === 'GET') })
    const report = { ok: results.every(r => r.ok), scope: 'Isolated admin page acceptance; four languages and read-only local API fixtures', results, requests, consoleErrors }
    fs.writeFileSync(path.join(output, 'browser-report.json'), JSON.stringify(report, null, 2))
    assert.equal(report.ok, true, 'admin page browser checks failed; see browser-report.json')
    return
  }
  await win.loadURL(origin + '/?screen=projects')
  await waitFor('!!document.querySelector(".pg-page") || document.body.innerText.includes("New project")', 'projects page')
  await sleep(350)
  assert.equal(await js('document.documentElement.lang'), 'en-US')
  assert.ok(await js('document.body.innerText.includes("保存")'), 'Chinese project name retained')
  assert.deepEqual(await visibleChinese(), [])
  await waitFor('document.querySelector(".env summary")?.innerText.includes("v1.0.5")', 'Hub release version')
  assert.equal(await js('document.querySelector(".env summary").innerText.includes("12345678")'), false, 'build revision stays out of the compact status')
  await js('document.querySelector(".env summary").click()')
  await waitFor('document.querySelector(".env[open] .env-details")?.innerText.includes("1234567890abcdef1234567890abcdef12345678")', 'full Hub build details')
  assert.ok(await js('document.querySelector(".env-details").innerText.includes("v1.0.5")'), 'release and complete build identity remain available in details')
  await js('document.querySelector(".env summary").click()')
  await screenshot('hub-version-en')
  await clickText('New project')
  await waitFor('!!document.querySelector(".modal")', 'new project dialog')
  await js(`(()=>{const e=document.querySelector('.modal input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'未保存客户项目');e.dispatchEvent(new Event('input',{bubbles:true}));window.fixtureInput=e})()`)
  await changeLocale('zh-CN')
  assert.ok(await js('document.querySelector(".env summary").innerText.includes("v1.0.5") && !document.querySelector(".env summary").innerText.includes("12345678")'), 'Chinese status shows the release without diagnostic build codes')
  assert.ok(await js('document.querySelector(".env-details").textContent.includes("构建") && document.querySelector(".env-details").textContent.includes("1234567890abcdef1234567890abcdef12345678")'), 'Chinese diagnostic details retain the complete build identity')
  assert.equal(await js('document.querySelector(".modal input").value'), '未保存客户项目')
  assert.equal(await js('document.querySelector(".modal input")===window.fixtureInput'), true, 'input identity retained')
  assert.ok(await js('document.querySelector(".modal").innerText.includes("项目名称")'))
  await changeLocale('en-US')
  assert.equal(await js('document.querySelector(".modal input").value'), '未保存客户项目')
  assert.ok(await js('document.querySelector(".modal").innerText.includes("Project name")'))
  assert.equal(await js('document.querySelector(".modal input").placeholder'), 'For example: Creative Tea House')
  await screenshot('project-dialog-en')
  await responsiveDialog('project-dialog')
  await clickText('Cancel')
  results.push({ name: 'project name, unsaved form and DOM identity survive locale roundtrip', ok: true })
  for (const size of [[1280, 900], [760, 900], [390, 844]]) {
    win.setSize(...size); await sleep(120)
    const bounds = await js(`(()=>{const r=document.querySelector('.side-foot').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}})()`)
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height, 'settings accessible at ' + size)
    await changeLocale('zh-CN'); await changeLocale('en-US')
    await screenshot('settings-' + size[0])
  }
  results.push({ name: 'settings switch accessible at 1280 / 760 / 390 px', ok: true })
  await checkGovernanceOverview({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, requests, results })
  await checkInsightsUsage({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, results })
  await checkInsightsMetricDefinitions({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, results })
  await checkCatalogUsage({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, results })
  await checkCapabilityCatalog({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, requests, results })
  await checkOrgTreeSearch({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, results })
  await checkDepartmentSelect({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, results })
  await checkAdminLayout({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, requests, results })
  win.setSize(1280, 900)
  const screens = ['overview','insights','automation-templates','operations','clients','usage','projects','repositories','models','plugins','capabilities','integrations','orgs','org-memory','work-catalog','users','roles','identity','audit']
  for (const screen of screens) {
    const before = consoleErrors.length
    await win.loadURL(origin + '/?screen=' + screen)
    await waitFor(`document.querySelector('.app')?.dataset.screen===${JSON.stringify(screen)}`, screen)
    await sleep(350)
    await waitFor('!!document.querySelector(".content")?.innerText && document.querySelector(".content").innerText.trim()!=="Loading…"', screen + ' content loaded')
    await changeLocale('zh-CN'); await changeLocale('en-US')
    const misses = await visibleChinese()
    const content = await js('document.querySelector(".content")?.innerText || ""')
    results.push({ name: screen, ok: misses.length === 0 && consoleErrors.length === before && !!content, chineseUi: misses, errors: consoleErrors.slice(before), preview: content.slice(0,140) })
    await responsiveLayout(screen)
    const dialogs = { 'automation-templates': 'New template', users: 'New user', roles: 'New role', models: 'Connect a service' }
    if (dialogs[screen]) {
      await clickText(dialogs[screen]); await sleep(160)
      if (screen === 'automation-templates') {
        await waitFor('document.querySelectorAll(".at-dialog .loc-grid input").length === 6', 'template localized fields')
        assert.deepEqual(await js('[...document.querySelectorAll(".at-dialog .loc-grid input")].map(e=>e.value)'), Array(6).fill(''), 'new template translations start empty')
        await js(`document.querySelector('.at-dialog .loc-block').open=true`)
        const setName = async (index, value) => {
          await js(`(()=>{const e=document.querySelectorAll('.at-dialog .loc-grid input')[${index}];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
          await waitFor(`document.querySelectorAll('.at-dialog .loc-grid input')[${index}].value===${JSON.stringify(value)}`, 'template translation updated')
        }
        await setName(0, 'Daily report')
        await setName(2, 'Team report')
        await changeLocale('zh-CN'); await changeLocale('en-US')
        assert.deepEqual(await js('[...document.querySelectorAll(".at-dialog .loc-grid input")].map(e=>e.value)'), ['Daily report', '', 'Team report', '', '', ''], 'translations survive rerender and language switch')
        await setName(0, '')
        await changeLocale('zh-CN'); await changeLocale('en-US')
        assert.equal(await js('document.querySelectorAll(".at-dialog .loc-grid input")[0].value'), '')
        assert.equal(await js('document.querySelectorAll(".at-dialog .loc-grid input")[2].value'), 'Team report', 'clearing one translation preserves another')
        assert.equal(consoleErrors.length, before, 'template editor has no renderer errors')
        results.push({ name: 'template localized draft editing, clearing and locale roundtrip', ok: true })
        await js(`document.querySelector('.at-dialog .loc-block').open=false`)
      }
      const dialogMisses = await visibleChinese()
      results.push({ name: screen + ' editor', ok: dialogMisses.length === 0, chineseUi: dialogMisses })
      await changeLocale('zh-CN'); await changeLocale('en-US')
      await screenshot(screen + '-editor-en')
      await responsiveDialog(screen+'-editor')
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'ESC'})
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'ESC'})
      await waitFor('!document.querySelector(".modal")',screen+' dialog Escape')
    }
  }
  await win.loadURL(origin + '/?screen=operations')
  await waitFor('document.querySelector(".app")?.dataset.screen==="operations"', 'operations recheck')
  await sleep(350)
  await waitFor('!!document.querySelector(".content")?.innerText && document.querySelector(".content").innerText.trim()!=="Loading…"', 'operations content loaded')
  await changeLocale('zh-CN'); await changeLocale('en-US')
  assert.ok(await js('document.body.innerText.includes("Multi-instance control plane")'), 'topology mode label translated')
  assert.ok(await js('document.body.innerText.includes("75 failed workflows")'), 'failed runs blocker translated')
  assert.ok(await js('document.body.innerText.includes("No Runners accepting work")'), 'runner blocker translated')
  assert.ok(await js('document.body.innerText.includes("Workflow run failed")'), 'recent failure fallback translated')
  assert.deepEqual(await visibleChinese(), [])
  await screenshot('operations-en')
  results.push({ name: 'operations backend-composed copy renders translated', ok: true })
  await win.loadURL(origin + '/?screen=client-releases')
  await waitFor('document.querySelectorAll(".cr-row").length===6', 'six client packages')
  assert.equal(await js('document.querySelectorAll(".cr-notes").length'), 1)
  for (const width of [1280, 390]) {
    win.setSize(width, 900); await sleep(150)
    await js('document.querySelector(".cr-notes summary").click()')
    if (!await js('document.querySelector(".cr-notes").open')) await js('document.querySelector(".cr-notes summary").click()')
    assert.equal(await js('document.querySelector(".cr-notes > div").textContent'), fixtures['/admin/client-releases'].releases[0].notes)
    assert.equal(await js('document.querySelector(".cr-notes img")'), null)
    assert.equal(await js('(()=>{const e=document.querySelector(".cr-notes > div");return e.scrollWidth>e.clientWidth})()'), false)
    await changeLocale('zh-CN'); await changeLocale('en-US')
    assert.equal(await js('document.querySelector(".cr-notes").open'), true)
    await screenshot('release-notes-' + width)
  }
  results.push({ name: 'six packages share release notes; literal HTML, line breaks, locale and narrow layout', ok: true })
  await changeLocale('en-US')
  await clickText('Upload release')
  await waitFor('!!document.querySelector(".modal")', 'upload release dialog')
  await waitFor('document.querySelectorAll(".cr-file-native").length === 2', 'two native file inputs')
  assert.ok(await js('[...document.querySelectorAll(".cr-file-native")].every(e=>{const r=e.getBoundingClientRect();return r.width<=2&&r.height<=2})'), 'native file inputs are visually hidden')
  assert.deepEqual(await js('[...document.querySelectorAll(".cr-file-chip")].map(e=>e.textContent)'), ['Choose file', 'Choose file'])
  assert.ok(await js('[...document.querySelectorAll(".cr-file-name")].every(e=>e.textContent==="No file chosen")'), 'empty file name fallback translated')
  await js('document.querySelector(".cr-notes")?.removeAttribute("open")')
  assert.deepEqual(await visibleChinese(), [])
  await screenshot('upload-dialog-en')
  results.push({ name: 'upload dialog hides native file controls and translates picker copy', ok: true })
  await responsiveDialog('upload-dialog')
  await win.webContents.sendInputEvent({type:'keyDown',keyCode:'ESC'})
  await win.webContents.sendInputEvent({type:'keyUp',keyCode:'ESC'})
  await waitFor('!document.querySelector(".modal")','upload dialog Escape')
  await win.loadURL(origin + '/?guest=1')
  await waitFor('!!document.querySelector(".locale-settings-trigger")', 'guest language settings')
  await js(`document.querySelector('.locale-settings-trigger').click()`)
  await waitFor('!!document.querySelector(".locale-settings-popover .select-menu-trigger")', 'guest language field')
  await js(`document.querySelector('.locale-settings-popover .select-menu-trigger').click()`)
  await waitFor('!!document.querySelector(".locale-settings-popover .select-menu-popover")', 'guest language options')
  const guestDropdown = await js(`(() => {
    const popup=document.querySelector('.locale-settings-popover'), options=popup.querySelector('.select-menu-popover');
    const p=popup.getBoundingClientRect(), r=options.getBoundingClientRect();
    return { fits:r.left>=p.left&&r.right<=p.right&&r.top>=p.top&&r.bottom<=p.bottom,
      panel:[p.left,p.top,p.right,p.bottom], options:[r.left,r.top,r.right,r.bottom],
      font:getComputedStyle(popup.querySelector('.select-menu-trigger')).fontSize };
  })()`)
  // locale-settings.css uses the shared 14.5px readable control size.
  results.push({ name: 'guest language dropdown is styled and unclipped', ok: guestDropdown.fits && guestDropdown.font==='14.5px', evidence: guestDropdown })
  await screenshot('guest-language-dropdown')
  await js(`document.querySelector('.locale-settings-trigger').click()`)
  await changeLocale('zh-CN'); await changeLocale('en-US')
  results.push({ name: 'landing', ok: (await visibleChinese()).length === 0, chineseUi: await visibleChinese() })
  const loginButton = await js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/Enter admin|Admin sign|Sign in|Enter console/.test(b.textContent));if(b)b.click();return !!b})()`)
  if (loginButton) { await sleep(200); results.push({ name: 'login', ok: (await visibleChinese()).length === 0, chineseUi: await visibleChinese() }) }
  assert.ok(requests.every(r => r.method === 'GET'), 'all fixture requests read-only')
  const report = { ok: results.every(r => r.ok), scope: 'Isolated Electron renderer with read-only local API fixtures; no production traffic', results, requests, consoleErrors }
  fs.writeFileSync(path.join(output, 'browser-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) throw new Error('Browser checks failed; see report')
}).catch(error => {
  const report = { ok: false, error: error.stack, results, consoleErrors, requests }
  fs.writeFileSync(path.join(output, 'browser-failure.json'), JSON.stringify(report, null, 2))
  console.error(error.stack)
  process.exitCode = 1
}).finally(() => {
  win?.destroy(); server?.close(); app.exit(process.exitCode || 0)
})
