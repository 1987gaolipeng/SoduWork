'use strict';
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute output directory required');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const js = source => win.webContents.executeJavaScript(source, true);
async function until(source) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await js('Boolean(' + source + ')')) return;
    await sleep(30);
  }
  throw Error('Timed out: ' + source);
}
const click = selector => js('document.querySelector(' + JSON.stringify(selector) + ').click(); void 0;');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1080, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, 'fixtures/cloud-environments.html'));
  await js(`(() => {
    fixture.calls = []; fixture.authed = false; fixture.cancelled = false;
    fixture.nodes = [{ id: 'cloud-linux', name: 'Isolated cloud computer', host: 'linux-cloud', os: 'Linux x86_64',
      online: true, canManage: true, eligible: true, availableAgents: [
        { id: 'codex', name: 'Codex', installed: true, ready: false },
        { id: 'opencode', name: 'OpenCode', installed: true, ready: true },
        { id: 'pi', name: 'Pi', installed: true, ready: true }
      ] }];
    SoduWorkAPI.agentSetup = async runnerId => {
      fixture.calls.push(['setup', runnerId]);
      return { machines: [{ runnerId: 'cloud-linux', agents: [{ key: 'codex', installed: true,
        auth: fixture.authed ? 'authed' : 'unauthed', authStatus: 'known', state: fixture.authed ? 'ready' : 'unauthed',
        loginAvailable: true, loginFlowVersion: 1 }] }] };
    };
    SoduWorkAPI.agentInstall = async (key, action, runnerId, options) => {
      fixture.calls.push(['install', key, action, runnerId, options || null]);
      if (action === 'login-cancel') fixture.cancelled = true;
      return { jobId: 'cloud-auth-job' };
    };
    SoduWorkAPI.agentProbe = async (key, model, runnerId) => {
      fixture.nodes[0].availableAgents.find(agent => agent.id === key).ready = true;
      fixture.calls.push(['probe', key, model, runnerId]); return { jobId: 'probe-' + key };
    };
    SoduWorkAPI.agentJob = async id => {
      fixture.calls.push(['job', id]);
      if (id.startsWith('probe-')) return { state: 'done', ok: true };
      return fixture.cancelled ? { state: 'done', auth: { state: 'cancelled' } } :
        { state: 'running', auth: { state: 'waiting', verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-EFGH', expiresAt: Date.now() / 1000 + 300 } };
    };
    CloudEnvironments.refresh();
  })()`);
  await until('document.querySelector("[data-ce-agent-key=codex][data-ce-agent-action=login]")');
  await click('[data-ce-agent-key=opencode]');
  await until('document.querySelector("[data-ce-harness=opencode]").textContent.includes("测通了")');
  assert.deepEqual(await js('fixture.calls.find(call => call[0] === "probe")'), ['probe', 'opencode', '', 'cloud-linux']);
  await click('[data-ce-agent-key=codex]');
  await until('document.querySelector(".codex-auth-dialog .codex-auth-primary")?.textContent === "继续登录"');
  assert.match(await js('document.querySelector(".codex-auth-machine").textContent'), /linux-cloud.*Linux/);
  await click('.codex-auth-primary');
  await until('document.querySelector(".codex-auth-primary")?.textContent === "打开官方授权页"');
  await click('.codex-auth-secondary');
  await until('!document.querySelector(".codex-auth-dialog")');
  assert.deepEqual(await js('fixture.calls.find(call => call[0] === "install" && call[2] === "login-cancel")'),
    ['install', 'codex', 'login-cancel', 'cloud-linux', { jobId: 'cloud-auth-job' }]);
  assert.equal(await js('fixture.calls.some(call => call[0] === "probe" && call[1] === "codex")'), false);
  await js('fixture.authed = true; void 0;');
  await click('[data-ce-agent-key=codex]');
  await until('document.querySelector(".codex-auth-primary")?.textContent === "测试连接"');
  await click('.codex-auth-primary');
  await until('document.querySelector("[data-ce-harness=codex]").textContent.includes("测通了")');
  assert.deepEqual(await js('fixture.calls.find(call => call[0] === "probe" && call[1] === "codex")'),
    ['probe', 'codex', '', 'cloud-linux']);
  assert.equal(await js('fixture.calls.some(call => call[0] === "install" && call[2] === "uninstall")'), false);
  assert.equal(await js('document.querySelector("[data-ce-harness=pi]").textContent.includes("卸载")'), false);
  assert.equal(await js('fixture.calls.filter(call => call[0] === "setup").every(call => call[1] === "cloud-linux")'), true);
  await js(`(() => {
    const row = fixture.nodes[0]; row.status = 'missing_agent'; row.action = 'install_agent';
    row.availableAgents.forEach(agent => { agent.installed = false; agent.ready = false; });
    SoduWorkAPI.agentInstall = async (key, action, runnerId) => {
      fixture.calls.push(['install', key, action, runnerId]);
      const pi = row.availableAgents.find(agent => agent.id === 'pi');
      pi.installed = true; pi.ready = true; row.status = 'ready'; row.action = '';
      return { jobId: 'install-pi' };
    };
    SoduWorkAPI.agentJob = async () => ({ state: 'done', ok: true });
    CloudEnvironments.refresh();
  })()`);
  await until('document.querySelector(".ce-server-actions [data-ce-agent-key=pi]")');
  await click('.ce-server-actions [data-ce-agent-key=pi]');
  await until('document.querySelector("[data-ce-harness=pi][data-state=ready]")');
  assert.deepEqual(await js('fixture.calls.find(call => call[0] === "install" && call[1] === "pi")'),
    ['install', 'pi', 'install', 'cloud-linux']);
  assert.equal(await js('!!document.querySelector(".ce-dialog")'), false);
  fs.writeFileSync(path.join(output, 'cloud-agent-maintenance.png'), (await win.webContents.capturePage()).toPNG());
  console.log('PASS cloud Agent authorization, cancellation, probes and Pi preparation stay on the selected Runner');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); win?.destroy(); app.exit(1); });
