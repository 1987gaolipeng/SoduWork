// Real isolated renderer. Only synthetic local responses; no live model calls.
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..'), output = process.env.SODUWORK_ADMIN_TEST_OUTPUT
  ? path.resolve(process.env.SODUWORK_ADMIN_TEST_OUTPUT) : path.resolve(root, '../release-evidence/model-capabilities/admin-' + Date.now())
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration()
const user = { id: 'fixture', username: 'fixture', displayName: 'Fixture Admin', isSuper: true, permissions: [] }
const provider = { id: 'company', name: 'Shared Model Service', enabled: true, baseUrl: 'https://gateway.example/v1', keySet: true, keyLen: 32, builtin: true, revision: 'p1' }
const catalog = { providers: [provider], models: [
  { id: 'vision', providerId: 'company', name: 'vision-model', label: 'Vision model', modality: 'chat', enabled: true, builtin: true, revision: 'm1', ctxWindow: 65536, config: { imageRouting: 'native', thinkingFormat: 'qwen', custom: 'preserved' } },
  { id: 'text', providerId: 'company', name: 'text-model', label: 'Text model', modality: 'chat', enabled: true, revision: 'm2', config: { capabilities: { imageInput: 'unsupported' } } },
  { id: 'image', providerId: 'company', name: 'image-model', label: 'Image studio', modality: 'image', enabled: true, revision: 'm3', config: { endpointPath: '/images/generations', defaults: { size: '1024x1024' } } },
] }
const llm = { baseUrl: 'https://gateway.example/v1', model: 'vision-model', keySet: true, keyLen: 32, revision: 'default1' }
const requests = [], errors = [], results = [], reportLocales = []; let checks = 0, failNext = false, win, server
const sleep = ms => new Promise(r => setTimeout(r, ms))
const js = code => win.webContents.executeJavaScript(code, true).catch(error=>{console.error('Renderer script:',code);throw error})
async function wait(code, label) { for(let i=0;i<150;i++){if(await js(code))return; await sleep(40)} throw Error('Timeout: '+label) }
async function clickElement(expression, times = 1) {
  const point = await js(`(async()=>{const n=${expression};if(!n)throw Error('Missing click target');if(n.disabled)throw Error('Disabled click target');
    n.scrollIntoView({block:'center',inline:'nearest'});await new Promise(requestAnimationFrame);const r=n.getBoundingClientRect();
    const x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);
    if(!r.width||!r.height||!n.contains(document.elementFromPoint(x,y)))throw Error('Click target is hidden or covered');return {x,y}})()`)
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  for (let i = 0; i < times; i++) {
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  await sleep(50)
}
async function click(text, scope = '([...document.querySelectorAll(".modal")].at(-1) || document)') { await js(`(()=>{const n=[...${scope}.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!n)throw Error('Missing button '+${JSON.stringify(text)});n.click()})()`); await sleep(50) }
async function clickSelector(selector) { await clickElement(`document.querySelector(${JSON.stringify(selector)})`) }
async function fill(selector, value) { await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}))})()`); await sleep(30) }
async function choose(id, index) { await js(`document.getElementById(${JSON.stringify(id)}).click()`); await sleep(30); await js(`document.querySelectorAll('.select-menu.is-open [role="option"]')[${index}].click()`); await sleep(30) }
async function locale(value) { await js(`localStorage.setItem('soduwork.locale',${JSON.stringify(value)});window.dispatchEvent(new StorageEvent('storage',{key:'soduwork.locale',newValue:${JSON.stringify(value)}}))`); await sleep(100) }
async function screenshot(name) { await sleep(120); fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG()) }
async function geometry(name) {
  const result = await js(`(()=>{const e=[...document.querySelectorAll('.modal')].at(-1)||document.querySelector('.model-provider-grid'); const r=e.getBoundingClientRect();return {width:innerWidth,scroll:document.documentElement.scrollWidth,left:r.left,right:r.right,minFont:Math.min(...[...e.querySelectorAll('label,button,code,p,small,.model-cap-badge,.model-cap-unchecked')].filter(n=>n.getClientRects().length).map(n=>parseFloat(getComputedStyle(n).fontSize)))}})()`)
  assert.ok(result.scroll <= result.width+1 && result.left>=-1 && result.right<=result.width+1, name+JSON.stringify(result))
  assert.ok(result.minFont>=12,name+' font '+result.minFont); results.push({name,...result}); await screenshot(name)
}
app.whenReady().then(async()=>{
  server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost'), key=url.pathname.replace(/^\/api\/v1/,'')
    if(url.pathname.startsWith('/api/')||key==='/healthz'){
      let raw=''; for await(const chunk of req) raw+=chunk; const body=raw?JSON.parse(raw):null
      requests.push({method:req.method,key,body})
      let response = key==='/admin/me'?user:key==='/healthz'?{ok:true}:key==='/admin/model-catalog'?catalog:key==='/admin/model-runtime'?{policy:{globalConcurrent:10,queueSize:30},running:0,queued:0,groups:[]}:key==='/admin/llm-config'?llm:[]
      if(req.method==='PUT'&&key==='/admin/model-defs'){
        if (body.name === 'failed-import') { res.writeHead(409); res.end('{}'); return }
        const existing=catalog.models.find(m=>m.name===body.name)
        if(existing){Object.assign(existing,body,{revision:existing.revision+'x'});delete existing.capabilityCheck;delete existing.capabilityProfile}
        else catalog.models.push({...body,id:body.name,revision:'created',configRevision:'cfg-' + body.name})
        response={ok:true,id:existing?.id || body.name}
        if (!existing) {
          const created = catalog.models.at(-1)
          Object.assign(response, { revision: created.revision, configRevision: created.configRevision,
            providerRevision: catalog.providers.find(p => p.id === body.providerId).revision })
        }
        if (body.name === 'already-checked') catalog.models.at(-1).capabilityCheck = { checks: {} }
        if (body.name === 'second-import') {
          // Another administrator edits an earlier import before the batch refresh.
          const edited = catalog.models.find(model => model.name === 'edited-import')
          Object.assign(edited, { ctxWindow: 65536, revision: 'edited', configRevision: 'cfg-edited' })
        }
      }
      if(key==='/admin/model-providers/company/discover') response={ok:true,models:['first-import','failed-import','already-checked','edited-import','second-import']}
      if(req.method==='POST'&&key==='/admin/model-capabilities/check'){
        checks++; if (body.model.endsWith('-import')) {
          assert.equal(requests.filter(r=>r.key==='/admin/model-capabilities/check' && r.body.model.endsWith('-import')).length,
            1 + catalog.models.filter(m=>m.name.endsWith('-import') && m.capabilityCheck).length, 'import checks run serially')
        }
        await sleep(450)
        if (failNext) {
          const { status, detail, headers } = failNext
          failNext = false
          res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
          res.end(JSON.stringify({ detail }))
          return
        }
        const model=catalog.models.find(m=>m.name===body.model), checkedAt='2026-09-30T12:00:00Z'
        response={providerId:body.providerId,model:body.model,configRevision:model.configRevision,checkedAt,checks:Object.fromEntries(body.checks.map(k=>[k,{status:'passed',code:'verified',checkedAt}])),capabilityProfile:Object.fromEntries(['imageInput','toolCalling','streaming'].map(k=>[k,{state:'supported',source:'verified',checkedAt}]))}
        response.checks.connection.stage = '<img src=x onerror="privateReceipt()">'
        response.checks.connection.detailCode = 'constructor'
        response.checks.toolCalling = { status: 'inconclusive', code: 'expected_output_missing', checkedAt,
          stage: 'tool_result', detailCode: 'tool_receipt_mismatch', detail: 'private-tool-receipt' }
        response.checks.imageInput = { status: 'inconclusive', code: 'expected_output_missing', checkedAt,
          stage: 'output', detailCode: 'expected_output_mismatch' }
        const previous = { status: 'passed', code: 'verified', checkedAt: '2026-09-29T12:00:00Z' }
        response.verifiedChecks = { toolCalling: previous, imageInput: previous }
        for (const capability of ['imageInput', 'toolCalling'])
          Object.assign(response.capabilityProfile[capability], { checkStatus: 'inconclusive', lastVerifiedAt: previous.checkedAt })
        if (model.name === 'new-chat-model') {
          const lastPass = model.capabilityCheck?.verifiedChecks?.imageInput
          const image = lastPass ? { status: 'unsupported', code: 'capability_not_supported', checkedAt }
            : { status: 'passed', code: 'verified', checkedAt: previous.checkedAt }
          response.checks.imageInput = image
          response.verifiedChecks.imageInput = lastPass || image
          response.capabilityProfile.imageInput.checkStatus = image.status
        }
        model.capabilityCheck=response;model.capabilityProfile=response.capabilityProfile
      }
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(response));return
    }
    const relative=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1)),file=path.resolve(root,'dist',relative)
    if(!file.startsWith(path.resolve(root,'dist')+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return}
    let data=fs.readFileSync(file)
    if(relative==='index.html')data=Buffer.from(data.toString().replace('<head>',`<head><script>localStorage.setItem('soduwork_hub_admin_token','fixture');localStorage.setItem('soduwork_hub_admin_user',${JSON.stringify(JSON.stringify(user))});sessionStorage.setItem('soduwork-hub-screen','models');if(!localStorage.getItem('soduwork.locale'))localStorage.setItem('soduwork.locale','zh-CN')</script>`))
    res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(data)
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); const origin=`http://127.0.0.1:${server.address().port}`
  const isolated=session.fromPartition('model-capabilities-'+Date.now())
  isolated.webRequest.onBeforeRequest((d,done)=>done({cancel:!d.url.startsWith(origin+'/')&&!d.url.startsWith('data:')}))
  win=new BrowserWindow({show:false,width:1400,height:1100,webPreferences:{session:isolated,offscreen:true,backgroundThrottling:false}})
  win.webContents.on('console-message', e=>{if(/Uncaught|React error/.test(e.message))errors.push(e.message)})
  await win.loadURL(origin);await wait('!!document.querySelector(".model-cloud-toggle")','model provider')
  assert.equal(await js('!!document.querySelector(".model-provider-dialog")'), false)
  assert.equal(await js('[...document.querySelectorAll(".model-cap-badges")].some(n=>n.getClientRects().length)'), false)
  await clickSelector('.model-cloud-toggle')
  await wait('!!document.querySelector(".model-provider-dialog")&&!!document.querySelector(".model-cap-badges").getClientRects().length','expanded models')
  await geometry('catalog-zh')
  await js('document.querySelector(".model-chip-actions button").click()');await wait('!!document.querySelector(".model-config-form")','edit model')
  await choose('model-cap-imageInput',1);await choose('model-cap-streaming',1)
  await js('document.querySelector(".model-config-advanced").open=true');await fill('#model-max-output','32768')
  await locale('en-US');assert.equal(await js('document.querySelector("#model-max-output").value'),'32768')
  assert.equal(await js('document.querySelector("#model-cap-imageInput").textContent.trim()'),'Supported')
  await geometry('model-form-en');win.setSize(390,820);await sleep(150);await geometry('model-form-en-narrow')
  await locale('zh-CN');await geometry('model-form-zh-narrow');win.setSize(1400,1100);await sleep(120)
  await click('保存','document.querySelector(".modal:not(.model-provider-dialog) .modal-foot")');await wait('!document.querySelector(".modal:not(.model-provider-dialog)")','saved')
  assert.equal(catalog.models[0].config.maxOutputTokens,32768);assert.equal(catalog.models[0].config.thinkingFormat,'qwen');assert.equal(catalog.models[0].config.custom,'preserved')
  await clickElement('document.querySelector(".model-cap-check-action button")', 2)
  assert.equal(await js('document.querySelector(".model-cap-check-action button").disabled'),true)
  await wait('!!document.querySelector(".model-cap-report")','capability check');assert.equal(checks,1)
  const badgeText = await js('[...document.querySelectorAll(".model-cap-badges")[0].children].map(node=>node.textContent)')
  assert.match(badgeText[0], /手动配置.*支持/)
  assert.match(badgeText[0], /最近检测：未能确认/)
  assert.match(badgeText[1], /上次验证：支持/)
  assert.match(badgeText[1], /最近检测：未能确认/)
  assert.doesNotMatch(badgeText[2], /上次验证|最近检测/)
  await clickSelector('.model-cap-report > summary');await geometry('checked-zh')
  assert.ok((await js('document.querySelector(".model-cap-report").innerText')).includes('未收到与图片中六位数字完全一致的回复'))
  for (const [value, expected] of [
    ['zh-CN', ['检测阶段：读取工具结果', '模型未正确确认工具执行结果', '上次验证：支持']],
    ['en-US', ['Test stage: Reading the tool result', 'The model did not correctly confirm the tool result.', 'Previously verified: supported']],
    ['ja-JP', ['検査段階：ツールの結果を確認', 'モデルがツールの実行結果を正しく確認しませんでした。', '前回の検証：対応']],
    ['ko-KR', ['검사 단계: 도구 결과 확인', '모델이 도구 실행 결과를 올바르게 확인하지 않았습니다.', '이전 검증: 지원']],
  ]) {
    await locale(value)
    const copy = await js('document.querySelector(".model-cap-report").innerText')
    for (const text of expected) assert.ok(copy.includes(text), value + ': ' + text)
    assert.doesNotMatch(copy, /privateReceipt|private-tool-receipt|constructor|function Object|expected_output_missing/)
    assert.equal(await js('document.querySelectorAll(".model-cap-report img").length'), 0)
    assert.equal(await js(`[...document.querySelectorAll('.model-cap-report time')].every(n=>n.textContent===new Date(n.dateTime).toLocaleString(${JSON.stringify(value)}))`), true)
    reportLocales.push({ locale: value, phase: expected[0], detail: expected[1] })
  }
  await locale('zh-CN')
  const errorText = 'document.querySelector(".model-cap-error")?.textContent'
  const legacyConflict = '模型配置在检测期间已变更，请重新检测'
  for (const [status, detail, headers] of [[503, legacyConflict], [409, 'Fixture unrelated conflict'],
    [409, legacyConflict, { 'X-Error-Code': 'other_conflict' }]]) {
    failNext = { status, detail, headers }
    await clickSelector('.model-cap-check-action button')
    await wait(errorText + '===' + JSON.stringify(detail), 'original error detail')
  }
  for (const failure of [{ status: 409, detail: legacyConflict },
    { status: 409, headers: { 'X-Error-Code': 'model_config_revision_changed' }, detail: 'Fixture coded conflict' }]) {
    failNext = failure
    await clickSelector('.model-cap-check-action button')
    await wait(errorText + ' && !document.querySelector(".model-cap-check-action button").disabled', 'revision conflict')
    for (const [value, message] of [
      ['en-US', 'The model configuration changed. Run the check again.'],
      ['ja-JP', 'モデル設定が変更されました。もう一度検査してください。'],
      ['ko-KR', '모델 설정이 변경되었습니다. 다시 검사해 주세요.'],
      ['zh-CN', '模型配置已变更，请重新检测'],
    ]) {
      await locale(value)
      assert.equal(await js(errorText), message, value + ' revision conflict')
    }
  }
  await clickSelector('.model-cap-check-action button');await wait('!document.querySelector(".model-cap-error")&&!document.querySelector(".model-cap-check-action button").disabled','retry')
  const checksBeforeAdd = checks
  await locale('en-US');await click('Add model');await wait('!!document.querySelector(".model-config-form")','add')
  await fill('.model-config-form input','new-chat-model');await choose('model-cap-toolCalling',1)
  await click('Save','document.querySelector(".modal:not(.model-provider-dialog) .modal-foot")');await wait('!document.querySelector(".modal:not(.model-provider-dialog)")','created')
  assert.equal(catalog.models.find(m=>m.name==='new-chat-model').config.capabilities.toolCalling,'supported')
  const chatRow = `[...document.querySelectorAll('.model-chip')].find(row=>row.querySelector('code')?.title==='new-chat-model')`
  const testButton = chatRow + ".querySelector('.model-cap-check-action button')"
  await wait(testButton + ".disabled", 'newly saved model is checking')
  await js(testButton + ".click()")
  // The automatic check must finish even after its detail dialog closes.
  await clickSelector('.model-provider-dialog > .modal-head .mx')
  for (let i=0;i<150 && !catalog.models.find(m=>m.name==='new-chat-model').capabilityCheck;i++) await sleep(40)
  assert.ok(catalog.models.find(m=>m.name==='new-chat-model').capabilityCheck)
  await clickSelector('.model-cloud-toggle')
  await wait("!!" + chatRow + ".querySelector('.model-cap-report')", 'automatic report without clicking Test')
  const autoChecks = requests.filter(r=>r.key==='/admin/model-capabilities/check' && r.body.model==='new-chat-model')
  assert.equal(autoChecks.length, 1)
  assert.deepEqual(autoChecks[0].body, {providerId:'company',model:'new-chat-model',expectedConfigRevision:'cfg-new-chat-model',checks:['connection','imageInput','toolCalling','streaming']})
  assert.equal(requests.filter(r=>r.key==='/admin/model-capabilities/check' && r.body.model!=='new-chat-model').length,checksBeforeAdd)
  await clickSelector('.model-provider-dialog > .modal-head .mx')
  await click('Expand overview')
  await click('Organization defaults (legacy)');await wait('!!document.querySelector(".modal input")','default settings')
  assert.ok((await js('document.querySelector(".modal").textContent')).includes('daily summaries and legacy execution'))
  assert.ok((await js('[...document.querySelectorAll(".modal input")].map(n=>n.value)')).includes('vision-model'))
  await js('document.querySelector(".modal-head button").click()');await wait('!document.querySelector(".modal:not(.model-provider-dialog)")','close defaults')
  await click('Collapse overview')
  assert.equal(requests.filter(r=>r.method!=='GET'&&r.key==='/admin/llm-config').length,0)
  await clickSelector('.model-cloud-toggle')
  await js('document.documentElement.dataset.theme="dark"');await geometry('catalog-en-dark')
  win.setSize(390,820);await sleep(150);await geometry('catalog-en-narrow')
  win.setSize(1400,1100); await locale('zh-CN')
  const imageBadge = chatRow + ".querySelector('.model-cap-badge')"
  await wait(imageBadge + ".textContent==='图片输入支持'", 'first successful image check')
  await clickElement(testButton)
  await wait(chatRow + ".querySelector('.model-cap-report')?.textContent.includes('本次检测未通过')", 'image rejection')
  await win.loadURL(origin)
  await wait('!!document.querySelector(".model-cloud-toggle")', 'reload model catalog')
  await clickSelector('.model-cloud-toggle')
  await wait(imageBadge + ".textContent==='图片输入支持'", 'retained image badge after reload')
  await clickElement(chatRow + ".querySelector('.model-cap-report summary')")
  const imageReport = await js(chatRow + ".querySelector('.model-cap-report').innerText")
  assert.ok(imageReport.includes('本次检测未通过'))
  assert.ok(imageReport.includes('服务拒绝了本次图片请求。对话沿用上次通过的结果，你仍可发图。'))
  assert.ok(imageReport.includes('上次通过'))
  assert.equal(requests.filter(r=>r.key==='/admin/model-capabilities/check' && r.body.model==='new-chat-model').length,2)
  await click('发现模型')
  await wait("document.querySelectorAll('.model-discover-row').length === 5", 'discovered models')
  await click('选择筛选结果')
  await clickElement("document.querySelector('.modal:not(.model-provider-dialog) .modal-foot .btn-primary')")
  await wait("!document.querySelector('.modal:not(.model-provider-dialog)')", 'partially successful import saved')
  // Queued import checks also continue while the model list is not displayed.
  await clickSelector('.model-provider-dialog > .modal-head .mx')
  for (let i=0;i<150 && catalog.models.filter(m=>m.name.endsWith('-import')&&m.capabilityCheck).length<2;i++) await sleep(40)
  assert.equal(catalog.models.filter(m=>m.name.endsWith('-import')&&m.capabilityCheck).length,2)
  await clickSelector('.model-cloud-toggle')
  await wait("[...document.querySelectorAll('.model-chip')].filter(row=>row.querySelector('code')?.title.endsWith('-import') && row.querySelector('.model-cap-report')).length===2", 'both imported reports')
  assert.deepEqual(requests.filter(r=>r.key==='/admin/model-capabilities/check' && ['first-import','failed-import','already-checked','edited-import','second-import'].includes(r.body.model)).map(r=>r.body.model), ['first-import','second-import'])
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({results,reportLocales,checks,requests,errors},null,2))
  console.log(JSON.stringify({ok:true,checks,layouts:results.length,reportLocales:reportLocales.length,output}));win.destroy();server.close();app.exit(0)
}).catch(async error=>{console.error(error.stack);try{await screenshot('failure');fs.writeFileSync(path.join(output,'failure-dom.txt'),await js('document.body.innerText'))}catch{}win?.destroy();server?.close();app.exit(1)})
