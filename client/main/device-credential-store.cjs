'use strict';

// Only device credentials: no renderer access and no additional persistent key store.
function create({ safeStorage, app, platform = process.platform }) {
  const cache = new Map();
  let blocked = false;
  const message = '无法访问系统安全存储中的设备凭据。请解锁 macOS 登录钥匙串，完全退出并重新打开 SoduWork 后允许访问；原设备凭据已保留。若仍失败，请联系支持人员检查，勿删除钥匙串项目';
  function accessError() {
    return Object.assign(new Error(message), { code: 'DEVICE_KEYCHAIN_UNAVAILABLE' });
  }
  function block() {
    blocked = true;
    cache.clear();
    return accessError();
  }
  function available() {
    if (blocked) return false;
    // Early module installation is not an OS permission failure.
    if (app?.isReady && !app.isReady()) return false;
    let ready = false;
    try {
      ready = !!safeStorage?.isEncryptionAvailable();
      if (ready && platform === 'linux') {
        ready = safeStorage.getSelectedStorageBackend() !== 'basic_text' ||
          process.env.SODUWORK_ALLOW_INSECURE_KEYSTORE === '1';
      }
    } catch (_) { ready = false; }
    // The synchronous macOS backend may retain a failed key lookup until process
    // exit. Background identity checks must not keep requesting OS authorization.
    if (!ready && platform === 'darwin') block();
    return ready;
  }
  function decrypt(file, row) {
    if (blocked) throw accessError();
    if (!row?.cipher) {
      if (platform === 'darwin') throw block();
      return '';
    }
    const previous = cache.get(file);
    if (previous && previous.hub === row.hub && previous.clientId === row.clientId &&
        previous.cipher === row.cipher) return previous.secret;
    cache.delete(file);
    if (!available()) {
      if (platform === 'darwin') throw accessError();
      return '';
    }
    try {
      const secret = safeStorage.decryptString(Buffer.from(row.cipher, 'base64'));
      if (!secret) throw new Error('Empty device credential');
      cache.set(file, { hub: row.hub, clientId: row.clientId, cipher: row.cipher, secret });
      return secret;
    } catch (_) {
      // Electron's synchronous error does not distinguish denied/locked Keychain
      // from damaged ciphertext. Never infer permission to replace an identity.
      if (platform === 'darwin') throw block();
      return '';
    }
  }
  function encrypt(secret) {
    if (blocked) throw accessError();
    try { return safeStorage.encryptString(secret); }
    catch (error) {
      if (platform === 'darwin') throw block();
      throw error;
    }
  }
  return { available, decrypt, encrypt, error: () => blocked ? accessError() : null };
}

module.exports = { create };
