'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const runtime = require('../main/runner-runtime');

test('packaged Runner receives the Pi bundled with SoduWork', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'soduwork-bundled-pi-'));
  try {
    const cli = path.join(root, 'pi', 'node_modules', '@earendil-works',
      'pi-coding-agent', 'dist', 'cli.js');
    await fsp.mkdir(path.dirname(cli), { recursive: true });
    await fsp.writeFile(cli, '# bundled pi fixture\n');

    const env = runtime._runnerEnv(
      { PATH: 'C:/tools' }, 'device-secret', { isPackaged: true }, root);
    assert.equal(env.SODUWORK_BUNDLED_PI_CLI, cli);
    assert.equal(env.SODUWORK_BUNDLED_NODE, process.execPath);
    assert.equal(env.SODUWORK_DEVICE_SECRET, 'device-secret');

    const dev = runtime._runnerEnv(
      { PATH: 'C:/tools' }, 'device-secret', { isPackaged: false }, root);
    assert.equal(Object.hasOwn(dev, 'SODUWORK_BUNDLED_PI_CLI'), false);
    assert.equal(Object.hasOwn(dev, 'SODUWORK_BUNDLED_NODE'), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('installer contract includes Pi and Runner consumes the same resource paths', (t) => {
  const pkg = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'package.json'), 'utf8'));
  const piResource = pkg.build.extraResources.find(
    (item) => item.to === 'pi');
  assert.ok(piResource);
  assert.equal(piResource.from, '.runtime/pi');

  const cli = path.join(__dirname, '..', 'node_modules', '@earendil-works',
    'pi-coding-agent', 'dist', 'cli.js');
  const api = path.join(__dirname, '..', 'node_modules', '@earendil-works',
    'pi-coding-agent', 'dist', 'index.js');
  /*
   * Validate bundled dependency details only when dependencies are installed; explicitly
   * skip dependency-free checkout environments.
   */
  if (!fs.existsSync(cli) && !fs.existsSync(api)) {
    t.skip('未安装 @earendil-works/pi-coding-agent（干净检出）——打包前环境会真校验');
    return;
  }
  assert.equal(fs.existsSync(cli), true, 'Pi CLI must exist before packaging');
  assert.equal(fs.existsSync(api), true, 'Pi library must exist before packaging');

  const py = fs.readFileSync(path.join(__dirname, '..', '..', 'hub-backend',
    'app', 'services', 'local_base.py'), 'utf8');
  assert.match(py, /SODUWORK_BUNDLED_PI_CLI/);
  assert.match(py, /SODUWORK_BUNDLED_NODE/);
  assert.match(py, /ELECTRON_RUN_AS_NODE/);
});

test('source Runner uses its own installed Pi dependency and rejects inherited overrides', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'soduwork-source-pi-'));
  try {
    const app = { isPackaged: false, getAppPath: () => root };
    const stale = { SODUWORK_BUNDLED_PI_CLI: '/other-owner/cli.js', SODUWORK_BUNDLED_NODE: '/other/node' };
    assert.equal(Object.hasOwn(runtime._runnerEnv(stale, '', app), 'SODUWORK_BUNDLED_PI_CLI'), false);
    const cli = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
    await fsp.mkdir(path.dirname(cli), { recursive: true });
    await fsp.writeFile(cli, '// source dependency fixture');
    const env = runtime._runnerEnv(stale, '', app);
    assert.equal(env.SODUWORK_BUNDLED_PI_CLI, cli);
    assert.equal(env.SODUWORK_BUNDLED_NODE, process.execPath);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});
