// Real renderer + real authenticated API + disposable SQLite. No business data.
const { app, BrowserWindow, session } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const output = path.resolve(root, '../outputs/automation-template-toggle')
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, 'profile'))
app.disableHardwareAcceleration()
let backend, server, win, clientWin, fixture
let failNextSave = false, saveCount = 0
const checks = [], errors = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = code => win.webContents.executeJavaScript(code, true)
async function waitFor(code, name) {
  for (let i = 0; i < 160; i++) { if (await js(code)) return; await sleep(50) }
  throw new Error('Timed out: ' + name)
}
async function click(text) {
  await js(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Missing button');b.click() })()`)
}
async function api(method, route, body) {
  const response = await fetch(fixture.url + '/api/v1/admin/automation-templates' + route, {
    method, headers: { Authorization: 'Bearer ' + fixture.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, data: await response.json() }
}
async function shot(name) {
  await sleep(100)
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG())
}
function startBackend() {
  const python = process.env.SODUWORK_ADMIN_TEST_PYTHON
  assert.ok(python, 'Set SODUWORK_ADMIN_TEST_PYTHON to the existing Hub Python environment')
  backend = spawn(python, ['-u', 'tests/automation_template_server.py'], { cwd: path.resolve(root, '../hub-backend'), windowsHide: true })
  return new Promise((resolve, reject) => {
    let buffer = '', diagnostic = ''
    const timer = setTimeout(() => reject(new Error('Fixture startup timed out: ' + diagnostic)), 20000)
    backend.stderr.on('data', chunk => { diagnostic += String(chunk) })
    backend.on('error', reject)
    backend.on('exit', code => { clearTimeout(timer); if (!fixture) reject(new Error('Fixture exited ' + code + ': ' + diagnostic)) })
    backend.stdout.on('data', chunk => {
      buffer += String(chunk)
      for (const line of buffer.split('\n')) {
        try { const value = JSON.parse(line); if (value.ready && value.fixtureOnly) { clearTimeout(timer); fixture = value; resolve(value); return } } catch {}
      }
    })
  })
}
async function cleanup() {
  clientWin?.destroy()
  win?.destroy()
  server?.close()
  if (backend?.pid) {
    try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(backend.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else backend.kill() } catch {}
  }
}
app.whenReady().then(async () => {
  await startBackend()
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(fixture.url + '/healthz')).ok) break } catch (error) { if (attempt === 99) throw error }
    await sleep(50)
  }
  const userResponse = await fetch(fixture.url + '/api/v1/admin/me', { headers: { Authorization: 'Bearer ' + fixture.token } })
  assert.equal(userResponse.status, 200)
  const user = await userResponse.json()
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'PUT' && url.pathname === '/api/v1/admin/automation-templates') {
      saveCount++
      if (failNextSave) { failNextSave = false; res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ detail: 'Fixture save failure' })); return }
    }
    if (url.pathname === '/_fixture/client.html') {
      let html = fs.readFileSync(path.resolve(root, '../client/e2e/fixtures/schedule-card-actions.html'), 'utf8')
        .replaceAll('../../', '/_fixture/client/')
        .replace('<script>openSchedulePanel();</script>', `<script>
          const deviceHeaders = { Authorization: 'Device ' + ${JSON.stringify(fixture.deviceToken)} };
          const read = async route => { const r = await fetch('/api/v1/' + route, {headers:deviceHeaders}); if(!r.ok)throw Error('HTTP '+r.status);return r.json(); };
          SoduWorkAPI.listSchedules=()=>read('schedules');
          SoduWorkAPI.listScheduleTemplates=()=>read('schedules/templates');
          window.pageReady=openSchedulePanel();
        </script>`)
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); return
    }
    if (url.pathname.startsWith('/_fixture/client/')) {
      const clientRoot = path.resolve(root, '../client'), file = path.resolve(clientRoot, decodeURIComponent(url.pathname.slice('/_fixture/client/'.length)))
      if (!file.startsWith(clientRoot + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' }); res.end(fs.readFileSync(file)); return
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
      const upstream = http.request(fixture.url + req.url, { method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res)
      })
      upstream.on('error', () => { res.writeHead(502); res.end() })
      req.pipe(upstream); return
    }
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
    const file = path.resolve(root, 'dist', relative)
    if (!file.startsWith(path.resolve(root, 'dist') + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
    let body = fs.readFileSync(file)
    if (relative === 'index.html') body = Buffer.from(body.toString().replace('<head>', `<head><script>localStorage.setItem('soduwork_hub_admin_token',${JSON.stringify(fixture.token)});localStorage.setItem('soduwork_hub_admin_user',${JSON.stringify(JSON.stringify(user))});sessionStorage.setItem('soduwork-hub-screen','automation-templates');if(!localStorage.getItem('soduwork.locale'))localStorage.setItem('soduwork.locale','zh-CN')</script>`))
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); res.end(body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const isolated = session.fromPartition('automation-template-test-' + Date.now())
  isolated.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('data:') }))
  win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { session: isolated, offscreen: true, backgroundThrottling: false } })
  win.webContents.on('console-message', event => { if (/Uncaught|React error/.test(event.message)) errors.push(event.message) })
  await win.loadURL(origin)

  await waitFor('document.querySelectorAll(".at-card").length === 2', 'initial templates')
  const before = (await api('GET', '')).data.items
  const deviceGet = async route => {
    const r = await fetch(fixture.url + '/api/v1/' + route, { headers: { Authorization: 'Device ' + fixture.deviceToken } })
    assert.equal(r.status, 200); return r.json()
  }
  const plans = await deviceGet('schedules')
  clientWin = new BrowserWindow({ show: false, width: 1100, height: 850,
    webPreferences: { session: isolated, offscreen: true, backgroundThrottling: false } })
  const clientJs = code => clientWin.webContents.executeJavaScript(code, true)
  await clientWin.loadURL(origin + '/_fixture/client.html'); await clientJs('pageReady')
  const clientIds = () => clientJs('[...document.querySelectorAll("[data-sch-recipe]")].map(e=>e.dataset.schRecipe)')
  const refreshClient = () => clientJs('closeSchedulePanel(); openSchedulePanel()')
  assert.deepEqual(await clientIds(), ['daily-report', 'weekly-review'])
  const clickToggle = () => js('document.querySelector(".at-toggle").click()')
  const toggleLabel = 'document.querySelector(".at-toggle")?.textContent'
  await shot('templates-enabled-desktop')
  failNextSave = true
  await clickToggle()
  await waitFor('document.body.textContent.includes("Fixture save failure")', 'failed save feedback')
  assert.equal(await js(toggleLabel), '停用')
  assert.deepEqual((await api('GET', '')).data.items, before)
  await refreshClient(); assert.deepEqual(await clientIds(), ['daily-report', 'weekly-review'])
  checks.push('Failed save retains administrator and client state and allows retry')

  await clickToggle()
  await waitFor(toggleLabel + ' === "启用"', 'disabled receipt')
  const disabled = (await api('GET', '')).data.items
  assert.deepEqual(disabled, [{ ...before[0], enabled: false }, before[1]])
  assert.deepEqual(await deviceGet('schedules'), plans, 'existing automations remain byte-for-byte unchanged')
  await refreshClient(); assert.deepEqual(await clientIds(), ['weekly-review'])
  await sleep(100)
  fs.writeFileSync(path.join(output, 'client-template-disabled.png'), (await clientWin.webContents.capturePage()).toPNG())
  await shot('templates-disabled-desktop')
  checks.push('Real administrator PUT persists disabled state; real client reopening hides that template only')
  await js('document.querySelectorAll(".at-toggle")[1].click()')
  await waitFor('document.querySelectorAll(".at-card.off").length === 2', 'all templates disabled')
  await refreshClient(); assert.deepEqual(await clientIds(), [])
  assert.equal(await clientJs('!!document.querySelector(".sch-recipes")'), false)
  assert.deepEqual(await deviceGet('schedules'), plans)
  await js('document.querySelectorAll(".at-toggle")[1].click()')
  await waitFor('document.querySelectorAll(".at-card.off").length === 1', 'restore second template')
  await refreshClient(); assert.deepEqual(await clientIds(), ['weekly-review'])
  checks.push('Disabling every template hides the client template section while retaining existing automations')
  await win.loadURL(origin)
  await waitFor(toggleLabel + ' === "启用"', 'disabled state survives reload')
  win.setSize(390, 800); await sleep(150)
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), 'narrow layout cannot overflow')
  await shot('templates-disabled-narrow')
  win.setSize(1280, 900)
  await clickToggle()
  await waitFor(toggleLabel + ' === "停用"', 'reenabled receipt')
  assert.deepEqual((await api('GET', '')).data.items, before)
  await refreshClient(); assert.deepEqual(await clientIds(), ['daily-report', 'weekly-review'])
  checks.push('Reload retains disabled state; enabling restores client visibility without changing template content or schedules')


  const fill = (name, value) => js(`(() => { const e=document.querySelector('.at-editor [name="'+${JSON.stringify(name)}+'"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});
    e.dispatchEvent(new Event('input',{bubbles:true})); })()`)
  await click('新建模板')
  await waitFor('!!document.querySelector(".at-editor")', 'new editor')
  const saveStart = saveCount
  await click('保存模板')
  await waitFor('document.querySelectorAll(".at-field-error").length === 2', 'required field explanations')
  assert.equal(saveCount, saveStart)
  assert.equal(await js('document.activeElement.name'), 'id')
  for (const id of ['a', 'a'.repeat(65), 'Daily-Report', '_daily', 'daily report', 'daily/report', 'daily-report']) {
    await fill('id', id)
    await waitFor('document.querySelector("[name=id]").getAttribute("aria-invalid") === "true"', 'invalid or duplicate ID')
    await click('保存模板'); assert.equal(saveCount, saveStart)
  }
  await fill('id', 'quarterly-review')
  for (const name of [' 　', '报'.repeat(81)]) {
    await fill('name', name)
    await waitFor('document.querySelector("[name=name]").getAttribute("aria-invalid") === "true"', 'invalid name')
    await click('保存模板'); assert.equal(saveCount, saveStart)
  }
  await shot('template-validation-errors')
  win.setSize(390, 800); await sleep(100)
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'))
  await shot('template-validation-errors-narrow')
  win.setSize(1280, 900)
  await fill('name', ' 季度总结 / 日報 주간 📊 ')
  await js(`(() => {const e=document.querySelector('.at-editor textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Summarize quarterly progress');
    e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  assert.equal(await js('document.querySelectorAll(".at-field-error").length'), 0)
  await click('保存模板')
  await waitFor('!document.querySelector(".at-editor") && document.querySelectorAll(".at-card").length === 3', 'valid creation')
  const createdCatalog = (await api('GET', '')).data.items
  const created = createdCatalog.find(item => item.id === 'quarterly-review')
  assert.equal(created.name, '季度总结 / 日報 주간 📊')
  await refreshClient(); assert.ok((await clientIds()).includes(created.id))
  assert.equal(saveCount, saveStart + 1)
  checks.push('Create form explains required, malformed, long and duplicate fields inline; no invalid request is sent; correcting permits one real creation')

  for (const invalid of [{id:'a'.repeat(65)}, {id:'Uppercase'}, {id:' daily'}, {id:'daily-report'},
    {name:' 　'}, {name:'报'.repeat(81)}, {name:'Invalid\nname'}, {name:'Invalid\u0000name'}, {name:['not a string']}]) {
    const response = await api('PUT', '', { items: [...createdCatalog, {...created, id:'bypass-check', ...invalid}] })
    assert.equal(response.status, 400, JSON.stringify(invalid))
    assert.ok(typeof response.data.detail === 'string' && response.data.detail.length > 0)
    assert.deepEqual((await api('GET', '')).data.items, createdCatalog)
  }
  checks.push('Direct API bypass also rejects malformed IDs, duplicate IDs and invalid names without changing persisted templates')

  for (const [locale, label] of [['en-US', 'Disable'], ['ja-JP', '無効化'], ['ko-KR', '사용 중지']]) {
    await js(`localStorage.setItem('soduwork.locale',${JSON.stringify(locale)})`)
    await win.loadURL(origin)
    await waitFor(toggleLabel + ' === ' + JSON.stringify(label), 'translated toggle ' + locale)
    const hint = await js('document.querySelector(".at-visibility-hint").textContent')
    assert.ok(hint && !hint.includes('停用后客户端'))
    await js('document.querySelector(".at-create").click()')
    await waitFor('!!document.querySelector(".at-editor")', 'localized editor')
    await js('document.querySelector(".at-dialog button[type=submit]").click()')
    await waitFor('document.querySelectorAll(".at-field-error").length === 2', 'localized validation')
    assert.ok(!await js('document.querySelector(".at-field-error").textContent.includes("请填写")'))
  }
  checks.push('English, Japanese and Korean toggle labels and explanatory copy render correctly')
  const forbidden = await fetch(fixture.url + '/api/v1/admin/automation-templates', {
    method: 'PUT', headers: { Authorization: 'Bearer ' + fixture.memberToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [] }),
  })
  assert.equal(forbidden.status, 403)
  assert.deepEqual((await api('GET', '')).data.items, createdCatalog)
  assert.equal(saveCount, 6)
  assert.deepEqual(await clientJs('errors'), [])
  assert.deepEqual(errors, [])
  checks.push('Existing authorization denies ordinary members; no client errors or duplicate saves')
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, checks, errors, realBackend: true, isolatedDatabase: true }, null, 2))
  console.log(JSON.stringify({ ok: true, checks, output }, null, 2))
  await cleanup(); app.exit(0)
}).catch(async error => {
  if (win) await shot('failure').catch(() => {})
  if (clientWin && !clientWin.isDestroyed()) console.error('Client errors:', await clientWin.webContents.executeJavaScript('window.errors || []').catch(() => []))
  console.error(error)
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: false, checks, error: String(error), errors }, null, 2))
  await cleanup(); app.exit(1)
})
