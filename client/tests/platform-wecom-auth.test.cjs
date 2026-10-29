'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const runtime = require('../main/platform-connections/runtime.cjs');
const life = require('../main/platform-connections/account-lifecycle.cjs');
const qr = require('../main/platform-connections/wecom-qr.cjs');
const errors = require('../main/platform-connections/wecom-auth-error.cjs');
const connections = require('../main/platform-connections/index.cjs');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { await tick(); await tick(); }
function failure(type, code) {
 return { code: 1, output: '正在获取二维码...\n' + JSON.stringify({ error: { type, code,
  message: 'PRIVATE-CREDENTIAL C:\\private\\credentials.enc', endpoint: 'https://private.invalid/?token=SECRET' } }, null, 2) };
}
function fixture(t) {
 const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-wecom-auth-'));
 const app = { getPath: () => folder }, state = { identity: identity(), starts: 0, probes: 0,
  execute: () => ({ completion: Promise.resolve(failure('PermissionError', 893006)), cancel() {} }) };
 t.mock.method(runtime, 'inspect', async () => ({ status: 'installed', label: '企业微信' }));
 t.mock.method(runtime, 'launch', async (_app, _key, _scope, args, options) => {
  if (args[1] === 'show') { state.probes++; return { completion: Promise.resolve({ code: 0, output: 'unauthorized' }) }; }
  state.starts++; return state.execute(options);
 });
 const options = { app, identityOf: async () => state.identity, safeStorage: {}, shell: {} };
 const service = connections.create(options);
 t.after(() => { service.close(); assert.equal(path.dirname(folder), path.resolve(os.tmpdir()));
  assert.ok(path.basename(folder).startsWith('soduwork-wecom-auth-')); fs.rmSync(folder, { recursive: true, force: true }); });
 return { app, state, service, options, scope: runtime.platformScope(app, state.identity, 'wecom') };
}
for (const [type, code, expected] of [
 ['PermissionError', 893006, /安全策略/], ['NetworkError', 893101, /网络或代理/],
 ['QrTimeout', 893202, /等待超时/], ['AuthError', 893201, /手机上确认/],
 ['CryptoError', 893203, /系统密钥/], ['ParseError', 893103, /返回异常/],
]) test('WeCom ' + type + ' is actionable without exposing provider details', () => {
 const text = errors.message(failure(type, code));
 assert.match(text, expected); assert.doesNotMatch(text, /PRIVATE|private|SECRET|https:|credentials/);
});
test('WeCom local exceptions and malformed diagnostics use only fixed safe messages', () => {
 assert.match(errors.message(Object.assign(Error('private'), { code: 'ETIMEDOUT' })), /等待超时/);
 assert.match(errors.message(Error('平台程序响应超时，请重试')), /等待超时/);
 assert.match(errors.message(Object.assign(Error('private'), { code: 'EACCES' })), /安全策略/);
 assert.match(errors.message(Object.assign(Error('private'), { code: 'ENOTFOUND' })), /网络或代理/);
 assert.match(errors.message(Object.assign(Error('private'), { code: 'ENOENT' })), /运行环境/);
 for (const value of [Error('PRIVATE-CREDENTIAL'), { code: 1, output: '{"error": {"type": "PRIVATE-CREDENTIAL"' },
  failure('PRIVATE-CREDENTIAL', 999999), failure({toString:null,valueOf:null},{toString:null,valueOf:null}), { code: 1, error: 'PRIVATE-CREDENTIAL' }]) {
  assert.doesNotMatch(errors.message(value), /PRIVATE-CREDENTIAL/); assert.match(errors.message(value), /连接未完成/);
 }
});
test('WeCom failed authorization releases persisted connecting and permits a fresh status probe after restart', async t => {
 const f = fixture(t);
 await f.service.connect('wecom'); await settle();
 const failed = await f.service.status('wecom');
 assert.equal(failed.state, 'error'); assert.equal(failed.connected, false); assert.match(failed.message, /安全策略/);
 assert.doesNotMatch(JSON.stringify(failed), /PRIVATE|private|SECRET/);
 assert.equal(life.read(f.app, 'wecom', f.scope).connecting, false);
 const restarted = connections.create(f.options); t.after(() => restarted.close());
 assert.equal((await restarted.refresh('wecom')).state, 'needs_auth'); assert.equal(f.state.probes, 1);
 await f.service.connect('wecom'); await settle(); assert.equal(f.state.starts, 2);
});
test('WeCom network failure and process timeout remain distinct and clear connecting', async t => {
 const f = fixture(t);
 f.state.execute = () => ({ completion: Promise.resolve(failure('NetworkError', 893101)), cancel() {} });
 await f.service.connect('wecom'); await settle();
 assert.match((await f.service.status('wecom')).message, /网络或代理/);
 assert.equal(life.read(f.app, 'wecom', f.scope).connecting, false);
 f.state.execute = () => ({ completion: Promise.reject(Error('平台程序响应超时，请重试')), cancel() {} });
 await f.service.connect('wecom'); await settle();
 assert.match((await f.service.status('wecom')).message, /等待超时/);
 assert.equal(life.read(f.app, 'wecom', f.scope).connecting, false);
});
test('WeCom QR setup and process launch failures are terminal and redact local paths', async t => {
 const f = fixture(t);
 f.state.execute = () => { throw Object.assign(Error('PRIVATE C:\\private'), { code: 'ENOENT' }); };
 await f.service.connect('wecom'); await settle();
 assert.match((await f.service.status('wecom')).message, /运行环境/);
 assert.equal(life.read(f.app, 'wecom', f.scope).connecting, false);
 t.mock.method(qr, 'create', () => { throw Object.assign(Error('PRIVATE C:\\private'), { code: 'EACCES' }); });
 await f.service.connect('wecom'); await settle();
 const state = await f.service.status('wecom'); assert.match(state.message, /安全策略/);
 assert.doesNotMatch(JSON.stringify(state), /PRIVATE|private/);
 assert.equal(life.read(f.app, 'wecom', f.scope).connecting, false); assert.equal(f.state.starts, 1);
});
test('WeCom late failure cannot change a switched account or a disconnect fence', async t => {
 const f = fixture(t); let complete;
 f.state.execute = () => ({ completion: new Promise(resolve => { complete = resolve; }), cancel() {} });
 await f.service.connect('wecom'); await settle();
 f.state.identity = identity('two'); const before = await f.service.status('wecom');
 complete(failure('NetworkError', 893101)); await settle();
 assert.deepEqual(await f.service.status('wecom'), before);
 f.state.identity = identity(); await f.service.connect('wecom'); await settle();
 const disconnecting = f.service.disconnect('wecom'); await tick();
 complete(failure('NetworkError', 893101)); await disconnecting;
 const marker = life.read(f.app, 'wecom', f.scope); assert.equal(marker.disconnected, true); assert.equal(marker.connecting, false);
 assert.equal((await f.service.status('wecom')).state, 'disconnected');
});
test('WeCom timeout still blocks another login until the old process has actually exited', async t => {
 const f = fixture(t), child = { exitCode: null, signalCode: null }; let reject;
 f.state.execute = () => ({ child, completion: new Promise((_resolve, fail) => { reject = fail; }), cancel() { return false; } });
 await f.service.connect('wecom'); await settle(); reject(Error('平台程序响应超时，请重试')); await settle();
 assert.equal(life.read(f.app, 'wecom', f.scope).connecting, false);
 assert.match((await f.service.status('wecom')).message, /等待超时/);
 await assert.rejects(f.service.connect('wecom'), /仍在退出/); assert.equal(f.state.starts, 1);
 child.exitCode = 1; f.state.execute = () => ({ completion: Promise.resolve(failure('NetworkError', 893101)), cancel() {} });
 await f.service.connect('wecom'); await settle(); assert.equal(f.state.starts, 2);
});
