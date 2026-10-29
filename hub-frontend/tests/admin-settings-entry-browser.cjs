// Exercise the built admin shell and real API client against an isolated HTTP fixture.
// No business backend, repository provider or SMTP service is contacted.
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')
const output = path.resolve(root, '../outputs/admin-settings-entry-20261024')

if (!process.versions.electron) {
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key]
  const result = require('node:child_process').spawnSync(require('../../client/node_modules/electron'), [__filename],
    { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
  console.log(result.stdout || '')
  if (result.status !== 0) console.error(result.stderr || result.error)
  process.exitCode = result.status || (result.error ? 1 : 0)
} else {
  const { app, BrowserWindow, session } = require('electron')
  fs.mkdirSync(output, { recursive: true })
  app.setPath('userData', path.join(output, 'profile'))
  app.disableHardwareAcceleration()
  let server, win
  const calls = [], errors = [], checks = []
  const users = {
    admin: { id: 'fixture-admin', displayName: 'Test administrator', isSuper: true, permissions: [] },
    manager: { id: 'fixture-manager', displayName: 'Identity administrator', isSuper: false, permissions: ['identity.manage'] },
    member: { id: 'fixture-member', displayName: 'Test member', isSuper: false, permissions: ['task.view'] },
  }
  const mail = { enabled: false, host: 'smtp.qiye.aliyun.com', port: 465, security: 'ssl', username: '', senderAddress: '', senderName: 'SoduWork', ready: false, passwordConfigured: false }
  const row = { id: 'fixture-repo', provider: 'gitlab', displayName: 'Fixture repository', fullName: 'fixture/repository', defaultBranch: 'main', issueSync: { enabled: false } }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const js = code => win.webContents.executeJavaScript(code, true)
  async function wait(code, description) {
    for (let i = 0; i < 120; i++) { if (await js(code)) return; await sleep(50) }
    throw Error('Timed out: ' + description)
  }
  const navText = text => `[...document.querySelectorAll('.nav-item')].find(e => e.textContent.trim() === ${JSON.stringify(text)})`
  async function shot(name) {
    await sleep(150)
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  app.whenReady().then(async () => {
    assert.ok(fs.existsSync(path.join(dist, 'index.html')), 'Run npm run build first')
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
      if (url.pathname === '/healthz') return json({ ok: true, version: 'fixture' })
      if (url.pathname.startsWith('/api/')) {
        const role = String(req.headers.authorization || '').replace('Bearer fixture-', '')
        calls.push({ method: req.method, path: url.pathname, role })
        if (!users[role]) return json({ detail: 'Fixture authentication required' }, 401)
        if (req.method !== 'GET') return json({ detail: 'Mutations are not allowed in the navigation fixture' }, 405)
        if (url.pathname === '/api/v1/admin/me') return json(users[role])
        if (url.pathname === '/api/v1/admin/repository-catalog') return json({ items: [row] })
        if (url.pathname === '/api/v1/admin/integrations') return json([{ id: 'fixture-source', name: 'Fixture GitLab', type: 'gitlab', enabled: true }])
        if (url.pathname === '/api/v1/admin/repository-catalog/fixture-repo/issue-sync') return json({ enabled: false, startedLabel: '处理中', members: [], writebacks: [] })
        if (url.pathname === '/api/v1/admin/mail-settings') return json(mail)
        if (url.pathname === '/api/v1/admin/account-legal') return json({ operatorName: '', contactEmail: '' })
        if (['/api/v1/admin/mail-deliveries', '/api/v1/admin/account-privacy-requests'].includes(url.pathname)) return json({ items: [] })
        if (url.pathname.endsWith('/delivery-board')) return json({})
        return json([])
      }
      if (url.pathname === '/') {
        const role = users[url.searchParams.get('role')] ? url.searchParams.get('role') : 'admin'
        const seed = `<script>localStorage.setItem('soduwork_hub_admin_token',${JSON.stringify('fixture-' + role)});localStorage.setItem('soduwork_hub_admin_user',${JSON.stringify(JSON.stringify(users[role]))});if(!sessionStorage.getItem('soduwork-hub-screen'))sessionStorage.setItem('soduwork-hub-screen','repositories');</script>`
        res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' })
        res.end(fs.readFileSync(path.join(dist, 'index.html'), 'utf8').replace('<head>', '<head>' + seed))
        return
      }
      const target = path.resolve(dist, '.' + decodeURIComponent(url.pathname))
      if (!target.startsWith(dist + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.writeHead(404); res.end(); return }
      res.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'image/png')
      res.end(fs.readFileSync(target))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = 'http://127.0.0.1:' + server.address().port
    const isolated = session.fromPartition('admin-entry-' + Date.now())
    isolated.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('data:') }))
    win = new BrowserWindow({ show: false, width: 1480, height: 1120, webPreferences: { session: isolated, offscreen: true, backgroundThrottling: false } })
    win.webContents.on('console-message', event => { if (/Uncaught|React error/.test(event.message)) errors.push(event.message) })
    await win.loadURL(origin)
    await wait('document.querySelectorAll(".rc-row").length === 1', 'repository catalog in real shell')
    assert.ok(await js(`!!${navText('账户与安全')}`), 'Administrator navigation includes account security')
    await js(`(()=>{const button=${navText('账户与安全')};button.scrollIntoView({block:'center'});button.click()})()`)
    await wait('!!document.querySelector(".mail-fields")', 'mail page through sidebar')
    assert.equal(await js('document.querySelector(".app").dataset.screen'), 'account-security')
    assert.ok(await js('document.querySelector(".mail-settings").textContent.includes("填入阿里邮箱配置")'))
    await shot('account-security-desktop')
    checks.push('Built administrator shell exposes Account and security; clicking opens the actual mail settings page')
    await win.loadURL(origin)
    await wait('!!document.querySelector(".mail-fields")', 'restored account page after reload')
    assert.equal(await js('document.querySelector(".app").dataset.screen'), 'account-security')
    checks.push('Reload restores the selected account settings page')
    await js(`(${navText('仓库目录')}).click()`)
    await wait('document.querySelectorAll(".rc-row").length === 1', 'return to repository catalog')
    await js('[...document.querySelectorAll(".rc-row-actions button")].find(e=>e.textContent.trim()==="配置 Issue 同步").click()')
    await wait('!!document.querySelector(".rc-issue-toggle")', 'Issue settings from catalog')
    await shot('issue-sync-desktop')
    checks.push('Built catalog exposes Issue sync configuration and opens the actual settings dialog')
    await js("sessionStorage.setItem('soduwork-hub-screen','account-security')")
    await win.loadURL(origin + '/?role=member')
    await wait('document.querySelector(".app")?.dataset.screen === "overview"', 'unauthorized route fallback')
    assert.equal(await js(`!!${navText('账户与安全')}`), false)
    assert.equal(await js('!!document.querySelector(".mail-fields")'), false)
    assert.equal(calls.filter(c => c.role === 'member' && c.path.includes('mail-')).length, 0)
    await js(`(${navText('仓库目录')}).click()`)
    await wait('document.querySelectorAll(".rc-row").length === 1', 'member repository catalog')
    assert.equal(await js('[...document.querySelectorAll(".rc-row-actions button")].some(e=>e.textContent.includes("Issue"))'), false)
    assert.equal(calls.filter(c => c.role === 'member' && c.path.endsWith('/integrations')).length, 0)
    checks.push('Members cannot see or restore account settings or configure Issue sync; catalog remains readable without integrations requests')
    await js("sessionStorage.setItem('soduwork-hub-screen','account-security')")
    await win.loadURL(origin + '/?role=manager')
    await wait('!!document.querySelector(".mail-fields")', 'scoped identity administrator')
    assert.ok(await js(`!!${navText('账户与安全')}`))
    checks.push('identity.manage permission grants account settings without requiring superadministrator')
    assert.deepEqual(errors, [])
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, checks, errors,
      boundary: 'Built React App, real API client and Chromium with isolated HTTP fixture; no live SMTP, GitLab, GitHub or business database' }, null, 2))
    console.log(JSON.stringify({ ok: true, checks, output }))
    win.destroy(); server.close(); app.exit(0)
  }).catch(error => { console.error(error); win?.destroy(); server?.close(); app.exit(1) })
}
