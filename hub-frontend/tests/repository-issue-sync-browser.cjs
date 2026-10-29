// Real Chromium interactions against the actual page and shared controls.
// API responses are isolated fixtures; this does not access GitHub or GitLab accounts.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const http = require('node:http')
const root = path.resolve(__dirname, '..')
const output = path.resolve(root, '../outputs/github-gitlab-issue-sync/admin-ui')
if (!process.versions.electron) {
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key]
  const result = require('node:child_process').spawnSync(require('../../client/node_modules/electron'), [__filename],
    { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
  process.stdout.write(result.stdout || '')
  if (result.status !== 0) console.error(result.stderr || result.error)
  process.exitCode = result.status || (result.error ? 1 : 0)
} else {
  const { app, BrowserWindow, session } = require('electron')
  fs.mkdirSync(output, { recursive: true })
  app.setPath('userData', path.join(output, 'profile'))
  app.disableHardwareAcceleration()
  let server, win
  const errors = [], checks = []
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const fixture = `
    const member={externalUserId:'42',username:'repository-member',displayName:'仓库成员张三',active:true,userId:'',userName:'',mappingSource:''};
    let saved={enabled:false,startedLabel:'处理中',intervalSeconds:60,enabledAt:null,lastPolledAt:null,lastSuccessAt:null,lastError:'',importedCount:0,lastCreatedCount:0,nextPollAt:null,pendingWritebacks:0,manualWritebacks:0,mappedMembers:0,totalMembers:1,members:[member],userOptions:[{id:'user-42',name:'SoduWork 张三',username:'zhangsan'}]};
    window.issueCalls=[];window.accountCalls=[];window.failSave=true;
    export const can=()=>true;
    export const api={
      testPullAccount:async(id,body)=>{window.accountCalls.push({action:'probe',id,body});return {ok:true,detail:'账号连接已验证'}},
      savePullAccount:async(id,body)=>{window.accountCalls.push({action:'save',id,body});return {ok:true}},
      integrations:async()=>[{id:'gitlab-main',type:'gitlab',name:'研发 GitLab',enabled:true,repositorySyncCount:2,repositorySyncOk:true,repositorySyncAt:Date.now(),pullAccountSet:true,pullAccountUser:'sync-account',config:{base_url:'https://gitlab.example.invalid'}},{id:'github-main',type:'github',name:'研发 GitHub',enabled:true,repositorySyncCount:1,pullAccountSet:true,pullAccountUser:'octocat',config:{base_url:'https://api.github.com'}}],
      repositoryCatalog:async()=>({items:[{id:'repo-a',provider:'gitlab',displayName:'企业仓库 A',fullName:'engineering/repository-a',defaultBranch:'main',issueSync:saved},{id:'repo-b',provider:'github',displayName:'GitHub 仓库 B',fullName:'engineering/repository-b',defaultBranch:'release/long-branch-name',issueSync:{enabled:false}}]}),
      repositoryIssueSync:async(id)=>({...saved,members:[{...member}],writebacks:(saved.writebacks||[]).map(entry=>id==='repo-b'?{...entry,issueUrl:'https://github.example.invalid/team/repo/issues/'+entry.issueIid,lastError:''}:entry)}),
      saveRepositoryIssueSync:async(id,body)=>{window.issueCalls.push({action:'save',id,body});if(window.failSave){window.failSave=false;throw Error('GitLab 成员读取权限不足，请检查拉取账号。')}saved={...saved,...body,enabledAt:Date.now(),nextPollAt:Date.now()+60000};return {...saved}},
      runRepositoryIssueSync:async(id)=>{window.issueCalls.push({action:'run',id});saved={...saved,lastPolledAt:Date.now(),lastSuccessAt:Date.now(),lastCreatedCount:3,importedCount:3,pendingWritebacks:1,manualWritebacks:1,writebacks:[
        {issueIid:12,issueUrl:'https://gitlab.example.invalid/engineering/repository-a/-/issues/12',state:'error',lastError:'GitLab 返回 HTTP 503，标签暂未写入。',attempts:2,nextRetryAt:Date.now()+60000},
        {issueIid:13,issueUrl:'https://gitlab.example.invalid/engineering/repository-a/-/issues/13',state:'manual',lastError:'无法确认标签是否写入，请人工核对。',attempts:3,nextRetryAt:null}
      ]};return {ok:true,created:3,skippedConfidential:0,issueSync:{...saved}}},
      mapRepositoryIssueMember:async(id,externalUserId,body)=>{window.issueCalls.push({action:'map',id,externalUserId,body});member.userId=body.userId||'';member.userName=body.userId?'SoduWork 张三':'';member.mappingSource=body.userId?'manual':'';saved={...saved,mappedMembers:body.userId?1:0};return {...saved}},
    }`
  async function wait(code, description) {
    for (let i = 0; i < 100; i++) { if (await js(code)) return; await sleep(50) }
    throw Error('Timed out: ' + description)
  }
  async function click(text) {
    await js(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Unavailable button: '+${JSON.stringify(text)});b.click()})()`)
  }
  async function shot(name) {
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await sleep(350)
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  async function noOverflow() { assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), 'page must not overflow horizontally') }
  app.whenReady().then(async () => {
    await require('esbuild').build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import Repositories from './src/screens/Repositories.jsx';
      import './src/styles.css';import './src/styles-bugloop.css';import './src/styles-devflow.css';import './src/design-system.css';import './src/page-layouts.css';import './src/landing.css';
      import './src/filter-controls.css';import './src/admin-controls.css';import './src/accessibility.css';import './src/responsive-pages.css';import './src/dialog-layout.css';import './src/screens/detail-layout.css';import './src/layout-safety.css';import './src/console-theme.css';
      createRoot(document.getElementById('root')).render(<div className="app"><main className="content" data-screen="repositories"><Repositories/></main></div>);`,
      loader: 'jsx', resolveDir: root }, bundle: true, jsx: 'automatic', outfile: path.join(output, 'fixture.js'), loader: { '.svg': 'dataurl' },
      plugins: [{ name: 'isolated-repository-api', setup(build) {
        build.onResolve({ filter: /(?:^|\/)api\.js$/ }, () => ({ path: 'fixture-api', namespace: 'fixture' }))
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: fixture, loader: 'js' }))
      } }] })
    const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>.app{display:block!important}.content{margin:0!important;padding:24px!important}body{margin:0}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'
    server = http.createServer((req, res) => {
      if (req.url === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(html); return }
      const name = req.url.slice(1)
      if (!['fixture.js', 'fixture.css'].includes(name)) { res.writeHead(404); res.end(); return }
      res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(path.join(output, name)))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = 'http://127.0.0.1:' + server.address().port
    const isolated = session.fromPartition('repository-issue-sync-' + Date.now())
    isolated.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('data:') }))
    win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { session: isolated, offscreen: true, backgroundThrottling: false } })
    win.webContents.on('console-message', (event) => { if (/Uncaught|React error|invalid.*type/i.test(event.message)) errors.push(event.message) })
    await win.loadURL(origin)
    await wait('document.querySelectorAll(".rc-row").length===2', 'catalog loaded')
    await noOverflow(); await shot('catalog-desktop-light')
    await js('document.querySelector(".rc-acct").click()')
    await wait('!!document.querySelector(".rc-source-cfg input")', 'pull account form')
    await js(`(()=>{const input=document.querySelector('.rc-source-cfg input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'corrected-user');input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await js('document.querySelector(".rc-source-cfg .select-menu-trigger").click()')
    await wait('!!document.querySelector("[role=option]")', 'authentication options')
    await js('[...document.querySelectorAll("[role=option]")].find(e=>e.textContent.includes("登录密码")).click()')
    await click('测一下')
    await wait('!!document.querySelector(".rc-probe.ok")', 'draft authentication probe')
    assert.deepEqual((await js('window.accountCalls'))[0].body, { user: 'corrected-user', secret: null, kind: 'password' })
    await shot('pull-account-desktop-light')
    win.setSize(390, 844); await sleep(150); await noOverflow(); await shot('pull-account-mobile-light')
    win.setSize(1440, 1000); await sleep(150)
    await js('document.querySelector(".rc-acct").click()')
    checks.push('Account draft sends the corrected username with its retained secret and explicit authentication mode; desktop/mobile form stays contained')
    await click('配置 Issue 同步')
    await wait('!!document.querySelector(".rc-issue-toggle input")', 'settings loaded')
    await shot('settings-initial-light')
    assert.equal(await js('document.querySelector(".rc-issue-toggle input").checked'), false)
    assert.equal(await js('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="立即同步 Issue").disabled'), true)
    await js('document.querySelector(".rc-issue-toggle input").click()')
    await click('保存设置')
    await wait('!!document.querySelector("[role=alert]")', 'permission error')
    assert.equal(await js('document.querySelector(".rc-issue-health .rc-issue-status").textContent.includes("未开启")'), true)
    checks.push('Failed permission check keeps server state disabled and preserves editable draft')
    await click('保存设置')
    await wait('document.querySelector(".rc-issue-health .rc-issue-status").textContent.includes("已开启")', 'enabled receipt')
    await click('立即同步 Issue')
    await wait('document.querySelector("[role=status]").textContent.includes("3 条")', 'sync receipt')
    assert.deepEqual((await js('window.issueCalls')).map((call) => call.action), ['save', 'save', 'run'])
    checks.push('Explicit save enables sync and manual run reports the server import count')
    await wait('document.querySelectorAll(".rc-issue-writeback").length===2', 'writeback details')
    assert.equal(await js('document.querySelectorAll(".rc-issue-writeback-retry").length'), 1)
    assert.ok(await js('[...document.querySelectorAll(".rc-issue-writeback a")].every(a=>a.rel==="noopener noreferrer"&&a.target==="_blank")'))
    checks.push('Writeback failures identify Issues with safe source links and distinguish retries from manual handling')
    await js('document.querySelector(".rc-issue-member .select-menu-trigger").click()')
    await wait('!!document.querySelector("[role=option]")', 'account options')
    await js('[...document.querySelectorAll("[role=option]")].find(e=>e.textContent.includes("SoduWork 张三")).click()')
    await click('保存关联')
    await wait('document.querySelector(".rc-issue-members-title").textContent.includes("1 / 1")', 'mapped member')
    assert.deepEqual((await js('window.issueCalls')).at(-1).body, { userId: 'user-42' })
    checks.push('Shared account selector saves an explicit repository member mapping')
    await js('document.querySelector(".modal-body").scrollTop=0')
    await shot('settings-desktop-light')
    await js('document.querySelector(".rc-issue-writebacks").scrollIntoView({block:"start"})')
    await shot('writebacks-desktop-light')
    await js('document.documentElement.setAttribute("data-theme","dark")')
    await shot('settings-desktop-dark')
    win.setSize(390, 844); await sleep(150); await noOverflow()
    assert.ok(await js('document.querySelector(".modal").getBoundingClientRect().width <= innerWidth'))
    await shot('settings-mobile-dark')
    await js('document.documentElement.setAttribute("data-theme","light")')
    await shot('settings-mobile-light')
    await js('document.querySelector(".rc-issue-writebacks").scrollIntoView({block:"start"})')
    await shot('writebacks-mobile-light')
    await js('document.querySelector(".rc-issue-member").scrollIntoView({block:"end"})')
    await shot('member-mobile-light')
    await click('关闭')
    await wait('!document.querySelector(".modal")', 'dialog closed')
    await noOverflow(); await shot('catalog-mobile-light')
    assert.equal(await js('document.querySelectorAll(".rc-row .rc-issue-status.on").length'), 1)
    checks.push('390px layouts remain contained in light/dark themes; only the edited row changes')
    win.setSize(1440, 1000); await sleep(150)
    await js('document.querySelectorAll(".rc-acct")[1].click()')
    await wait('!!document.querySelector(".rc-source-cfg")', 'GitHub PAT form')
    assert.ok(await js('document.querySelector(".rc-source-cfg").textContent.includes("Personal Access Token")'))
    assert.equal(await js('document.querySelector(".rc-source-cfg").textContent.includes("登录密码")'), false)
    await js('document.querySelectorAll(".rc-acct")[1].click()')
    await js('[...document.querySelectorAll(".rc-row")][1].querySelector("button").click()')
    await wait('!!document.querySelector(".rc-issue-writebacks")', 'GitHub Issue settings')
    assert.ok(await js('document.querySelector(".rc-issue-intro").textContent.includes("认领后移到待开始")'))
    assert.ok(await js('[...document.querySelectorAll(".rc-issue-writeback a")].every(a=>a.getAttribute("aria-label").includes("GitHub")&&a.href.startsWith("https://github.example.invalid/"))'))
    assert.equal(await js('document.querySelector(".rc-issue-dialog").textContent.includes("GitLab")'), false)
    assert.ok(await js('document.querySelector(".rc-issue-team").textContent.includes("当前团队全员可见")'))
    assert.equal(await js('document.querySelectorAll(".rc-issue-member, .rc-issue-members-title").length'), 0)
    assert.equal(await js('document.querySelector(".rc-issue-field input").maxLength'), 50)
    await noOverflow(); await shot('github-settings-desktop-light')
    win.setSize(390, 844); await sleep(150); await noOverflow(); await shot('github-settings-mobile-light')
    checks.push('GitHub catalog uses PAT-only setup and provider-correct links; all current team members can view and claim without member mapping, then Intake moves to Ready')
    assert.deepEqual(errors, [])
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, checks, errors,
      boundary: 'Actual React page and Chromium controls with isolated API responses; no live GitHub, GitLab or production backend' }, null, 2))
    console.log(JSON.stringify({ ok: true, checks, output }))
    win.destroy(); server.close(); app.exit(0)
  }).catch(async (error) => {
    console.error(error)
    if (win && !win.isDestroyed()) { try { await shot('failure') } catch {} win.destroy() }
    server?.close(); app.exit(1)
  })
}
