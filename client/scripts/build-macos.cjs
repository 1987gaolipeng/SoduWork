'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareRunner } = require('./prepare-runner.cjs');
const { macosBuildEnvironment } = require('./macos-build-environment.cjs');
const { notarizeArtifact, notarizeEnabled, signingIdentity, restoreNotarizedApp } = require('./notarize-macos.cjs');
const { candidateVersion } = require('./client-build-version.cjs');

function signingKeychain(env = process.env) {
  return env.SODUWORK_MAC_KEYCHAIN || (env.HOME ? path.join(env.HOME, 'Library/Keychains/login.keychain-db') : '');
}

function build({ root = path.resolve(__dirname, '../..'), platform = process.platform,
  env = process.env, run = execFileSync, prepare = prepareRunner, hostArch = process.arch,
  distributions, preparedRunner, beforePackages = () => {}, beforePackage = () => {}, afterPackage = () => {} } = {}) {
  assert.equal(platform, 'darwin', 'macOS packages require a native Mac runner');
  env = require('../../tools/ci/build-environment.cjs').buildEnvironment(env);
  const architectures = env.SODUWORK_MACOS_ARCH === undefined ? ['arm64', 'x64'] : [env.SODUWORK_MACOS_ARCH];
  assert.ok(architectures.every(arch => ['arm64', 'x64'].includes(arch)), 'Invalid SODUWORK_MACOS_ARCH');
  assert.ok(hostArch !== 'x64' || !architectures.includes('arm64'), 'Intel Mac cannot execute ARM build tools; select SODUWORK_MACOS_ARCH=x64');
  const toolchain = macosBuildEnvironment({ env, run, hostArch });
  try {
    return buildTargets({ root, platform, env: toolchain.env, run, prepare, architectures, hostArch,
      distributions, preparedRunner, beforePackages, beforePackage, afterPackage });
  } finally {
    toolchain.cleanup();
  }
}
function buildTargets({ root, platform, env, run, prepare, architectures, hostArch,
  distributions, preparedRunner, beforePackages, beforePackage, afterPackage }) {
  const client = path.join(root, 'client');
  const targets = architectures.map(arch => ({ arch,
    python: env['SODUWORK_MACOS_' + arch.toUpperCase() + '_PYTHON'] ||
      (arch === hostArch ? path.join(root, 'hub-backend/.venv/bin/python') : '') }));
  // Validate all selected interpreters before spending time on a package.
  assert.ok(!preparedRunner || targets.length === 1, 'A prepared Runner belongs to one architecture');
  for (const { arch, python } of preparedRunner ? [] : targets) {
    assert.ok(python, 'Configure SODUWORK_MACOS_' + arch.toUpperCase() + '_PYTHON');
    // Verify the target Python can invoke real lipo before expensive packaging; preserve underlying diagnostics.
    const actual = run(python, ['-c', 'import platform, subprocess, sys\n' +
      'probe = subprocess.run(["lipo", "-archs", sys.executable], capture_output=True, text=True)\n' +
      'if probe.returncode: sys.exit(probe.stderr or probe.stdout)\n' +
      'print(platform.machine())'], { env, encoding: 'utf8' }).trim();
    assert.equal(actual, arch === 'x64' ? 'x86_64' : 'arm64', 'Build Python architecture differs from ' + arch);
  }
  // Real Developer ID signing stays opt-in so GitLab CI keeps its ad-hoc contract.
  const identity = signingIdentity(env);
  if (identity) {
    const keychain = signingKeychain(env);
    const args = ['find-identity', '-v', '-p', 'codesigning'];
    if (keychain) args.push(keychain);
    const listed = run('security', args, { env, encoding: 'utf8' });
    assert.ok(listed.includes(identity), 'Developer ID identity is missing from the keychain: ' + identity);
  }
  for (const { arch, python } of targets) {
    const runner = preparedRunner || prepare({ root, platform, python, env });
    const architectures = run('lipo', ['-archs', runner], { env, encoding: 'utf8' }).trim().split(/\s+/);
    assert.ok(architectures.includes(arch === 'x64' ? 'x86_64' : 'arm64'), 'Bundled Runner architecture differs from ' + arch);
    if (!preparedRunner) run(python, [path.join(root, 'tools/ci/verify-runner-skills.py'), runner], { env, cwd: root, stdio: 'inherit' });
    // Finish each package before replacing the shared Runner with the next architecture.
    beforePackages({ arch, env });
    for (const id of distributions || [env.SODUWORK_DISTRIBUTION || 'internal']) {
      const profileEnv = { ...env, SODUWORK_DISTRIBUTION: id };
      beforePackage();
      const signed = identity && notarizeEnabled(env);
      const dmgPath = signed ? path.join(client, 'dist', id, `SoduWork-${candidateVersion(env, root)}-mac-${arch}.dmg`) : '';
      const checkpoint = signed ? require('./macos-notary-dmg.cjs').checkpoint(dmgPath, profileEnv) : null;
      const restored = checkpoint?.restore();
      // Resume the immutable signed App before invoking electron-builder, so a
      // notary wait interruption does not repeat application assembly/signing.
      const appPath = path.join(client, 'dist', id, 'restored-app-' + arch,
        require('../../tools/ci/client-distribution.cjs').profile(profileEnv).productName + '.app');
      const restoredApp = !restored && signed && restoreNotarizedApp({ appPath, env: profileEnv, run });
      if (!restored) run(process.execPath, [path.join(client, 'node_modules/electron-builder/cli.js'), '--config', 'scripts/distribution-builder.cjs', '--mac', '--' + arch, '--publish', 'never',
        '--config.mac.identity=' + (identity || '-'),
        ...(identity && notarizeEnabled(env) ? ['--config.mac.hardenedRuntime=true', '--config.afterSign=scripts/notarize-macos.cjs'] : []),
        ...(restoredApp ? ['--prepackaged', appPath] : []),
        ...(distributions ? ['--config.npmRebuild=false'] : [])], { env: profileEnv, cwd: client, stdio: 'inherit' });
      if (signed) {
        // The app inside is already notarized and stapled by the afterSign hook;
        // notarizing the DMG as well lets the quarantined disk image mount offline.
        assert.ok(fs.existsSync(dmgPath), 'electron-builder did not produce ' + path.relative(root, dmgPath));
        if (checkpoint && !restored) checkpoint.save();
        notarizeArtifact({ artifactPath: dmgPath, env: profileEnv, run });
      }
      afterPackage(profileEnv, arch);
    }
  }
}
module.exports = { build };
if (require.main === module) {
  try { build(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
