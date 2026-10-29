'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareRunner } = require('./prepare-runner.cjs');
const { macosBuildEnvironment } = require('./macos-build-environment.cjs');

function build({ root = path.resolve(__dirname, '../..'), platform = process.platform,
  env = process.env, run = execFileSync, prepare = prepareRunner, hostArch = process.arch } = {}) {
  assert.equal(platform, 'darwin', 'macOS packages require a native Mac runner');
  const architectures = env.SODUWORK_MACOS_ARCH === undefined ? ['arm64', 'x64'] : [env.SODUWORK_MACOS_ARCH];
  assert.ok(architectures.every(arch => ['arm64', 'x64'].includes(arch)), 'Invalid SODUWORK_MACOS_ARCH');
  assert.ok(hostArch !== 'x64' || !architectures.includes('arm64'), 'Intel Mac cannot execute ARM build tools; select SODUWORK_MACOS_ARCH=x64');
  const toolchain = macosBuildEnvironment({ env, run, hostArch });
  try {
    return buildTargets({ root, platform, env: toolchain.env, run, prepare, architectures, hostArch });
  } finally {
    toolchain.cleanup();
  }
}
function buildTargets({ root, platform, env, run, prepare, architectures, hostArch }) {
  const client = path.join(root, 'client');
  const targets = architectures.map(arch => ({ arch,
    python: env['SODUWORK_MACOS_' + arch.toUpperCase() + '_PYTHON'] ||
      (arch === hostArch ? path.join(root, 'hub-backend/.venv/bin/python') : '') }));
  // Validate all selected interpreters before spending time on a package.
  for (const { arch, python } of targets) {
    assert.ok(python, 'Configure SODUWORK_MACOS_' + arch.toUpperCase() + '_PYTHON');
    // Verify the target Python can invoke real lipo before expensive packaging; preserve underlying diagnostics.
    const actual = run(python, ['-c', 'import platform, subprocess, sys\n' +
      'probe = subprocess.run(["lipo", "-archs", sys.executable], capture_output=True, text=True)\n' +
      'if probe.returncode: sys.exit(probe.stderr or probe.stdout)\n' +
      'print(platform.machine())'], { env, encoding: 'utf8' }).trim();
    assert.equal(actual, arch === 'x64' ? 'x86_64' : 'arm64', 'Build Python architecture differs from ' + arch);
  }
  for (const { arch, python } of targets) {
    const runner = prepare({ root, platform, python, env });
    const architectures = run('lipo', ['-archs', runner], { env, encoding: 'utf8' }).trim().split(/\s+/);
    assert.ok(architectures.includes(arch === 'x64' ? 'x86_64' : 'arm64'), 'Bundled Runner architecture differs from ' + arch);
    run(python, [path.join(root, 'tools/ci/verify-runner-skills.py'), runner], { env, cwd: root, stdio: 'inherit' });
    // Finish each package before replacing the shared Runner with the next architecture.
    run(process.execPath, [path.join(client, 'node_modules/electron-builder/cli.js'), '--mac', '--' + arch, '--publish', 'never',
      '--config.mac.identity=-'], { env, cwd: client, stdio: 'inherit' });
  }
}
module.exports = { build };
if (require.main === module) {
  try { build(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
