'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const contract = require('../main/client-update-contract');

/* Wrap platform-sensitive validation deterministically because validateManifest defaults to process.platform. */
async function withPlatform(value, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

function fixture(platform = 'win32', arch = 'x64', name = 'SoduWork-1.2.11-Setup.exe') {
  const pair = crypto.generateKeyPairSync('ed25519');
  const keyId = 'smoke-key';
  const manifest = {
    schema: 1,
    releaseId: '12345678-1234-4234-8234-123456789abc',
    version: '1.2.11', channel: 'stable', platform, arch,
    artifact: {
      name, size: 2 * 1024 * 1024,
      sha256: 'a'.repeat(64),
      url: '/api/v1/client-updates/artifacts/12345678-1234-4234-8234-123456789abc',
    },
    mandatory: false, minVersion: '', notes: '安全升级',
    publishedAt: '2026-08-12T08:00:00Z', keyId,
  };
  manifest.signature = crypto.sign(null, contract.canonicalBytes(manifest), pair.privateKey).toString('base64');
  const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
  const pub = spki.subarray(spki.length - 32).toString('base64');
  return { manifest, trust: { schema: 1, keys: { [keyId]: pub } } };
}

test('strict semantic versions never downgrade or accept malformed values', () => {
  assert.equal(contract.newer('1.2.11', '1.2.10'), true);
  assert.equal(contract.newer('1.2.10', '1.2.10'), false);
  assert.equal(contract.newer('1.2.9', '1.2.10'), false);
  assert.equal(contract.newer('1.2.11-beta', '1.2.10'), false);
  assert.equal(contract.newer('1.2.11', 'bad'), false);
  assert.equal(contract.newer('1.13.11', '1.13.11-beta.532'), true);
  assert.equal(contract.newer('1.13.11-beta.532', '1.13.11'), false);
  assert.equal(contract.newer('1.13.11-beta.10', '1.13.11-beta.9'), true);
  assert.equal(contract.newer('1.13.11-beta.9', '1.13.11-beta.10'), false);
  assert.equal(contract.newer('1.13.11-beta.532', '1.13.11-beta.532'), false);
});

test('signed canonical manifest verifies and any mutation fails', async () => {
  const { manifest, trust } = fixture();
  await withPlatform('win32', async () => {
    assert.equal(contract.validateManifest(manifest, trust), manifest);
  });
  const changed = structuredClone(manifest);
  changed.artifact.size += 1;
  await withPlatform('win32', async () => {
    assert.throws(() => contract.validateManifest(changed, trust), /签名校验失败/);
  });
});

test('unknown signing key and unsafe installer paths are rejected', async () => {
  const { manifest } = fixture();
  await withPlatform('win32', async () => {
    assert.throws(() => contract.validateManifest(manifest, { schema: 1, keys: {} }), /不受信任/);
  });
  assert.throws(() => contract.safeInstallerPath('C:\\safe', '..\\evil.exe'), /名称无效/);
  assert.match(contract.safeInstallerPath('C:\\safe', 'SoduWork-1.2.11-Setup.exe', 'win32'), /SoduWork-1\.2\.11-Setup\.exe$/);
});

test('cross-platform manifests match only the running platform convention', () => {
  // mac/linux clients keep receiving the same signed bundle shape;
  // only the platform gate and the installer-name convention differ.
  const mac = fixture('darwin', 'arm64', 'SoduWork-1.2.11-mac-arm64.dmg');
  assert.equal(contract.validateManifest(mac.manifest, mac.trust, 'darwin'), mac.manifest);
  assert.throws(() => contract.validateManifest(mac.manifest, mac.trust, 'win32'), /与当前系统不匹配/);

  const linuxTar = fixture('linux', 'x64', 'SoduWork-1.2.11-linux-x64.tar.gz');
  assert.equal(contract.validateManifest(linuxTar.manifest, linuxTar.trust, 'linux'), linuxTar.manifest);
  const linuxRpm = fixture('linux', 'arm64', 'SoduWork-1.2.11-linux-arm64.rpm');
  assert.equal(contract.validateManifest(linuxRpm.manifest, linuxRpm.trust, 'linux'), linuxRpm.manifest);

  // wrong-suffix installers fail even with a valid signature
  const badSuffix = fixture('linux', 'x64', 'SoduWork-1.2.11-linux-x64.exe');
  assert.throws(() => contract.validateManifest(badSuffix.manifest, badSuffix.trust, 'linux'), /名称无效/);
  const bareGz = fixture('linux', 'x64', 'SoduWork-1.2.11-linux-x64.gz');
  assert.throws(() => contract.validateManifest(bareGz.manifest, bareGz.trust, 'linux'), /名称无效/);

  // legacy default keeps windows behaviour when platform is omitted
  const win = fixture();
  assert.equal(contract.validateManifest(win.manifest, win.trust, 'win32'), win.manifest);
  assert.throws(() => contract.validateManifest(win.manifest, win.trust, 'darwin'), /与当前系统不匹配/);
});

test('safeInstallerPath honours the per-platform name convention', () => {
  assert.throws(() => contract.safeInstallerPath('/tmp/u', 'SoduWork-1.2.11-Setup.exe', 'linux'), /名称无效/);
  assert.match(contract.safeInstallerPath('/tmp/u', 'SoduWork-1.2.11-linux-x64.tar.gz', 'linux'), /tar\.gz$/);
  assert.throws(() => contract.safeInstallerPath('/tmp/u', '../../evil.tar.gz', 'linux'), /名称无效/);
});

test('SoduWork prefix (1.12.69 rename) is accepted alongside legacy SoduWork-', () => {
  // Accept current prefixes on every supported platform.
  const macNew = fixture('darwin', 'arm64', 'SoduWork-1.2.11-mac-arm64.dmg');
  assert.equal(contract.validateManifest(macNew.manifest, macNew.trust, 'darwin'), macNew.manifest);
  assert.match(contract.safeInstallerPath('/tmp/u', 'SoduWork-1.2.11-Setup.exe', 'win32'), /SoduWork-1\.2\.11-Setup\.exe$/);
  assert.match(contract.safeInstallerPath('/tmp/u', 'SoduWork-1.2.11-linux-x64.deb', 'linux'), /SoduWork-1\.2\.11-linux-x64\.deb$/);
  // Retain transitional legacy prefixes for installed-client upgrade compatibility.
  assert.match(contract.safeInstallerPath('/tmp/u', 'SoduWork-1.2.11-Setup.exe', 'win32'), /SoduWork-1\.2\.11-Setup\.exe$/);
  // Reject mixed prefixes.
  assert.throws(() => contract.safeInstallerPath('/tmp/u', 'SoduWorkworkX-1.2.11-Setup.exe', 'win32'), /名称无效/);
  assert.throws(() => contract.safeInstallerPath('/tmp/u', 'SoduWork 1.2.11-Setup.exe', 'win32'), /名称无效/);
});
