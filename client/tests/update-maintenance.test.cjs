'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const maintenance = require('../main/update-maintenance');
const { maintenanceScript } = require('../build/prune-versions.cjs');
const windows = { skip: process.platform !== 'win32', timeout: 30000 };
const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(30); }
  assert.fail('Fixture event did not arrive');
}
function launch(script, env) {
  const child = cp.spawn(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';child.stderr.on('data', chunk => { output += chunk; });
  child.stdout.on('data', chunk => { output += chunk; });
  child.done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ code, output })); });
  return child;
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-maintenance-'));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, '.soduwork-versions/ns001.tmp'), { recursive: true });
  await fs.writeFile(path.join(root, '.soduwork-active'), 'ns001.tmp');
  await fs.writeFile(path.join(root, '.soduwork-previous'), 'ns002.tmp');
  await fs.writeFile(path.join(root, '.soduwork-launcher'), '1');
  const helper = path.join(root, '.soduwork-versions/ns001.tmp/.soduwork-prune.cjs');
  return { root, helper, env: { SODUWORK_MAINTENANCE_ROOT: root, SODUWORK_MAINTENANCE_EXE: process.execPath, SODUWORK_MAINTENANCE_SCRIPT: helper } };
}
const lockScript = "$lock=[IO.File]::Open((Join-Path $env:SODUWORK_MAINTENANCE_ROOT '.soduwork-update.lock'),'OpenOrCreate','ReadWrite','None');[IO.File]::WriteAllText((Join-Path $env:SODUWORK_MAINTENANCE_ROOT 'locked'),'1');[Console]::ReadLine() | Out-Null;$lock.Dispose()";

test('native installer lock prevents maintenance from changing any payload', windows, async t => {
  const { root, helper, env } = await fixture(t);
  await fs.writeFile(helper, "require('fs').writeFileSync(process.env.SODUWORK_MAINTENANCE_ROOT+'/unexpected','bad')");
  const locker = launch(lockScript, env);
  try {
    await until(() => fs.access(path.join(root, 'locked')).then(() => true, () => false));
    const result = await launch(maintenanceScript(0), env).done;
    assert.equal(result.code, 0, result.output);
    await assert.rejects(fs.access(path.join(root, 'unexpected')), { code: 'ENOENT' });
  } finally { locker.stdin.end('\n'); await locker.done; }
});

test('slow deletion releases the install lock so another update can proceed', windows, async t => {
  const { root, helper, env } = await fixture(t);
  await fs.writeFile(helper, [
    "const fs=require('fs'),path=require('path'),root=process.env.SODUWORK_MAINTENANCE_ROOT;",
    "if(process.argv[2]==='--delete-retired'){fs.writeFileSync(path.join(root,'deleting'),'1');",
    "const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'finish'))){clearInterval(timer)}},20)}",
  ].join('\n'));
  const running = launch(maintenanceScript(0), env);
  let next;
  try {
    await until(() => fs.access(path.join(root, 'deleting')).then(() => true, () => false));
    next = launch(lockScript, env);
    await until(() => fs.access(path.join(root, 'locked')).then(() => true, () => false));
    // Both helpers are still alive: cleanup is running but activation is available.
    assert.equal(running.exitCode, null);assert.equal(next.exitCode, null);
  } finally {
    if (next) { next.stdin.end('\n'); await next.done; }
    await fs.writeFile(path.join(root, 'finish'), '1');
    const result = await running.done;assert.equal(result.code, 0, result.output);
  }
});

test('development and legacy layouts never start maintenance', () => {
  assert.equal(maintenance.launch(process.execPath, () => assert.fail('unexpected helper')), false);
});
