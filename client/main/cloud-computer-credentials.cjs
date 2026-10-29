'use strict';

/*
 * Per-user cloud computer credentials.
 *
 * The renderer only ever sees public connection metadata. Passwords, private
 * keys and key passphrases are encrypted with Electron safeStorage and kept in
 * a file below the current user's app-data directory. The record key includes
 * the selected Hub origin and the authenticated account scope returned by
 * device-auth. This deliberately keeps operating-system login credentials out
 * of the Hub database and out of localStorage.
 *
 * Renderer bridge (see preload.js):
 *   soduWorkAPI.cloudComputer.get({ hub? })
 *   soduWorkAPI.cloudComputer.status({ hub? })       // alias of get
 *   soduWorkAPI.cloudComputer.save(payload)
 *   soduWorkAPI.cloudComputer.test(payload)          // no persistence
 *   soduWorkAPI.cloudComputer.install(payload)       // setup from Hub's one-time response
 *   soduWorkAPI.cloudComputer.clear({ hub? })
 *
 * `payload` accepts { hub, host, port, username, platform, workRoot,
 * authMethod: 'password'|'privateKey', password, privateKey, passphrase,
 * hostFingerprint }. Empty secret fields on save preserve the existing secret,
 * which lets the settings form edit metadata without forcing re-entry.
 *
 * SSH is implemented through the maintained ssh2 package. `test` performs an
 * authenticated SSH handshake and a harmless `printf` probe. `install` only
 * runs a command supplied by the trusted main-process cloud-environment flow;
 * arbitrary renderer commands are rejected unless the caller includes the
 * one-time setup marker returned by the Hub. Secrets are never put in argv,
 * logs or returned IPC values.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { replaceFileSync } = require('./verified-file-replace.cjs');

const SCHEMA = 1;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/;
const USER_RE = /^[^\x00\r\n]{1,128}$/;
const PORT_MIN = 1;
const PORT_MAX = 65535;
const COMMAND_MAX = 24 * 1024;
const TIMEOUT_MS = 12000;
// A fresh Linux host also installs Python, native Node/npm and the default Agent.
const INSTALL_TIMEOUT_MS = 45 * 60 * 1000;
const AUTH_METHODS = new Set(['password', 'privateKey']);
const PLATFORMS = new Set(['linux', 'windows', 'macos', 'other']);

let _safeStorage = null;
let _deviceAuth = null;

function file(app) { return path.join(app.getPath('userData'), 'cloud-computer-credentials.json'); }

function secureStoreAvailable() {
  if (!_safeStorage || !_safeStorage.isEncryptionAvailable()) return false;
  try {
    return process.platform !== 'linux' || _safeStorage.getSelectedStorageBackend() !== 'basic_text' ||
      process.env.SODUWORK_ALLOW_INSECURE_KEYSTORE === '1';
  } catch (_) { return true; }
}

function parseDoc(app) {
  const target = file(app);
  for (const candidate of [target, target + '.bak']) {
    try {
      const doc = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (doc && doc.schema === SCHEMA && doc.profiles && typeof doc.profiles === 'object') return doc;
    } catch (_) { /* try the recovery copy */ }
  }
  return { schema: SCHEMA, profiles: {} };
}

function writeDoc(app, doc) {
  const target = file(app);
  const next = target + '.next-' + crypto.randomUUID();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(next, JSON.stringify(doc), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    replaceFileSync(next, target);
    try { fs.rmSync(target + '.bak', { force: true }); } catch (_) {}
  } finally {
    try { fs.rmSync(next, { force: true }); } catch (_) {}
  }
}

function encrypt(value) {
  if (!secureStoreAvailable()) throw new Error('系统安全存储不可用，无法保存云端电脑凭据');
  return _safeStorage.encryptString(JSON.stringify(value)).toString('base64');
}

function decrypt(cipher) {
  if (!secureStoreAvailable() || !cipher) return null;
  try {
    const value = JSON.parse(_safeStorage.decryptString(Buffer.from(cipher, 'base64')));
    return value && typeof value === 'object' ? value : null;
  } catch (_) { return null; }
}

function normalizeHub(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch (_) { throw new Error('后台地址无效'); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash ||
      (url.pathname && url.pathname !== '/')) throw new Error('后台地址必须是不带路径的 http:// 或 https:// 地址');
  return url.origin;
}

function ownerScope(app, hub) {
  const id = _deviceAuth && _deviceAuth.identity(app, hub, '');
  if (!id) throw new Error('请先连接 SoduWork 后台');
  // localOwner is a one-way account scope derived only after an authenticated
  // session. It is safe to use as a storage namespace and never leaves main.
  const active = _deviceAuth.identity(app);
  if (!active || active.hub !== id.hub) throw new Error('请先切换到当前 SoduWork 后台并登录');
  const owner = _deviceAuth.localOwner(app);
  if (!owner) throw new Error('请先登录 SoduWork，再配置云端电脑');
  return { hub: id.hub, owner };
}

function keyFor(hub, owner) {
  return crypto.createHash('sha256').update(String(hub) + '\0' + String(owner)).digest('hex');
}

function validateHost(raw) {
  const host = String(raw == null ? '' : raw).trim();
  if (!host || host.length > 253 || !HOST_RE.test(host) || /[\\/\s]/.test(host)) {
    throw new Error('请输入有效的云端电脑 IP 或主机名');
  }
  return host;
}

function validatePort(raw) {
  const port = raw == null || raw === '' ? 22 : Number(raw);
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) throw new Error('SSH 端口必须是 1-65535 的整数');
  return port;
}

function validateUser(raw) {
  const username = String(raw == null ? '' : raw).trim();
  if (!USER_RE.test(username)) throw new Error('请输入云端电脑登录账号');
  return username;
}

function normalizeInput(raw, current = null) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const authMethod = String(input.authMethod || current?.metadata?.authMethod || 'password');
  if (!AUTH_METHODS.has(authMethod)) throw new Error('不支持的 SSH 认证方式');
  const platform = String(input.platform || current?.metadata?.platform || 'linux').toLowerCase();
  if (!PLATFORMS.has(platform)) throw new Error('不支持的云端电脑系统');
  const host = validateHost(input.host || current?.metadata?.host);
  const port = validatePort(input.port == null || input.port === '' ? current?.metadata?.port : input.port);
  const username = validateUser(input.username || current?.metadata?.username);
  const password = String(input.password == null ? '' : input.password);
  const privateKey = String(input.privateKey == null ? '' : input.privateKey);
  const passphrase = String(input.passphrase == null ? '' : input.passphrase);
  if (password.length > 4096 || privateKey.length > 128 * 1024 || passphrase.length > 4096) {
    throw new Error('凭据内容过长');
  }
  if (authMethod === 'password' && !password && !current?.secret?.password) throw new Error('请输入 SSH 密码');
  if (authMethod === 'privateKey' && !privateKey && !current?.secret?.privateKey) throw new Error('请输入 SSH 私钥');
  const metadata = {
    host, port, username, authMethod, platform,
    workRoot: String(input.workRoot || current?.metadata?.workRoot || '').trim().slice(0, 400),
    hostFingerprint: String(input.hostFingerprint || current?.metadata?.hostFingerprint || '').trim().slice(0, 200),
  };
  const secret = {
    password: authMethod === 'password' ? (password || current?.secret?.password || '') : '',
    privateKey: authMethod === 'privateKey' ? (privateKey || current?.secret?.privateKey || '') : '',
    passphrase: authMethod === 'privateKey' ? (passphrase || current?.secret?.passphrase || '') : '',
  };
  return { metadata, secret };
}

function publicProfile(row) {
  if (!row || !row.metadata) return null;
  const m = row.metadata;
  return {
    host: m.host, port: m.port, username: m.username, authMethod: m.authMethod,
    platform: m.platform, workRoot: m.workRoot || '', hostFingerprint: m.hostFingerprint || '',
    configured: true, hasPassword: m.authMethod === 'password' && !!row.secret?.password,
    hasPrivateKey: m.authMethod === 'privateKey' && !!row.secret?.privateKey,
    updatedAt: row.updatedAt || '',
  };
}

function readCurrent(app, rawHub) {
  const hub = normalizeHub(rawHub || (_deviceAuth && _deviceAuth.identity(app)?.hub));
  const owner = ownerScope(app, hub);
  const doc = parseDoc(app), row = doc.profiles[keyFor(hub, owner.owner)] || null;
  if (!row) return { hub, owner: owner.owner, row: null };
  const secret = decrypt(row.cipher);
  if (!secret) throw new Error('云端电脑凭据无法解密，请重新配置');
  return { hub, owner: owner.owner, row: { metadata: row.metadata || {}, secret }, raw: row };
}

function get(app, input = {}) {
  try {
    const current = readCurrent(app, input.hub || input.credential?.hub);
    return { ok: true, hub: current.hub, configured: !!current.row, profile: publicProfile(current.row) };
  } catch (error) { return { ok: false, code: 'CLOUD_CREDENTIALS_UNAVAILABLE', error: String(error.message || error) }; }
}

function save(app, input = {}) {
  try {
    const credential = input.credential && typeof input.credential === 'object' ?
      { ...input.credential, hub: input.hub || input.credential.hub } : input;
    const current = readCurrent(app, credential.hub);
    const value = normalizeInput(credential, current.row);
    const doc = parseDoc(app), slot = keyFor(current.hub, current.owner);
    doc.profiles[slot] = { hub: current.hub, owner: current.owner, metadata: value.metadata,
      cipher: encrypt(value.secret), updatedAt: new Date().toISOString() };
    writeDoc(app, doc);
    return { ok: true, hub: current.hub, profile: publicProfile(value), persisted: true };
  } catch (error) { return { ok: false, code: 'CLOUD_CREDENTIALS_SAVE_FAILED', error: String(error.message || error) }; }
}

function clear(app, input = {}) {
  try {
    const current = readCurrent(app, input.hub);
    const doc = parseDoc(app), slot = keyFor(current.hub, current.owner);
    delete doc.profiles[slot];
    writeDoc(app, doc);
    return { ok: true, hub: current.hub, cleared: true };
  } catch (error) { return { ok: false, code: 'CLOUD_CREDENTIALS_CLEAR_FAILED', error: String(error.message || error) }; }
}

function loadSsh2() {
  try { return require('ssh2'); } catch (_) {
    try { return require(path.join(process.resourcesPath, 'ssh2', 'lib', 'index.js')); } catch (_) { return null; }
  }
}

function sshOptions(profile, observed) {
  const options = { host: profile.metadata.host, port: profile.metadata.port,
    username: profile.metadata.username, readyTimeout: TIMEOUT_MS, keepaliveInterval: 0 };
  if (profile.metadata.authMethod === 'privateKey') {
    options.privateKey = profile.secret.privateKey;
    if (profile.secret.passphrase) options.passphrase = profile.secret.passphrase;
  } else options.password = profile.secret.password;
  const expected = String(profile.metadata.hostFingerprint || '').toLowerCase().replace(/^sha256:/, '');
  options.hostHash = 'sha256';
  options.hostVerifier = hash => {
    const actual = String(hash).toLowerCase();
    if (observed) observed.value = 'sha256:' + actual;
    // First connection uses TOFU: the successful connection pins the host
    // fingerprint locally. Subsequent connections must match the pin.
    return !expected || actual === expected;
  };
  return options;
}

function withSsh(profile, operation, operationTimeoutMs = TIMEOUT_MS) {
  const ssh2 = loadSsh2();
  if (!ssh2 || !ssh2.Client) return Promise.resolve({ ok: false, code: 'SSH_UNAVAILABLE', error: '当前客户端缺少 SSH 运行组件，请更新客户端后重试' });
  return new Promise(resolve => {
    const conn = new ssh2.Client();
    let settled = false;
    const observed = { value: '' };
    const done = value => {
      if (settled) return; settled = true; try { conn.end(); } catch (_) {}
      if (value && typeof value === 'object' && observed.value && value.ok) value.hostFingerprint = observed.value;
      resolve(value);
    };
    const timer = setTimeout(() => done({ ok: false, code: 'SSH_TIMEOUT', error: '连接云端电脑超时，请检查地址、端口和防火墙' }), operationTimeoutMs + 1000);
    conn.once('ready', async () => {
      try { const value = await operation(conn); clearTimeout(timer); done(value); }
      catch (error) { clearTimeout(timer); done({ ok: false, code: 'SSH_OPERATION_FAILED', error: sanitizeSshError(error) }); }
    });
    conn.once('error', error => { clearTimeout(timer); done({ ok: false, code: sshCode(error), error: sanitizeSshError(error) }); });
    try { conn.connect(sshOptions(profile, observed)); }
    catch (error) { clearTimeout(timer); done({ ok: false, code: 'SSH_CONNECT_FAILED', error: sanitizeSshError(error) }); }
  });
}

function sanitizeSshError(error) {
  const value = String(error?.message || error || 'SSH 连接失败');
  return value.replace(/password|passphrase|privateKey|-----BEGIN[\s\S]*?END [^-]+-----/gi, '凭据');
}
function sshCode(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  if (/auth|authentication|all configured authentication methods failed/.test(msg)) return 'SSH_AUTH_FAILED';
  if (/host verifier|fingerprint/.test(msg)) return 'SSH_HOST_UNTRUSTED';
  if (/econnrefused/.test(msg)) return 'SSH_REFUSED';
  if (/enotfound|getaddrinfo/.test(msg)) return 'SSH_HOST_NOT_FOUND';
  return 'SSH_CONNECT_FAILED';
}

async function test(app, input = {}) {
  try {
    const credential = input.credential && typeof input.credential === 'object' ?
      { ...input.credential, hub: input.hub || input.credential.hub } : input;
    const current = readCurrent(app, credential.hub);
    const value = normalizeInput(credential, current.row);
    const profile = { metadata: value.metadata, secret: value.secret };
    return await withSsh(profile, conn => new Promise(resolve => {
      const probeCommand = value.metadata.platform === 'windows' ? 'echo soduwork-cloud-check' : 'printf soduwork-cloud-check';
      conn.exec(probeCommand, (error, stream) => {
        if (error) return resolve({ ok: false, code: 'SSH_PROBE_FAILED', error: sanitizeSshError(error) });
        let output = '';
        stream.on('data', data => { output += String(data); });
        stream.stderr.on('data', () => {});
        stream.once('close', code => resolve(code === 0 && output.trim() === 'soduwork-cloud-check'
          ? { ok: true, code: 'SSH_READY', authenticated: true, host: value.metadata.host, port: value.metadata.port }
          : { ok: false, code: 'SSH_PROBE_FAILED', error: '云端电脑已连接，但 SSH 命令探测未通过' }));
      });
    }));
  } catch (error) { return { ok: false, code: 'CLOUD_CREDENTIALS_TEST_FAILED', error: String(error.message || error) }; }
}

async function install(app, input = {}) {
  // Installing a Runner is intentionally a separate explicit step. Never run
  // arbitrary text supplied by an untrusted renderer: the Hub response must be
  // passed as `setup` and the selected command must exactly match its command
  // for the selected platform. The setup key is checked inside the command so
  // an old or hand-written command cannot be smuggled into this operation.
  try {
    const current = readCurrent(app, input.hub || input.credential?.hub);
    const value = normalizeInput(input.credential || input, current.row);
    const setup = input.setup && typeof input.setup === 'object' ? input.setup : null;
    const platform = value.metadata.platform === 'windows' ? 'windows' : 'linux';
    const command = String(setup?.commands?.[platform] || '').trim();
    const setupKey = String(setup?.key || '').trim();
    const setupHub = String(setup?.hub || '').trim();
    // The install command must use the Hub's reachable/public address, while
    // the encrypted credential profile is scoped to the authenticated client
    // origin.  A local client commonly has `clientHub=127.0.0.1` and
    // `hub=10.x.x.x`; validate the signed setup response against the former.
    const setupClientHub = String(setup?.clientHub || setupHub).trim();
    const setupRunner = String(setup?.runnerId || '').trim();
    if (!setup || !command || command.length > COMMAND_MAX ||
        !/^[A-Za-z0-9._:-]{16,512}$/.test(setupKey) || !setupRunner ||
        normalizeHub(setupClientHub) !== current.hub ||
        !command.includes(setupKey) || !command.includes(setupRunner)) {
      return { ok: false, code: 'SETUP_RESPONSE_REQUIRED', error: '请从当前云端环境向导重新获取一次性安装指令' };
    }
    const profile = { metadata: value.metadata, secret: value.secret };
    // Runner installation downloads a package and creates a virtualenv on the
    // target host; keep the SSH session alive longer than the handshake probe.
    const result = await withSsh(profile, conn => new Promise(resolve => {
      conn.exec(command, (error, stream) => {
        if (error) return resolve({ ok: false, code: 'SSH_INSTALL_FAILED', error: sanitizeSshError(error) });
        let stderr = '';
        stream.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-1000); });
        stream.on('data', () => {}); // setup output never crosses the renderer boundary
        stream.once('close', code => resolve(code === 0
          ? { ok: true, code: 'RUNNER_INSTALL_STARTED', host: value.metadata.host, port: value.metadata.port }
          : { ok: false, code: 'SSH_INSTALL_FAILED', error: stderr || 'Runner 安装命令执行失败' }));
      });
    }), INSTALL_TIMEOUT_MS);
    if (result.ok) {
      const saved = save(app, { ...input.credential, hub: input.hub, hostFingerprint: result.hostFingerprint || input.credential?.hostFingerprint || '' });
      if (!saved.ok) return saved;
    }
    return result;
  } catch (error) { return { ok: false, code: 'CLOUD_INSTALL_FAILED', error: String(error.message || error) }; }
}

function installIpc({ app, ipcMain, deviceAuth, safeStorage }) {
  _deviceAuth = deviceAuth;
  if (safeStorage) _safeStorage = safeStorage;
  ipcMain.handle('cloud-computer-get', (_event, input) => get(app, input || {}));
  ipcMain.handle('cloud-computer-status', (_event, input) => get(app, input || {}));
  ipcMain.handle('cloud-computer-save', (_event, input) => save(app, input || {}));
  ipcMain.handle('cloud-computer-test', (_event, input) => test(app, input || {}));
  ipcMain.handle('cloud-computer-install', (_event, input) => install(app, input || {}));
  ipcMain.handle('cloud-computer-clear', (_event, input) => clear(app, input || {}));
}

module.exports = { install: installIpc, get, save, test, installRemote: install, clear,
  _private: { normalizeInput, publicProfile, keyFor, sshCode,
    setSafeStorage: value => { _safeStorage = value; } } };
