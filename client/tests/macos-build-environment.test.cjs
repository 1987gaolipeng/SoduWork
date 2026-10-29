'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { macosBuildEnvironment } = require('../scripts/macos-build-environment.cjs');

test('only the two Apple binary tools override PATH, preserving compiler and SDK lookup', t => {
  const env = Object.freeze({ PATH: '/custom/bin:/usr/bin', DEVELOPER_DIR: '/Applications/Xcode Beta.app', MARKER: 'keep' });
  const calls = [];
  const result = macosBuildEnvironment({ env, hostArch: 'arm64', run(file, args, options) {
    calls.push(args.at(-1));
    assert.equal(file, '/usr/bin/arch');
    assert.deepEqual(args.slice(0, 3), ['-arm64', '/usr/bin/xcrun', '--find']);
    assert.equal(options.env, env);
    return '/Applications/Xcode Beta.app/' + (args.at(-1) === 'lipo' ? 'Toolchain/bin/lipo' : 'Tools/bin/install_name_tool') + '\n';
  } });
  t.after(result.cleanup);
  assert.deepEqual(calls, ['lipo', 'install_name_tool']);
  // Preserve the original macOS PATH contract without splitting host Windows drive letters.
  const suffix = ':' + env.PATH;
  assert.ok(result.env.PATH.endsWith(suffix));
  const directory = result.env.PATH.slice(0, -suffix.length);
  assert.ok(path.isAbsolute(directory));
  assert.deepEqual(fs.readdirSync(directory).sort(), ['install_name_tool', 'lipo']);
  // Compare readlink targets using host path rules, including Windows drive prefixes.
  assert.equal(fs.readlinkSync(path.join(directory, 'lipo')), path.resolve('/Applications/Xcode Beta.app/Toolchain/bin/lipo'));
  assert.equal(fs.readlinkSync(path.join(directory, 'install_name_tool')), path.resolve('/Applications/Xcode Beta.app/Tools/bin/install_name_tool'));
  assert.equal(result.env.DEVELOPER_DIR, env.DEVELOPER_DIR);
  assert.equal(result.env.MARKER, 'keep');
  assert.equal(env.PATH, '/custom/bin:/usr/bin');
});
test('Intel tool lookup uses native x86_64 xcrun', t => {
  const result = macosBuildEnvironment({ hostArch: 'x64', run(file, args) {
    assert.equal(file, '/usr/bin/arch');
    assert.deepEqual(args.slice(0, 3), ['-x86_64', '/usr/bin/xcrun', '--find']);
    return '/Developer/usr/bin/' + args.at(-1);
  } });
  t.after(result.cleanup);
  assert.ok(result.env.PATH.endsWith(':' + process.env.PATH));
});
test('temporary links are removable without touching Apple tools and cleanup is idempotent', t => {
  const result = macosBuildEnvironment({ env: {}, run: (_file, args) => '/Developer/usr/bin/' + args.at(-1) });
  t.after(result.cleanup);
  assert.equal(fs.readlinkSync(path.join(result.env.PATH, 'lipo')), path.resolve('/Developer/usr/bin/lipo'));
  result.cleanup(); result.cleanup();
  assert.ok(!fs.existsSync(result.env.PATH));
});
test('missing or invalid Apple tools fail rather than falling back to the broken system shim', () => {
  assert.throws(() => macosBuildEnvironment({ run() { throw Error('developer tools unavailable'); } }), /unavailable/);
  for (const result of ['', 'lipo', '/Developer/bin/wrong-tool']) {
    assert.throws(() => macosBuildEnvironment({ run: () => result }), /invalid path/);
  }
});
