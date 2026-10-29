import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { CdpPage, listPages } from './lib/cdp.mjs';
const require = createRequire(import.meta.url);
const core = require('../main/personal-plugin-debug.js');
const { verify } = require('../main/personal-plugin-debug-runner.js');
const root = path.resolve(import.meta.dirname, '..');
const evidence = path.resolve(process.env.SODUWORK_PLUGIN_DEBUG_EVIDENCE || path.join(os.tmpdir(), 'soduwork-plugin-debug-e2e-' + Date.now()));
fs.mkdirSync(evidence, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-plugin-debug-profile-'));
const work = path.join(profile, 'work'); fs.mkdirSync(work);
const plugin = { pluginId: 'local:workflow-e2e', enabled: true, personal: true, name: '产品简报 · 本机工作流', version: '1.0.0',
  checksum: 'isolated-fixture', inputs: [{ key: 'format', type: 'select', label: '输出格式', required: true, options: [{value:'md',label:'Markdown'}] }], capabilities: { hasWorkflow: true },
  localDraft: { key: 'workflow-e2e', name: '产品简报', template: 'workflow', instructions: '生成简报并人工检查',
    skills: [], runtime: [], mcpServers: [] } };
let controller = null, record = null, workCount = 0, calls = [], output = [];
const journal = core.store(path.join(profile, 'journal'), 'fixture-chat');
function start() {
  record = core.createRecord(plugin, 'fixture-chat', '生成产品简报，并检查交付物');
  record.nodes.find(node => node.key === 'work').outputs = [{ key: 'result', label: '简报', kind: 'file', path: 'brief.md', required: true }];
  controller = core.create({ record, save: value => journal.write(value), message: text => output.push(text),
    stopNode: async () => {},
    executeNode: async node => {
      calls.push(node.key);
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (node.key === 'understand') return [{ key: 'plan', kind: 'evidence', text: '已制定简报计划' }];
      if (++workCount === 1) return verify(node, work, work, '我完成了，但没有写文件');
      fs.writeFileSync(path.join(work, 'brief.md'), '# 产品简报\n\n已完成本地验证');
      return verify(node, work, work, '真实文件已生成');
    } });
  controller.execute().catch(error => output.push(error.message));
}
const html = `<!doctype html><meta charset="utf-8"><title>插件调试独立页面验收</title>
<link rel="stylesheet" href="/components/panels/plugin-ui-host.css"><link rel="stylesheet" href="/components/panels/plugin-debug-card.css">
<style>body{margin:0;background:#f7f9fc;font:14px "Segoe UI","Microsoft YaHei",sans-serif;color:#243247}.demo{width:min(860px,calc(100% - 64px));margin:36px auto}.demo h1{font-size:22px}.ordinary{padding:24px;background:white;border:1px solid #e1e7ef;border-radius:16px;margin:20px 0}.nchat-draft{width:100%}.composer{border:1px solid #dce4ef;border-radius:16px;background:#fff;padding:20px}.composer textarea{font:14px inherit;width:100%;border:0;resize:none}.composer footer{color:#66758a;font-size:13px;margin-top:12px}</style>
<div class="demo" id="cpChat"><h1>产品简报验证</h1><div class="ordinary" id="ordinary">普通会话的消息与输入框保持不变。</div><div class="nchat-draft"></div><div class="composer"><textarea id="ordinary-input" placeholder="接着说…" rows="2"></textarea><footer>工作目录 · Pi</footer></div></div>
<script>window.ChatWorkbench={openOutput:()=>false,openInput:file=>{window.lastWorkbenchFile=file;return true;}};window.NativeChat={sessionInfo:()=>({ref:'fixture-chat'})};window.soduWorkAPI={personalPlugins:{
list:async()=>({ok:true,items:[${JSON.stringify(plugin)}]}),
debug:async(ref,options)=>fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(options)}).then(r=>r.json())
},conversationSession:{
outputs:async()=>fetch('/files').then(r=>r.json()),
readOutput:async()=>fetch('/preview').then(r=>r.json())
}};</script>
<script src="/components/panels/plugin-ui-host.js"></script><script src="/components/panels/plugin-debug-card.js"></script><script>PluginDebugCard.open({ref:'fixture-chat'});</script>`;
const server = http.createServer(async (req, res) => {
  if (req.url === '/api') {
    let text = ''; for await (const chunk of req) text += chunk;
    const options = JSON.parse(text || '{}');
    try {
      if (options.command === 'start' && (!record || core.terminal.has(record.status))) { core.inputValues(plugin.inputs, options.parameters); start(); }
      if (['approve', 'retry', 'cancel'].includes(options.command)) await controller.action(options.command, options.revision, options.nodeKey);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, run: core.view(record), recoverable: false })); return;
    } catch (error) { res.end(JSON.stringify({ ok: false, reason: error.message })); return; }
  }
  if (req.url === '/files' || req.url === '/preview') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/files' ? {ok:true,files:[{name:'brief.md',relative:'brief.md',path:path.join(work,'brief.md')}]} : {ok:true,text:fs.readFileSync(path.join(work,'brief.md'),'utf8')}));
    return;
  }
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
  const files = ['/components/panels/plugin-ui-host.css', '/components/panels/plugin-debug-card.css',
    '/components/panels/plugin-ui-host.js', '/components/panels/plugin-debug-card.js'];
  if (!files.includes(req.url)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript');
  res.end(fs.readFileSync(path.join(root, req.url)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = 9468, url = 'http://127.0.0.1:' + server.address().port;
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const launchArgs = [path.join(root, 'e2e/fixtures/plugin-resource-window.cjs'), profile, url, '--remote-debugging-port=' + port,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
if (process.platform === 'linux' && !env.DISPLAY) launchArgs.push('--ozone-platform=headless');
const child = spawn(require('electron'), launchArgs,
  { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
let childLog = '';
child.stdout.on('data', value => { childLog += value; });
child.stderr.on('data', value => { childLog += value; });
let page;
const shots = [], checks = [];
async function shot(name) {
  const result = await page.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(evidence, name + '.png'), Buffer.from(result.data, 'base64')); shots.push(name + '.png');
}
async function activate(label) {
  const point = await page.run(label => {
    const node = [...document.querySelectorAll('button')].find(node => node.textContent === label);
    if (!node || node.disabled) throw new Error('按钮不可用：' + label);
    node.scrollIntoView({ block: 'center' });
    const rect = node.getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
  }, label);
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point });
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...point });
}
try {
  for (let i = 0; i < 80; i++) {
    try { const target = (await listPages(port, 1000)).find(item => item.url.startsWith(url)); if (target) { page = await CdpPage.connect(target); break; } }
    catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.ok(page, '独立测试页面应启动：' + childLog.slice(-2000));
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 940, deviceScaleFactor: 1, mobile: false });
  await page.waitFor(() => Boolean(document.querySelector('.pdebug textarea')), null, 5000);
  await shot('01-ready');
  await page.run(() => { document.querySelector('.pdebug textarea').value = '验证产品简报生成和审批'; document.querySelector('#ordinary-input').value = '尚未发送的普通消息'; });
  await activate('开始本机调试');
  await page.waitFor(() => !document.querySelector('.pdebug-error').hidden, null, 4000);
  assert.equal(record, null); checks.push('缺少必填插件参数时不启动');
  await page.run(() => { document.querySelector('[data-parameter="format"]').value = 'md'; });
  await activate('开始本机调试');
  await page.waitFor(() => document.querySelector('.pdebug-status')?.textContent === '执行中', null, 4000);
  await shot('02-running');
  await page.waitFor(() => document.querySelector('.pdebug-status')?.textContent === '已暂停', null, 8000);
  assert.equal(record.nodes.find(node => node.key === 'complete').status, 'pending');
  checks.push('缺少文件时暂停，未误报成功');
  await shot('03-failed');
  await activate('重试本步骤');
  await page.waitFor(() => document.querySelector('.pdebug-status')?.textContent === '等待你确认', null, 8000);
  assert.deepEqual(calls, ['understand', 'work', 'work']);
  checks.push('仅重试失败节点，不重跑已完成节点');
  await activate('查看简报');
  await page.waitFor(() => document.querySelector('.pdebug-file-preview')?.textContent.includes('已完成本地验证'), null, 4000);
  assert.equal(record.status, 'waiting');
  checks.push('审批前可在卡内查看实际成果正文，不会触发通过');
  await shot('04-approval');
  await activate('收起预览');
  const layout = await page.run(() => ({
    small: [...document.querySelectorAll('.pdebug *')].filter(node => node.textContent.trim() && parseFloat(getComputedStyle(node).fontSize) < 12).map(node => node.className),
    overflow: document.documentElement.scrollWidth > innerWidth,
    text: document.querySelector('#ordinary-input').value,
  }));
  assert.deepEqual(layout.small, []); assert.equal(layout.overflow, false);
  assert.equal(layout.text, '尚未发送的普通消息'); checks.push('最小字号12px、无横向溢出、普通输入未丢失');
  await page.call('Page.reload', {});
  await page.waitFor(() => document.querySelector('.pdebug-status')?.textContent === '等待你确认', null, 8000);
  assert.equal(journal.read().status, 'waiting'); checks.push('刷新恢复等待确认，不自动审批');
  await activate('确认通过并继续');
  await page.waitFor(() => document.querySelector('.pdebug-status')?.textContent === '已完成', null, 6000);
  assert.equal(record.status, 'completed');
  checks.push('页面确认后才执行办结，真实文件及校验值留存');
  await shot('05-completed');
  await activate('新一轮调试');
  await page.waitFor(() => Boolean(document.querySelector('.pdebug textarea')), null, 4000);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(await page.run(() => Boolean(document.querySelector('.pdebug textarea'))), true);
  checks.push('新一轮草稿不会被后台轮询覆盖');
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
  await shot('06-desktop-1024');
  assert.equal(await page.run(() => document.documentElement.scrollWidth > innerWidth), false);
  record.mode = 'conversation'; record.revision++;
  await page.call('Page.reload', {});
  await page.waitFor(() => Boolean(document.querySelector('.pdebug.is-collaboration')), null, 5000);
  assert.equal(await page.run(() => document.querySelector('.pdebug').getBoundingClientRect().height), 0);
  checks.push('完成的普通协作不再留下接力卡');
  record.status = 'running'; record.revision++;
  await page.call('Page.reload', {});
  await page.waitFor(() => Boolean(document.querySelector('.pdebug.is-collaboration[hidden]')), null, 5000);
  assert.equal(await page.run(() => Boolean(document.querySelector('.pdebug-progress'))), false);
  checks.push('执行中复用普通对话，不渲染专用流程标题或进度卡');
  const review = record.nodes.find(node => node.type === 'human_review');
  record.status = 'waiting'; review.status = 'waiting'; record.revision++;
  await page.call('Page.reload', {});
  await page.waitFor(() => Boolean(document.querySelector('.pdebug.is-collaboration:not([hidden])')), null, 5000);
  assert.equal(await page.run(() => document.querySelector('.pdebug-head').getBoundingClientRect().height), 0);
  assert.equal(await page.run(() => [...document.querySelectorAll('.pdebug button')].some(b => b.textContent === '确认通过并继续')), true);
  checks.push('需要人工确认时仍显示必要操作，不显示协作标题');
  await page.run(() => { document.querySelector('.pdebug-evidence').open = true; });
  await activate('查看简报');
  await page.waitFor(() => Boolean(window.lastWorkbenchFile), null, 4000);
  assert.equal(await page.run(() => window.lastWorkbenchFile.name), 'brief.md');
  assert.equal(await page.run(() => Boolean(document.querySelector('.pdebug-file-preview'))), false);
  checks.push('普通协作成果复用右侧工作区入口，不内嵌另一份正文或调用系统打开');
  assert.deepEqual(page.takeRuntimeErrors(), []);
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ kind: 'isolated-renderer-with-real-debug-state-machine', input: 'CDP pointer input in isolated Electron renderer', realModel: false, checks, shots, calls }, null, 2));
  console.log(JSON.stringify({ ok: true, checks, evidence, shots }));
} catch (error) {
  const state = page ? await page.run(() => ({
    body: document.body.innerText, fields: [...document.querySelectorAll('input,select,textarea')]
      .map(node => ({ name: node.id || node.dataset.parameter, value: node.value })),
  })).catch(() => null) : null;
  fs.writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify({ error: error.stack, state, calls, childLog }, null, 2));
  console.error('Isolated UI failure evidence: ' + evidence);
  throw error;
} finally { if (page) page.close(); child.kill(); server.close(); }
