// Real isolated renderer. Only synthetic local responses; no live model calls.
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..'), output = path.resolve(root, '../outputs/model-settings/admin')
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration()
const user = { id: 'fixture', username: 'fixture', displayName: 'Fixture Admin', isSuper: true, permissions: [] }
const provider = { id: 'company', name: 'Shared Model Service', enabled: true, baseUrl: 'https://gateway.example/v1', keySet: true, keyLen: 32, builtin: true, revision: 'p1' }
const catalog = { providers: [provider], models: [
  { id: 'vision', providerId: 'company', name: 'vision-model', label: 'Vision model', modality: 'chat', enabled: true, builtin: true, revision: 'm1', ctxWindow: 65536, config: { imageRouting: 'native', thinkingFormat: 'qwen', custom: 'preserved' } },
  { id: 'text', providerId: 'company', name: 'text-model', label: 'Text model', modality: 'chat', enabled: true, revision: 'm2', config: { capabilities: { imageInput: 'unsupported' } } },
  { id: 'image', providerId: 'company', name: 'image-model', label: 'Image studio', modality: 'image', enabled: true, revision: 'm3', config: { endpointPath: '/images/generations', defaults: { size: '1024x1024' } } },
] }
const llm = { baseUrl: 'https://gateway.example/v1', model: 'vision-model', keySet: true, keyLen: 32, revision: 'default1' }
const requests = [], errors = [], results = []; let checks = 0, failNext = false, win, server
const sleep = ms => new Promise(r => setTimeout(r, ms))
const js = code => win.webContents.executeJavaScript(code, true).catch(error=>{console.error('Renderer script:',code);throw error})
async function wait(code, label) { for(let i=0;i<150;i++){if(await js(code))return; await sleep(40)} throw Error('Timeout: '+label) }
async function click(text, scope = 'document') { await js(`(()=>{const n=[...${scope}.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!n)throw Error('Missing button '+${JSON.stringify(text)});n.click()})()`); await sleep(50) }
async function fill(selector, value) { await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}))})()`); await sleep(30) }
async function choose(id, index) { await js(`document.getElementById(${JSON.stringify(id)}).click()`); await sleep(30); await js(`document.querySelectorAll('.select-menu.is-open [role="option"]')[${index}].click()`); await sleep(30) }
async function locale(value) { await js(`localStorage.setItem('soduwork.locale',${JSON.stringify(value)});window.dispatchEvent(new StorageEvent('storage',{key:'soduwork.locale',newValue:${JSON.stringify(value)}}))`); await sleep(100) }
async function screenshot(name) { await sleep(120); fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG()) }
async function geometry(name) {
  const result = await js(`(()=>{const e=document.querySelector('.modal')||document.querySelector('.model-provider-grid'); const r=e.getBoundingClientRect();return {width:innerWidth,scroll:document.documentElement.scrollWidth,left:r.left,right:r.right,minFont:Math.min(...[...e.querySelectorAll('label,button,code,p,small,.model-cap-badge,.model-cap-unchecked')].filter(n=>n.getClientRects().length).map(n=>parseFloat(getComputedStyle(n).fontSize)))}})()`)
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
        const existing=catalog.models.find(m=>m.name===body.name)
        if(existing){Object.assign(existing,body,{revision:existing.revision+'x'});delete existing.capabilityCheck;delete existing.capabilityProfile}
        else catalog.models.push({...body,id:body.name,revision:'created'})
        response={ok:true}
      }
      if(req.method==='POST'&&key==='/admin/model-capabilities/check'){
        checks++; await sleep(450)
        if(failNext){failNext=false;res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({detail:'Fixture temporary failure'}));return}
        const model=catalog.models.find(m=>m.name===body.model), checkedAt='2026-09-30T12:00:00Z'
        response={providerId:body.providerId,model:body.model,checkedAt,checks:Object.fromEntries(body.checks.map(k=>[k,{status:'passed',code:'verified',checkedAt}])),capabilityProfile:Object.fromEntries(['imageInput','toolCalling','streaming'].map(k=>[k,{state:'supported',source:'verified',checkedAt}]))}
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
  await win.loadURL(origin);await wait('!!document.querySelector(".model-cap-badges")','models')
  await geometry('catalog-zh')
  await js('document.querySelector(".model-chip-actions button").click()');await wait('!!document.querySelector(".model-config-form")','edit model')
  await choose('model-cap-imageInput',1);await choose('model-cap-streaming',1)
  await js('document.querySelector(".model-config-advanced").open=true');await fill('#model-max-output','32768')
  await locale('en-US');assert.equal(await js('document.querySelector("#model-max-output").value'),'32768')
  assert.equal(await js('document.querySelector("#model-cap-imageInput").textContent.trim()'),'Supported')
  await geometry('model-form-en');win.setSize(390,820);await sleep(150);await geometry('model-form-en-narrow')
  await locale('zh-CN');await geometry('model-form-zh-narrow');win.setSize(1400,1100);await sleep(120)
  await click('保存','document.querySelector(".modal-foot")');await wait('!document.querySelector(".modal")','saved')
  assert.equal(catalog.models[0].config.maxOutputTokens,32768);assert.equal(catalog.models[0].config.thinkingFormat,'qwen');assert.equal(catalog.models[0].config.custom,'preserved')
  await js('document.querySelector(".model-cap-check-action button").click();document.querySelector(".model-cap-check-action button").click()')
  assert.equal(await js('document.querySelector(".model-cap-check-action button").disabled'),true)
  await wait('!!document.querySelector(".model-cap-report")','capability check');assert.equal(checks,1)
  await js('document.querySelector(".model-cap-report").open=true');await geometry('checked-zh')
  failNext=true;await js('document.querySelector(".model-cap-check-action button").click()');await wait('!!document.querySelector(".model-cap-error")','network error')
  await js('document.querySelector(".model-cap-check-action button").click()');await wait('!document.querySelector(".model-cap-error")&&!document.querySelector(".model-cap-check-action button").disabled','retry')
  await locale('en-US');await click('Add model');await wait('!!document.querySelector(".model-config-form")','add')
  await fill('.model-config-form input','new-chat-model');await choose('model-cap-toolCalling',1)
  await click('Save','document.querySelector(".modal-foot")');await wait('!document.querySelector(".modal")','created')
  assert.equal(catalog.models.find(m=>m.name==='new-chat-model').config.capabilities.toolCalling,'supported')
  await click('Organization defaults');await wait('!!document.querySelector(".modal input")','default settings')
  assert.ok((await js('[...document.querySelectorAll(".modal input")].map(n=>n.value)')).includes('vision-model'))
  await js('document.querySelector(".modal-head button").click()');await wait('!document.querySelector(".modal")','close defaults')
  assert.equal(requests.filter(r=>r.method!=='GET'&&r.key==='/admin/llm-config').length,0)
  await js('document.documentElement.dataset.theme="dark"');await geometry('catalog-en-dark')
  win.setSize(390,820);await sleep(150);await geometry('catalog-en-narrow')
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({results,checks,requests,errors},null,2))
  console.log(JSON.stringify({ok:true,checks,layouts:results.length,output}));win.destroy();server.close();app.exit(0)
}).catch(async error=>{console.error(error.stack);try{await screenshot('failure');fs.writeFileSync(path.join(output,'failure-dom.txt'),await js('document.body.innerText'))}catch{}win?.destroy();server?.close();app.exit(1)})
