'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const derive = promisify(crypto.scrypt);
const storage = 'soduwork-passphrase-v1';
const localModelsLabel = 'soduwork-local-models-v1';
const unlocked = Symbol('soduwork-unlocked-vault');
const headerName = 'device-vault-v1';
const saltSize = 16;
const ivSize = 12;
const tagSize = 16;

function exists(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// An inaccessible native identity or backup must never be replaced by a new device.
function canCreate(directory) {
  for (const name of ['device-auth.json', 'device-auth.json.bak']) {
    const file = path.join(directory, name);
    if (!exists(file)) continue;
    // Selecting a Hub can persist an empty index before creating the first identity.
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 65536) return false;
      const doc = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (doc?.v !== 1 || !doc.profiles || typeof doc.profiles !== 'object' ||
          Array.isArray(doc.profiles) || Object.keys(doc.profiles).length) return false;
    } finally { fs.closeSync(fd); }
  }
  return true;
}

function startupMode(directory, nativeReady) {
  try {
    if (exists(path.join(directory, headerName))) return 'unlock';
    if (nativeReady()) return 'native';
    if (canCreate(directory)) return 'create';
  } catch { /* Keep the recovery window on filesystem errors. */ }
  return 'recover';
}

function readHeader(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== saltSize + 32) throw Error('Invalid device vault');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

// Publish a complete header exclusively, including across interrupted or concurrent first runs.
function createHeader(file, header) {
  const temp = file + '.' + crypto.randomUUID();
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, header); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.linkSync(temp, file);
  }
  finally { fs.unlinkSync(temp); }
}

async function unlock(directory, mode, passphrase) {
  if (!['create', 'unlock'].includes(mode) || typeof passphrase !== 'string' ||
      passphrase.length < 12 || passphrase.length > 256 || !passphrase.trim()) throw Error('Invalid vault passphrase');
  const file = path.join(directory, headerName);
  const header = mode === 'unlock' ? readHeader(file) : null;
  const salt = header ? header.subarray(0, saltSize) : crypto.randomBytes(saltSize);
  const material = await derive(passphrase, salt, 64, { N: 2 ** 17, r: 8, p: 1, maxmem: 192 * 1024 * 1024 });
  let key;
  try {
    // Independent halves of the KDF output: only the verifier goes on disk.
    const verifier = material.subarray(32);
    if (header) {
      if (!crypto.timingSafeEqual(verifier, header.subarray(saltSize))) throw Error('Could not unlock device vault');
    } else {
      if (!canCreate(directory)) throw Error('Existing device credentials');
      createHeader(file, Buffer.concat([salt, verifier]));
    }
    key = Buffer.from(material.subarray(0, 32));
  } finally { material.fill(0); }

  const context = (hub, clientId) => Buffer.from(JSON.stringify([storage, hub, clientId]));
  // Local model secrets reuse this in-memory key with a separate AAD. Device
  // credentials stay bound to [storage, hub, clientId]; the raw key is not returned.
  function protect(label, plaintext) {
    if (label !== localModelsLabel) throw Error('Unsupported vault protection label');
    if (typeof plaintext !== 'string') throw Error('Unsupported vault plaintext');
    const iv = crypto.randomBytes(ivSize);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(label));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  }
  function unprotect(label, bytes) {
    if (label !== localModelsLabel) throw Error('Unsupported vault protection label');
    try {
      if (!Buffer.isBuffer(bytes) || bytes.length <= ivSize + tagSize) throw Error();
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, ivSize));
      decipher.setAAD(Buffer.from(label));
      decipher.setAuthTag(bytes.subarray(ivSize, ivSize + tagSize));
      return Buffer.concat([decipher.update(bytes.subarray(ivSize + tagSize)), decipher.final()]).toString('utf8');
    } catch { throw Error('Cannot decrypt the stored local secret'); }
  }
  return {
    [unlocked]: true,
    platform: 'linux', storage, available: () => true, protect, unprotect,
    encrypt(secret, hub, clientId) {
      const iv = crypto.randomBytes(ivSize);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(context(hub, clientId));
      const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decrypt(_file, row) {
      try {
        if (row.storage !== storage) throw Error();
        const bytes = Buffer.from(row.cipher, 'base64');
        if (bytes.length <= ivSize + tagSize) throw Error();
        const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, ivSize));
        cipher.setAAD(context(row.hub, row.clientId));
        cipher.setAuthTag(bytes.subarray(ivSize, ivSize + tagSize));
        return Buffer.concat([cipher.update(bytes.subarray(ivSize + tagSize)), cipher.final()]).toString('utf8');
      } catch { throw Error('Cannot decrypt the stored device credential'); }
    },
    legacySecret: () => '',
  };
}

function isUnlockedVault(store) {
  return !!store && store[unlocked] === true && store.platform === 'linux' && store.storage === storage &&
    typeof store.protect === 'function' && typeof store.unprotect === 'function' &&
    typeof store.available === 'function';
}

module.exports = { startupMode, unlock, isUnlockedVault, localModelsLabel };
