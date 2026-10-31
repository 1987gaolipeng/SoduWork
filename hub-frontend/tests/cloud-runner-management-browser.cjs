// Real admin renderer/login/API with disposable DB. No business host is touched.
const { app, BrowserWindow, session } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const output = path.resolve(root, '../outputs/cloud-runner-admin-20261015')
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, 'profile'))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {}) // Cleanup owns process termination.
let backend, server, win, fixture, token
const checks = [], errors = []
const trace = message => { if (process.env.SODUWORK_E2E_TRACE) console.error('[cleanup] ' + message) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = code => win.webContents.executeJavaScript(code, true)
async function waitFor(code, name) {
  for (let i = 0; i < 200; i++) { if (await js(code)) return; await sleep(50) }
  throw Error('Timed out: ' + name)
}
async function point(code) {
  await waitFor(`(() => {const e=(${code});return !!e&&!e.disabled&&e.getClientRects().length>0})()`, 'native click target: ' + code)
  // Resizing and scrolling settle asynchronously in the real renderer. Await
  // layout before computing native coordinates; keep missing targets as failures.
  const b = await js(`(async () => {const e=(${code});if(!e)throw Error('Missing native click target: '+${JSON.stringify(code)});e.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));if(!e.isConnected||e.disabled)throw Error('Native click target changed: '+${JSON.stringify(code)});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...b })
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...b })
  await sleep(80)
}
const click = text => point(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)})`)
async function input(selector, value) {
  await point(`document.querySelector(${JSON.stringify(selector)})`)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
  await win.webContents.insertText(value)
  await sleep(80)
}
async function api(method, route, body, authorization = 'Bearer ' + token) {
  const response = await fetch(fixture.url + '/api/v1' + route, { method,
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, data: await response.json() }
}
async function shot(name) {
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG())
}
function startBackend() {
  backend = spawn(path.resolve(root, '../hub-backend/.venv/Scripts/python.exe'),
    ['-X', 'utf8', '-u', 'tests/cloud_runner_admin_server.py'],
    { cwd: path.resolve(root, '../hub-backend'), windowsHide: true })
  return new Promise((resolve, reject) => {
    let buffer = '', diagnostic = ''
    const timer = setTimeout(() => reject(Error('Fixture startup timeout: ' + diagnostic)), 60000)
    backend.stderr.on('data', b => { diagnostic += String(b) })
    backend.on('error', reject)
    backend.on('exit', code => { clearTimeout(timer); if (!fixture) reject(Error('Fixture exited ' + code + ': ' + diagnostic)) })
    backend.stdout.on('data', b => {
      buffer += String(b)
      for (const line of buffer.split('\n')) {
        try { const row = JSON.parse(line); if (row.ready && row.fixtureOnly) { fixture = row; clearTimeout(timer); resolve(); return } } catch {}
      }
    })
  })
}
async function cleanup() {
  trace('start')
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.stop()
      await win.webContents.session.closeAllConnections()
      trace('connections closed')
    }
    if (backend?.pid) {
      // This isolated fixture needs a bounded wait, independent of Electron's
      // child-process callbacks during renderer shutdown.
      const result = spawnSync('taskkill', ['/PID', String(backend.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore', timeout: 15000 })
      if (result.error) throw result.error
      if (result.status !== 0) {
        try { process.kill(backend.pid, 0) } catch (error) {
          if (result.status === 128 && error.code === 'ESRCH') return
          throw error
        }
        throw Error('Fixture backend cleanup failed: taskkill exit ' + result.status)
      }
      trace('backend stopped')
    }
  } finally {
    backend?.stdin?.destroy(); backend?.stdout?.destroy(); backend?.stderr?.destroy()
    server?.closeAllConnections(); server?.close()
    trace('server closed')
    if (win && !win.isDestroyed()) win.destroy()
    trace('window destroyed')
  }
  trace('cleanup finished')
}
async function finish(error) {
  try { await cleanup() } catch (cleanupError) {
    console.error(cleanupError)
    error = error || cleanupError
  }
  const result = { ok: !error, checks, realApi: true, isolatedDatabase: true,
    remoteHostExecuted: false, ...(error ? { error: String(error), errors } : {}) }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ...result, output }))
  // The parent owns the Electron process lifecycle. Only this live IPC message,
  // sent after assertions and API cleanup, may authorize successful shutdown.
  if (process.send) process.send({ type: 'soduwork-cloud-runner-admin-complete', result })
  else app.exit(result.ok ? 0 : 1)
}
app.whenReady().then(async () => {
  await startBackend()
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
      const upstream = http.request(fixture.url + req.url, { method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res)
      })
      upstream.on('error', () => { res.writeHead(502); res.end() }); req.pipe(upstream); return
    }
    const relative = url.pathname === '/' || url.pathname === '/admin' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
    const file = path.resolve(root, 'dist', relative)
    if (!file.startsWith(path.resolve(root, 'dist') + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
    let body = fs.readFileSync(file)
    if (relative === 'index.html') body = Buffer.from(body.toString().replace('<head>', '<head><script>sessionStorage.setItem("soduwork-hub-screen","clients");sessionStorage.setItem("soduwork-execution-tab","runners");localStorage.setItem("soduwork.locale","zh-CN")</script>'))
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); res.end(body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const isolated = session.fromPartition('cloud-runner-admin-' + Date.now())
  isolated.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('data:') }))
  win = new BrowserWindow({ show: false, width: 1440, height: 950,
    webPreferences: { session: isolated, backgroundThrottling: false } })
  win.webContents.on('console-message', event => { if (/Uncaught|React error/.test(event.message)) errors.push(event.message) })
  await win.loadURL(origin + '/admin')
  await waitFor('document.body.textContent.includes("进入管理后台")', 'landing')
  await point(`[...document.querySelectorAll('button')].find(e=>e.textContent.includes('进入管理后台'))`)
  await waitFor('!!document.querySelector("input[name=username]")', 'login form')
  await input('input[name=username]', fixture.username)
  await input('input[name=password]', fixture.password)
  await point('document.querySelector("button[type=submit]")')
  await waitFor('document.body.textContent.includes("Runner 执行机")', 'authenticated execution network')
  await point(`[...document.querySelectorAll('button[role=tab]')].find(e=>e.querySelector('b')?.textContent==='Runner 执行机')`)
  await waitFor('!!document.querySelector(".rb-card")', 'authenticated Runner board')
  token = await js('localStorage.getItem("soduwork_hub_admin_token")')
  assert.ok(token)
  await waitFor('document.querySelector(".rb-card").textContent.includes("Personal cloud")', 'personal row')
  checks.push('Real form login and scoped personal-host inventory')
  await click('停用'); await waitFor('!!document.querySelector(".modal")', 'disable confirmation')
  await click('继续')
  await waitFor('document.querySelector(".rb-card").textContent.includes("管理员已停用")', 'disabled status')
  assert.equal((await api('PATCH', '/cloud-environments/' + fixture.originalRunner, { mode: 'accepting' }, fixture.deviceToken)).status, 409)
  await click('重新分配')
  await waitFor('!!document.querySelector(".cloud-runner-management")', 'transfer modal')
  await input('.cloud-runner-management input', 'Cloud recipient')
  await waitFor('document.querySelector(".cloud-runner-management select").options.length===2 && !document.querySelector(".cloud-runner-management select").disabled', 'assignee search')
  await point('document.querySelector(".cloud-runner-management select")')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await waitFor(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='确认分配'&&!b.disabled)`, 'selected recipient')
  await shot('handover-confirm')
  await click('确认分配')
  await waitFor('!document.querySelector(".cloud-runner-management") && document.querySelector(".rb-card").textContent.includes("待安全接入")', 'handover saved')
  assert.equal((await api('GET', '/cloud-environments', undefined, fixture.deviceToken)).data.environments.length, 0)
  const rows = (await api('GET', '/admin/runners')).data.items
  const transferred = rows.find(r => r.ownerUserId === fixture.targetUser)
  assert.ok(transferred && transferred.runnerId !== fixture.originalRunner)
  assert.ok(!rows.some(r => r.runnerId === fixture.originalRunner))
  checks.push('Disable cannot be overridden by old owner; transfer retires old ID and keeps new ID pending')
  await click('安全接入'); await waitFor('!!document.querySelector(".crm-check")', 'clean setup form')
  assert.ok(await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='生成接入命令').disabled`))
  win.setSize(620, 800); await sleep(150)
  assert.ok(await js('document.querySelector(".cloud-runner-management").getBoundingClientRect().right <= innerWidth'), 'dialog fits viewport')
  await shot('safe-setup-narrow')
  win.setSize(1440, 950)
  await point('document.querySelector(".crm-check input")')
  await input('.crm-field input', '/srv/recipient/workspace')
  await click('生成接入命令')
  await waitFor('!!document.querySelector(".crm-command")', 'new identity setup command')
  assert.ok(await js(`document.querySelector('.crm-command').value.includes(${JSON.stringify(transferred.runnerId)})`))
  await click('关闭')
  await waitFor('!document.querySelector(".cloud-runner-management")', 'setup close')
  await click('启用'); await waitFor('!!document.querySelector(".modal")', 'enable confirmation'); await click('继续')
  await waitFor(`(function(){const b=[...document.querySelectorAll('.rb-acts button')].find(b=>b.textContent.trim()==='停用');return !!b})()`, 'enabled controls')
  const enabled = (await api('GET', '/admin/runners')).data.items.find(r => r.runnerId === transferred.runnerId)
  assert.equal(enabled.managementState, ''); assert.equal(enabled.mode, 'accepting')
  await shot('management-result')
  checks.push('Cleanup acknowledgement and independent directory required; generate new enrollment and explicitly enable')
  assert.deepEqual(errors, [])
  await finish()
}).catch(async error => {
  if (win) await shot('failure').catch(() => {})
  console.error(error)
  await finish(error)
})
