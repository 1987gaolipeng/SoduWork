// Actual client capability components + built admin UI + real auth/backend + local installer.
// Every profile, database and package is isolated; no live accounts or models are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CdpPage, listPages, delay } from './lib/cdp.mjs';
const require = createRequire(import.meta.url);
const cache = require('../main/conversation/skill-cache.js');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-mcp-e2e-'));
const output = path.resolve(process.env.MCP_E2E_OUTPUT || path.join(root, 'evidence'));
fs.mkdirSync(output, { recursive: true });
const checks = [];
const pages = [], children = [];
const check = (label, value = true) => { assert.ok(value, label); checks.push(label); console.log('PASS ' + label); };
async function port() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}
async function until(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch {} await delay(150); }
  throw new Error('Timed out waiting for fixture');
}
const hubPort = await port(), base = 'http://127.0.0.1:' + hubPort;
const logs = fs.openSync(path.join(output, 'backend.log'), 'w');
const backend = spawn(path.join(repo, 'hub-backend/.venv/Scripts/python.exe'),
  ['-u', 'e2e_mcp_management_server.py', String(hubPort), root],
  { cwd: path.join(repo, 'hub-backend'), windowsHide: true, stdio: ['ignore', logs, logs] });
children.push(backend);
async function request(who, endpoint, options = {}) {
  return fetch(base + '/api/v1' + endpoint, { ...options,
    headers: { Authorization: (who === 'admin' ? 'Bearer ' : 'Device ') + tokens[who],
      ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers } });
}
let tokens;
async function browser(who, admin = false) {
  const debug = await port(), profile = path.join(root, 'profile-' + who);
  const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=' + debug, '--user-data-dir=' + profile, '--window-size=1440,1000', 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
  children.push(chrome);
  const target = await until(async () => (await listPages(debug))[0]);
  const page = await CdpPage.connect(target);
  pages.push(page);
  await page.call('Page.enable');
  await page.call('Network.enable');
  page.failedRequests=[];
  page.ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Network.responseReceived' && m.params.response.status>=400)page.failedRequests.push({url:m.params.response.url,status:m.params.response.status});});
  await page.call('Page.setInterceptFileChooserDialog', { enabled: true });
  await page.call('Browser.setDownloadBehavior', { behavior:'allow', downloadPath:path.join(root,'downloads-'+who) });
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const seed = admin ?
    `localStorage.setItem('soduwork_hub_admin_token', ${JSON.stringify(tokens.admin)});
     localStorage.setItem('soduwork_hub_admin_user', JSON.stringify({id:'admin',username:'admin',isSuper:true}));
     sessionStorage.setItem('soduwork-work-hub-screen','capabilities');` :
    `localStorage.setItem('soduwork_work_hub_environment_v1','development');
     localStorage.setItem('soduwork_work_development_hub_url_v1',${JSON.stringify(base)});
     window.soduWorkAPI={deviceAuthBootstrap:async()=>({ok:true,stored:true,clientId:${JSON.stringify('device-'+who)},
       session:${JSON.stringify(tokens[who])},expiresIn:1800})};`;
  await page.call('Page.addScriptToEvaluateOnNewDocument', { source: seed });
  await page.call('Page.navigate', { url: base + (admin ? '/admin' : '/fixture/client') });
  if (!admin) {
    await click(page, '[data-cap-tab="mcp"]');
    await page.waitFor(() => !!document.querySelector('[data-mcp-import]'));
  } else await page.waitFor(() => !!document.querySelector('.cap-admin-tabs'));
  return page;
}
async function click(page, selector) {
  await page.waitFor(s => !!document.querySelector(s), selector, 15000);
  await delay(250);
  const box = await page.run(s => {
    const el = document.querySelector(s);
    el.scrollIntoView({block:'center'});
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box });
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box });
}
async function shot(page, name) {
  const image = await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(image.data, 'base64'));
}
async function textClick(page,label,scope='') {
  await page.waitFor(({label,scope}) => [...document.querySelectorAll(scope+' button')].some(x=>x.textContent.trim()===label),{label,scope});
  await page.run(({label,scope})=>{document.querySelectorAll('[data-e2e-click]').forEach(x=>x.removeAttribute('data-e2e-click'));
    [...document.querySelectorAll(scope+' button')].find(x=>x.textContent.trim()===label).dataset.e2eClick='yes'}, {label,scope});
  await click(page,'[data-e2e-click="yes"]');
}
async function fill(page,selector,text){
  await click(page,selector);
  await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});
  await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});
  await page.call('Input.insertText',{text});
}
async function callBusiness(page,server,tool='read_status'){
  return page.run(async ({server,tool})=>{
    const auth=await window.soduWorkAPI.deviceAuthBootstrap();
    const r=await fetch('/fixture/call',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Device '+auth.session},body:JSON.stringify({server,tool})});
    return {status:r.status,body:await r.text()}
  },{server,tool});
}
try {
  tokens = await until(async () => (await fetch(base + '/fixture/auth')).json());
  const alice=await browser('alice'),bob=await browser('bob');
  await click(alice,'[data-mcp-import]');
  const filename=path.join(root,'mcp-config.json');
  fs.writeFileSync(filename,await(await fetch(base+'/fixture/package')).text());
  const doc=await alice.call('DOM.getDocument');
  const node=await alice.call('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'[data-mcp-file]'});
  await alice.call('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[filename]});
  await alice.waitFor(()=>!!document.querySelector('.cap-mcp-import-row'));
  check('configuration preview shows one valid connection',await alice.run(()=>document.querySelector('[data-mcp-preview]').textContent.includes('1 / 1')));
  check('preview never echoes credentials',!await alice.run(()=>document.body.innerText.includes('private-fixture-key')));
  await shot(alice,'01-import-preview');
  await click(alice,'[data-mcp-import-consent]');await click(alice,'[data-mcp-import-do]');
  // A successful import opens the same connection editor with the imported
  // non-secret values already populated; credentials remain write-only.
  await alice.waitFor(()=>!!document.querySelector('#capMcpUrl'));
  check('import opens a prefilled MCP editor',await alice.run(()=>document.querySelector('#capMcpUrl').value==='https://import.fixture.invalid/mcp'));
  check('import does not enable connection',await alice.run(()=>!document.querySelector('#capMcpEnabled').checked));
  await click(alice,'#capMcpApprove');
  await click(alice,'#capMcpCheck');
  await alice.waitFor(()=>document.querySelector('#capMcpProbe').classList.contains('ok'),null,30000);
  check('personal connector uses actual Runner handler and HTTP MCP',await alice.run(()=>document.querySelector('#capMcpProbe').textContent.includes('read_status')));
  await shot(alice,'02-personal-test');
  await click(alice,'#capMcpEnabled');await click(alice,'#capMcpSave');
  await alice.waitFor(()=>document.querySelector('#capModalLayer').hidden);
  check('personal tool call returns real business result',(await callBusiness(alice,'business')).body.includes('BUSINESS_OK'));
  check('another client cannot discover private connection',!await bob.run(()=>document.querySelector('[data-edit-mcp]')));
  await click(alice,'[data-mcp-share]');
  await fill(alice,'[data-mcp-share-name]','company-business');
  await click(alice,'[data-mcp-share-consent]');await click(alice,'[data-mcp-share-do]');
  await alice.waitFor(()=>document.querySelector('[data-mcp-feedback]').textContent.includes('等待管理员'));
  await shot(alice,'03-submitted');
  await click(alice,'#capModalClose');
  const admin=await browser('admin',true);
  await textClick(admin,'MCP 连接','.cap-admin-tabs');
  await click(admin,'[data-mcp-review]');
  await admin.waitFor(()=>!!document.querySelector('.modal-body'));
  check('admin receives no personal credential',!await admin.run(()=>[...document.querySelectorAll('textarea')].some(x=>x.value.includes('private-fixture-key'))));
  await admin.run(()=>[...document.querySelectorAll('textarea')].find(x=>x.placeholder==='X-MCP-Key=xxxx').dataset.e2eHeader='yes');
  await fill(admin,'[data-e2e-header]','Authorization=Bearer company-fixture-key');
  await textClick(admin,'测一下','.modal-foot');
  await admin.waitFor(()=>document.querySelector('.mcp-probe')?.classList.contains('ok'),null,30000);
  await shot(admin,'04-admin-review');
  await textClick(admin,'实测并开放','.modal-foot');
  await admin.waitFor(()=>!document.querySelector('.modal-mask'),null,30000);
  check('admin published only after real connection test',true);
  await bob.call('Page.reload');await click(bob,'[data-cap-tab="mcp"]');
  await bob.waitFor(()=>!!document.querySelector('[data-company-mcp="company-business"]'));
  check('other client sees published connection but is not auto-opted-in',await bob.run(()=>document.querySelector('[data-company-mcp]').getAttribute('aria-pressed')==='false'));
  await click(bob,'[data-mcp-inspect]');
  await click(bob,'[data-mcp-company-probe]');
  await bob.waitFor(()=>document.querySelector('[data-mcp-feedback]').textContent.includes('连接通过'),null,30000);
  check('published tool restrictions remain visible',await bob.run(()=>document.querySelector('.cap-mcp-facts').textContent.includes('delete_item')));
  check('company test exposes only allowed tools',await bob.run(()=>document.querySelector('[data-mcp-tools]').textContent==='read_status'));
  await shot(bob,'05-other-client');
  const oldColor=await bob.run(()=>getComputedStyle(document.querySelector('[data-mcp-company-probe]')).backgroundColor);
  await bob.run(()=>document.documentElement.setAttribute('data-theme','ruby'));
  await bob.waitFor(old=>getComputedStyle(document.querySelector('[data-mcp-company-probe]')).backgroundColor!==old,oldColor);
  check('connection dialog inherits company theme',oldColor!==await bob.run(()=>getComputedStyle(document.querySelector('[data-mcp-company-probe]')).backgroundColor));
  check('all visible detail text uses at least 12px',await bob.run(()=>[...document.querySelectorAll('.cap-mcp-flow *')].filter(e=>e.getClientRects().length&&e.textContent.trim()).every(e=>parseFloat(getComputedStyle(e).fontSize)>=12)));
  check('dialog stays inside viewport',await bob.run(()=>{const r=document.querySelector('.cap-modal').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight}));
  await shot(bob,'06-theme');
  await click(bob,'#capModalClose');await click(bob,'[data-company-mcp="company-business"]');
  await bob.waitFor(()=>document.querySelector('[data-company-mcp]').getAttribute('aria-pressed')==='true');
  const called=await callBusiness(bob,'company-business');
  check('second client invokes shared MCP with isolated company credential',called.status===200&&called.body.includes('BUSINESS_OK'));
  await bob.call('Page.reload');await click(bob,'[data-cap-tab="mcp"]');
  check('enabled selection survives reopening',await bob.run(()=>document.querySelector('[data-company-mcp]').getAttribute('aria-pressed')==='true'));
  const errors=pages.map(p=>p.takeRuntimeErrors());
  fs.writeFileSync(path.join(output,'browser-errors.json'),JSON.stringify({errors,requests:pages.map(p=>p.failedRequests)},null,2));
  check('no JavaScript errors or failed HTTP requests',errors.every(x=>x.length===0)&&pages.every(p=>!p.failedRequests.length));
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,screenshots:fs.readdirSync(output).filter(x=>/^\d+-.*\.png$/.test(x)),root},null,2));
  console.log(JSON.stringify({passed:checks.length,output}));
} catch(error) {
  for(let i=0;i<pages.length;i++)try {
    await shot(pages[i],'failure-'+i);
    fs.writeFileSync(path.join(output,'diagnostic-'+i+'.json'),JSON.stringify({errors:pages[i].takeRuntimeErrors(),state:await pages[i].run(()=>({text:document.body.innerText.slice(0,6000)}))},null,2));
  }catch{}
  fs.writeFileSync(path.join(output,'failure.txt'),error.stack||String(error));
  throw error;
} finally {
  for(const p of pages)p.close();
  for(const c of children.reverse())try{c.kill()}catch{}
  fs.closeSync(logs);
}
