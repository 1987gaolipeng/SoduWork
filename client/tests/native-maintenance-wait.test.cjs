'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), os = require('node:os');
const cp = require('node:child_process');
const { maintenanceScript } = require('../build/prune-versions.cjs');
const windows = { skip: process.platform !== 'win32', timeout: 20000 };
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(20); }
  assert.fail('Native GUI helper did not start');
}
function canOpen(file) {
  try { fs.closeSync(fs.openSync(file, 'r')); return true; }
  catch (error) { assert.ok(['EBUSY', 'EACCES', 'EPERM'].includes(error.code), error.stack); return false; }
}
for (const exitCode of [0, 7]) test('GUI retire is awaited under the native lock, exit ' + exitCode, windows, async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'soduwork-gui-maintenance-'));
  const helper = path.join(root, 'probe.cjs');
  await fsp.writeFile(helper, [
    "const fs=require('fs'),path=require('path'),root=process.env.SODUWORK_MAINTENANCE_ROOT;",
    "const write=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value));",
    "function open(name){try{fs.closeSync(fs.openSync(path.join(root,name),'r'));return true}catch(e){return e.code}}",
    "if(process.argv[2]==='--retire-only'){write('retire-start',true);setTimeout(()=>{write('retire-done',true);process.exit(Number(process.env.SODUWORK_TEST_RETIRE_EXIT))},1000)}",
    "else if(process.argv[2]==='--delete-retired'){write('delete-start',{retireDone:fs.existsSync(path.join(root,'retire-done')),activationOpen:open('.soduwork-update.lock'),maintenanceOpen:open('.soduwork-maintenance.lock')})}",
  ].join('\n'));
  let child, done;
  t.after(async () => {
    if (child?.exitCode === null) { child.kill(); await done; }
    // The old broken script can exit before its GUI child; keep its fixture
    // until the bounded probe exits even when an assertion detects that bug.
    await delay(1200);
    assert.equal(path.dirname(root), os.tmpdir());
    await fsp.rm(root, { recursive: true, force: true });
  });
  child = cp.spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(maintenanceScript(0), 'utf16le').toString('base64')], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      ELECTRON_RUN_AS_NODE: '1', SODUWORK_MAINTENANCE_ROOT: root,
      SODUWORK_MAINTENANCE_EXE: require('electron'), SODUWORK_MAINTENANCE_SCRIPT: helper,
      SODUWORK_TEST_RETIRE_EXIT: String(exitCode), SODUWORK_MAINTENANCE_TRACE: '1' },
  });
  let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  done = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  await until(() => fs.existsSync(path.join(root, 'retire-start')));
  // Independent file open against Windows FileShare.None proves the parent
  // still holds both locks while a real GUI-subsystem child is doing its work.
  assert.equal(child.exitCode, null, output);
  assert.equal(canOpen(path.join(root, '.soduwork-update.lock')), false);
  assert.equal(canOpen(path.join(root, '.soduwork-maintenance.lock')), false);
  assert.equal(await done, exitCode, output);
  assert.ok(fs.existsSync(path.join(root, 'retire-done')));
  if (exitCode === 0) {
    const state = JSON.parse(await fsp.readFile(path.join(root, 'delete-start'), 'utf8'));
    assert.equal(state.retireDone, true); assert.equal(state.activationOpen, true);
    assert.ok(['EBUSY', 'EACCES', 'EPERM'].includes(state.maintenanceOpen));
  } else assert.equal(fs.existsSync(path.join(root, 'delete-start')), false);
  assert.equal(canOpen(path.join(root, '.soduwork-update.lock')), true);
  assert.equal(canOpen(path.join(root, '.soduwork-maintenance.lock')), true);
  const trace = await fsp.readFile(path.join(root, '.soduwork-maintenance-trace.log'), 'utf8');
  assert.match(trace, new RegExp('retire-exit=' + exitCode));
  if (exitCode !== 0) assert.doesNotMatch(trace, /delete-exit/);
});
test('retire CLI reports an actual filesystem failure through its exit code', windows, async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'soduwork-maintenance-error-'));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await fsp.rm(root, { recursive: true, force: true }); });
  const stage = path.join(root, '.soduwork-versions/ns001.tmp'); await fsp.mkdir(stage, { recursive: true });
  const helper = path.join(stage, '.soduwork-prune.cjs');
  await fsp.copyFile(path.join(__dirname, '../build/prune-versions.cjs'), helper);
  const result = cp.spawnSync(require('electron'), [helper, '--retire-only'],
    { windowsHide: true, encoding: 'utf8', timeout: 10000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(result.status, 1); assert.match(result.stderr, /Maintenance skipped: ENOENT/);
});
