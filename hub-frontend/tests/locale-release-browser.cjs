// Run the production build in an isolated Electron renderer with synthetic API
// responses. No installed profile, credentials, or external service is used.
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const output = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-locale-release-'))
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, 'profile'))
app.disableHardwareAcceleration()
const user = { id: 'fixture-admin', displayName: 'Fixture admin', isSuper: true, permissions: [] }
const content = label => ({ summary: label, sections: [{ id: 'fixes', title: 'Fixes', items: [{ id: 'one', text: '<img src=x onerror=alert(1)> literal text' }] }] })
const release = { id: 'fixture-release', version: '2.0.0', channel: 'stable', platform: 'win32', arch: 'x64', artifactName: 'Fixture.exe', enabled: true, notes: 'Legacy release notes' }
let win, server, languages = ['zh-CN'], stored = null, seed = true, mode = 'ok', notesRequests = 0
const results = [], errors = [], requests = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = source => win.webContents.executeJavaScript(source, true)
async function until(source, label) {
  for (let i = 0; i < 120; i++) { if (await js(source)) return; await sleep(50) }
  throw Error('Timed out: ' + label)
}
async function load(preferences, saved = null) {
  languages = preferences; stored = saved; seed = true
  await win.loadURL(origin + '/')
  await until('!!document.querySelector(".cr-list,.cr-error")', 'release page')
}
async function pickLocale(value) {
  await js('document.querySelector(".side-foot").click()')
  await until('!!document.querySelector(".profile-menu .locale-language-select .select-menu-trigger")', 'language picker')
  await js('document.querySelector(".profile-menu .locale-language-select .select-menu-trigger").click()')
  await until('!!document.querySelector(".profile-menu [role=option]")', 'language options')
  await js(`(()=>{const label=${JSON.stringify({ 'zh-CN': '简体中文', 'en-US': 'English', 'ja-JP': '日本語', 'ko-KR': '한국어' }[value])};const option=[...document.querySelectorAll('.profile-menu [role=option]')].find(el=>el.textContent.trim()===label);if(!option)throw Error('Missing language option');option.click()})()`)
  await until(`document.documentElement.lang===${JSON.stringify(value)}`, 'selected locale')
}
let origin
app.whenReady().then(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const json = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
      requests.push({ method: req.method, path: url.pathname })
      if (req.method !== 'GET') return json({ detail: 'Read-only fixture' }, 405)
      if (url.pathname.endsWith('/admin/me')) return json(user)
      if (url.pathname.endsWith('/admin/client-releases')) return json({ releases: [release] })
      if (url.pathname.endsWith('/admin/client-release-notes')) {
        notesRequests++
        if (mode === 'missing') return json({ detail: 'Not found' }, 404)
        if (mode === 'failure') return json({ detail: 'Fixture notes unavailable' }, 503)
        if (mode === 'denied') return json({ detail: 'Fixture forbidden' }, 403)
        return json({ notes: [{ version: release.version, channel: 'stable', locales: { 'zh-CN': content('中文发布说明'), 'en-US': content('English release notes'), 'ja-JP': content('日本語の更新内容'), 'ko-KR': content('한국어 업데이트') } }] })
      }
      if (url.pathname.endsWith('/admin/client-update-attempts')) return json({ attempts: [], counts: {} })
      return json({})
    }
    const base = path.join(root, 'dist'), file = path.resolve(base, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)))
    if (!file.startsWith(base + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end() }
    let body = fs.readFileSync(file)
    if (file.endsWith('index.html')) {
      // Supply browser preferences before the actual bundled i18n module loads.
      const prefs = `Object.defineProperty(navigator,'languages',{get:()=>${JSON.stringify(languages)}});Object.defineProperty(navigator,'language',{get:()=>${JSON.stringify(languages[0] || '')}});`
      const initial = seed ? `localStorage.clear();sessionStorage.clear();localStorage.setItem('soduwork_hub_admin_token','fixture-only');localStorage.setItem('soduwork_hub_admin_user',${JSON.stringify(JSON.stringify(user))});sessionStorage.setItem('soduwork-hub-screen','client-releases');${stored ? `localStorage.setItem('soduwork.locale',${JSON.stringify(stored)});` : ''}` : ''
      seed = false
      body = Buffer.from(body.toString().replace('<head>', `<head><script>${prefs}${initial}</script>`))
    }
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); res.end(body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = 'http://127.0.0.1:' + server.address().port
  const isolated = session.fromPartition('locale-release-' + Date.now())
  isolated.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('data:') }))
  win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { session: isolated, offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', event => { if (/Uncaught|React error/.test(event.message)) errors.push(event.message) })
  for (const [preferences, expected] of [[['zh-CN'], 'zh-CN'], [['zh-Hans-SG'], 'zh-CN'], [['ja-JP'], 'ja-JP'], [['ko-KR'], 'ko-KR'], [['en-GB'], 'en-US'], [['de-DE', 'zh-CN'], 'zh-CN'], [['de-DE'], 'en-US']]) {
    await load(preferences)
    assert.equal(await js('document.documentElement.lang'), expected)
    assert.equal(await js('localStorage.getItem("soduwork.locale")'), null, 'first-visit detection must not save an explicit override')
    const expectedSummary = { 'zh-CN': '中文发布说明', 'en-US': 'English release notes', 'ja-JP': '日本語の更新内容', 'ko-KR': '한국어 업데이트' }[expected]
    assert.ok(await js(`document.querySelector('.cr-notes').textContent.includes(${JSON.stringify(expectedSummary)})`))
    assert.equal(await js('document.querySelectorAll(".cr-notes img").length'), 0)
    results.push({ preferences, expected, releaseNotes: true })
  }
  await load(['zh-CN'])
  await pickLocale('en-US')
  assert.equal(await js('localStorage.getItem("soduwork.locale")'), 'en-US')
  await win.reload()
  await until('!!document.querySelector(".cr-list")', 'persisted release list')
  assert.equal(await js('document.documentElement.lang'), 'en-US')
  assert.ok(await js('document.querySelector(".cr-notes").textContent.includes("English release notes")'))
  results.push({ manualSelectionPersists: true })
  for (const [next, expected] of [['missing', 'Legacy release notes'], ['failure', 'Fixture notes unavailable'], ['denied', 'Fixture forbidden']]) {
    mode = next
    await load(['en-US'])
    assert.ok(await js(`document.querySelector(${JSON.stringify(next === 'missing' ? '.cr-notes' : '.cr-error')}).textContent.includes(${JSON.stringify(expected)})`))
    results.push({ notesResponse: next, handled: true })
  }
  mode = 'ok'; await load(['zh-CN'], 'ko-KR')
  assert.equal(await js('document.documentElement.lang'), 'ko-KR')
  assert.ok(notesRequests >= 12)
  assert.deepEqual(errors, [])
  assert.ok(requests.every(row => row.method === 'GET'))
  fs.writeFileSync(path.join(output, 'browser-report.json'), JSON.stringify({ ok: true, platform: process.platform, results, requests, errors }, null, 2))
  console.log(JSON.stringify({ ok: true, results, output }))
}).catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { win?.destroy(); server?.close(); app.exit(process.exitCode || 0) })
