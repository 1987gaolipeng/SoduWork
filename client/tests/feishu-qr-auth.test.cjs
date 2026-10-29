const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const auth = require('../main/platform-connections/feishu-auth.cjs');
const feishu = require('../main/platform-connections/feishu.cjs');
const runtime = require('../main/platform-connections/runtime.cjs');
const connections = require('../main/platform-connections/index.cjs');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const tick = () => new Promise(r => setImmediate(r));
const safe = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'secure-test',
  encryptString: value => Buffer.from(value).map(x => x ^ 137), decryptString: value => Buffer.from(value).map(x => x ^ 137).toString() };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-feishu-qr-test-'));
  t.after(() => { feishu.closeAll(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('soduwork-feishu-qr-test-')); fs.rmSync(dir, { recursive: true, force: true }); });
  const app = { getPath: () => dir };
  return { app, scope: runtime.platformScope(app, identity(), 'feishu'), identityOf: async () => identity() };
}
const value = () => ({ appId: 'cli_fixture', appSecret: 'private-fixture-secret', bearer: 'local-fixture-bearer' });
const response = (data, ok = true) => ({ ok, json: async () => data });
const device = { device_code: 'private-device', user_code: 'ABCD-EFGH',
  verification_uri_complete: 'https://accounts.feishu.cn/oauth/device?user_code=ABCD-EFGH', expires_in: 60, interval: 1 };
const granted = () => ({ accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: Date.now() + 7200000,
  refreshExpiresAt: Date.now() + 604800000, grantedScope: 'offline_access docx:document' });

test('device flow uses fixed endpoints, follows pending/slow_down and exposes only public scan data', async () => {
  const publicStates = [], intervals = [], calls = [];
  const answers = [response(device), response({ error: 'authorization_pending' }, false),
    response({ error: 'slow_down' }, false), response({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 7200 })];
  let now = 10000;
  const result = await auth.authorize(value(), { now: () => now, progress: x => publicStates.push(x),
    sleep: async ms => { intervals.push(ms); now += ms; }, fetchImpl: async (url, options) => {
      calls.push({ url, options }); assert.equal(options.redirect, 'error'); return answers.shift();
    } });
  assert.equal(result.accessToken, 'private-access'); assert.equal(result.expiresAt, now + 7200000);
  assert.deepEqual(intervals, [1000, 1000, 6000]);
  assert.equal(calls[0].url, 'https://accounts.feishu.cn/oauth/v1/device_authorization');
  assert.equal(calls[0].options.headers.Authorization, 'Basic ' + Buffer.from('cli_fixture:private-fixture-secret').toString('base64'));
  const poll = new URLSearchParams(calls[1].options.body);
  assert.equal(poll.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');assert.equal(poll.get('device_code'), 'private-device');
  assert.equal(publicStates[0].phase, 'user_authorization'); assert.ok(!JSON.stringify(publicStates).includes('private-'));
});

test('official page URLs reject spoofed domains, embedded credentials and credential query parameters', () => {
  for (const url of ['https://feishu.cn.evil.test/a', 'https://evil.test/?feishu.cn', 'http://accounts.feishu.cn/a',
    'https://secret@accounts.feishu.cn/a', 'https://accounts.feishu.cn:8443/a', 'https://accounts.feishu.cn/a?device_code=private',
    'https://accounts.feishu.cn/a?access_token=private']) assert.throws(() => auth.authUrl(url));
  assert.equal(auth.authUrl(device.verification_uri_complete), device.verification_uri_complete);
});

test('denial/expiry/cancellation never report a successful personal login or echo provider diagnostics', async () => {
  for (const code of ['access_denied', 'expired_token', 'invalid_grant', 'invalid_client']) {
    let n = 0;
    await assert.rejects(auth.authorize(value(), { progress() {}, sleep: async () => {},
      fetchImpl: async () => ++n === 1 ? response(device) : response({ error: code, error_description: 'private-fixture-secret' }, false) }),
    e => e.code === code && !e.message.includes('private-'));
  }
  let n = 0; const ctl = new AbortController();
  await assert.rejects(auth.authorize(value(), { signal: ctl.signal, progress() { ctl.abort(); },
    fetchImpl: async () => { n++; return response(device); } }), e => e.code === 'abort');
  assert.equal(n, 1);
  let now = 0;
  await assert.rejects(auth.authorize(value(), { progress() {}, now: () => now, sleep: async ms => { now += ms; },
    fetchImpl: async () => response({ ...device, expires_in: 1 }) }), e => e.code === 'expired_token');
});

test('network recovery during polling retains the same device authorization', async () => {
  let starts = 0, polls = 0;
  const result = await auth.authorize(value(), { progress() {}, sleep: async () => {}, fetchImpl: async url => {
    if (url.includes('device_authorization')) { starts++; return response(device); }
    if (++polls === 1) throw Error('network');
    return response({ access_token: 'private-access', expires_in: 7200 });
  } });
  assert.equal(result.accessToken, 'private-access');assert.equal(starts, 1);assert.equal(polls, 2);
});

test('refresh rotates tokens through the official endpoint; invalid refresh is an actionable rescan', async () => {
  const result = await auth.refresh({ ...value(), ...granted() }, undefined, async (url, options) => {
    assert.equal(url, 'https://open.feishu.cn/open-apis/authen/v2/oauth/token');
    const form = new URLSearchParams(options.body);assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'private-refresh');
    return response({ access_token: 'private-new-access', refresh_token: 'private-new-refresh', expires_in: 7200, refresh_token_expires_in: 9000 });
  });
  assert.equal(result.refreshToken, 'private-new-refresh');
  await assert.rejects(auth.refresh({ ...value(), refreshToken: 'x' }, undefined,
    async () => response({ error: 'invalid_grant', error_description: 'private-secret' }, false)), /重新扫码/);
  await assert.rejects(auth.userInfo('private-access', undefined, async () => response({ code: 0, data: {} })), /个人身份/);
});

test('created app survives second-stage cancellation and retry does not register another app', async t => {
  const { app, scope, identityOf } = fixture(t);let creates = 0, logins = 0;
  t.mock.method(auth, 'registerApp', async () => { creates++; return value(); });
  t.mock.method(auth, 'authorize', async () => { logins++; throw auth.failure('access_denied'); });
  for (let i = 0; i < 2; i++) await assert.rejects(feishu.connect(app, identity(), scope, {}, safe, identityOf), /未获得/);
  assert.equal(creates, 1);assert.equal(logins, 2);
  const stored = feishu.read(app, scope, safe);assert.equal(stored.appId, 'cli_fixture');assert.equal(stored.accessToken, undefined);
  const legacy = await feishu.restore(app, identity(), scope, safe, identityOf);
  assert.equal(legacy.connected, false);assert.match(legacy.description, /扫码授权个人账号/);
  assert.ok(!fs.readFileSync(path.join(runtime.paths(app, 'feishu', scope).account, 'connection.json'), 'utf8').includes('private-'));
});

test('account switch or cancel while creating an app prevents late credential persistence', async t => {
  const { app, scope } = fixture(t);let done, current = identity();
  t.mock.method(auth, 'registerApp', () => new Promise(r => { done = r; }));
  const ctl = new AbortController();
  const pending = feishu.connect(app, identity(), scope, { signal: ctl.signal }, safe, async () => current);
  await tick();current = identity('two');done(value());
  await assert.rejects(pending, /账号已切换/);assert.equal(feishu.read(app, scope, safe), null);
  current = identity();const cancelled = feishu.connect(app, identity(), scope, { signal: ctl.signal }, safe, async () => current);
  await tick();ctl.abort();done(value());await assert.rejects(cancelled, /取消/);assert.equal(feishu.read(app, scope, safe), null);
});

test('concurrent expired-token requests refresh once, verify identity and persist rotation encrypted', async t => {
  const { app, scope, identityOf } = fixture(t);let count = 0;
  const old = { ...value(), ...granted(), expiresAt: 1, openId: 'ou_fixture', authMode: 'user' };
  feishu.save(app, scope, old, safe);
  t.mock.method(auth, 'refresh', async () => { count++;await tick();return { ...granted(), accessToken: 'new-access', refreshToken: 'new-refresh' }; });
  t.mock.method(auth, 'userInfo', async () => ({ openId: 'ou_fixture', name: 'fixture' }));
  const values = await Promise.all(Array.from({ length: 5 }, () => feishu.ensureToken(app, scope, { ...old }, safe, identityOf)));
  assert.equal(count, 1);assert.deepEqual(values, Array(5).fill('new-access'));
  assert.equal(feishu.read(app, scope, safe).refreshToken, 'new-refresh');
});

test('refresh cannot switch Feishu identity or persist after SoduWork account changes', async t => {
  const { app, scope } = fixture(t);let current = identity();
  const old = { ...value(), ...granted(), expiresAt: 1, openId: 'ou_fixture' };feishu.save(app, scope, old, safe);
  t.mock.method(auth, 'refresh', async () => ({ ...granted(), accessToken: 'other' }));
  t.mock.method(auth, 'userInfo', async () => ({ openId: 'ou_other' }));
  await assert.rejects(feishu.ensureToken(app, scope, old, safe, async () => current), /个人身份/);
  t.mock.method(auth, 'userInfo', async () => { current = identity('two');return { openId: 'ou_fixture' }; });
  await assert.rejects(feishu.ensureToken(app, scope, old, safe, async () => current), /账号已切换/);
  assert.equal(feishu.read(app, scope, safe).accessToken, 'private-access');
});

test('Feishu background jobs deduplicate, cancel, expire links and ignore a late previous result', async t => {
  const { app, identityOf } = fixture(t);const attempts = [];
  t.mock.method(runtime, 'inspect', async () => ({ status: 'installed', label: '飞书' }));
  t.mock.method(feishu, 'connect', (_a, _i, _s, options) => new Promise(resolve => { attempts.push({ options, resolve }); }));
  const service = connections.create({ app, identityOf, safeStorage: safe, shell: { openExternal() { throw Error('expired must not open'); } } });
  t.after(() => service.close());
  await Promise.all([service.connect('feishu'), service.connect('feishu')]);await tick();assert.equal(attempts.length, 1);
  attempts[0].options.progress({ state: 'awaiting_user', phase: 'app_registration', authUrl: device.verification_uri_complete, expiresAt: 1, client_secret: 'private-secret' });
  assert.ok(!JSON.stringify(await service.status('feishu')).includes('private-'));
  await assert.rejects(service.openAuth('feishu'), /失效/);
  await service.cancel('feishu');assert.equal(attempts[0].options.signal.aborted, true);
  await service.connect('feishu');await tick();assert.equal(attempts.length, 2);
  attempts[0].resolve({ connected: true, account: 'old' });await tick();assert.equal((await service.status('feishu')).state, 'connecting');
  attempts[1].resolve({ connected: true, account: 'new' });await tick();assert.equal((await service.status('feishu')).account, 'new');
});

test('proxy substitutes fresh user token and strips caller options, cookies and local credentials', async t => {
  const { app, scope, identityOf } = fixture(t);let token = 'private-fresh', forwards = 0;
  const upstream = http.createServer((req, res) => {
    forwards++;assert.equal(req.headers.authorization, 'Bearer ' + token);assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers['x-lark-token-mode'], undefined);res.end('ok');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const proxy = feishu.createProxy(upstream.address().port, scope, value(), app, identityOf, async () => token);
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  t.after(() => { for (const server of [proxy, upstream]) { server.closeAllConnections();server.close(); } });
  const url = 'http://127.0.0.1:' + proxy.address().port + '/mcp';
  const options = { headers: { Authorization: 'Bearer local-fixture-bearer', cookie: 'private-cookie', 'x-lark-token-mode': 'tenant_access_token' } };
  assert.equal((await fetch(url, options)).status, 200);token = 'private-rotated';assert.equal((await fetch(url, options)).status, 200);
  assert.equal((await fetch(url + '?tokenMode=tenant_access_token', options)).status, 404);assert.equal(forwards, 2);
});


test('connect waits for a preceding restore instead of reusing an old MCP startup', async t => {
  const { app, identityOf } = fixture(t);let finishRestore, starts = 0;
  t.mock.method(runtime, 'inspect', async () => ({ status: 'installed', label: '飞书' }));
  t.mock.method(feishu, 'restore', () => new Promise(r => { finishRestore = r; }));
  t.mock.method(feishu, 'connect', async () => { starts++;return { connected: true }; });
  const service = connections.create({ app, identityOf, safeStorage: safe, shell: {} });t.after(() => service.close());
  const checking = service.refresh('feishu');await tick();const connecting = service.connect('feishu');await tick();
  assert.equal(starts, 0);finishRestore({ connected: false });await Promise.all([checking, connecting]);await tick();
  assert.equal(starts, 1);assert.equal((await service.status('feishu')).connected, true);
});

test('switching SoduWork account cancels the previous account authorization job', async t => {
  const { app } = fixture(t);let current = identity(), pending;
  t.mock.method(runtime, 'inspect', async () => ({ status: 'installed', label: '飞书' }));
  t.mock.method(feishu, 'connect', (_a, _i, _s, options) => { pending = options;return new Promise(() => {}); });
  const service = connections.create({ app, identityOf: async () => current, safeStorage: safe, shell: {} });t.after(() => service.close());
  await service.connect('feishu');await tick();assert.equal(pending.signal.aborted, false);
  current = identity('two');const checked = await service.status('feishu');assert.equal(checked.connected, false);
  assert.equal(pending.signal.aborted, true);current = identity();assert.equal((await service.status('feishu')).state, 'needs_auth');
});


function registrationSdk(app) {
  const dir = path.join(runtime.paths(app, 'feishu').prefix, 'node_modules/@larksuiteoapi/node-sdk');
  fs.mkdirSync(dir, { recursive: true });const file = path.join(dir, 'index.js');fs.writeFileSync(file, 'module.exports = {};');
  return require(file);
}
test('registration rejects Lark domain switching with the correct user-facing reason', async t => {
  const { app } = fixture(t), sdk = registrationSdk(app);
  sdk.registerApp = async options => { options.onStatusChange({ status: 'domain_switched' }); };
  await assert.rejects(auth.registerApp(app, { progress() {} }), e => e.code === 'brand' && e.message.includes('飞书账号'));
});
test('cancelling registration before its begin response blocks late QR progress and credentials', async t => {
  const { app } = fixture(t), sdk = registrationSdk(app), ctl = new AbortController();let options, done, updates = 0;
  sdk.registerApp = opts => { options = opts;return new Promise(r => { done = r; }); };
  const pending = auth.registerApp(app, { signal: ctl.signal, progress() { updates++; } });
  ctl.abort();await assert.rejects(pending, /取消/);
  assert.throws(() => options.onQRCodeReady({ url: device.verification_uri_complete, expireIn: 60 }), /取消/);
  done({ client_id: 'cli_fixture', client_secret: 'private-secret' });await tick();assert.equal(updates, 0);
});
