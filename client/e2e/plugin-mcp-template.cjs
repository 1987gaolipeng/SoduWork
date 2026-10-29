'use strict';
// Use real personal-plugin storage and IPC with an in-memory HTTP database in isolated Electron; no user accounts or vendor services.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { spawn, spawnSync } = require('node:child_process'), assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../..'), evidence = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !path.isAbsolute(process.argv[2])) throw Error('Absolute evidence directory required');
fs.mkdirSync(evidence, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-mcp-e2e-'));
app.setPath('userData', path.join(root, 'electron'));
app.setPath('sessionData', path.join(root, 'electron-session'));
const personal = require('../main/personal-plugins');
const store = { getPath: () => path.join(root, 'plugins') };
const fixtureSource = { template: 'connector', key: 'template-fixture', name: '连接模板验收', version: '1.0.0',
  description: '仅用于隔离模板交互验收', instructions: '检查连接状态。', mcpServers: ['template-fixture'],
  resources: [{ path: 'references/connections/template-fixture.mcp.json', kind: 'reference', encoding: 'utf8',
    content: JSON.stringify({ mcpServers: { 'template-fixture': { type: 'http', url: 'https://import.fixture.invalid/mcp',
      headers: { Authorization: '' }, enabled: false, enabledTools: ['read_status'], disabledTools: ['delete_item'] } } }) }] };
const candidateFile = path.join(root, 'candidate.json'), metadataFile = path.join(root, 'plugin-info.json');
fs.writeFileSync(candidateFile, fixtureSource.resources[0].content);
fs.writeFileSync(metadataFile, JSON.stringify(Object.fromEntries(['key', 'name', 'version', 'description', 'instructions'].map(key => [key, fixtureSource[key]]))));
const delivery = path.join(root, 'generated');
require('../../skills/mcp-studio/scripts/mcp-config.cjs').bundle(candidateFile, metadataFile, delivery);
const source = JSON.parse(fs.readFileSync(path.join(delivery, 'soduwork-plugin-draft.json'), 'utf8'));
let backend, win, tokens, base, log;
const report = { ok: false, boundary: 'isolated Electron/real personal store IPC/real loopback HTTP and SQLite; no provider connection', checks: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { const r = await fn(); if (r) return r; await delay(50); } throw Error('Timed out'); }
const js = code => win.webContents.executeJavaScript(code, true);
async function click(selector) {
  const point = await js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}; })()`);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
  await delay(60);
}
function check(label, value) { assert.ok(value, label); report.checks.push(label); }
app.whenReady().then(async () => {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); base = 'http://127.0.0.1:' + port;
  log = fs.openSync(path.join(evidence, 'backend.log'), 'w');
  backend = spawn(path.join(repo, 'hub-backend/.venv/Scripts/python.exe'), ['-u', 'e2e_mcp_management_server.py', String(port), root],
    { cwd: path.join(repo, 'hub-backend'), windowsHide: true, stdio: ['ignore', log, log] });
  await until(async () => { try { tokens = await (await fetch(base + '/fixture/auth')).json(); return Boolean(tokens.alice); } catch { return false; } }, 30000);
  const plugin = personal.create(store, source).plugin;
  ipcMain.handle('template-auth', () => ({ ok: true, stored: true, clientId: 'device-alice', session: tokens.alice, expiresIn: 1800 }));
  ipcMain.handle('template-plugin', (_event, id) => ({ ok: true, plugin: personal.get(store, id) }));
  const preload = path.join(root, 'preload.cjs');
  fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
localStorage.setItem('soduwork_work_hub_environment_v1','development');
localStorage.setItem('soduwork_work_development_hub_url_v1',${JSON.stringify(base)});
contextBridge.exposeInMainWorld('soduWorkAPI',{getHubConnection:async()=>({hub:${JSON.stringify(base)},internalTest:true}),deviceAuthBootstrap:()=>ipcRenderer.invoke('template-auth'),personalPlugins:{get:id=>ipcRenderer.invoke('template-plugin',id)}});`);
  win = new BrowserWindow({ show: false, width: 1280, height: 960,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on('console-message', details => {
    if (details.level === 'error') console.error(JSON.stringify({ message: details.message, line: details.lineNumber, sourceId: details.sourceId }));
  });
  win.webContents.on('did-fail-load', (_event, code, description, url) => console.error(JSON.stringify({ code, description, url })));
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => cb({ cancel: !details.url.startsWith(base + '/') }));
  await win.loadURL(base + '/fixture/client');
  await until(() => js('Boolean(window.SoduWorkAPI && window.SoduWorkCapabilityEditors && window.SoduWorkMcpManagement)'));
  await js(fs.readFileSync(path.join(repo, 'client/components/panels/plugin-mcp-gate.js'), 'utf8'));
  await js(`(() => {
    const item = ${JSON.stringify(plugin)};
    window.testMessages = []; window.testResumes = 0;
    const layer = document.createElement('div'); layer.id='templateModal'; layer.className='cap-modal-layer'; layer.hidden=true;
    layer.innerHTML='<section class="cap-modal"><header class="cap-modal-head"><h2></h2></header><div id="capModalBody" class="cap-modal-body"></div><footer class="cap-modal-foot"></footer></section>';
    document.body.append(layer);
    const ctx = {api:SoduWorkAPI, h:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
      say:s=>testMessages.push(s), errorText:e=>e.message, mcp:{personal:[],company:[]}, companyMcp:new Set(), data:{},
      closeModal:()=>{layer.hidden=true}, openModal:(title,sub,body,foot)=>{layer.hidden=false;layer.querySelector('h2').textContent=title;
        layer.querySelector('#capModalBody').innerHTML=body;layer.querySelector('footer').innerHTML=foot;return layer;},
      load:async()=>{ctx.mcp=await SoduWorkAPI.myMcpServers()},render:()=>{},setState:(mcp,data)=>{ctx.mcp=mcp;ctx.data=data}};
    ctx.openMcpEditor=(...args)=>SoduWorkCapabilityEditors.create(ctx).openMcpEditor(...args);
    const button=document.createElement('button');button.id='templateTry';button.textContent='试用模板插件';button.style.cssText='position:fixed;left:20px;top:20px;z-index:9999';document.body.append(button);
    button.onclick=()=>SoduWorkPluginMcpGate.ensure(item,{api:SoduWorkAPI,say:ctx.say,errorText:ctx.errorText,setCatalog:c=>{ctx.mcp=c},
      openPanel:async()=>{},openEditor:ctx.openMcpEditor,openImport:o=>SoduWorkMcpManagement.openImport(ctx,o),resume:()=>{testResumes++}});
    window.testContext=ctx;
  })()`);
  await click('#templateTry');
  await until(() => js('Boolean(document.querySelector(".cap-mcp-import-row"))'));
  check('real IPC retrieves exact installed resource and HTTP preview exposes URL/header names', await js('document.querySelector("[data-mcp-preview]").textContent.includes("https://import.fixture.invalid/mcp") && document.querySelector("[data-mcp-preview]").textContent.includes("Authorization")'));
  check('bundled template preview does not show an unrelated file picker', await js('!document.querySelector("[data-mcp-file]")'));
  check('preview does not create or enable connections', await js('(async()=>{const c=await SoduWorkAPI.myMcpServers();return c.personal.length===0 && document.querySelector("[data-mcp-import-do]").disabled})()'));
  await click('[data-mcp-import-consent]'); await click('[data-mcp-import-do]');
  await until(() => js('Boolean(document.querySelector("#capMcpUrl"))'));
  check('confirmed import opens prefilled target, credential field and explicit connect action', await js('document.querySelector("#capMcpUrl").value==="https://import.fixture.invalid/mcp" && document.querySelector("#capMcpHeaders").value==="Authorization=" && document.querySelector("#capMcpSave").textContent.includes("连接")'));
  check('tool restrictions persist into the real editor', await js('document.querySelector("#capMcpEnabledTools").value==="read_status" && document.querySelector("#capMcpDisabledTools").value==="delete_item"'));
  check('explicit import consent approves only the reviewed target and keeps it disabled', await js('(async()=>{const c=await SoduWorkAPI.myMcpServers();return c.personal.length===1 && !c.personal[0].enabled && c.personal[0].approved===true && c.personal[0].approvedTarget==="https://import.fixture.invalid/mcp"})()'));
  await js('document.querySelector("#capMcpQuickConfig").value="{broken";document.querySelector("#capMcpQuickConfig").dispatchEvent(new Event("input",{bubbles:true}))');
  await click('#capMcpSave');
  check('malformed replacement blocks connecting and never resumes execution', await js('!document.querySelector("#templateModal").hidden && testResumes===0 && document.querySelector("#capMcpAutoFillStatus").textContent.includes("JSON")'));
  check('rejected replacement leaves the approved but disabled target unchanged', await js('(async()=>{const c=await SoduWorkAPI.myMcpServers();return c.personal.length===1 && !c.personal[0].enabled && c.personal[0].approvedTarget==="https://import.fixture.invalid/mcp" && c.personal[0].url==="https://import.fixture.invalid/mcp"})()'));
  await delay(200);
  fs.writeFileSync(path.join(evidence, 'prefilled.png'), (await win.webContents.capturePage()).toPNG());
  await click('#capModalCancel'); await click('#templateTry');
  await until(() => js('!document.querySelector("#templateModal").hidden'));
  check('repeat trial edits the existing disabled connection instead of creating a duplicate', await js('Boolean(document.querySelector("#capMcpUrl")) && !document.querySelector("[data-mcp-import-do]")'));
  check('reopening never enables the saved connection', await js('(async()=>{const c=await SoduWorkAPI.myMcpServers();return c.personal.length===1 && !c.personal[0].enabled && testResumes===0})()'));
  report.ok = true;
}).catch(async error => { report.error = error.stack;
  if (win && !win.isDestroyed()) report.ui = await js('({messages:window.testMessages,preview:document.querySelector("[data-mcp-preview]")?.textContent,modalHidden:document.querySelector("#templateModal")?.hidden,bridge:Boolean(window.soduWorkAPI?.personalPlugins)})').catch(() => null);
}).finally(() => {
  if (win && !win.isDestroyed()) win.destroy();
  if (backend && backend.exitCode === null) {
    const killed = spawnSync('taskkill.exe', ['/PID', String(backend.pid), '/T', '/F'], { windowsHide: true, timeout: 10000, encoding: 'utf8' });
    if (killed.error || killed.status !== 0) { report.ok=false; report.cleanupError = String(killed.error || 'taskkill exit '+killed.status); }
  }
  if (log) fs.closeSync(log);
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
});
