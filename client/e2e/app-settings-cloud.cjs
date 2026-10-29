'use strict';
// Real Electron/native bridge + production cloud login/ukey/MCP + rollback-only PG.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_NO_ATTACH_CONSOLE','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename, ...process.argv.slice(2), '--disable-gpu'], { env, windowsHide: true, stdio: 'inherit', timeout: 210000 });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, WebContentsView, ipcMain, safeStorage } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), readline = require('node:readline');
const args = process.argv.slice(2), option = key => args[args.indexOf(key) + 1];
if (!args.includes('--cloud-root') || !args.includes('--cloud-python')) throw Error('Explicit --cloud-root and --cloud-python required');
const cloud = path.resolve(option('--cloud-root')), root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-auth-e2e-'));
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const report = { ok: false, cases: [], boundary: 'Production Electron preload/SDK/postMessage, H5 login and cloud ukey/MCP APIs, real PostgreSQL rolled back. Isolated SoduWork owner fixture; no real model or paid media calls.' };
const windows = [], grants = [];
let fixture, host, rolledBack = false, fixtureError = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label) => { for (let i=0; i<400; i++) { try { if (await check()) return; } catch (_) {} await delay(50); } throw Error('Timed out: ' + label); };
const js = (wc, value) => wc.executeJavaScript(value);
app.whenReady().then(async () => {
  fixture = spawn(option('--cloud-python'), [path.join(cloud,'server/tests/app_auth_e2e_server.py')], { cwd: cloud, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  fixture.stderr.on('data', data => { fixtureError += data.toString(); });
  const lines = readline.createInterface({ input: fixture.stdout });
  const info = await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(Error('Cloud fixture did not start: ' + fixtureError)), 20000);
    lines.on('line', line => { const value = JSON.parse(line); if (value.rolledBack) rolledBack = true; if (value.base) { clearTimeout(timer); resolve(value); } });
    fixture.once('error', reject);
  });
  const store = require('../main/app-settings-store.cjs'), personal = require('../main/personal-plugins'), preview = require('../main/work-preview');
  store.configure({ app, safeStorage, ownerOf: () => 'isolated-hub/soduwork-owner-fixture' });
  const body = JSON.parse(fs.readFileSync(path.join(cloud,'plugin/soduwork-plugin-draft.json')));
  body.ui.contributions[0].source.url = info.base + '/login.html';
  const plugin = personal.create(app, body).plugin, pluginId = plugin.pluginId;
  const binding = { pluginId, origin: info.base };
  fs.writeFileSync(path.join(root,'host.html'), '<!doctype html><title>Authentication test host</title>');
  fs.writeFileSync(path.join(root,'composer.html'), '<!doctype html><title>Isolated composer surface</title>');
  preview.install({ app, ipcMain,
    BrowserWindow: Object.assign(function(options) { const win = new BrowserWindow(options); windows.push(win); return win; }, { fromWebContents: wc => BrowserWindow.fromWebContents(wc) }),
    WebContentsView: function(options) { const view = new WebContentsView(options), load = view.webContents.loadFile.bind(view.webContents); view.webContents.loadFile = (file, options) => load(path.basename(file) === 'desk.html' ? path.join(root,'composer.html') : file, options); return view; },
    shell: { openExternal: async () => { throw Error('No external opens'); } } });
  host = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname,'../preload.js'), contextIsolation: true, sandbox: true } });
  await host.loadFile(path.join(root,'host.html'));
  const payload = { tabId: 'auth-fixture', url: info.base + '/login.html', appBridge: { appId: 'plugin:' + pluginId, contributionId: 'ops-cloud-console', origin: info.base, version: 1, capabilities: body.ui.contributions[0].source.bridge.capabilities } };
  async function open() {
    const shown = await js(host.webContents,'soduWorkAPI.workPreview.showDetached(' + JSON.stringify(payload) + ')'); assert.equal(shown.ok,true,shown.reason);
    const [,view,composer] = windows.at(-1).contentView.children;
    await until(() => !view.webContents.isLoading() && js(view.webContents,'!!window.MediaOpsAppSettings'), 'application settings SDK');
    return { wc: view.webContents, composer: composer.webContents, win: windows.at(-1) };
  }
  let surface = await open();
  async function login(user) {
    await until(() => js(surface.wc,'!!document.getElementById("username")'), 'login form');
    await js(surface.wc, 'username.value=' + JSON.stringify(user.username) + ';password.value="app-auth-fixture-only";document.getElementById("box").requestSubmit()');
    await until(async () => surface.wc.getURL().includes('/home.html') && await js(surface.wc,'!!window.MediaOpsAppSettings && !!window.MediaOpsSkills'), 'cloud home after password login');
    await until(() => store.read(binding).values.accountId === user.id && preview.appContextFor(surface.composer)?.connection, 'ukey synchronization and own MCP connection');
  }
  const pluginGrant = require('../main/pi-session/plugin-grant');
  async function grant() {
    const value = await pluginGrant.resolve({ app, ref: 'settings-auth-fixture', cwd: root, pluginIds: [pluginId], appContext: preview.appContextFor(surface.composer), identityOf: async () => { throw Error('Must use own app connector'); } });
    grants.push(value.grant);
    const contents = fs.readFileSync(value.grant.configFile,'utf8');
    assert.ok(!contents.includes(store.read(binding).values.ukey));
    return { grant: value.grant, config: JSON.parse(contents).servers['media-ops-cloud'] };
  }
  async function who(lease) {
    const response = await fetch(lease.config.url, { method: 'POST', headers: { ...lease.config.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }) });
    return { status: response.status, data: await response.json() };
  }
  await login(info.users[0]);
  const first = await grant(); assert.equal((await who(first)).data.result.structuredContent.user.id, info.users[0].id);
  report.cases.push('Real H5 password login issues ukey, stores it through native settings bridge, and production per-turn MCP grant resolves account A. Stored key is absent from agent config.');
  let original = store.read(binding).values.ukey;
  const saved = await js(surface.wc,'soduWorkApp.settings.update({values:{theme:"dark",customOptions:{language:"zh-CN",count:2}}})'); assert.equal(saved.ok,true);
  assert.equal(store.read(binding).values.customOptions.count,2);
  assert.equal((await js(surface.wc,'soduWorkApp.settings.get()')).values.ukey, undefined);
  report.cases.push('Arbitrary JSON application parameters share the same scoped settings; ordinary reads mask credentials and explicit own-app reads are supported.');
  const beforeRotation = await grant();
  await js(surface.wc,'document.getElementById("openAccountSettings").click()');
  let account;
  await until(async () => {
    account = surface.wc.mainFrame.frames.find(frame => frame.url.includes('/account.html'));
    return account && await account.executeJavaScript('!!document.getElementById("accountUkey")?.value && !!window.MediaOpsAccountAccess');
  }, 'real settings drawer and fixed ukey');
  const frameJs = value => account.executeJavaScript(value);
  await frameJs('location.hash="security"');
  assert.equal(await frameJs('accountUkey.value'), original);
  assert.equal(await frameJs('(async()=>{const a=await MediaOpsAccountAccess.request("/api/auth/ukey");const b=await MediaOpsAccountAccess.request("/api/auth/ukey");return a.ukey===b.ukey && b.ukey===accountUkey.value})()'),true);
  await frameJs('showAccountUkey.click()');
  await until(()=>frameJs('accountUkey.type==="text"'),'show fixed ukey');
  await until(()=>frameJs('!regenerateAccountUkey.disabled'),'rotation action ready');
  assert.equal(await frameJs('(()=>{if(regenerateAccountUkey.disabled)return false;regenerateAccountUkey.click();return accountUkeyStatus.textContent.includes("正在")})()'),true);
  try { await until(()=>store.read(binding).values.ukey !== original,'regeneration updates native settings through iframe'); }
  catch(error) { report.credentialUI=await frameJs('({status:accountUkeyStatus.textContent,disabled:regenerateAccountUkey.disabled,hasKey:!!accountUkey.value})');throw error; }
  await until(()=>frameJs('accountUkeyStatus.textContent.includes("壳已自动同步")'),'visible shell sync result');
  assert.equal((await who(beforeRotation)).status,401);
  const oldResponse = await fetch(info.base + '/api/auth/me',{headers:{Authorization:'Bearer '+original}}); assert.equal(oldResponse.status,401);
  original = store.read(binding).values.ukey;
  assert.equal(await frameJs('accountUkey.value'),original);
  assert.equal((await who(await grant())).data.result.structuredContent.user.id,info.users[0].id);
  report.cases.push('Actual personal-settings iframe shows one fixed account ukey, explicit regeneration invalidates the old key and grant, and postMessage immediately updates encrypted shell settings and the next MCP turn.');
  // Clipboard is an isolated browser capability fixture; no system clipboard changes.
  await frameJs('Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{window.__copied=text}}})');
  await frameJs('location.hash="integration"');
  const downloads = [];
  surface.wc.session.on('will-download', (_event,item) => {
    const file = path.join(root,item.getFilename()); item.setSavePath(file);
    item.once('done',(_event,state)=>downloads.push({state,file}));
  });
  for (const client of ['workbuddy','codex','generic']) {
    await frameJs('document.querySelector("[data-integration-client='+client+']").click()');
    await until(()=>frameJs('document.querySelector("[data-integration-client='+client+']").getAttribute("aria-pressed")==="true"'),'client guide '+client);
    await frameJs('window.__copied="";copyMcpConfig.click()');
    await until(()=>frameJs('!!window.__copied'),'MCP config copy '+client);
    const copied = await frameJs('window.__copied');
    let mcp;
    if (client === 'codex') mcp = {url:JSON.parse(copied.match(/^url = (.+)$/m)[1]), headers:{Authorization:JSON.parse(copied.match(/Authorization = ("[^"]+")/)[1])}};
    else mcp = JSON.parse(copied).mcpServers['media-ops-cloud'];
    const response = await fetch(mcp.url,{method:'POST',headers:{...mcp.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'whoami',arguments:{}}})});
    assert.equal((await response.json()).result.structuredContent.user.id,info.users[0].id);
    await frameJs('testMcpConnection.click()');
    await until(()=>frameJs('integrationStatus.textContent.includes("连接成功")'),'UI MCP handshake '+client);
    const count = downloads.length;
    await frameJs('downloadSkill.click()');
    await until(()=>downloads.length>count,'actual ZIP download '+client);
    const downloaded = downloads.at(-1); assert.equal(downloaded.state,'completed');
    const entries = require('../main/plugin-package-reader.cjs')._readEntries(fs.readFileSync(downloaded.file));
    assert.ok(entries.has('media-ops-cloud/SKILL.md'));
    for (const bytes of entries.values()) assert.ok(!bytes.includes(Buffer.from(original)));
    const skillRoot = path.join(root,'skill-'+client);
    for (const [name,bytes] of entries) {
      const target = path.resolve(skillRoot,name); assert.ok(target.startsWith(skillRoot+path.sep));
      fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
    }
    await frameJs('window.__copied="";copyConnection.click()');
    await until(()=>frameJs('!!window.__copied'),'skill connection copy '+client);
    const cfg = JSON.parse(await frameJs('window.__copied')); assert.equal(cfg.ukey,original);
    fs.writeFileSync(path.join(root,'.soduwork-media-ops.json'),JSON.stringify(cfg),{mode:0o600});
    const output = await new Promise((resolve,reject) => {
      const child = spawn(option('--cloud-python'),[path.join(skillRoot,'media-ops-cloud/scripts/workbench_client.py'),'connect'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
      child.once('exit',code=>code===0?resolve(stdout):reject(Error('Downloaded skill connect failed: '+stderr)));child.once('error',reject);
    });
    assert.equal(JSON.parse(output).user.id,info.users[0].id);
    fs.rmSync(path.join(root,'.soduwork-media-ops.json'),{force:true});
  }
  report.cases.push('WorkBuddy, Codex and generic personal-setting guides copy real working MCP configurations, pass UI initialize/tools/list/whoami, download credential-free ZIPs, and execute each downloaded skill client against the real cloud identity. External desktop clients themselves are not installed/configured by this test.');
  await js(surface.wc,'toggleDrawer(false)');
  await js(surface.wc,'document.querySelector("[data-account-logout]").click()');
  await until(() => js(surface.wc,'!localStorage.getItem("soduworkToken") && sessionStorage.getItem("soduworkShellLoggedOut")==="1"'), 'explicit logout');
  assert.equal(store.read(binding).values.ukey,original);
  report.cases.push('Page logout removes the browser login and stays logged out in this window while preserving the encrypted shell credential.');
  surface.win.destroy();
  surface = await open();
  await until(async () => surface.wc.getURL().includes('/home.html') && await js(surface.wc,'!!window.MediaOpsSkills'), 'automatic ukey login after reopen');
  assert.equal(await js(surface.wc,'JSON.parse(localStorage.getItem("soduworkAuth")).user.id'),info.users[0].id);
  report.cases.push('Closing and reopening the native app reads stored ukey through the public bridge and automatically authenticates account A against the real cloud API.');
  await until(()=>preview.appContextFor(surface.composer)?.connection,'auto-login MCP ready');
  assert.equal(await js(surface.wc,'localStorage.getItem("soduworkToken").startsWith("uk_")'),true);
  const autoLease = await grant();
  await js(surface.wc,'document.getElementById("openAccountSettings").click()');
  await until(async()=>{account=surface.wc.mainFrame.frames.find(frame=>frame.url.includes('/account.html'));return account && await frameJs('!!accountUkey.value && !regenerateAccountUkey.disabled')},'auto-login settings iframe');
  await frameJs('location.hash="security"');
  await until(()=>frameJs('!regenerateAccountUkey.disabled'),'auto-login rotation action ready');
  assert.equal(await frameJs('(()=>{if(regenerateAccountUkey.disabled)return false;regenerateAccountUkey.click();return accountUkeyStatus.textContent.includes("正在")})()'),true);
  try { await until(()=>store.read(binding).values.ukey!==original,'auto-login rotation reaches shell'); }
  catch(error) { report.credentialUI=await frameJs('({status:accountUkeyStatus.textContent,disabled:regenerateAccountUkey.disabled,hasKey:!!accountUkey.value})');throw error; }
  await until(()=>frameJs('accountUkeyStatus.textContent.includes("壳已自动同步")'),'auto-login rotation visible result');
  assert.equal((await who(autoLease)).status,401);
  original=store.read(binding).values.ukey;
  assert.equal(await js(surface.wc,'localStorage.getItem("soduworkToken")'),original);
  assert.equal((await who(await grant())).data.result.structuredContent.user.id,info.users[0].id);
  await frameJs('location.hash="integration"');
  await until(()=>frameJs('!document.getElementById("panel-integration").hidden'),'integration panel layout');
  assert.equal(await frameJs('document.documentElement.scrollWidth<=innerWidth'),true);
  const evidence=path.resolve(__dirname,'../../outputs/fixed-ukey-integrations-20261021');fs.mkdirSync(evidence,{recursive:true});
  await delay(250);
  fs.writeFileSync(path.join(evidence,'personal-integrations.png'),(await surface.wc.capturePage()).toPNG());
  report.cases.push('An app automatically signed in with ukey can regenerate it from the iframe: page bearer and shell settings both change, old MCP lease is rejected, current connection remains usable, and the settings layout fits its native drawer.');
  await js(surface.wc,'toggleDrawer(false)');

  // Log out again, then choose a different account in the normal login page.
  await js(surface.wc,'document.querySelector("[data-account-logout]").click()');
  await until(() => js(surface.wc,'!localStorage.getItem("soduworkToken")'), 'second logout');
  await surface.wc.loadURL(info.base + '/login.html');
  await login(info.users[1]);
  assert.notEqual(store.read(binding).values.ukey, original);
  assert.equal((await who(first)).status,401);
  const second = await grant(); assert.equal((await who(second)).data.result.structuredContent.user.id,info.users[1].id);
  assert.equal(store.read(binding).values.theme,'dark');
  report.cases.push('Account B login replaces ukey atomically, preserves other settings, rejects account A stale MCP lease and resolves account B on a new turn.');
  const forbidden = await js(surface.wc,'soduWorkApp.settings.update({values:JSON.parse(\'{"__proto__":{"polluted":true}}\')})'); assert.equal(forbidden.ok,false);
  report.cases.push('Malformed settings are rejected at the production native boundary.');
  report.ok = true;
}).catch(error => { report.error = String(error.stack || error); }).finally(async () => {
  fs.rmSync(path.join(root,'.soduwork-media-ops.json'),{force:true});
  grants.forEach(grant => {try {grant.cleanup();} catch(error) {report.cleanupError=error.message;}}); host?.destroy(); windows.forEach(win => { if (!win.isDestroyed()) win.destroy(); });
  if (fixture) { fixture.stdin.end('\n'); await Promise.race([new Promise(resolve => fixture.once('exit',resolve)), delay(10000)]); }
  report.rolledBack = rolledBack; if (!rolledBack) report.ok = false;
  const out = args.includes('--output') ? path.resolve(option('--output')) : path.resolve(__dirname,'../../outputs/fixed-ukey-integrations-20261021'); fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
  if (!report.ok) fs.writeFileSync(path.join(out,'fixture-stderr.log'),fixtureError);
  console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
});
