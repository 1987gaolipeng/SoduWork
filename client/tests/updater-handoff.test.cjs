'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const updater = require('../main/client-updater');
test('installer is revalidated immediately before handoff, including same-size tampering', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-install-hash-'));
  try {
    const file = path.join(root, 'Setup.exe');
    await fs.writeFile(file, 'GOOD');
    const manifest = { artifact: { size: 4, sha256: crypto.createHash('sha256').update('GOOD').digest('hex') } };
    await updater._verifyInstaller(file, manifest);
    await fs.writeFile(file, 'EVIL');
    await assert.rejects(updater._verifyInstaller(file, manifest), /校验失败/);
    await fs.writeFile(file, 'NO');
    await assert.rejects(updater._verifyInstaller(file, manifest), /不完整/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('WSH handoff acknowledges a running helper, not merely a spawned host', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-install-handshake-'));
  try {
    const helper = path.join(root, 'helper.vbs'), ready = path.join(root, 'ready');
    const env = { ...process.env, SODUWORK_HELPER_READY: ready };
    await fs.writeFile(helper, [
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'Set shell = CreateObject("WScript.Shell")',
      'Set env = shell.Environment("PROCESS")',
      'Set ready = fso.CreateTextFile(env("SODUWORK_HELPER_READY") & ".tmp", True)',
      'ready.Write "ready"', 'ready.Close',
      'fso.MoveFile env("SODUWORK_HELPER_READY") & ".tmp", env("SODUWORK_HELPER_READY")',
      'WScript.Sleep 300',
    ].join('\r\n'), 'ascii');
    await updater._launchUpdateHelper(helper, env);
    // Production receipts are disposable: antivirus can delay best-effort deletion.
    // A new handoff always owns a new receipt and cannot acknowledge an earlier one.
    await fs.writeFile(helper, 'WScript.Quit 7', 'ascii');
    await assert.rejects(updater._launchUpdateHelper(helper, {
      ...env, SODUWORK_HELPER_READY: path.join(root, 'second-ready'),
    }), /没有退出/);
  } finally { await new Promise(r => setTimeout(r, 400)); await fs.rm(root, { recursive: true, force: true }); }
});

test('production helper publishes readiness only after closing its file', () => {
  const script = updater._updateHelperScript();
  assert.match(script, /CreateTextFile.*\.tmp/);
  assert.ok(script.indexOf('ready.Close') < script.indexOf('fso.MoveFile'));
});
