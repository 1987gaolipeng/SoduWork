'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], { env, stdio: 'inherit', windowsHide: true });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const cp = require('node:child_process');
const launches = [];
for (const name of ['spawn', 'spawnSync', 'execSync', 'execFile', 'execFileSync']) {
  const original = cp[name];
  const wrapped = function (...args) {
    const opts = args.find((arg, index) => index > 0 && arg && typeof arg === 'object' && !Array.isArray(arg));
    launches.push({ name, hidden: opts?.windowsHide === true, discovery: /^where(?:\.exe)? /.test(String(args[0])) });
    return original.apply(this, args);
  };
  Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original)); cp[name] = wrapped;
}
require('node:module').syncBuiltinESMExports();
const background = require('../main/pi-session/background-process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-send-responsive-'));
app.setPath('userData', path.join(root, 'profile'));
const report = { ok: false, turns: [], launches };
let fixture, window;
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await window.loadURL('data:text/html,<button id="state">Ready</button>');
  const extension = path.join(root, 'runtime-probe.mjs');
  fs.writeFileSync(extension, `import {execSync,execFile} from 'node:child_process';
    export default function(pi){pi.on('before_agent_start',async()=>{
      for(const name of ['node','bash','bun','python','python3','ruby','go','rustc','php','perl','Rscript','r','elixir','dotnet-script','tsx','ts-node']){
        try{execSync('where '+name,{encoding:'utf8',timeout:2000});}catch{}
      }
      await new Promise((resolve,reject)=>execFile(process.execPath,['-p','42'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}},error=>error?reject(error):resolve()));
    });}`);
  fixture = await background.run(() => require('./fixtures/access-sdk.cjs').create(root, 'standard', () => {}, {
    extensionPaths: [extension], reply: () => null,
  }));
  for (let index = 0; index < 3; index++) {
    const start = performance.now(); let first = null, lag = 0, tick = start;
    const timer = setInterval(() => { const now = performance.now(); lag = Math.max(lag, now - tick - 10); tick = now; }, 10);
    const off = fixture.session.subscribe(event => { if (first === null && event.type === 'message_update') first = performance.now() - start; });
    try {
      await background.run(() => fixture.session.prompt('Reply OK.'));
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(await window.webContents.executeJavaScript('document.querySelector("#state").textContent'), 'Ready');
      assert.ok(first !== null && first < 3000, 'local first token should not wait for a series of shell probes');
      assert.ok(lag < 500, 'Electron main event loop should remain responsive');
      report.turns.push({ firstTokenMs: Math.round(first), maxMainLoopLagMs: Math.round(lag) });
    } finally { clearInterval(timer); off(); }
  }
  if (process.platform === 'win32') {
    assert.equal(launches.filter(item => item.discovery).length, 0, 'where discovery must not start a shell');
    assert.equal(launches.filter(item => !item.hidden).length, 0, 'CLI children must not open a console');
  }
  report.ok = true;
}).catch(error => { report.error = error.stack; }).finally(async () => {
  try { await fixture?.close(); } catch (_) {}
  if (window && !window.isDestroyed()) window.destroy();
  const out = path.resolve(__dirname, '../../outputs/send-responsiveness'); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
});
