'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function macosBuildEnvironment({ env = process.env, run = execFileSync, hostArch = process.arch } = {}) {
  assert.ok(['arm64', 'x64'].includes(hostArch), 'Unsupported Mac host architecture');
  const executables = [];
  for (const tool of ['lipo', 'install_name_tool']) {
    // Run xcrun with the host architecture on Apple Silicon.
    // Avoid loading ARM-only libxcrun through a Rosetta-inherited Intel Python invocation.
    const executable = run('/usr/bin/arch', [hostArch === 'x64' ? '-x86_64' : '-arm64', '/usr/bin/xcrun', '--find', tool],
      { env, encoding: 'utf8' }).trim();
    assert.ok(path.posix.isAbsolute(executable) && path.posix.basename(executable) === tool,
      'Apple tool lookup returned an invalid path for ' + tool);
    executables.push({ tool, executable });
  }
  // Override only the required binary tools rather than prepending the entire CLT bin directory.
  // Preserve system compiler forwarding and SDK setup for Electron native-module headers.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-mac-build-tools-'));
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    for (const { tool, executable } of executables) fs.symlinkSync(executable, path.join(directory, tool));
    return { env: { ...env, PATH: [directory, env.PATH].filter(Boolean).join(':') }, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
module.exports = { macosBuildEnvironment };
