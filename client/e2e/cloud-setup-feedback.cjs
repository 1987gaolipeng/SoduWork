'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute output directory required');
let win;
const js = source => win.webContents.executeJavaScript(source, true);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(source) {
  for (let i = 0; i < 150; i++) { if (await js('Boolean(' + source + ')')) return; await pause(20); }
  throw Error('Timed out: ' + source);
}
async function stage(text) {
  await until('document.querySelector("[data-ce-progress]")?.textContent.includes(' + JSON.stringify(text) + ')');
  assert.equal(await js('document.querySelector("[data-ce-progress]").hidden'), false);
}
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  app.setPath('userData', path.join(output, 'profile'));
  win = new BrowserWindow({ show: false, width: 1000, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, 'fixtures/cloud-environments.html'));
  await until('document.querySelector("#cloudEnvironmentPanel")');
  await js(`(() => {
    fixture.nodes=[]; fixture.pending={}; fixture.calls=[];
    fixture.defer=name=>(input)=>{ fixture.calls.push(name); return new Promise(resolve=>{fixture.pending[name]=resolve}); };
    soduWorkAPI.cloudComputer.test=fixture.defer('test');
    soduWorkAPI.cloudComputer.save=fixture.defer('save');
    soduWorkAPI.cloudComputer.install=fixture.defer('install');
    SoduWorkAPI.addCloudEnvironment=fixture.defer('create');
    CloudEnvironments.refresh();
  })()`);
  await until('document.querySelector("[data-ce-add]") && !document.querySelector("[data-ce-add]").disabled');
  await js(`(() => {
    document.querySelector('[data-ce-add]').click();
    const form=document.querySelector('dialog form');
    form.elements.name.value='隔离测试电脑'; form.elements.host.value='fixture.invalid';
    form.elements.username.value='fixture'; form.elements.authMethod.value='privateKey';
    form.elements.authMethod.dispatchEvent(new Event('change'));
    form.elements.privateKey.value='synthetic-key';
    form.querySelector('[type=submit]').click();
  })()`);
  await stage('正在测试 SSH 连接');
  assert.equal(await js('document.querySelector("dialog textarea").disabled'), true, 'private key is frozen during the request');
  assert.equal(await js('getComputedStyle(document.querySelector(".ce-progress-spinner")).animationName'), 'ce-progress-spin');
  assert.equal(await js('(() => { const r=document.querySelector("[data-ce-progress]").getBoundingClientRect(); return r.top>=0 && r.bottom<=innerHeight; })()'), true, 'progress stays visible beside the submit button');
  await js('document.querySelector("dialog form").dispatchEvent(new Event("submit",{cancelable:true})); void 0');
  assert.deepEqual(await js('fixture.calls'), ['test'], 'repeated submit cannot duplicate connection attempts');
  await js('fixture.pending.test({ok:false,error:"SSH 连接超时（隔离测试）"}); void 0');
  await until('!document.querySelector("dialog").hasAttribute("aria-busy")');
  assert.match(await js('document.querySelector("dialog [role=alert]").textContent'), /SSH 连接超时/);
  assert.equal(await js('document.querySelector("[data-ce-progress]").hidden'), true);
  assert.equal(await js('document.querySelector("dialog textarea").disabled'), false);
  assert.equal(await js('document.querySelector("dialog textarea").value'), 'synthetic-key');
  assert.equal(await js('document.querySelector("dialog [type=submit]").textContent'), '测试并接入');
  await js('document.querySelector("dialog [type=submit]").click(); void 0');
  await stage('正在测试 SSH 连接');
  await js('fixture.pending.test({ok:true,hostFingerprint:"sha256:fixture"}); void 0');
  await stage('SSH 已连接，正在安全保存');
  await js('fixture.pending.save({ok:true}); void 0');
  await stage('正在创建云端环境');
  await js('fixture.pending.create({ok:true,environment:{id:"target"},setup:{runnerId:"target",commands:{linux:"echo fixture"}}}); void 0');
  await stage('SSH 已连接，正在安装 Runner');
  fs.mkdirSync(output, { recursive: true });
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await pause(100);
  fs.writeFileSync(path.join(output, 'installation-progress.png'), (await win.webContents.capturePage()).toPNG());
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await js('getComputedStyle(document.querySelector(".ce-progress-spinner")).animationName'), 'none');
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 390, height: 760, deviceScaleFactor: 1, mobile: false });
  assert.equal(await js('(() => { const d=document.querySelector("dialog"), r=document.querySelector("[data-ce-progress]").getBoundingClientRect(); return r.top>=0 && r.bottom<=innerHeight && d.scrollWidth<=d.clientWidth; })()'), true, 'narrow dialog keeps the real progress visible without horizontal overflow');
  await js(`(() => {
    SoduWorkAPI.cloudEnvironments=async()=>({ok:true,environments:[{id:'unrelated',online:true,statusText:'不应使用其他环境状态'},{id:'target',online:false}],permissions:{}});
    fixture.pending.install({ok:true,installed:true});
  })()`);
  await until('document.querySelector("dialog")?.dataset.created === "true" && !document.querySelector("dialog").hasAttribute("aria-busy")');
  const connection = await js('document.querySelector("dialog [data-ce-connection]").textContent');
  assert.match(connection, /尚未连接|等待.*上线/);
  assert.doesNotMatch(connection, /正在刷新|不应使用/);
  assert.deepEqual(await js('fixture.calls'), ['test','test','save','create','install']);
  await js('SoduWorkAPI.cloudEnvironments=async()=>({ok:true,environments:[{id:"unrelated",online:false},{id:"target",online:true,statusText:"已连接"}],permissions:{}}); document.querySelector("dialog [data-ce-check]").click(); void 0');
  await until('!document.querySelector("dialog").hasAttribute("aria-busy")');
  assert.equal(await js('document.querySelector("dialog [data-ce-connection]").textContent'), '已连接');
  await js('SoduWorkAPI.cloudEnvironments=async()=>{throw Error("连接检查失败（隔离测试）")}; document.querySelector("dialog [data-ce-check]").click(); void 0');
  await until('!document.querySelector("dialog").hasAttribute("aria-busy")');
  assert.match(await js('document.querySelector("dialog [role=alert]").textContent'), /连接检查失败/);
  assert.equal(await js('document.querySelector("dialog [type=submit]").textContent'), '完成');
  assert.equal(await js('document.querySelector("dialog [data-ce-check]").disabled'), false);
  assert.equal(await js('localStorage.length'), 0);
  await js('document.querySelector("dialog [type=submit]").click(); void 0');
  await until('!document.querySelector("dialog")');
  await js(`(() => {
    SoduWorkAPI.cloudEnvironments=async()=>({ok:true,environments:[],permissions:{canCreate:true},service:{recommendedHub:'https://fixture.invalid'}});
    CloudEnvironmentSetup.open({environments:[],permissions:{canCreate:true},service:{recommendedHub:'https://fixture.invalid'}});
    const form=document.querySelector('dialog form');
    form.elements.name.value='待切换账号'; form.elements.host.value='fixture.invalid';
    form.elements.username.value='fixture'; form.elements.password.value='synthetic';
    form.querySelector('[type=submit]').click();
  })()`);
  await stage('正在测试 SSH 连接');
  await js('fixture.owner="other-account"; CloudEnvironmentSetup.invalidate(); fixture.pending.test({ok:true}); void 0');
  await until('!document.querySelector("dialog")');
  assert.deepEqual(await js('fixture.calls'), ['test','test','save','create','install','test'], 'stale probe cannot save credentials or enroll under a new account');
  const report={ok:true,cases:['visible truthful request stages','single-flight and private-key freeze','SSH failure preserves draft and retry','target Runner online status checked automatically','manual status retry restores controls','narrow layout and reduced motion','account changes discard stale setup']};
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report)); win.destroy(); app.exit(0);
}).catch(error=>{ console.error(error.stack||error); if(win&&!win.isDestroyed())win.destroy(); app.exit(1); });
