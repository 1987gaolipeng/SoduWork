const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function loadEnvironment(mocks) {
  const file = path.resolve(__dirname, '../main/pi-session/environment-ipc.js');
  const module = { exports: {} };
  const localRequire = createRequire(file);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports,
    require: name => mocks[name] || localRequire(name),
    console, Promise, setTimeout, clearTimeout,
  }, { filename: file });
  return module.exports;
}

test('local capability discovery fences the first send on Pi warmup', async () => {
  const handlers = new Map();
  let releaseWarmup;
  let warmupStarted = false;
  let resourceWarmupStarted = false;
  const warmup = new Promise(resolve => { releaseWarmup = resolve; });
  const environment = loadEnvironment({
    electron: { shell: {} },
    '../conversation/capabilities': {
      inspect: async () => ({ policyOk: true, policyReason: '', items: [], businessSkills: [] }),
    },
  });
  environment.install({
    app: {},
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    session: {
      loadSdk: async () => ({ ok: true }),
      prewarm: async () => { warmupStarted = true; await warmup; return { ok: true }; },
      prewarmResources: async () => { resourceWarmupStarted = true; await warmup; return { ok: true }; },
    },
    identityOf: async () => ({ hub: 'http://fixture', clientId: 'device' }),
    capabilityGrantsOf: () => [],
    _skillDirs: () => [],
    workDir: () => 'C:/fixture',
    _saveConf: () => {},
    _conf: () => ({}),
  });
  const request = handlers.get('conversation-capabilities')({}, {
    adapterId: 'pi', executionLocation: 'local', modelName: 'fixture-model',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(warmupStarted, true);
  assert.equal(resourceWarmupStarted, true);
  let settled = false;
  request.finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'capability IPC must not resolve while warmup is still running');
  releaseWarmup();
  const result = await request;
  assert.equal(result.ok, true);
});

test('cloud or non-Pi capability menus do not wait for local Pi warmup', async () => {
  const handlers = new Map();
  let prewarmCalls = 0;
  const environment = loadEnvironment({
    electron: { shell: {} },
    '../conversation/capabilities': {
      inspect: async () => ({ policyOk: true, policyReason: '', items: [], businessSkills: [] }),
    },
  });
  environment.install({
    app: {},
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    session: { prewarm: async () => { prewarmCalls += 1; } },
    identityOf: async () => ({ hub: 'http://fixture', clientId: 'device' }),
    capabilityGrantsOf: () => [], _skillDirs: () => [], workDir: () => 'C:/fixture',
    _saveConf: () => {}, _conf: () => ({}),
  });
  assert.equal((await handlers.get('conversation-capabilities')({}, {
    adapterId: 'codex-harness', executionLocation: 'local',
  })).ok, true);
  assert.equal((await handlers.get('conversation-capabilities')({}, {
    adapterId: 'pi', executionLocation: 'cloud',
  })).ok, true);
  assert.equal(prewarmCalls, 0);
});

const sessionSource = fs.readFileSync(path.resolve(__dirname, '../main/pi-session/session.js'), 'utf8');
assert.match(sessionSource, /async function prewarm[\s\S]*?modelConfig\.prepare\(app, identity, modelName\)/,
  'Pi warmup must prepare the same model environment that session.open consumes');
assert.match(sessionSource, /async function prewarmResources[\s\S]*?sessionResources\(/,
  'Pi warmup must prime extension/resource discovery before the first local send');
assert.match(sessionSource, /_resourceWarmupResult[\s\S]*?if \(result\?\.ok\) _resourceWarmupResult = result/,
  'successful Pi resource warmup must be retained so each new chat does not reload extensions');
