'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createRequire } = require('node:module');

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-status-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, 'resources');
  fs.mkdirSync(path.join(resources, 'runner'), { recursive: true });
  const binary = process.platform === 'win32'
    ? (options.legacyBrand ? 'soduwork-runner.exe' : 'soduwork-runner.exe')
    : (options.legacyBrand ? 'soduwork-runner' : 'soduwork-runner');
  fs.writeFileSync(path.join(resources, 'runner', binary), 'fixture');
  const file = path.resolve(__dirname, '../main/runner-runtime.js');
  const nativeRequire = createRequire(file), handlers = new Map(), children = [], timers = [];
  const secureIdentity = { hub: 'https://fixture.invalid', clientId: 'fixture-device', secret: 'fixture-device-secret-before' };
  let session = options.noSession ? '' : 'fixture-session';
  if (options.existingConfig) {
    fs.mkdirSync(path.join(root, 'runner'), { recursive: true });
    fs.writeFileSync(path.join(root, 'runner', 'config.json'), JSON.stringify({
      hub: secureIdentity.hub, clientId: secureIdentity.clientId, ...options.savedIdentity,
      ...(options.confirmed ? { activationConfirmed: true } : {}),
    }));
  }
  const client = options.sourceLayout ? path.join(root, 'application', 'client') : path.dirname(path.dirname(file));
  const python = path.join(root, 'venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  const env = { ...process.env, ...options.env };
  delete env.SODUWORK_SOURCE_SESSION;
  delete env.SODUWORK_SOURCE_RUNNER_PYTHON;
  if (options.sourceLayout) {
    const backend = path.join(root, 'application', 'hub-backend');
    fs.mkdirSync(backend, { recursive: true });
    fs.writeFileSync(path.join(backend, 'runner_main.py'), 'fixture');
    if (options.projectPython) {
      const projectPython = path.join(backend, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
      fs.mkdirSync(path.dirname(projectPython), { recursive: true });
      fs.writeFileSync(projectPython, 'fixture');
    }
    fs.mkdirSync(path.dirname(python), { recursive: true });
    if (!options.missingSourcePython) fs.writeFileSync(python, 'fixture');
    Object.assign(env, { SODUWORK_SOURCE_SESSION: '1', SODUWORK_SOURCE_RUNNER_PYTHON: python,
      VIRTUAL_ENV: path.join(root, 'unrelated-environment') });
  }
  Object.assign(env, options.env);
  const app = { isPackaged: options.isPackaged !== false, getPath: () => root, whenReady: () => Promise.resolve(), on() {} };
  const context = { module: { exports: {} }, __dirname: path.join(client, 'main'), Buffer, URL,
    process: Object.assign(Object.create(process), { resourcesPath: resources, env }),
    setTimeout: fn => { timers.push(fn); return fn; }, clearTimeout() {},
    require(name) {
      if (name === './runner-process-lifecycle.cjs') return { supervise: () => ({ stop: async () => {} }) };
      if (name === 'fs' && options.missingPython) return { ...fs,
        existsSync: file => /[\\/]\.venv[\\/](?:Scripts[\\/]python\.exe|bin[\\/]python)$/.test(file)
          ? false : fs.existsSync(file) };
      if (name === 'child_process') return { spawn(bin, args, options) {
        const child = new EventEmitter(); child.pid = 100 + children.length;
        child.command = { bin, args, options };
        child.stdout = new PassThrough(); child.stdin = new EventEmitter();
        child.writes = []; child.stdin.writable = true;
        child.stdin.write = value => { child.writes.push(value); return true; }; child.stdin.end = () => {};
        children.push(child); return child;
      } };
      if (name.includes('custom-runtime-store')) return { startupAgents: () => [] };
      return nativeRequire(name);
    } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  context.module.exports.install({ app, ipcMain: { handle: (id, fn) => handlers.set(id, fn) },
    identityOf: () => ({ ...secureIdentity }),
    localOwnerOf: options.localOwnerOf, onSessionIssued: options.onSessionIssued,
    sessionOf: (_app, hub, clientId) => {
      assert.equal(hub, secureIdentity.hub);
      assert.equal(clientId, secureIdentity.clientId);
      return session;
    } });
  await Promise.resolve();
  const configure = () => handlers.get('runner-configure')(null, { hub: 'https://fixture.invalid', clientId: 'fixture-device' });
  if (!options.existingConfig) await configure();
  return { configure, children, timers, python, client, root,
    activate: () => { session = 'fixture-session'; },
    setSecret: secret => { secureIdentity.secret = secret; },
    configText: () => fs.readFileSync(path.join(root, 'runner', 'config.json'), 'utf8'),
    status: () => handlers.get('runner-status')(), rpc: context.module.exports.rpc,
    mobile: context.module.exports.setMobileCapabilities,
    report: data => children.at(-1).stdout.emit('data', '@@SODUWORK_RUNNER_STATUS@@' + JSON.stringify(data) + '\n') };
}

test('a dispatch timeout can only verify absence through its original local pipe', async t => {
  const f = await fixture(t), original = f.children[0];
  const pending = f.rpc('job.dispatch', { dispatchId: 'synthetic' });
  assert.match(original.writes.at(-1), /job\.dispatch/);
  f.timers.at(-1)();
  const error = await pending.then(() => assert.fail('expected timeout'), value => value);
  assert.match(error.message, /timed out/);
  assert.equal(error.sameDispatchConnection(), true);
  original.emit('exit', 0);
  await f.configure();
  assert.notEqual(f.children.at(-1), original);
  assert.equal(error.sameDispatchConnection(), false);
});

test('the desktop session bridge observes the original Runner pipe after a Qwen dispatch timeout', async t => {
  const f = await fixture(t), child = f.children[0], calls = [];
  const bridge = require('../main/agent-runtime/pi-session-bridge');
  t.mock.method(require('../main/runner-runtime'), 'rpc', f.rpc);
  t.mock.method(require('../main/pi-session/model-config'), 'fetchModel', async () => ({
    ok: true, model: { id: 'synthetic', key: 'synthetic', baseUrl: 'http://synthetic.invalid' },
  }));
  const prefix = '@@SODUWORK_LOCAL_RPC@@';
  let dispatchTimeout;
  let received;
  const dispatch = new Promise(resolve => { received = resolve; });
  t.mock.method(child.stdin, 'write', line => {
    const { id, message } = JSON.parse(line.slice(prefix.length));
    calls.push(message);
    if (message.op === 'job.dispatch') {
      dispatchTimeout = f.timers.at(-1);
      received(); return true;
    }
    const data = message.op === 'job.session'
      ? { ok: false, code: 'NATIVE_HISTORY_MISSING', ref: message.ref, items: [] }
      : message.op === 'job.has' ? { has: false, inflight: false, persisted: false, localWorkPending: false,
        admissionDurable: true, admissionKey: message.admissionKey, bootId: 'fixture' } : {};
    queueMicrotask(() => child.stdout.emit('data', prefix + JSON.stringify({ id, ok: true, result: { ok: true, data } }) + '\n'));
    return true;
  });
  const opened = await bridge.open({ ref: 'timeout-in-desktop-bridge', adapterId: 'qwen', cwd: f.root,
    identity: {}, modelName: 'synthetic' });
  assert.equal(opened.ok, true, opened.reason);
  const handle = opened.session;
  t.after(() => bridge.closeAll());
  const turn = handle.submit('Synthetic test', []);
  await dispatch;
  handle.cancel(); await turn.completion;
  dispatchTimeout(); await new Promise(setImmediate);
  assert.equal(handle.updateQueue('', 'resume').recovering, true);
  await new Promise(setImmediate);
  assert.equal(handle.snapshot().execution.recoveryRequired, false);
  const probes = calls.filter(message => message.op === 'job.has');
  assert.equal(probes.length, 2);
  assert.ok(probes.every(message => message.checkPendingWork === true));
  assert.equal(calls.filter(message => message.op === 'job.dispatch').length, 1);
});

test('the private Runner pipe receives only the current trusted desktop account fingerprint', async t => {
  const f = await fixture(t, { localOwnerOf: () => 'a'.repeat(32) });
  const frame = JSON.parse(f.children[0].writes[0].split('@@SODUWORK_RUNNER_CONFIG@@')[1]);
  const expected = require('node:crypto').createHash('sha256')
    .update(JSON.stringify(['https://fixture.invalid', 'a'.repeat(32)])).digest('hex');
  assert.equal(frame.codexAccountScope, expected);
  assert.equal(f.configText().includes('codexAccountScope'), false);
  assert.equal(f.configText().includes(expected), false);
});

for (const existingConfig of [false, true]) {
  test(`pending device waits for login with ${existingConfig ? 'a legacy' : 'no'} Runner configuration`, async t => {
    const f = await fixture(t, { existingConfig, noSession: true });
    await f.configure();
    await f.configure();
    assert.equal(f.children.length, 0);
    assert.equal(f.timers.length, 0);
    f.activate();
    await f.configure();
    f.report({ state: 'online' });
    await f.configure();
    assert.equal(f.children.length, 1);
    assert.equal(f.status().connected, true);
    assert.equal(JSON.parse(f.configText()).activationConfirmed, true);
  });
}

test('a previously activated device starts on cold boot while the Hub session is offline', async t => {
  const f = await fixture(t, { existingConfig: true, confirmed: true, noSession: true });
  assert.equal(f.children.length, 1);
});

test('a saved activation cannot start a different Hub or device before login', async t => {
  for (const savedIdentity of [{ hub: 'https://other.invalid' }, { clientId: 'other-device' }]) {
    const f = await fixture(t, { existingConfig: true, confirmed: true, noSession: true, savedIdentity });
    await f.configure();
    assert.equal(f.children.length, 0);
  }
});

test('unchanged secure identity and configuration keep the current Runner', async t => {
  const f = await fixture(t), child = f.children.at(-1);
  f.report({ state: 'online' });
  await f.configure();
  await f.configure();
  assert.equal(f.children.length, 1);
  assert.equal(f.status().pid, child.pid);
  assert.equal(f.status().connected, true);
  f.report({ state: 'error', code: 'AUTH_REQUIRED' });
  const authError = f.status().error;
  assert.match(authError, /设备登记/);
  await f.configure();
  assert.equal(f.children.length, 1, 'an authentication failure alone cannot restart with the same rejected key');
  assert.equal(f.status().pid, child.pid);
  assert.equal(f.status().connected, false);
  assert.equal(f.status().error, authError);
  assert.equal(f.timers.length, 0);
});

test('startup from existing public configuration tracks the launched secure identity', async t => {
  const f = await fixture(t, { existingConfig: true });
  assert.equal(f.children.length, 1, 'whenReady starts the persisted configuration before renderer configure');
  const initial = f.children[0];
  await f.configure();
  assert.equal(f.children.length, 1, 'the first renderer configure must preserve the auto-started Runner');
  assert.equal(f.status().pid, initial.pid);
  f.setSecret('fixture-recovered-startup-secret');
  await f.configure();
  assert.equal(f.children.length, 2);
  assert.equal(f.status().pid, f.children[1].pid);
  assert.equal(f.children[1].command.options.env.SODUWORK_DEVICE_SECRET, 'fixture-recovered-startup-secret');
  await f.configure();
  assert.equal(f.children.length, 2);
});

test('rotated device secret replaces the Runner without exposing credentials', async t => {
  const f = await fixture(t), previous = f.children.at(-1);
  const previousSecret = previous.command.options.env.SODUWORK_DEVICE_SECRET;
  const recoveredSecret = 'fixture-device-secret-after';
  const persistedConfig = f.configText();
  f.report({ state: 'online' });
  f.setSecret(recoveredSecret);
  const result = await f.configure();
  assert.equal(result.ok, true);
  assert.equal(f.children.length, 2, 'the recovered key must reach a newly spawned Runner');
  const replacement = f.children.at(-1);
  assert.notEqual(replacement, previous);
  assert.equal(previous.command.options.env.SODUWORK_DEVICE_SECRET, previousSecret);
  assert.equal(replacement.command.options.env.SODUWORK_DEVICE_SECRET, recoveredSecret);
  assert.equal(f.configText(), persistedConfig, 'rotating a key must not change public Runner configuration');
  assert.equal(f.status().pid, replacement.pid);
  previous.stdout.emit('data', '@@SODUWORK_RUNNER_STATUS@@' + JSON.stringify({ state: 'online' }) + '\n');
  assert.equal(f.status().connected, false, 'the replacement must wait for its own Hub welcome');
  for (const child of f.children) assert.match(child.writes[0], /^@@SODUWORK_RUNNER_CONFIG@@/);
  for (const value of [f.configText(), JSON.stringify(f.status()), JSON.stringify(result),
    ...f.children.flatMap(child => child.writes), ...f.children.flatMap(child => Array.from(child.command.args))]) {
    assert.equal(value.includes(previousSecret), false);
    assert.equal(value.includes(recoveredSecret), false);
  }
  f.report({ state: 'online' });
  previous.stdout.emit('data', '@@SODUWORK_RUNNER_STATUS@@' + JSON.stringify({ state: 'error', code: 'AUTH_REQUIRED' }) + '\n');
  assert.equal(f.status().error, '', 'a superseded Runner cannot overwrite the new connection status');
  const timerCount = f.timers.length;
  previous.emit('exit', 0);
  assert.equal(f.status().running, true);
  assert.equal(f.status().pid, replacement.pid);
  assert.equal(f.status().connected, true);
  assert.equal(f.timers.length, timerCount, 'the superseded process cannot schedule another Runner');
  await f.configure();
  assert.equal(f.children.length, 2, 'refreshing the recovered identity must not restart again');
});

test('mobile capability replies use the initiating private Runner pipe', async t => {
  const f = await fixture(t), child = f.children.at(-1), writes = [];
  child.stdin.write = value => writes.push(value);
  f.mobile(async body => ({ operation: body.operation }));
  child.stdout.emit('data', '@@SODUWORK_LOCAL_RPC@@' + JSON.stringify({ kind: 'desktop-capability', id: 'request', body: { operation: 'catalog' } }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  const packet = JSON.parse(writes[0].slice('@@SODUWORK_LOCAL_RPC@@'.length));
  assert.equal(packet.message.op, 'desktop.capability.reply');
  assert.equal(packet.message.requestId, 'request');
  assert.equal(packet.message.result.data.operation, 'catalog');
});

test('Runner RPC preserves multiline user events across UTF-8 pipe boundaries and process replacement', async t => {
  const f = await fixture(t), previous = f.children.at(-1);
  const prefix = '@@SODUWORK_LOCAL_RPC@@';
  const text = 'first line\nsecond line 中文 🎨';
  function response(child, value) {
    const { id } = JSON.parse(child.writes.at(-1).slice(prefix.length));
    return Buffer.from(prefix + JSON.stringify({ id, ok: true, result: { items: [{ kind: 'user', text: value }] } }) + '\r\n');
  }

  const first = f.rpc('job.session');
  const firstFrame = response(previous, text);
  const second = f.rpc('job.session');
  const secondFrame = response(previous, '另一条消息');
  const chinese = firstFrame.indexOf('中') + 1;
  const emoji = firstFrame.indexOf('🎨') + 2;
  previous.stdout.write(firstFrame.subarray(0, chinese));
  previous.stdout.write(firstFrame.subarray(chinese, emoji));
  previous.stdout.write(Buffer.concat([firstFrame.subarray(emoji), secondFrame]));
  assert.equal((await first).items[0].text, text);
  assert.equal((await second).items[0].text, '另一条消息');

  const abandoned = f.rpc('job.session');
  const partial = response(previous, text);
  const split = partial.indexOf('中') + 1;
  previous.stdout.write(partial.subarray(0, split));
  const stopped = assert.rejects(abandoned, /Runner stopped/);
  f.setSecret('fixture-replacement-secret');
  await f.configure();
  await stopped;
  previous.stdout.write(partial.subarray(split));

  const replacement = f.children.at(-1);
  assert.notEqual(replacement, previous);
  const fresh = f.rpc('job.session');
  replacement.stdout.write(response(replacement, text));
  assert.equal((await fresh).items[0].text, text);
});

test('mobile capability result never goes to a replaced Runner process', async t => {
  const f = await fixture(t), child = f.children.at(-1), writes = [];
  let finish;
  child.stdin.write = value => writes.push(value);
  f.mobile(() => new Promise(resolve => { finish = resolve; }));
  child.stdout.emit('data', '@@SODUWORK_LOCAL_RPC@@' + JSON.stringify({ kind: 'desktop-capability', id: 'request', body: {} }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  child.emit('exit', 0);
  finish({ plugins: ['private'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 0);
});

test('Runner process existence is distinct from authenticated Hub readiness', async t => {
  const f = await fixture(t);
  assert.equal(f.status().running, true);
  assert.equal(f.status().connected, false);
  assert.equal(f.status().error, '', 'a profile awaiting its first configuration is not a failure');
  f.report({ state: 'online' });
  assert.equal(f.status().connected, true);
  f.report({ state: 'error', code: 'HANDSHAKE_TIMEOUT' });
  assert.equal(f.status().connected, false);
  assert.match(f.status().error, /后台.*确认|确认.*上线/);
  await f.configure();
  assert.match(f.status().error, /后台.*确认|确认.*上线/, 'config refresh cannot erase a connection failure');
  f.report({ state: 'online' });
  assert.equal(f.status().error, '');
});

test('a Runner left over from the previous brand name still starts', async t => {
  const f = await fixture(t, { legacyBrand: true });
  assert.equal(f.status().running, true, 'upgraded installs keep their existing Runner binary working');
});

test('missing development Runner environment is reported by status and local RPC', async t => {
  const f = await fixture(t, { isPackaged: false, missingPython: true });
  assert.equal(f.children.length, 0);
  assert.equal(f.status().running, false);
  assert.equal(f.status().state, 'error');
  assert.match(f.status().error, /hub-backend\/\.venv.*requirements-runner\.txt/);
  await assert.rejects(f.rpc('runtime.detect', { key: 'qwen' }), error => {
    assert.equal(error.code, 'RUNNER_NOT_RUNNING');
    assert.equal(error.message, f.status().error);
    return true;
  });
});

test('the source launcher starts Runner with its own prepared Python and supports catalog RPC', async t => {
  const f = await fixture(t, { isPackaged: false, sourceLayout: true });
  assert.equal(f.children.length, 1, f.status().error);
  const child = f.children[0];
  assert.equal(child.command.bin, f.python);
  assert.deepEqual(Array.from(child.command.args), [path.join(f.client, '..', 'hub-backend', 'runner_main.py'), '--config-stdin']);
  f.report({ state: 'online' });
  assert.equal(f.status().connected, true);
  child.stdin.write = value => {
    const packet = JSON.parse(value.slice('@@SODUWORK_LOCAL_RPC@@'.length));
    assert.equal(packet.message.op, 'agent.setup');
    child.stdout.emit('data', '@@SODUWORK_LOCAL_RPC@@' + JSON.stringify({ id: packet.id, ok: true,
      result: { agents: [{ key: 'pi', installed: true }], env: { ok: true } } }) + '\n');
    return true;
  };
  assert.deepEqual(JSON.parse(JSON.stringify(await f.rpc('agent.setup'))), {
    agents: [{ key: 'pi', installed: true }], env: { ok: true } });
});

test('source Runner Python cannot be replaced by an inherited virtual environment or arbitrary override', async t => {
  for (const value of ['', '/usr/bin/python3', 'python3']) {
    const f = await fixture(t, { isPackaged: false, sourceLayout: true,
      env: { SODUWORK_SOURCE_RUNNER_PYTHON: value } });
    assert.equal(f.children.length, 0);
    assert.equal(f.status().state, 'error');
    assert.match(f.status().error, /start\.sh --desktop/);
  }
});

test('a missing launcher environment reports repair guidance without falling back to system Python', async t => {
  const f = await fixture(t, { isPackaged: false, sourceLayout: true, missingSourcePython: true });
  assert.equal(f.children.length, 0);
  assert.equal(f.status().state, 'error');
  assert.match(f.status().error, /start\.sh --desktop/);
});

test('packaged Runner ignores all source Python overrides', async t => {
  const f = await fixture(t, { sourceLayout: true,
    env: { SODUWORK_SOURCE_RUNNER_PYTHON: '/unexpected/python' } });
  assert.equal(f.children.length, 1);
  assert.match(f.children[0].command.bin, /resources[\\/]runner[\\/]soduwork-runner/);
  assert.deepEqual(Array.from(f.children[0].command.args), ['--config-stdin']);
});

test('ordinary development keeps its backend environment unless the source-session flag is explicit', async t => {
  for (const flag of [undefined, '', '0', 'unexpected']) {
    const f = await fixture(t, { isPackaged: false, sourceLayout: true, projectPython: true,
      env: { SODUWORK_SOURCE_SESSION: flag, SODUWORK_SOURCE_RUNNER_PYTHON: '/unexpected/python' } });
    assert.equal(f.children.length, 1, f.status().error);
    assert.equal(f.children[0].command.bin, path.join(f.client, '..', 'hub-backend', '.venv',
      ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'])));
  }
});

test('asynchronous spawn failure clears phantom process and schedules recovery', async t => {
  const f = await fixture(t);
  f.children[0].emit('error', new Error('fixture spawn denied'));
  assert.equal(f.status().running, false);
  assert.match(f.status().error, /fixture spawn denied/);
  assert.equal(f.timers.length, 1);
  f.timers.shift()();
  assert.equal(f.children.length, 2);
});

test('identity recovery failures remain actionable across child exit and retry', async t => {
  for (const [code, message] of [
    ['IDENTITY_STORAGE_FAILED', /无法保存.*身份.*目录.*写入/],
    ['IDENTITY_RECOVERY_FAILED', /身份恢复失败.*设备登记/],
  ]) {
    const f = await fixture(t);
    f.report({ state: 'error', code: 'IDENTITY_CONFLICT' });
    f.report({ state: 'error', code });
    f.children.at(-1).emit('exit', 1);
    assert.match(f.status().error, message);
    f.timers.shift()();
    await f.configure();
    assert.match(f.status().error, message);
    assert.equal(f.status().connected, false);
    f.report({ state: 'online' });
    assert.equal(f.status().error, '');
  }
});
