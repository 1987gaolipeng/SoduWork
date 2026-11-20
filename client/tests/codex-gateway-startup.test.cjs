'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const loader = pathToFileURL(path.resolve(__dirname, '../../hub-backend/app/services/codex_gateway_startup.mjs')).href;
function probe(overrides = {}, source = '', executable = process.execPath) {
  const env = { ...process.env, NODE_OPTIONS: '', MODEL_PROVIDER: 'custom-gateway',
    DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: 'gateway', _meta: { gateway: {
      baseUrl: 'http://127.0.0.1:19777/v1', headers: { Authorization: 'Bearer fixture-private-token' },
    } } }), ...overrides };
  return spawnSync(executable, ['--input-type=module', '-e', `
    import childProcess from 'node:child_process';
    const calls = [];
    childProcess.spawn = (...args) => { calls.push(args); return {fixture:true}; };
    await import(${JSON.stringify(loader)});
    ${source}
    console.log(JSON.stringify(calls));
  `], { env, encoding: 'utf8', timeout: 15000 });
}

test('native startup and adapter restarts receive the same provider without credential argv or persistent config', () => {
  const result = probe({}, `
    const env = {NODE_OPTIONS:'adapter-only', DEFAULT_AUTH_REQUEST:'private', CODEX_CONFIG:'private', CODEX_HOME:'isolated'};
    childProcess.spawn('codex.exe', ['app-server'], {env, windowsHide:true});
    childProcess.spawn('codex.exe', ['app-server'], {env});
    if (env.NODE_OPTIONS !== 'adapter-only') throw Error('Mutated caller environment');
  `);
  assert.equal(result.status, 0, result.stderr);
  const calls = JSON.parse(result.stdout);
  assert.equal(calls.length, 2);
  for (const [command, args, options] of calls) {
    assert.equal(command, 'codex.exe');
    assert.equal(args[0], 'app-server');
    assert.ok(args.includes('model_provider="custom-gateway"'));
    assert.match(args.at(-1), /env_http_headers/);
    assert.match(args.at(-1), /SODUWORK_CODEX_GATEWAY_AUTH/);
    assert.doesNotMatch(JSON.stringify(args), /fixture-private-token|Bearer /);
    assert.equal(options.env.SODUWORK_CODEX_GATEWAY_AUTH, 'Bearer fixture-private-token');
    assert.equal(options.env.CODEX_HOME, 'isolated');
    for (const key of ['NODE_OPTIONS', 'DEFAULT_AUTH_REQUEST', 'CODEX_CONFIG']) assert.equal(options.env[key], undefined);
  }
});

test('bundled Codex receives gateway configuration from versioned and renamed Node runtimes', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-codex-node-')));
  const extension = process.platform === 'win32' ? '.exe' : '';
  let executable = path.join(directory, 'node-22' + extension);
  try {
    // A symlink resolves back to the original name in process.execPath.
    // Copy the binary so this exercises the adapter's real renamed runtime.
    fs.copyFileSync(process.execPath, executable);
    for (const name of ['node-22', 'node20', 'node22', 'custom-node-runtime']) {
      const next = path.join(directory, name + extension);
      if (next !== executable) fs.renameSync(executable, next);
      executable = next;
      const result = probe({}, `
        const args = ['/isolated/codex.js', 'app-server', '-c', 'model_provider="custom-gateway"'];
        const env = {NODE_OPTIONS:'adapter-only', DEFAULT_AUTH_REQUEST:'private', CODEX_CONFIG:'private', CODEX_HOME:'isolated'};
        const options = {env, windowsHide:true};
        childProcess.spawn(process.execPath, args, options);
        if (args.length !== 4 || env.NODE_OPTIONS !== 'adapter-only' || options.env !== env) throw Error('Mutated caller inputs');
        childProcess.spawn(process.execPath, ['/isolated/codex.js', 'login'], {env:{keep:'login'}});
        childProcess.spawn(process.execPath, ['/isolated/tool.js', 'app-server'], {env:{keep:'tool'}});
      `, executable);
      assert.equal(result.status, 0, `${name}: ${result.stderr || result.error || ''}`);
      const calls = JSON.parse(result.stdout);
      assert.equal(calls.length, 3);
      const [command, args, options] = calls[0];
      assert.equal(command, executable);
      assert.deepEqual(args.slice(0, 4), ['/isolated/codex.js', 'app-server', '-c', 'model_provider="custom-gateway"']);
      assert.equal(args.length, 8);
      assert.match(args.at(-1), /^model_providers\.custom-gateway=/);
      assert.match(args.at(-1), /SODUWORK_CODEX_GATEWAY_AUTH/);
      assert.doesNotMatch(JSON.stringify(args), /fixture-private-token|Bearer /);
      assert.equal(options.env.SODUWORK_CODEX_GATEWAY_AUTH, 'Bearer fixture-private-token');
      assert.equal(options.env.CODEX_HOME, 'isolated');
      assert.equal(options.windowsHide, true);
      for (const key of ['NODE_OPTIONS', 'DEFAULT_AUTH_REQUEST', 'CODEX_CONFIG']) assert.equal(options.env[key], undefined);
      assert.deepEqual(calls[1], [executable, ['/isolated/codex.js', 'login'], {env:{keep:'login'}}]);
      assert.deepEqual(calls[2], [executable, ['/isolated/tool.js', 'app-server'], {env:{keep:'tool'}}]);
    }
  } finally {
    fs.rmSync(directory, {recursive:true, force:true});
  }
});

test('bundled npm native launch is covered while unrelated commands and account login remain untouched', () => {
  const result = probe({}, `
    childProcess.spawn('node', ['/isolated/codex.js', 'app-server'], {env:{}});
    childProcess.spawn('codex', ['login'], {env:{keep:'login'}});
    childProcess.spawn('node', ['/isolated/tool.js', 'app-server'], {env:{keep:'tool'}});
    childProcess.spawn('python', ['app-server'], {env:{keep:'python'}});
  `);
  assert.equal(result.status, 0, result.stderr);
  const calls = JSON.parse(result.stdout);
  assert.equal(calls[0][1].length, 6);
  assert.deepEqual(calls[1], ['codex', ['login'], {env:{keep:'login'}}]);
  assert.deepEqual(calls[2], ['node', ['/isolated/tool.js', 'app-server'], {env:{keep:'tool'}}]);
  assert.deepEqual(calls[3], ['python', ['app-server'], {env:{keep:'python'}}]);
});

test('similar executable names do not receive managed gateway credentials', () => {
  const commands = ['nodemon', 'nodefoo', 'node.exe-22', 'python'];
  const result = probe({}, `
    for (const command of ${JSON.stringify(commands)}) {
      childProcess.spawn(command, ['/isolated/codex.js', 'app-server'], {env:{keep:'unrelated'}});
    }
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), commands.map(command =>
    [command, ['/isolated/codex.js', 'app-server'], {env:{keep:'unrelated'}}]));
});

test('malformed managed gateway configuration fails before spawning and never prints its secret', () => {
  for (const overrides of [
    { MODEL_PROVIDER: 'openai' },
    { DEFAULT_AUTH_REQUEST: '{fixture-private-token' },
    { DEFAULT_AUTH_REQUEST: JSON.stringify({methodId:'gateway',_meta:{gateway:{baseUrl:'https://name:fixture-private-token@example.invalid',headers:{Authorization:'Bearer fixture-private-token'}}}}) },
  ]) {
    const result = probe(overrides, "throw Error('must not execute');");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid SoduWork managed Codex gateway configuration/);
    assert.doesNotMatch(result.stderr, /fixture-private-token|must not execute/);
  }
});
