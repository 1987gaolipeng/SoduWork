// Real renderer + real authenticated API + disposable SQLite. No business data.
const { app, BrowserWindow, session } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const output = path.resolve(root, '../outputs/org-memory-singleton')
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, 'profile'))
app.disableHardwareAcceleration()
let backend, server, win, fixture
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
async function chooseOrg(label) {
  const labelJson = JSON.stringify(label)
  await js("(() => { const t=document.querySelector('.om-org-select .select-menu-trigger'); if(!t) throw Error('Missing org selector trigger'); t.click() })()")
  await waitFor('!!document.querySelector(".om-org-select .select-menu-popover [role=\\"option\\"]")', 'org options open')
  await js('(() => { const options=[...document.querySelectorAll(\'.om-org-select .select-menu-popover [role="option"]\')]; const target=options.find((option)=>option.textContent.trim()===' + labelJson + '); if(!target) throw Error("Missing option: " + ' + labelJson + '); target.click() })()')
}
async function input(selector, value) {
  await js(`(() => {const e=document.querySelector(${JSON.stringify(selector)});const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
}
async function api(method, route, body) {
  const response = await fetch(fixture.url + '/api/v1/admin/org-memory' + route, {
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
  backend = spawn(python, ['-u', 'tests/org_memory_server.py'], { cwd: path.resolve(root, '../hub-backend'), windowsHide: true })
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
    if (relative === 'index.html') body = Buffer.from(body.toString().replace('<head>', `<head><script>localStorage.setItem('soduwork_hub_admin_token',${JSON.stringify(fixture.token)});localStorage.setItem('soduwork_hub_admin_user',${JSON.stringify(JSON.stringify(user))});sessionStorage.setItem('soduwork-hub-screen','org-memory');localStorage.setItem('soduwork.locale','zh-CN')</script>`))
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); res.end(body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const isolated = session.fromPartition('org-memory-test-' + Date.now())
  isolated.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('data:') }))
  win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { session: isolated, offscreen: true, backgroundThrottling: false } })
  win.webContents.on('console-message', event => { if (/Uncaught|React error/.test(event.message)) errors.push(event.message) })
  await win.loadURL(origin)
  await waitFor('!!document.querySelector(".om-empty")', 'empty state with archived record')
  assert.equal((await api('GET', '')).data.items.length, 0)
  await click('补充与修正')
  await waitFor('!!document.querySelector(".om-editor")', 'create editor')
  await input('.om-editor input', '团队共同记忆')
  await input('.om-editor textarea', '统一交付标准，每次交付都要验证结果。')
  await input('.om-editor label:nth-child(3) textarea', '共同目标：稳定交付')
  await input('.om-editor label:nth-child(5) textarea', '约束：保护客户资料')
  await click('保存组织记忆')
  await waitFor('!!document.querySelector(".om-document") && !document.querySelector(".om-editor")', 'save new memory')
  let record = (await api('GET', '')).data.items[0]
  const id = record.id
  assert.notEqual(id, 'fixture-archived')
  assert.equal(record.revision, 1)
  assert.equal(await js('document.querySelectorAll(".om-document").length'), 1)
  assert.ok(await js('document.querySelector(".om-document").textContent.includes("共同目标：稳定交付")'))
  checks.push('Create beside archived default without reviving history; display all structured fields')
  await shot('organization-memory-desktop')
  await click('补充与修正')
  await waitFor('!!document.querySelector(".om-editor")', 'edit editor')
  await input('.om-editor textarea', '更新后的统一标准：完成后核对验收证据。')
  await click('保存组织记忆')
  await waitFor('!document.querySelector(".om-editor")', 'save existing memory')
  record = (await api('GET', '')).data.items[0]
  assert.equal(record.id, id); assert.equal(record.revision, 2)
  await win.loadURL(origin)
  await waitFor('!!document.querySelector(".om-document")', 'reopen')
  assert.equal(await js('document.querySelectorAll(".om-document").length'), 1)
  assert.ok(await js('document.querySelector(".om-document").textContent.includes("更新后的统一标准")'))
  checks.push('Edit retains ID and increments revision; reload still shows one current document')
  await click('补充与修正')
  await waitFor('!!document.querySelector(".om-editor")', 'conflict editor')
  await input('.om-editor textarea', '此处草稿在冲突后必须保留')
  assert.equal((await api('PUT', '/' + id, { confirmed: true, revision: 2, fields: { summary: 'Another administrator updated this memory' } })).status, 200)
  await click('保存组织记忆')
  await waitFor('document.body.textContent.includes("保存失败")', 'conflict surfaced')
  assert.equal(await js('document.querySelector(".om-editor textarea").value'), '此处草稿在冲突后必须保留')
  assert.equal((await api('GET', '')).data.items[0].revision, 3)
  await click('取消')
  await click('重新加载')
  await waitFor('document.querySelector(".om-document").textContent.includes("Another administrator")', 'reload winner')
  checks.push('Concurrent change rejects stale save and preserves the unsaved draft')
  win.setSize(390, 720); await sleep(180)
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), 'narrow screen cannot overflow horizontally')
  await shot('organization-memory-mobile')
  checks.push('390px viewport retains one readable document without horizontal overflow')
  win.setSize(1280, 900)
  await click('删除')
  await waitFor('!!document.querySelector(".modal")', 'delete confirmation')
  await js('document.querySelector(".modal .btn-danger").click()')
  await waitFor('!!document.querySelector(".om-empty")', 'current deleted')
  assert.equal((await api('GET', '')).data.items.length, 0)
  const history = (await api('GET', '?archived=true')).data.items
  assert.equal(history.length, 1); assert.equal(history[0].summary, 'Historical fixture content')
  await click('补充与修正')
  await waitFor('!!document.querySelector(".om-editor")', 'recreate editor')
  await input('.om-editor textarea', '新的当前组织记忆')
  await click('保存组织记忆')
  await waitFor('!!document.querySelector(".om-document")', 'recreated')
  const recreated = (await api('GET', '')).data.items
  assert.equal(recreated.length, 1); assert.notEqual(recreated[0].id, 'fixture-archived'); assert.notEqual(recreated[0].id, id)
  checks.push('Delete and recreate preserve archived content and never revive it as current')

  const shared = async action => {
    const response = await fetch(fixture.url + '/_fixture/work/' + action, { method: 'POST',
      headers: { Authorization: 'Bearer ' + fixture.token } })
    assert.equal(response.status, 200)
    return response.json()
  }
  const complete = await shared('complete')
  assert.equal(complete.item.sourceCount, 2)
  assert.doesNotMatch(complete.prompt, /其他组织隔离内容/)
  await click('重新加载')
  await waitFor('!!document.querySelector(".om-automatic")', 'automatic team work appears')
  assert.ok(await js('document.querySelector(".om-automatic").textContent.includes("2 项共享工作")'))
  assert.ok(await js('document.querySelector(".om-automatic").textContent.includes("月度交付规范")'))
  await click('补充与修正')
  await waitFor('!!document.querySelector(".om-editor")', 'manual corrections only')
  assert.equal(await js('document.querySelector(".om-editor textarea").value'), '新的当前组织记忆')
  assert.ok(!await js('document.querySelector(".om-editor textarea").value.includes("月度交付规范")'))
  await input('.om-editor textarea', '团队修正：验收记录需要复核人签字')
  await click('保存组织记忆')
  await waitFor('!document.querySelector(".om-editor")', 'corrections saved')
  await win.loadURL(origin)
  await waitFor('!!document.querySelector(".om-automatic")', 'automatic memory survives reopen')
  assert.ok(await js('document.querySelector(".om-document").textContent.includes("复核人签字")'))
  const clientContext = await fetch(fixture.url + '/api/v1/memories/organization-context', {
    headers: { Authorization: 'Device ' + fixture.deviceToken },
  })
  assert.equal(clientContext.status, 200)
  assert.match((await clientContext.json()).prompt, /复核人签字/)
  await shot('organization-memory-automatic')
  checks.push('Two real team task completions aggregate automatically, remain separate from editable corrections, and reach device conversation context')
  // Superadministrators can browse another organization's memory from the header.
  await waitFor('!!document.querySelector(".om-org-select")', 'organization selector appears')
  await chooseOrg('Other isolated organization')
  await waitFor('!!document.querySelector(".om-document") && document.body.textContent.includes("其他组织隔离内容")', 'other organization memory loads')
  assert.ok(await js('document.querySelector(".om-automatic").textContent.includes("1 项共享工作")'))
  checks.push('Organization selector loads another organization memory for superadministrators')
  await chooseOrg('Isolated organization')
  await waitFor('document.body.textContent.includes("复核人签字")', 'own organization memory restored')
  checks.push('Switching back to the own organization restores its current memory')

  const withdrawn = await shared('withdraw')
  assert.equal(withdrawn.item.sourceCount, 1); assert.doesNotMatch(withdrawn.prompt, /月度交付规范/)
  await click('重新加载')
  await waitFor('document.querySelector(".om-automatic").textContent.includes("1 项共享工作")', 'withdrawn source removed')
  assert.ok(!await js('document.querySelector(".om-automatic").textContent.includes("月度交付规范")'))
  const beforeForget = (await api('GET', '')).data.items[0]
  assert.equal((await api('DELETE', '/' + beforeForget.id)).status, 200)
  assert.equal((await api('GET', '')).data.items.length, 0)
  const future = await shared('new')
  assert.equal(future.item.sourceCount, 1)
  assert.match(future.prompt, /后续新完成/); assert.doesNotMatch(future.prompt, /回归验收流程|月度交付规范|复核人签字/)
  checks.push('Withdrawal removes outdated facts; deleting forgets old sources while future completed work can form new memory')

  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, checks, errors, realBackend: true, isolatedDatabase: true }, null, 2))
  console.log(JSON.stringify({ ok: true, checks, output }, null, 2))
  await cleanup(); app.exit(0)
}).catch(async error => {
  if (win) await shot('failure').catch(() => {})
  console.error(error)
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: false, checks, error: String(error), errors }, null, 2))
  await cleanup(); app.exit(1)
})
