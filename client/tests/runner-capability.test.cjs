'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const runtime = require('../main/runner-runtime');

const identity = {
  hub: 'http://127.0.0.1:9080',
  clientId: 'client-smoke',
  secret: 'secure-device-secret',
};

test('runner prepares a new custom workspace before publishing file capabilities', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runner-work-root-'));
  try {
    const selected = path.join(temp, 'custom', 'work');
    const cfg = runtime._clean({ workRoot: selected }, temp, identity);
    assert.equal(fs.existsSync(selected), false);
    runtime._prepareWorkRoot(cfg.workRoot);
    assert.equal(cfg.workRoot, selected, 'never replace the user-selected path');
    assert.equal(fs.statSync(selected).isDirectory(), true);
    const deliverable = path.join(selected, 'result.md');
    fs.writeFileSync(deliverable, 'task result');
    runtime._prepareWorkRoot(cfg.workRoot);
    assert.equal(fs.readFileSync(deliverable, 'utf8'), 'task result');
    assert.equal(runtime._mergeRaw(cfg, { workRoot: '' }).workRoot, selected,
      'an early window bootstrap must not erase the configured directory');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('runner reports an unusable workspace without switching paths or changing files', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runner-work-blocked-'));
  try {
    const selected = path.join(temp, 'existing-file');
    fs.writeFileSync(selected, 'keep');
    assert.throws(() => runtime._prepareWorkRoot(selected), error =>
      error.message.includes('工作目录不可用') && error.message.includes(selected));
    assert.equal(fs.readFileSync(selected, 'utf8'), 'keep');
    assert.deepEqual(fs.readdirSync(temp), ['existing-file']);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('runner capabilities use safe defaults and preserve explicit local consent', () => {
  assert.equal(runtime.CAPABILITY_KEYS.has('office'), false);
  const defaults = runtime._clean({
    hub: identity.hub, clientId: identity.clientId, workRoot: 'C:/work',
  }, 'C:/runner-data', identity);
  assert.deepEqual(defaults.capabilityGrants, ['browser']);

  const denied = runtime._clean({
    hub: identity.hub, clientId: identity.clientId, workRoot: 'C:/work',
    capabilityGrants: [],
  }, 'C:/runner-data', identity);
  assert.deepEqual(denied.capabilityGrants, []);

  const elevated = runtime._clean({
    hub: identity.hub, clientId: identity.clientId, workRoot: 'C:/work',
    capabilityGrants: ['computer', 'browser', 'computer', 'unknown'],
  }, 'C:/runner-data', identity);
  assert.deepEqual(elevated.capabilityGrants, ['computer', 'browser']);

  const synced = runtime._mergeRaw(
    { hub: identity.hub, clientId: identity.clientId, capabilityGrants: ['computer'] },
    { workRoot: 'D:/new-work' },
  );
  assert.deepEqual(synced.capabilityGrants, ['computer'],
    'routine device sync must not erase a prior machine-owner decision');

  const replaced = runtime._mergeRaw(synced, { capabilityGrants: ['office'] });
  assert.deepEqual(runtime._grants(replaced.capabilityGrants), []);

  const stored = runtime._stored({ ...elevated, secret: identity.secret });
  assert.deepEqual(stored.capabilityGrants, ['computer', 'browser']);
  assert.equal(stored.capabilityGrantVersion, runtime.CAPABILITY_GRANT_VERSION);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'secret'), false);
});

test('legacy Office grant is removed because office files use the normal work directory', () => {
  const migrated = runtime._migrateRaw({
    capabilityGrants: ['browser', 'office', 'computer'],
  });
  assert.deepEqual(migrated.capabilityGrants, ['browser', 'computer']);
  assert.equal(migrated.capabilityGrantVersion, runtime.CAPABILITY_GRANT_VERSION);

  const current = runtime._clean({
    hub: 'http://127.0.0.1:9080', clientId: 'client-1', workRoot: 'C:/work',
    capabilityGrantVersion: runtime.CAPABILITY_GRANT_VERSION,
    capabilityGrants: ['browser', 'office'],
  }, 'C:/runner-data', { hub: 'http://127.0.0.1:9080', clientId: 'client-1', secret: 'secret' });
  assert.deepEqual(current.capabilityGrants, ['browser']);
});

test('embedded runner does not inherit chat-only model directories or temporary credentials', () => {
  const source = {
    PATH: 'C:/tools',
    PI_CODING_AGENT_DIR: 'C:/chat/pi-agent',
    SODUWORK_PROXY_KEY: 'short-model-ticket',
    SODUWORK_MCP_KEY: 'short-mcp-ticket',
    SODUWORK_HUB_ORIGIN: 'http://127.0.0.1:9080',
    SODUWORK_MCP_SERVERS: 'C:/chat/mcp/servers.json',
    SODUWORK_MCP_SERVERS_JSON: '{"servers":{}}',
    SODUWORK_LLM_KEY: 'stale-task-key',
    SODUWORK_GIT_USER: 'stale-user',
    SODUWORK_GIT_TOKEN: 'stale-token',
    OPENCODE_CONFIG_CONTENT: '{"provider":{}}',
    SODUWORK_BUNDLED_OPENCODE: 'C:/chat/opencode.exe',
    SODUWORK_BUNDLED_PI_CLI: 'C:/chat/pi/cli.js',
    SODUWORK_BUNDLED_NODE: 'C:/chat/node.exe',
    SODUWORK_BUNDLED_SHELL: 'C:/chat/shell',
    NODE_OPTIONS: '--require C:/electron/bootstrap.js',
    ELECTRON_RUN_AS_NODE: '1',
  };
  const env = runtime._runnerEnv(source, 'runner-device-secret');

  assert.equal(env.PATH, source.PATH);
  assert.equal(env.SODUWORK_DEVICE_SECRET, 'runner-device-secret');
  runtime.RUNNER_ENV_DENY.forEach((key) => {
    assert.equal(Object.prototype.hasOwnProperty.call(env, key), false, key + ' must be isolated');
    assert.equal(Object.prototype.hasOwnProperty.call(source, key), true,
      'sanitizing the child environment must not mutate Electron process.env');
  });
});

test('desktop authorization stays in the trusted main process and local machine UI', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main', 'runner-runtime.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const panelSource = fs.readFileSync(
    path.join(__dirname, '..', 'components', 'panels', 'panels-runners.js'), 'utf8');

  assert.match(mainSource, /runner-capability-set/);
  assert.match(mainSource, /dialog\.showMessageBox/);
  assert.match(mainSource, /key === 'computer' && enabled/);
  assert.doesNotMatch(mainSource, /允许 AI 读写本机办公文档/);
  assert.match(preloadSource, /setRunnerCapability/);
  assert.match(panelSource, /runner\.embedded && runner\.owned/);
  assert.match(panelSource, /data-rn-cap-set/);
  assert.match(mainSource, /runner-component-confirm/);
  assert.match(mainSource, /dialog\.showMessageBox/);
  assert.match(preloadSource, /confirmRunnerComponentInstall/);
  assert.match(panelSource, /data-rn-cap-install/);
  assert.match(panelSource, /runnerComponentInstall/);
  assert.match(panelSource, /安装并测通/);
});

test('all Runner-backed agents quarantine private tool protocol before rendering it', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'main', 'agent-runtime', 'runner-adapter.js'), 'utf8');
  const guard = require('../main/agent-runtime/protocol-guard');
  const quote = String.fromCharCode(34);
  const inspected = guard.inspect(
    '保留这句\n<|DSML|parameter name=' + quote + 'extra63' + quote +
      '>e</|DSML|parameter>',
    { final: true });
  assert.equal(inspected.detected, true);
  assert.equal(inspected.text, '保留这句');
  assert.match(source, /protocolGuard\.inspect\(_assistantText\(rawText\)/);
  assert.match(source, /requestStop\(\)/);
});
