'use strict';

const vault = require('./linux-device-vault.cjs');

// Versioned local-model envelope. Distinct from Electron safeStorage prefixes
// (v10/v11/v20). Device-credential ciphertext is unchanged and has no prefix.
const envelope = Buffer.from('soduwork-lm-v1\0');

function asBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value || []);
}

function hasEnvelope(bytes) {
  return bytes.length > envelope.length && bytes.subarray(0, envelope.length).equals(envelope);
}

function create(store) {
  if (!vault.isUnlockedVault(store)) throw Error('Linux vault store is not available');
  const label = vault.localModelsLabel;
  return {
    isEncryptionAvailable() {
      try { return store.available() === true; }
      catch { return false; }
    },
    getSelectedStorageBackend() { return label; },
    encryptString(plain) {
      if (this.isEncryptionAvailable() !== true) throw Error('系统安全存储不可用，无法保存本地模型凭据');
      return Buffer.concat([envelope, store.protect(label, plain)]);
    },
    decryptString(buffer) {
      if (this.isEncryptionAvailable() !== true) throw Error('系统安全存储不可用，无法保存本地模型凭据');
      const bytes = asBuffer(buffer);
      if (!hasEnvelope(bytes)) throw Error('Cannot decrypt the stored local secret');
      return store.unprotect(label, bytes.subarray(envelope.length));
    },
  };
}

module.exports = { create, envelope, hasEnvelope };
