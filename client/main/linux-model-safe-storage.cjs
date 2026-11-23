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
      throw Error('系统安全存储不可用，无法保存本地模型凭据');
    },
    decryptString(value) {
      const bytes = asBuffer(value);
      if (isVaultCipher(bytes)) {
        if (typeof bound?.decryptString !== 'function') throw Error('系统安全存储不可用，无法保存本地模型凭据');
        return bound.decryptString(bytes);
      }
      if (isNativeCipher(bytes)) {
        if (typeof native?.decryptString !== 'function') throw Error('系统安全存储不可用，无法保存本地模型凭据');
        return native.decryptString(bytes);
      }
      throw Error('系统安全存储不可用，无法保存本地模型凭据');
    },
    bindVault(credentials) {
      if (!vault.isUnlockedVault(credentials)) return false;
      bound = adapter.create(credentials);
      return bound.getSelectedStorageBackend() === vault.localModelsLabel;
    },
  };
}

module.exports = { create };
