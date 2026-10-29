'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

function acceptanceTiming(entry, { platform = process.platform, hostArch = process.arch,
  inspect = spawnSync } = {}) {
  let translated = false;
  if (platform === 'darwin' && hostArch === 'arm64') {
    const result = inspect('/usr/bin/lipo', ['-archs', entry], { encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'Cannot inspect installed Mac architecture');
    const architectures = String(result.stdout || '').trim().split(/\s+/);
    assert.ok(architectures.every(arch => ['arm64', 'arm64e', 'x86_64'].includes(arch)),
      'Unexpected installed Mac architecture');
    translated = architectures.includes('x86_64') && !architectures.some(arch => arch.startsWith('arm64'));
  }
  // CPU translation can substantially increase page-inspection and clean-exit times.
  // Extend budgets only for verified Intel-only Mach-O applications; keep every success condition.
  return translated
    ? { translated, totalMs: 240000, discoveryMs: 90000, commandMs: 30000, rendererMs: 60000, exitMs: 30000 }
    : { translated, totalMs: 90000, discoveryMs: 60000, commandMs: 10000, rendererMs: 30000, exitMs: 10000 };
}

module.exports = { acceptanceTiming };
