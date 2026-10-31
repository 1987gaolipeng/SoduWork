'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path'), fs = require('node:fs/promises');
const assert = require('node:assert/strict');
require('./lib/isolated-profile.cjs').isolateProfile(app, 'cloud-start-compose');

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute output directory required');
let win;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = source => win.webContents.executeJavaScript(source, true);
async function until(source) {
  for (let i = 0; i < 160; i += 1) {
    if (await js('Boolean(' + source + ')')) return;
    await sleep(30);
  }
  throw Error('Timed out: ' + source);
}

async function click(selector) {
  const point = await js('(()=>{const r=document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
  await sleep(60);
}
async function key(keyCode) {
  keyCode = ({ ArrowDown: 'Down', ArrowUp: 'Up' })[keyCode] || keyCode;
  for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode });
  await sleep(60);
}
async function chooseLocation(location) {
  if (await js('document.querySelector("[data-execution-menu]").getAttribute("aria-expanded")') !== 'true') await click('[data-execution-menu]');
  await until('!document.querySelector(".wc-execution-pop").hidden');
  await click('[data-execution=' + location + ']');
}
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 820, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }, offscreen: true });
  await win.loadFile(path.join(__dirname, 'fixtures/cloud-start-compose.html'));
  await until('document.querySelector("[data-execution-menu]")');
  assert.equal(await js('document.querySelector(".cp-execution-options")'), null);
  assert.equal(await js('document.querySelectorAll("[data-execution-menu]").length'), 1);
  assert.equal(await js('document.querySelectorAll(".wc-execution-pop [role=menuitemradio]").length'), 2);
  assert.equal(await js('[...document.querySelectorAll("[data-execution-menu] svg")].filter(icon=>getComputedStyle(icon).display!=="none").length'), 1);
  assert.equal(await js('document.querySelector("[data-execution=local]").getAttribute("aria-checked")'), 'true');
  await click('[data-execution-menu]');
  assert.equal(await js('document.querySelector("[data-execution-menu]").getAttribute("aria-expanded")'), 'true');
  assert.equal(await js('ComposeExecution.value()'), 'local');
  assert.equal(await js('starts'), 0);
  await key('Escape');
  assert.equal(await js('document.querySelector(".wc-execution-pop").hidden'), true);
  assert.equal(await js('document.activeElement.matches("[data-execution-menu]")'), true);
  await key('ArrowDown');
  await until('!document.querySelector(".wc-execution-pop").hidden');
  await key('End');
  assert.equal(await js('document.activeElement.dataset.execution'), 'cloud');
  await key('Home');
  assert.equal(await js('document.activeElement.dataset.execution'), 'local');
  await click('#receipt');
  assert.equal(await js('document.querySelector(".wc-execution-pop").hidden'), true);
  assert.equal(await js('ComposeExecution.value()'), 'local');
  assert.equal(await js('starts'), 0);

  // A new conversation with no personal cloud computer must explain the
  // missing setup before the first send, rather than failing after submit.
  await js("soduWorkAPI.conversationSession.cloud.targets = async () => ({ok:true,targets:[],diagnostics:{summary:'请先连接你的云端电脑'}}); void 0");
  await chooseLocation('cloud');
  await until('!document.querySelector(".wc-execution-notice").hidden');
  assert.equal(await js('document.querySelector("#receipt").textContent'), '');
  await js("document.querySelector('[data-execution-configure]').click(); void 0");
  assert.equal(await js('document.querySelector("#receipt").textContent'), '打开云端环境配置');
  assert.equal(await js('document.querySelector("[data-execution=cloud]").getAttribute("aria-checked")'), 'true');
  await js('document.querySelector("#receipt").textContent = ""; document.querySelector("#cpGo").click(); void 0');
  await until('document.querySelector("#receipt").textContent.length > 0');
  await until('document.querySelector("[data-execution-menu]").disabled === false');
  assert.match(await js('document.querySelector("#receipt").textContent'), /没有可用|配置云端|连接你的云端/);

  // Once a machine becomes available, the same conversation can continue
  // without a second screen or a stale “no machine” state.
  await js("soduWorkAPI.conversationSession.cloud.targets = async () => ({ok:true,targets:[{id:'remote'}]}); ComposeRuntime.refreshAccess(); void 0");
  await until('ComposeRuntime.availability()?.ok === true');
  assert.equal(await js('document.querySelector(".cp-cloud-settings")'), null);
  // Cloud Harnesses are independently selectable. The selected Agent is part
  // of the cloud start request and switching back to local keeps the local
  // selection instead of leaking the remote choice across locations.
  await js("soduWorkAPI.conversationSession.cloud.targets = async agent => ({ok:true,targets:[{id:'remote',agentId:agent || 'pi'}]}); document.querySelector('#cpRuntime').click(); void 0");
  await until('document.querySelector("#cpRuntimePop").classList.contains("show")');
  await js("document.querySelector('[data-runtime=\\\"qwen\\\"]').click(); void 0");
  await until('ComposeRuntime.value() === "qwen"');
  assert.equal(await js('ComposeRuntime.location()'), 'cloud');
  assert.equal(await js('document.querySelector("#cpRuntimeName").textContent'), 'Qwen Code');
  assert.equal(await js('document.querySelector("#cpRuntimePop .cp-runtime-heading b").textContent'), '选择云端 Harness');
  await chooseLocation('local');
  await until('ComposeExecution.value() === "local"');
  assert.equal(await js('ComposeRuntime.value()'), 'pi');
  await chooseLocation('cloud');
  await until('ComposeExecution.value() === "cloud"');
  await until('ComposeRuntime.value() === "qwen"');
  // Sending fences the location control and keeps the draft intact. A stale
  // preparation cannot dispatch into a replacement conversation.
  await js("window.modeCurrent=true; window.modePending=ComposeExecution.start({text:'retained draft',attachments:[],isCurrent:()=>modeCurrent,prepare:()=>new Promise(resolve=>window.finishModePrepare=resolve)}); void 0");
  await until('window.finishModePrepare');
  assert.equal(await js('[...document.querySelectorAll("[data-execution]")].every(button=>button.disabled)'), true);
  assert.equal(await js('document.querySelector("[data-execution-menu]").disabled'), true);
  await click('[data-execution-menu]');
  assert.equal(await js('document.querySelector(".wc-execution-pop").hidden'), true);
  assert.equal(await js('ComposeExecution.value()'), 'cloud');
  await js('modeCurrent=false;ComposeExecution.reset();finishModePrepare({attachments:[]});void 0');
  assert.equal(await js('modePending'), false);
  assert.equal(await js('ComposeExecution.value()'), 'local');
  assert.equal(await js('document.querySelector("[data-execution=local]").getAttribute("aria-checked")'), 'true');
  assert.equal(await js('[...document.querySelectorAll("[data-execution]")].some(button=>button.disabled)'), false);
  assert.equal(await js('starts'), 0);
  win.setSize(420, 760);
  await sleep(80);
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
  await click('[data-execution-menu]');
  const geometry = await js('(()=>{const r=document.querySelector(".wc-execution-pop").getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}})()');
  assert.ok(geometry.left >= 0 && geometry.right <= geometry.width && geometry.top >= 0 && geometry.bottom <= geometry.height, JSON.stringify(geometry));
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'menu-narrow.png'), (await win.webContents.capturePage()).toPNG());
  await key('Escape');
  console.log(JSON.stringify({ ok: true, cases: [
    'single icon opens a menu without switching; Escape, outside click and keyboard navigation preserve mode',
    'new chat without a cloud computer guides setup before send',
    'cloud availability refreshes in place and stays usable on narrow layout',
    'cloud Harnesses can be switched while local remains the default'
  ] }));
  win.destroy(); app.exit(0);
}).catch(error => {
  console.error(error.stack || error);
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(1);
});
