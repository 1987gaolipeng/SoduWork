// Runs the built admin page in isolated Electron with synthetic API responses.
// No Hub, provider requests, business data, or installed client profile is used.
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const output = path.resolve(process.argv[2] || path.join(root, '../outputs/model-catalog-layout'))
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, 'profile'))
app.disableHardwareAcceleration()
const user = { id: 'fixture', username: 'fixture', displayName: 'Fixture Admin', isSuper: true, permissions: [] }
const providers = Array.from({ length: 10 }, (_, i) => ({ id: 'builtin-' + i, name: 'Builtin service ' + i,
  builtin: true, enabled: true, revision: 'fixture', baseUrl: 'https://example.invalid/v1', keySet: false }))
providers.push({ id: 'custom', name: 'ZZ custom service', builtin: false, enabled: true, revision: 'fixture',
  baseUrl: 'https://example.invalid/v1', keySet: true, keyLen: 16 })
const catalog = { providers, models: [{ id: 'fixture-model', providerId: 'custom', name: 'fixture-model', enabled: true, config: {} }] }
catalog.models[0].capabilityProfile = {
  imageInput: { state: 'supported', source: 'verified' }, toolCalling: { state: 'unknown', source: 'unknown' },
  streaming: { state: 'supported', source: 'verified' },
}
catalog.models[0].capabilityCheck = { checkedAt: '2026-11-16T08:11:58Z', checks: {
  connection: { status: 'passed' }, imageInput: { status: 'passed' },
  toolCalling: { status: 'inconclusive', code: 'invalid_response' }, streaming: { status: 'passed' },
} }
providers[9].name = 'A very long provider name / 长名称服务 / 長いサービス名 / 긴 서비스 이름'
providers[9].baseUrl += '/a-long-path-for-layout-verification'
providers[9].note = 'A long provider note / 服务说明必须可查看且不能撑破卡片 / サービスの説明'
const policy = { globalConcurrent: 16, queueSize: 8, providers: {}, models: {} }
const runtime = { policy, running: 2, queued: 1, lastHour: { started: 1, waitMs: 50 },
  groups: [{ provider: 'custom', model: 'fixture-model', running: 2, queued: 1 }] }
const results = [], errors = [], requests = []
let win, server
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = code => win.webContents.executeJavaScript(code, true)
async function wait(code, label) {
  for (let i = 0; i < 150; i++) { if (await js(code)) return; await sleep(40) }
  throw Error('Timeout: ' + label)
}
async function screenshot(name) {
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await sleep(100)
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG())
}
async function resetScroll() { await js('window.scrollTo(0,0); document.querySelector(".content").scrollTop=0') }
async function geometry() {
  return js(`(() => {
    const overview = document.querySelector('.model-runtime'), list = document.querySelector('.model-provider-grid');
    const rect = overview.getBoundingClientRect(), lr = list.getBoundingClientRect();
    return { viewport: [innerWidth,innerHeight], pageWidth: document.documentElement.scrollWidth,
      height: rect.height, listHeight: lr.height, top: lr.top,
      columns: getComputedStyle(list).gridTemplateColumns.split(' ').length,
      cardHeight: document.querySelector('.model-provider').getBoundingClientRect().height,
      overflow: [...document.querySelectorAll('.model-provider')].some(e => e.scrollWidth > e.clientWidth + 1),
      closed: document.querySelector('.model-runtime-overview-body').hidden,
      first: document.querySelector('.model-provider h3').textContent,
      stats: [...document.querySelectorAll('.model-runtime-quick-stats dd')].map(e => e.textContent),
      toggle: document.querySelector('.model-runtime-overview-toggle').textContent };
  })()`)
}
app.whenReady().then(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'), key = url.pathname.replace(/^\/api\/v1/, '')
    if (url.pathname.startsWith('/api/') || key === '/healthz') {
      requests.push({ method: req.method, key })
      if (req.method === 'POST' && key === '/admin/model-providers/custom/discover') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, models: ['synthetic-discovered-model'] })); return
      }
      if (req.method === 'PUT' && key === '/admin/model-providers/custom') {
        let body = ''; for await (const chunk of req) body += chunk
        const payload = JSON.parse(body)
        assert.equal(payload.expectedRevision, 'fixture')
        assert.equal(typeof payload.enabled, 'boolean')
        providers.find(p => p.id === 'custom').enabled = payload.enabled
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return
      }
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
      const response = key === '/admin/me' ? user : key === '/admin/model-catalog' ? catalog :
        key === '/admin/model-runtime' ? runtime : key === '/healthz' ? { ok: true } : []
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response)); return
    }
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
    const file = path.resolve(root, 'dist', relative)
    if (!file.startsWith(path.resolve(root, 'dist') + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
    let data = fs.readFileSync(file)
    if (relative === 'index.html') data = Buffer.from(data.toString().replace('<head>', `<head><script>
      localStorage.setItem('soduwork_hub_admin_token','fixture');
      localStorage.setItem('soduwork_hub_admin_user',${JSON.stringify(JSON.stringify(user))});
      sessionStorage.setItem('soduwork-hub-screen','models');
      if(!localStorage.getItem('soduwork.locale'))localStorage.setItem('soduwork.locale','zh-CN');
    </script>`))
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(data)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const isolated = session.fromPartition('model-catalog-layout-' + Date.now())
  isolated.webRequest.onBeforeRequest((request, done) => done({ cancel: !request.url.startsWith(origin + '/') && !request.url.startsWith('data:') }))
  win = new BrowserWindow({ show: false, width: 1512, height: 982, useContentSize: true,
    webPreferences: { session: isolated, offscreen: true, backgroundThrottling: false } })
  win.webContents.on('console-message', event => { if (/Uncaught|React error/.test(event.message)) errors.push(event.message) })
  await win.loadURL(origin)
  await wait('document.querySelectorAll(".model-provider").length===11 && document.querySelector(".model-runtime-quick-stats").textContent.includes("2")', 'catalog loaded')
  const labels = { 'zh-CN': '展开概览', 'en-US': 'Expand overview', 'ja-JP': '概要を展開', 'ko-KR': '개요 펼치기' }
  for (const [locale, label] of Object.entries(labels)) {
    await js(`localStorage.setItem('soduwork.locale',${JSON.stringify(locale)});window.dispatchEvent(new StorageEvent('storage',{key:'soduwork.locale',newValue:${JSON.stringify(locale)}}))`)
    for (const [width, height, columns] of [[1920,1080,4], [1512,982,3], [1280,800,2], [390,844,1]]) {
      win.setContentSize(width, height); await sleep(180); await resetScroll()
      const result = await geometry()
      assert.equal(result.closed, true)
      assert.equal(result.first, 'ZZ custom service')
      assert.deepEqual(result.stats, ['11', '1', '2', '1'])
      assert.ok(result.toggle.includes(label), locale)
      assert.ok(result.pageWidth <= result.viewport[0] + 1, JSON.stringify(result))
      assert.equal(result.columns, columns, JSON.stringify(result))
      assert.equal(result.overflow, false, JSON.stringify(result))
      assert.ok(result.cardHeight < 300, JSON.stringify(result))
      if (width === 1512) { assert.ok(result.height < 180, JSON.stringify(result)); assert.ok(result.listHeight > 500, JSON.stringify(result)) }
      results.push({ locale, width, ...result })
      await screenshot('compact-' + locale + '-' + width)
      const positions = () => js(`Array.from(document.querySelectorAll('.model-provider-grid > .model-provider'), e => {
        const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height];
      })`)
      const before = await positions()
      await js('document.querySelector(".model-cloud-toggle").click()')
      await wait('document.querySelector(".model-provider-dialog")', 'model detail dialog')
      assert.deepEqual(await positions(), before, 'opening details keeps the grid stable')
      assert.ok(await js(`(() => {
        const card=document.querySelector('.model-provider-dialog .model-chip'), badges=card.querySelector('.model-cap-badges');
        const style=getComputedStyle(card);
        return badges.getBoundingClientRect().width >= card.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-1;
      })()`), 'capability badges fill the model row')
      await js('document.querySelector(".model-cap-report summary").click()')
      assert.ok(await js(`(() => {
        const report=document.querySelector('.model-cap-report'), list=report.querySelector('dl');
        return report.open && list.getBoundingClientRect().width >= report.clientWidth-2;
      })()`), 'capability report uses available width')
      assert.ok(await js(`(() => {
        const dialog = document.querySelector('.model-provider-dialog'), r=dialog.getBoundingClientRect();
        return r.left>=0 && r.right<=innerWidth+1 && r.top>=0 && r.bottom<=innerHeight+1 && dialog.scrollWidth<=dialog.clientWidth+1;
      })()`), 'details fit viewport')
      if (width === 1512 || width === 390) await screenshot('model-details-' + locale + '-' + width)
      // Configuration and deletion keep the parent detail dialog mounted.
      await js('document.querySelector(".model-provider-dialog .model-chip-actions button").focus();document.querySelector(".model-provider-dialog .model-chip-actions button").click()')
      await wait('document.querySelectorAll(".modal").length===2', 'nested model configuration')
      await js('[...document.querySelectorAll(".modal")].at(-1).querySelector(".mx").click()')
      await wait('document.querySelectorAll(".modal").length===1', 'return to details')
      assert.equal(await js('document.activeElement===document.querySelector(".model-provider-dialog .model-chip-actions button")'), true)
      await js('document.querySelector(".model-provider-dialog .is-danger").focus();document.querySelector(".model-provider-dialog .is-danger").click()')
      await wait('document.querySelectorAll(".modal").length===2', 'nested model deletion confirmation')
      await js('[...document.querySelectorAll(".modal")].at(-1).querySelector(".mx").click()')
      await js('document.querySelector(".model-provider-dialog .modal-foot .btn-primary").focus();document.querySelector(".model-provider-dialog .modal-foot .btn-primary").click()')
      await wait('document.querySelectorAll(".modal").length===2', 'add model from details')
      await js('[...document.querySelectorAll(".modal")].at(-1).querySelector(".mx").click()')
      await js('document.querySelector(".model-provider-dialog .mx").click()')
      await wait('!document.querySelector(".modal")', 'details close')
      assert.deepEqual(await positions(), before, 'closing details keeps the grid stable')
      assert.equal(await js('document.activeElement===document.querySelector(".model-cloud-toggle")'), true)
      assert.equal((await geometry()).columns, columns)
    }
    win.setContentSize(1512,982); await sleep(120)
    await js('document.querySelector(".model-runtime-overview-toggle").focus()')
    // Hidden renderers do not reliably dispatch native keyboard input. Verify
    // focusability and the real click handler, without claiming native keys.
    assert.equal(await js('document.activeElement === document.querySelector(".model-runtime-overview-toggle")'), true)
    await js('document.querySelector(".model-runtime-overview-toggle").click()')
    await wait('!document.querySelector(".model-runtime-overview-body").hidden', 'overview opens')
    assert.equal(await js('document.querySelectorAll(".model-runtime-metrics > section").length'), 3)
    await screenshot('expanded-' + locale)
    await js('document.querySelector(".model-runtime-services-head").click()')
    await wait('!document.querySelector(".model-runtime-services-body").hidden', 'request groups open')
    assert.ok(await js('document.querySelector(".model-runtime-table").textContent.includes("fixture-model")'))
    await js('document.querySelector(".model-runtime-services-head").click()')
    await js('document.querySelector(".model-runtime-overview-toggle").click()')
    await wait('document.querySelector(".model-runtime-overview-body").hidden', 'overview closes')
  }
  // A real reload discards the temporary new-provider marker, not custom-first order.
  await win.loadURL(origin)
  await wait('document.querySelectorAll(".model-provider").length===11', 'reloaded catalog')
  assert.equal((await geometry()).first, 'ZZ custom service')
  assert.equal((await geometry()).closed, true)
  runtime.running = 5
  await wait('document.querySelectorAll(".model-runtime-quick-stats dd")[2]?.textContent==="5"', 'collapsed summary keeps polling')
  assert.ok(requests.every(request => request.method === 'GET'), 'rendering must not mutate settings')
  // Exercise the actual card entry points against the isolated fixture server.
  await js(`localStorage.setItem('soduwork.locale','zh-CN');window.dispatchEvent(new StorageEvent('storage',{key:'soduwork.locale',newValue:'zh-CN'}))`)
  for (const [index, title] of [[0,'加一个模型'],[1,'从服务发现模型'],[2,'配置「ZZ custom service」']]) {
    await js(`document.querySelectorAll('.model-provider .model-card-action-group button')[${index}].click()`)
    await wait('document.querySelector(".modal")', 'card action dialog')
    const heading = await js('document.querySelector(".modal-title").textContent')
    assert.ok(heading.includes(title), heading)
    if (index === 1) await wait('document.querySelector(".model-discover-row")', 'synthetic discovery')
    await js('document.querySelector(".modal .mx").click()')
    await wait('!document.querySelector(".modal")', 'dialog closes')
  }
  const cardHeight = (await geometry()).cardHeight
  await js('document.querySelector(".model-card-more > button").click()')
  await wait('document.querySelector(".model-card-more-popup:popover-open")', 'more popup opens')
  assert.equal((await geometry()).cardHeight, cardHeight, 'more does not resize card')
  await screenshot('more-popup')
  assert.ok(await js(`(() => {
    const r=document.querySelector('.model-card-more-popup:popover-open').getBoundingClientRect();
    return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;
  })()`), 'more popup stays in viewport')
  await js('document.querySelector(".model-card-more-popup").dispatchEvent(new KeyboardEvent("keydown", { key:"Escape", bubbles:true }))')
  assert.equal(await js('!!document.querySelector(".model-card-more-popup:popover-open")'), false)
  assert.equal(await js('document.activeElement===document.querySelector(".model-card-more > button")'), true)
  await js('document.querySelector(".model-card-more > button").click();document.querySelector(".model-card-more .is-danger").click()')
  await wait('document.querySelector(".modal")', 'delete confirmation')
  assert.ok(await js('document.querySelector(".modal-body").textContent.includes("ZZ custom service")'))
  await js('document.querySelector(".modal .mx").click()')
  assert.equal(requests.some(r => r.method === 'DELETE'), false, 'cancel must not delete')
  for (const enabled of [false, true]) {
    await js(`(() => {
      const card = [...document.querySelectorAll('.model-provider')].find(e => e.querySelector('h3').textContent==='ZZ custom service');
      card.querySelector('.model-card-more > button').click();card.querySelector('.model-card-more-popup button').click();
    })()`)
    await wait(`(() => {
      const card=[...document.querySelectorAll('.model-provider')].find(e=>e.querySelector('h3').textContent==='ZZ custom service');
      return card.classList.contains('disabled')===${!enabled};
    })()`, 'provider state refreshes')
  }
  // Several models with long names and reports must scroll inside the dialog.
  catalog.models = Array.from({ length: 5 }, (_, i) => ({ ...catalog.models[0], id: 'model-' + i,
    name: 'long-model-name-for-multilingual-layout-verification-' + i }))
  await win.loadURL(origin)
  await wait('document.querySelectorAll(".model-provider-grid > .model-provider").length===11', 'multi-model catalog')
  await js('document.querySelector(".model-cloud-toggle").click()')
  await wait('document.querySelectorAll(".model-provider-dialog .model-chip").length===5', 'multiple models')
  await js('document.querySelectorAll(".model-cap-report summary").forEach(e=>e.click())')
  assert.ok(await js(`(() => {
    const body=document.querySelector('.model-provider-dialog > .modal-body');
    return body.scrollHeight>body.clientHeight && body.scrollWidth<=body.clientWidth+1;
  })()`), 'long model list scrolls vertically without horizontal overflow')
  await screenshot('multiple-models')
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: true, results, errors, checks: ['focusable toggle and click', 'request details', 'reload order', 'collapsed polling', 'read-only rendering', 'add/configure dialogs', 'synthetic discovery', 'delete cancel', 'synthetic enable/disable', 'more popup Escape', 'stable card geometry', 'nested model dialogs and focus restoration'] }, null, 2))
  console.log(JSON.stringify({ ok: true, layouts: results.length, output }))
}).catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  win?.destroy(); server?.close(); app.exit(process.exitCode || 0)
})
