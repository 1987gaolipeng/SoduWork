'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');

test('a locked DLL defers rollback until the handle closes and preserves the active payload', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-stage-rollback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const versions = path.join(root, '.soduwork-versions');
  const stage = path.join(versions, 'ns123.tmp');
  const active = path.join(versions, 'ns456.tmp');
  const token = '{' + randomUUID() + '}';
  await fs.mkdir(stage, { recursive: true });
  await fs.mkdir(active);
  await fs.writeFile(path.join(root, '.soduwork-active'), path.basename(active));
  await fs.writeFile(path.join(active, 'existing.txt'), 'keep');
  await fs.writeFile(path.join(root, '.soduwork-update.lock'), '');
  await fs.writeFile(path.join(stage, '.soduwork-stage'), token);

  const holder = [
    "$ErrorActionPreference = 'Stop'",
    "$dll = [IO.File]::Open((Join-Path $env:SODUWORK_ROLLBACK_STAGE 'd3dcompiler_47.dll'), 'CreateNew', 'ReadWrite', 'None')",
    'try { & "$PSHOME/powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $env:SODUWORK_TEST_HELPER; $code = $LASTEXITCODE }',
    'finally { $dll.Dispose() }',
    'exit $code',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', holder], {
    env: { ...process.env, SODUWORK_ROLLBACK_STAGE: stage, SODUWORK_ROLLBACK_TOKEN: token,
      SODUWORK_TEST_HELPER: path.resolve(__dirname, '../build/rollback-stage.ps1') },
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(result.status, 3, result.error?.message || result.stdout + result.stderr);
  async function retiredFiles() {
    if (!(await fs.readdir(root)).includes('.soduwork-retired')) return [];
    return fs.readdir(path.join(root, '.soduwork-retired'));
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!(await fs.readdir(versions)).includes(path.basename(stage)) && (await retiredFiles()).length === 0) break;
    await delay(100);
  }
  assert.deepEqual(await fs.readdir(versions), [path.basename(active)]);
  assert.deepEqual(await retiredFiles(), [], 'deferred cleanup removed the locked DLL and its receipt');
  assert.equal(await fs.readFile(path.join(root, '.soduwork-active'), 'utf8'), path.basename(active));
  assert.equal(await fs.readFile(path.join(active, 'existing.txt'), 'utf8'), 'keep');
});
