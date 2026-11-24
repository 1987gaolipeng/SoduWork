'use strict';

const vault = require('./linux-device-vault.cjs');
const adapter = require('./linux-vault-safe-storage.cjs');

const nativePrefixes = [Buffer.from('v10'), Buffer.from('v11'), Buffer.from('v20')];

function asBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value || []);
}

function startsWith(bytes, prefix) {
  return bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix);
}

function isNativeCipher(bytes) {
  return nativePrefixes.some(prefix => startsWith(bytes, prefix));
}

function isVaultCipher(bytes) {
  return adapter.hasEnvelope(bytes);
}

function nativeUsable(native) {
  return native?.isEncryptionAvailable?.() === true && native.getSelectedStorageBackend?.() !== 'basic_text';
}

function vaultUsable(bound) {
  return bound?.isEncryptionAvailable?.() === true;
}

function storageUnavailable(message = '系统安全存储不可用，无法读取已加密记录') {
  return Object.assign(Error(message), { code: 'SAFE_STORAGE_UNAVAILABLE' });
}

function create(nativeSafeStorage) {
  const native = nativeSafeStorage || null;
  let bound = null;
  return {
    isEncryptionAvailable() {
      return nativeUsable(native) || vaultUsable(bound);
    },
    getSelectedStorageBackend() {
      if (nativeUsable(native) && typeof native.getSelectedStorageBackend === 'function') {
        return native.getSelectedStorageBackend();
      }
      if (vaultUsable(bound)) return bound.getSelectedStorageBackend();
      if (typeof native?.getSelectedStorageBackend === 'function') return native.getSelectedStorageBackend();
      return undefined;
    },
    encryptString(value) {
      if (nativeUsable(native)) return native.encryptString(value);
      if (vaultUsable(bound) && typeof bound.encryptString === 'function') return bound.encryptString(value);
      throw storageUnavailable('系统安全存储不可用，无法保存本地模型凭据');
    },
    decryptString(value) {
      const bytes = asBuffer(value);
      if (isVaultCipher(bytes)) {
        if (!vaultUsable(bound) || typeof bound?.decryptString !== 'function') {
          throw storageUnavailable('系统安全存储不可用，无法读取凭据库加密记录');
        }
        return bound.decryptString(bytes);
      }
      if (isNativeCipher(bytes)) {
        if (typeof native?.decryptString !== 'function' || native.getSelectedStorageBackend?.() === 'basic_text') {
          throw storageUnavailable('系统安全存储不可用，无法读取原生密钥环加密记录');
        }
        try {
          return native.decryptString(bytes);
        } catch (error) {
          if (!nativeUsable(native)) throw storageUnavailable('系统安全存储不可用，无法读取原生密钥环加密记录');
          throw error;
        }
      }
      throw Error('Cannot decrypt the stored local secret');
    },
    bindVault(credentials) {
      if (!vault.isUnlockedVault(credentials)) return false;
      bound = adapter.create(credentials);
      return bound.getSelectedStorageBackend() === vault.localModelsLabel;
    },
  };
}

module.exports = { create };
