'use strict';
// Exercise app.isPackaged=true with a disposable Electron distribution. Never
// launch or change the user's installed application or profile.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-packaged-preflight-'));
const runtime = path.dirname(require('electron'));
const client = path.resolve(__dirname, '..');
const installed = path.join(root, 'runtime');
fs.mkdirSync(installed);
// Keep the small diagnostic profile, but do not accumulate copied Electron
// distributions on the persistent Windows Runner after success or failure.
process.once('exit', () => fs.rmSync(installed, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }));
for (const item of fs.readdirSync(runtime, { withFileTypes: true })) {
  if (item.name === 'resources') continue;
  fs.cpSync(path.join(runtime, item.name), path.join(installed, item.name), { recursive: true });
}
const executable = path.join(installed, 'SoduWork.exe');
fs.renameSync(path.join(installed, path.basename(require('electron'))), executable);
const packageRoot = path.join(installed, 'resources', 'app');
fs.mkdirSync(packageRoot, { recursive: true });
fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'preflight-fixture', version: '1.0.0', main: 'main.cjs' }));
const profile = path.join(root, 'profile');
const candidate = path.join(root, 'candidate');
require('../../skills/app-developer/scripts/scaffold.cjs').scaffold({ out: candidate, key: 'packaged-probe', name: 'Packaged probe', storage: true });
const draft = path.join(candidate, 'soduwork-plugin-draft.json');
const body = require('../main/plugin-resources').collect(JSON.parse(fs.readFileSync(draft, 'utf8')), draft, root);
delete body.jiyong.initialization; // This fixture verifies installation, not account initialization.
fs.writeFileSync(path.join(root, 'candidate.json'), JSON.stringify(body));
// The child must reach the real main.js early dispatcher. Without it this
// launch attempts normal desktop initialization and fails the isolated check.
fs.writeFileSync(path.join(packageRoot, 'main.cjs'), `
process.on('uncaughtException',error=>{console.error(error.stack);require('electron').app.exit(1);});
if (process.argv.includes('--soduwork-app-preflight')) {
  require(${JSON.stringify(path.join(client, 'main.js'))});
} else {
  const {app}=require('electron'), fs=require('node:fs');
  if(!app.isPackaged)throw Error('Fixture must be packaged');
  app.setPath('userData',${JSON.stringify(profile)});
  app.disableHardwareAcceleration();
  app.whenReady().then(async()=>{
    const result=await require(${JSON.stringify(path.join(client, 'main/app-candidate-preflight.cjs'))}).run(app,
      JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, 'candidate.json'))},'utf8')));
    if(fs.readFileSync(${JSON.stringify(path.join(profile, 'personal-plugins.json'))},'utf8')!==${JSON.stringify(JSON.stringify({ schemaVersion: 1, plugins: [], sentinel: 'unchanged' }))})throw Error('Preflight changed the parent profile');
    const handlers={};
    require(${JSON.stringify(path.join(client, 'main/personal-plugins.js'))}).install({app,ipcMain:{handle:(name,fn)=>handlers[name]=fn}});
    result.installation=await handlers['personal-plugin-create']({},JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, 'candidate.json'))},'utf8')));
    if(!result.installation.ok)throw Error(JSON.stringify(result.installation));
    fs.writeFileSync(${JSON.stringify(path.join(root, 'result.json'))},JSON.stringify(result));
    app.exit(result.ok?0:1);
  }).catch(error=>{console.error(error);app.exit(1);});
}
`);
fs.mkdirSync(profile);
const sentinel = JSON.stringify({ schemaVersion: 1, plugins: [], sentinel: 'unchanged' });
fs.writeFileSync(path.join(profile, 'personal-plugins.json'), sentinel);
const env = { ...process.env };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'APP_CANDIDATE_PREFLIGHT_FOLDER', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
const execution = spawnSync(executable, [], {
  env, windowsHide: true, encoding: 'utf8', timeout: 55000,
});
assert.equal(execution.status, 0, execution.stderr || execution.stdout || String(execution.error));
const result = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
assert.equal(result.ok, true, JSON.stringify(result));
assert.equal(result.isolated, true);
assert.equal(result.installation.ok, true);
assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'personal-plugins.json'), 'utf8')).plugins.length, 1);
console.log(JSON.stringify({ ok: true, evidence: root, cases: ['packaged executable dispatch', 'real native preflight', 'preflight leaves parent profile unchanged', 'installation IPC persists exactly one app'], businessTested: false }));
