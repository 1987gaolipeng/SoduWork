// Real capability UI + HTTP authorization. Temporary DB/packages/browser only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CdpPage, listPages, delay} from './lib/cdp.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-e2e-lifecycle-'));
const output = path.resolve(process.env.CAPABILITY_DELETION_E2E_OUTPUT || path.join(root, 'evidence')); fs.mkdirSync(output,{recursive:true});
const children = [], checks = []; let page, tokens;
const check = (name, yes = true) => {assert.ok(yes, name); checks.push(name); console.log('PASS ' + name);};
async function port() {const s = net.createServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r)); const n=s.address().port; await new Promise(r=>s.close(r)); return n;}
async function until(fn, timeout=30000) {const end=Date.now()+timeout; while(Date.now()<end){try{const r=await fn();if(r)return r;}catch{} await delay(150);}throw Error('Fixture timed out');}
const hub = await port(), base = 'http://127.0.0.1:' + hub, debug = await port();
const log = fs.openSync(path.join(output,'backend.log'),'w');
async function api(method, endpoint, body, who='alice') {
  const response = await fetch(base+'/api/v1'+endpoint, {method,
    headers:{Authorization:'Device '+tokens[who], ...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{})});
  assert.equal(response.status,200,await response.clone().text()); return response.json();
}
async function click(selector) {
  await page.waitFor(s=>{const el=document.querySelector(s);return el&&!el.disabled&&el.getClientRects().length>0;},selector);
  await page.run(s=>document.querySelector(s).scrollIntoView({block:'center',behavior:'instant'}),selector);
  await page.waitFor(s=>{const el=document.querySelector(s),r=el?.getBoundingClientRect();return r?.width>0&&r.height>0&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));},selector);
  const box=await page.run(s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};},selector);
  await page.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});
  await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});
}
const mcpRow = id => '[data-connection-key="personal:' + id + '"]';
async function mcpAction(id, selector) {
  await click(mcpRow(id) + ' .connector-row-menu>summary');
  await page.waitFor(s=>document.querySelector(s)?.open,mcpRow(id) + ' .connector-row-menu');
  await click(mcpRow(id) + ' ' + selector);
}
async function shot(name) {const r=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));}
async function idle() {await page.waitFor(()=>!document.querySelector('#capSkillRefresh')?.disabled);await delay(600);}
try {
  children.push(spawn(path.join(repo,'hub-backend/.venv/Scripts/python.exe'),['-u','e2e_skill_sharing_server.py',String(hub),root,'--lifecycle'],
    {cwd:path.join(repo,'hub-backend'),windowsHide:true,stdio:['ignore',log,log],env:{...process.env,DATABASE_URL:'sqlite+aiosqlite:///:memory:',CLUSTER_REDIS_URL:''}}));
  tokens=await until(async()=> (await fetch(base+'/fixture/auth')).json(),60000);
  await api('POST','/skills/create',{name:'my-method',description:'A method I created',instructions:'Only process the fixture.'});
  const configured=await api('PUT','/mcp-servers',{servers:[
    {name:'My service',type:'http',url:'https://example.invalid/mcp',approved:true,approvedTarget:'https://example.invalid/mcp',enabled:false},
    {name:'SoduWork time',type:'stdio',templateKey:'mcp-time',approved:true,approvedTarget:'mcp-time',enabled:false}],enabledCompany:[]});
  const own=configured.personal.find(x=>x.name==='My service'), builtin=configured.personal.find(x=>x.name==='SoduWork time');
  const electronEnv = {...process.env}; delete electronEnv.ELECTRON_RUN_AS_NODE;
  children.push(spawn(path.join(repo,'client/node_modules/electron/dist/electron.exe'),
    [path.join(repo,'client/e2e/fixtures/plugin-resource-window.cjs'),path.join(root,'profile'),base+'/healthz','--remote-debugging-port='+debug],
    {windowsHide:true,stdio:['ignore',log,log],env:electronEnv}));
  page=await CdpPage.connect(await until(async()=> (await listPages(debug))[0]));
  await page.waitFor(()=>location.pathname==='/healthz'&&document.readyState==='complete');
  await page.call('Page.enable');
  await page.call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await page.call('Page.addScriptToEvaluateOnNewDocument',{source:
    `window.__SODUWORK_TEST_HUB_CONFIG__={allowSwitch:true};
     localStorage.setItem('soduwork_work_hub_environment_v1','development');localStorage.setItem('soduwork_work_development_hub_url_v1',${JSON.stringify(base)});
     window.soduWorkAPI={deviceAuthBootstrap:async()=>({ok:true,stored:true,clientId:'device-alice',session:${JSON.stringify(tokens.alice)},expiresIn:1800})};`});
  await page.call('Page.navigate',{url:base+'/fixture/client'});
  await delay(500);
  if (page.ws.readyState !== WebSocket.OPEN) {
    const prior = page.takeRuntimeErrors(); page.close();
    page = await CdpPage.connect(await until(async () => (await listPages(debug)).find(p => p.url === base+'/fixture/client')));
    page.runtimeErrors.push(...prior);
  }
  await click('[data-cap-tab="skills"]'); await idle();
  await page.waitFor(()=>!!document.querySelector('[data-remove-skill="my-method"]'));
  check('custom Skill has delete; builtin has toggle but no delete',await page.run(()=>!!document.querySelector('[data-skill="builtin-method"]')&&!document.querySelector('[data-remove-skill="builtin-method"]')));
  check('available builtin Skill is enabled by default',(await api('GET','/skills')).enabled.includes('builtin-method'));
  await click('[data-skill="builtin-method"]'); await until(async()=> !(await api('GET','/skills')).enabled.includes('builtin-method'));
  await idle(); await click('[data-skill="builtin-method"]'); await until(async()=> (await api('GET','/skills')).enabled.includes('builtin-method'));
  check('builtin Skill can be disabled and enabled'); await idle();
  await click('[data-remove-skill="my-method"]');
  await page.waitFor(()=>!!document.querySelector('[data-delete-confirm]'));
  const geometry=await page.run(()=>{const d=document.querySelector('.cap-delete-modal'),r=d.getBoundingClientRect();const fonts=[...d.querySelectorAll('*')].filter(e=>e.getClientRects().length&&e.textContent.trim()).map(e=>parseFloat(getComputedStyle(e).fontSize));return{within:r.left>=0&&r.right<=innerWidth,min:Math.min(...fonts)};});
  check('delete confirmation fits viewport with minimum 12px text',geometry.within&&geometry.min>=12);
  await shot('01-skill-delete-confirm');
  await click('[data-delete-cancel]');
  check('cancel retains Skill',!!(await api('GET','/skills/my-method/details')).canDelete);
  await click('[data-remove-skill="my-method"]');
  await page.run(()=>{window.realDeleteSkill=SoduWorkAPI.deleteMySkill;SoduWorkAPI.deleteMySkill=async()=>{throw Error('Fixture temporary offline');};});
  await click('[data-delete-confirm]');
  await page.waitFor(()=>document.querySelector('[data-delete-error]')?.textContent.includes('Fixture temporary offline'));
  check('failed deletion retains card and permits retry',await page.run(()=>!!document.querySelector('[data-remove-skill="my-method"]')&&!document.querySelector('[data-delete-confirm]').disabled));
  await page.run(()=>{SoduWorkAPI.deleteMySkill=window.realDeleteSkill;delete window.realDeleteSkill;});
  await click('[data-delete-confirm]');
  await page.waitFor(()=>document.querySelector('#capModalLayer')?.hidden&&!document.querySelector('[data-remove-skill="my-method"]'));
  check('confirmed Skill deletion refreshes catalog and selection',!(await api('GET','/skills')).enabled.includes('my-method'));
  await click('[data-skill-details="builtin-method"]');
  await page.waitFor(()=>!!document.querySelector('[data-package-download]'));
  check('builtin Skill detail has no delete',await page.run(()=>!document.querySelector('[data-skill-delete]')));
  await click('#capModalClose'); await click('[data-cap-tab="connections"]');
  check('builtin MCP retains toggle without deletion',await page.run(id=>!!document.querySelector('[data-toggle-mcp="'+id+'"]')&&!document.querySelector('[data-connection-key="personal:'+id+'"] button.danger'),builtin.id));
  await click('[data-connection-manage="personal:'+builtin.id+'"]');
  check('builtin MCP management is read-only',await page.run(()=>!!document.querySelector('.connector-readonly-copy')&&!!document.querySelector('[data-readonly-toggle]')&&!document.querySelector('#capMcpUrl')));
  await click('#capModalClose');
  for(const enabled of [true,false]){await mcpAction(builtin.id,'[data-toggle-mcp]');await until(async()=> (await api('GET','/mcp-servers')).personal.find(x=>x.id===builtin.id).enabled===enabled);await delay(300);}
  check('builtin MCP enable and disable persist');
  await mcpAction(own.id,'button.danger');
  await page.waitFor(()=>!!document.querySelector('[data-delete-confirm]'));
  await page.run(()=>document.documentElement.setAttribute('data-theme','ruby'));
  await shot('02-mcp-delete-themed'); await click('[data-delete-cancel]');
  check('cancel retains custom MCP',(await api('GET','/mcp-servers')).personal.some(x=>x.id===own.id));
  await mcpAction(own.id,'button.danger'); await click('[data-delete-confirm]');
  await page.waitFor(id=>document.querySelector('#capModalLayer')?.hidden&&!document.querySelector('[data-connection-key="personal:'+id+'"]'),own.id);
  check('custom MCP deleted without removing builtin',(await api('GET','/mcp-servers')).personal.length===1);
  await page.call('Page.reload'); await click('[data-cap-tab="connections"]');
  check('deletion persists after reload',await page.run(id=>!document.querySelector('[data-connection-key="personal:'+id+'"]'),own.id));
  await page.call('Emulation.setDeviceMetricsOverride',{width:680,height:760,deviceScaleFactor:1,mobile:false});
  await shot('03-builtin-retained-small-screen');
  check('no JavaScript or resource errors',page.takeRuntimeErrors().length===0);
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,output},null,2));
  console.log('Evidence: '+output);
} catch(error) {
  if(page){
    await shot('failure').catch(()=>{});
    const diagnostic={errors:page.takeRuntimeErrors(),state:await page.run(()=>{const ctx=document.getElementById('capContent')?._connectorContext;return{text:document.body.innerText,current:ctx?.isCurrent(),selection:ctx?.state(),rows:ctx?.getMcp()?.personal?.map(x=>({id:x.id,enabled:x.enabled})),menus:[...document.querySelectorAll('.connector-row-menu')].map(x=>({open:x.open,html:x.outerHTML}))};}).catch(()=>null)};
    fs.writeFileSync(path.join(output,'diagnostic.json'),JSON.stringify(diagnostic,null,2));
  }
  console.error('Evidence: '+output);throw error;
}
finally {if(page){try{page.close();}catch{}}for(const child of children.reverse()){try{child.kill();}catch{}}fs.closeSync(log);}
