'use strict';
// Native Electron profile and lock verification, using synthetic configuration only.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const electron = require('electron');

if (typeof electron !== 'string') {
  const { app } = electron;
  const config = JSON.parse(fs.readFileSync(process.env.SODUWORK_ISOLATION_FIXTURE, 'utf8'));
  app.setPath('appData', config.appData);
  const profiles = require('../main/distribution.cjs');
  try {
    const directory = require('../main/userdata-path.cjs').initializeUserData(
      app, config.override ? { SODUWORK_USER_DATA: config.override } : {},
      profiles.getProfile(config.distribution));
    const locked = app.requestSingleInstanceLock();
    const marker = path.join(directory, 'instance-fixture.json');
    const previous = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
    if (locked && !previous) fs.writeFileSync(marker, JSON.stringify({ instance: config.instance }));
    process.send({ directory, locked, previous, packaged: app.isPackaged });
    if (!locked) app.exit(0);
    else {
      app.on('second-instance', () => {});
      process.on('message', message => { if (message === 'stop') app.quit(); });
      app.whenReady().then(() => process.send({ ready: true }));
    }
  } catch (error) {
    process.send({ blocked: true, message: error.message });
    app.exit(0);
  }
} else {
  const { spawn } = require('node:child_process');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-instance-e2e-'));
  const output = path.resolve(__dirname, '../../outputs/agent-runtime-repair-20261030/source-instance-e2e.json');
  const appData = path.join(fixture, 'appdata');
  const children = new Set();
  const cases = [];
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[name];
  fs.mkdirSync(appData);
  const installed = path.join(appData, 'SoduWork');
  fs.mkdirSync(installed);
  const installedConfig = path.join(installed, 'device-auth.json');
  const sentinel = 'synthetic-installed-profile-must-stay-private';
  fs.writeFileSync(installedConfig, sentinel);

  async function start(checkout, instance, distribution = 'internal', override = '') {
    const directory = path.join(fixture, checkout);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'soduwork-instance-fixture', main: 'main.cjs' }));
    fs.writeFileSync(path.join(directory, 'main.cjs'), 'require(' + JSON.stringify(__filename) + ');\n');
    const config = path.join(fixture, instance + '.json');
    fs.writeFileSync(config, JSON.stringify({ appData, instance, distribution, override }));
    const child = spawn(electron, [directory], {
      env: { ...env, SODUWORK_ISOLATION_FIXTURE: config }, windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.add(child);
    let stderr = '';
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
    child.once('exit', () => children.delete(child));
    return new Promise((resolve, reject) => {
      let result;
      const timer = setTimeout(() => reject(Error('Electron instance timed out: ' + instance + '\n' + stderr)), 20000);
      child.on('message', message => {
        if (!message.ready) result = message;
        if (message.ready || message.blocked || message.locked === false) {
          clearTimeout(timer);
          resolve({ child, result });
        }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => {
        clearTimeout(timer);
        if (!result) reject(Error('Electron exited before reporting: ' + code + '\n' + stderr));
      });
    });
  }
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error('Electron did not exit cleanly')); }, 10000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send('stop');
    });
  }
  (async () => {
    let ok = false;
    try {
      const a = await start('checkout-a', 'a');
      const b = await start('checkout-b', 'b');
      const global = await start('checkout-a', 'global', 'global');
      for (const instance of [a, b, global]) {
        assert.equal(instance.result.packaged, false);
        assert.equal(instance.result.locked, true);
        assert.equal(instance.result.previous, null);
        assert.equal(fs.existsSync(path.join(instance.result.directory, 'device-auth.json')), false);
      }
      assert.equal(new Set([a.result.directory, b.result.directory, global.result.directory, installed]).size, 4);
      cases.push('Different checkouts and distributions hold independent native Electron locks concurrently');
      const duplicate = await start('checkout-a', 'duplicate');
      assert.equal(duplicate.result.directory, a.result.directory);
      assert.equal(duplicate.result.locked, false);
      cases.push('The same checkout retains the native single-instance lock');
      await stop(a.child);
      const restarted = await start('checkout-a', 'restarted');
      assert.equal(restarted.result.directory, a.result.directory);
      assert.equal(restarted.result.locked, true);
      assert.deepEqual(restarted.result.previous, { instance: 'a' });
      cases.push('Restart restores only that source instance data');
      const rejected = await start('checkout-a', 'reserved', 'internal', installed);
      assert.equal(rejected.result.blocked, true);
      assert.match(rejected.result.message, /独立数据目录/);
      assert.equal(fs.readFileSync(installedConfig, 'utf8'), sentinel);
      cases.push('An installed-profile override is rejected and synthetic installed data remains unchanged');
      ok = true;
    } finally {
      await Promise.all([...children].map(stop));
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, JSON.stringify({ ok, cases, boundary: 'Real Electron processes and production profile initialization; synthetic appData only; no real account, Runner or network.' }, null, 2));
      assert.equal(path.dirname(fixture), os.tmpdir());
      assert.ok(path.basename(fixture).startsWith('soduwork-instance-e2e-'));
      fs.rmSync(fixture, { recursive: true, force: true });
    }
    console.log(JSON.stringify({ ok, cases, output }, null, 2));
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
