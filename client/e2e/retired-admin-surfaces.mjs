// Production admin bundle, isolated browser profile and explicit read-only API fixtures.
// Never connects to enterprise services or exercises approve/publish mutations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {CdpPage, waitForPage} from './lib/cdp.mjs';

const client = path.resolve(import.meta.dirname, '..');
const build = path.resolve(process.argv[2] || '');
const evidence = path.resolve(process.argv[3] || '');
assert.ok(process.argv[2] && process.argv[3], 'Provide the built admin directory and evidence directory');
assert.ok(fs.existsSync(path.join(build, 'index.html')));
fs.mkdirSync(evidence, {recursive:true});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-admin-cleanup-'));
const version = {id:'isolated-version',version:'1.0.0',enabled:true,trustState:'approved',
  capabilities:{executionMode:'skill',hasWorkflow:false,skills:['document-helper'],mcpServers:[]}};
const plugin = {id:'isolated-plugin',key:'document-helper',name:'文档整理助手 · 隔离回归',
  description:'验证当前插件目录与详情入口，没有连接企业发布服务。',sourceKind:'personal',
  enabled:true,latestVersion:version,updatedAt:1};
const fixtures = new Map([
  ['/healthz',{ok:true,version:'isolated-cleanup'}],
  ['/api/v1/admin/me',{id:'isolated-reviewer',displayName:'隔离回归',isSuper:true}],
  ['/api/v1/admin/plugins/governance',{items:[plugin],queues:{},summary:{}}],
  ['/api/v1/admin/plugins',{items:[plugin]}],
  ['/api/v1/admin/model-catalog',{providers:[{id:'isolated',name:'隔离模型服务',enabled:true,
    builtin:true,baseUrl:'http://127.0.0.1/fixture-only',keySet:false}],models:[]}],
  ['/api/v1/admin/capabilities',{cfg:{allowed:['document-helper']},skills:[
    {name:'document-helper',description:'当前能力目录的隔离数据',portable:true,source:'builtin'}],mcpTemplates:[]}],
  ['/api/v1/admin/projects',[]], ['/api/v1/admin/clients',[]],
  ['/api/v1/admin/project-owner-options',[]],
]);
const requests=[], unexpected=[];
const bootstrap = '<script>localStorage.setItem("soduwork_hub_admin_token","isolated-not-a-credential");'+
  'localStorage.setItem("soduwork_hub_admin_user",JSON.stringify({id:"isolated-reviewer",displayName:"隔离回归",isSuper:true}));'+
  'sessionStorage.setItem("soduwork-work-hub-screen","plugins");</script>';
const server = http.createServer((req,res)=>{
  const url = new URL(req.url,'http://127.0.0.1'), pathname=url.pathname;
  if(pathname.startsWith('/api/') || pathname==='/healthz'){
    requests.push({method:req.method,path:pathname});
    if(req.method!=='GET' || !fixtures.has(pathname)){
      unexpected.push({method:req.method,path:pathname});res.writeHead(501,{'Content-Type':'application/json'});
      res.end(JSON.stringify({detail:'Unexpected fixture request'}));return;
    }
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(fixtures.get(pathname)));return;
  }
  if(pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
  const file = path.resolve(build,'.'+decodeURIComponent(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(build+path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()){
    res.writeHead(404);res.end();return;
  }
  const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
  res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');
  res.end(file.endsWith('index.html')?fs.readFileSync(file,'utf8').replace('<head>','<head>'+bootstrap):fs.readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
const port=probe.address().port;await new Promise(r=>probe.close(r));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(path.join(client,'node_modules/electron/dist/electron.exe'),
  [path.join(client,'e2e/fixtures/plugin-resource-window.cjs'),profile,
   'http://127.0.0.1:'+server.address().port,'--remote-debugging-port='+port],
  {windowsHide:true,env,stdio:'ignore'});
const checks=[];let page;
async function click(selector){
  const point=await page.waitFor(s=>{const e=document.querySelector(s);
    if(!e || e.disabled || !e.getClientRects().length)return false;
    e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
  },selector);
  for(const type of ['mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
}
async function screen(id,selector){
  await page.waitFor(({id,selector})=>document.querySelector('.app')?.dataset.screen===id &&
    document.querySelector(selector)?.getClientRects().length,{id,selector});
  assert.equal(await page.run(()=>document.documentElement.scrollWidth>innerWidth+1),false,id+' overflow');
  const result=await page.call('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(evidence,id+'.png'),Buffer.from(result.data,'base64'));
  checks.push(id+' current page loads without overflow');
}
try{
  const deadline=Date.now()+15000;
  while(!page){
    try { page=await CdpPage.connect(await waitForPage(port,p=>p.url.startsWith('http://127.0.0.1:'),1500)); }
    catch(error){if(Date.now()>=deadline)throw error;await new Promise(r=>setTimeout(r,150));}
  }
  await page.call('Page.enable');await page.call('Emulation.setFocusEmulationEnabled',{enabled:true});
  await screen('plugins','.plugin-card');
  assert.equal(await page.run(()=>document.querySelectorAll('.nav-item').length),17);
  const nav = await page.run(()=>[...document.querySelectorAll('.nav-item .nav-copy')].map(x=>x.textContent));
  assert.ok(!nav.some(x=>/审批策略|发布中心|研发自动化|环境中心/.test(x)));
  const entries=[['models','模型目录','.model-provider'],['capabilities','能力目录','.cap-admin-card'],
    ['projects','项目与仓库','.pg-ledger']];
  for(const [id,label,selector] of entries){
    const index=nav.indexOf(label);assert.ok(index>=0,label);
    await page.run(label=>{const item=[...document.querySelectorAll('.nav-item')].find(x=>x.querySelector('.nav-copy')?.textContent===label);
      item.dataset.cleanupTarget='true';},label);
    await click('[data-cleanup-target="true"]');
    await page.run(()=>document.querySelector('[data-cleanup-target]')?.removeAttribute('data-cleanup-target'));
    await screen(id,selector);
  }
  for(const [legacy,current,selector] of [['automation','plugins','.plugin-card'],['flows','plugins','.plugin-card'],
    ['mcp','capabilities','.cap-admin-card'],['skills','capabilities','.cap-admin-card']]){
    await page.run(screen=>window.dispatchEvent(new CustomEvent('soduwork-hub-nav',{detail:{screen}})),legacy);
    await screen(current,selector);checks.push(legacy+' redirects to '+current);
  }
  assert.deepEqual(unexpected,[],'No retired API wrappers should be invoked');
  assert.deepEqual(page.takeRuntimeErrors(),[],'No browser exceptions or failed asset loads');
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({scope:'production bundle with isolated GET fixtures',
    checks,requests,unexpected},null,2));
  console.log(JSON.stringify({passed:checks.length,requests:requests.length,evidence}));
}finally{
  page?.close();child.kill();await new Promise(r=>server.close(r));
}
