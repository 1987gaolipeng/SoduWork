'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const loader = pathToFileURL(path.resolve(__dirname, '../../hub-backend/app/services/codex_gateway_startup.mjs')).href;
function probe(overrides = {}, source = '') {
  const env = { ...process.env, NODE_OPTIONS: '', MODEL_PROVIDER: 'custom-gateway',
    DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: 'gateway', _meta: { gateway: {
      baseUrl: 'http://127.0.0.1:19777/v1', headers: { Authorization: 'Bearer fixture-private-token' },
    } } }), ...overrides };
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
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
