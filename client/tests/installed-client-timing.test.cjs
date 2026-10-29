'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { acceptanceTiming } = require('../../tools/ci/installed-client-timing.cjs');

test('only Intel-only Mac apps on Apple Silicon receive bounded translation budgets', () => {
  const entry = '/test app/SoduWork';
  const timing = acceptanceTiming(entry, { platform: 'darwin', hostArch: 'arm64', inspect(file, args) {
    assert.equal(file, '/usr/bin/lipo'); assert.deepEqual(args, ['-archs', entry]);
    return { status: 0, stdout: 'x86_64\n' };
  } });
  assert.deepEqual(timing, { translated: true, totalMs: 240000, discoveryMs: 90000,
    commandMs: 30000, rendererMs: 60000, exitMs: 30000 });
  assert.ok(timing.commandMs < timing.rendererMs && timing.rendererMs < timing.totalMs);
});

test('native and universal Mac apps retain the original time limits', () => {
  for (const architectures of ['arm64', 'arm64e', 'x86_64 arm64', 'x86_64 arm64e']) {
    const timing = acceptanceTiming('/test/app', { platform: 'darwin', hostArch: 'arm64',
      inspect: () => ({ status: 0, stdout: architectures }) });
    assert.deepEqual(timing, { translated: false, totalMs: 90000, discoveryMs: 60000,
      commandMs: 10000, rendererMs: 30000, exitMs: 10000 });
  }
});

test('Windows, Linux and Intel Macs neither invoke lipo nor use translation limits', () => {
  for (const [platform, hostArch] of [['win32', 'arm64'], ['linux', 'x64'], ['darwin', 'x64']]) {
    const timing = acceptanceTiming('/test/app', { platform, hostArch,
      inspect() { throw Error('Unexpected Mac inspection'); } });
    assert.equal(timing.translated, false); assert.equal(timing.totalMs, 90000);
  }
});

test('failed or unknown binary inspection cannot silently extend the acceptance budget', () => {
  for (const result of [{ status: 1 }, { status: 0, stdout: '' }, { status: 0, stdout: 'mips' },
    { status: null, error: Error('lipo failed') }]) {
    assert.throws(() => acceptanceTiming('/test/app', { platform: 'darwin', hostArch: 'arm64', inspect: () => result }));
  }
});
