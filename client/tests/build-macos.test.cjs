'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../scripts/build-macos.cjs');
function fixture(options = {}) {
  const calls = [], env = { SODUWORK_MACOS_ARM64_PYTHON: '/python/arm64', SODUWORK_MACOS_X64_PYTHON: '/python/x64', ...(options.env || {}) };
  let current;
  return { calls, config: { root: '/fixture', platform: 'darwin', hostArch: 'arm64', env,
    prepare({ python }) { current = python; calls.push(['prepare', python]); return '/fixture/runner'; },
    run(file, args) {
      if (file === '/usr/bin/arch') return '/Apple Tools/bin/' + args.at(-1);
      if (args[0] === '-c') return file.endsWith('x64') ? (options.wrongPython || 'x86_64') : 'arm64';
      if (file === 'security') return options.identity || '';
      if (file === 'lipo') return options.wrongRunner || (current.endsWith('x64') ? 'x86_64' : 'arm64');
      calls.push([file, ...args]); return '';
    } } };
}
test('macOS packages compile, verify and package each matching Runner in order', () => {
  const { calls, config } = fixture(); build(config);
  assert.deepEqual(calls.filter(row => row[0] === 'prepare'), [['prepare', '/python/arm64'], ['prepare', '/python/x64']]);
  assert.match(calls[1][1], /verify-runner-skills\.py$/);
  assert.ok(calls[2].includes('--arm64'));
  assert.match(calls[4][1], /verify-runner-skills\.py$/);
  assert.ok(calls[5].includes('--x64'));
  assert.ok(calls[2].includes('--config.mac.identity=-'));
  assert.deepEqual(calls[2].slice(-3, -1), ['--publish', 'never']);
});
test('Intel Mac builds only x64 and never probes or prepares ARM Python', () => {
  const f = fixture();
  f.config.hostArch = 'x64'; f.config.env.SODUWORK_MACOS_ARCH = 'x64';
  delete f.config.env.SODUWORK_MACOS_ARM64_PYTHON;
  const run = f.config.run;
  f.config.run = (file, args, options) => {
    if (file === '/usr/bin/arch') assert.equal(args[0], '-x86_64');
    assert.notEqual(file, '/python/arm64');
    return run(file, args, options);
  };
  build(f.config);
  assert.deepEqual(f.calls.filter(row => row[0] === 'prepare'), [['prepare', '/python/x64']]);
  assert.ok(f.calls.at(-1).includes('--x64'));
});
test('ARM shard builds only ARM; invalid selections fail before tool lookup', () => {
  const f = fixture(); f.config.env.SODUWORK_MACOS_ARCH = 'arm64';
  delete f.config.env.SODUWORK_MACOS_X64_PYTHON;
  build(f.config);
  assert.deepEqual(f.calls.filter(row => row[0] === 'prepare'), [['prepare', '/python/arm64']]);
  for (const arch of ['', '../x64', 'arm64,x64']) {
    const invalid = fixture(); invalid.config.env.SODUWORK_MACOS_ARCH = arch;
    invalid.config.run = () => assert.fail('must not look up tools');
    assert.throws(() => build(invalid.config), /Invalid SODUWORK_MACOS_ARCH/);
  }
  const intel = fixture(); intel.config.hostArch = 'x64';
  assert.throws(() => build(intel.config), /Intel Mac cannot execute ARM/);
});
test('toolchain failure in either Python stops packaging before either Runner is compiled', () => {
  const f = fixture(); const run = f.config.run;
  let directory;
  f.config.run = (file, args, options) => {
    if (file === '/python/x64') {
      // The fixture supplies no PATH; preserve Windows drive colons when examining its temporary directory.
      directory = options.env.PATH;
      assert.deepEqual(fs.readdirSync(directory).sort(), ['install_name_tool', 'lipo']);
      throw Error('lipo subprocess failed');
    }
    return run(file, args, options);
  };
  assert.throws(() => build(f.config), /lipo subprocess failed/);
  assert.equal(f.calls.length, 0);
  assert.ok(directory && !fs.existsSync(directory), 'failed builds clean up temporary tool links');
});
test('all packaging children inherit the resolved toolchain without changing the caller environment', () => {
  const f = fixture(); const run = f.config.run; const prepare = f.config.prepare;
  f.config.env.PATH = '/custom/bin:/usr/bin';
  let expected, directory;
  f.config.run = (file, args, options) => {
    if (file !== '/usr/bin/arch') {
      expected ??= options.env.PATH;
      assert.equal(options.env.PATH, expected);
      assert.ok(expected.endsWith(':/custom/bin:/usr/bin'));
      // Interpret the tested macOS PATH contract using known suffixes while preserving host Windows drive letters.
      directory ??= expected.slice(0, -(':' + f.config.env.PATH).length);
      assert.ok(path.isAbsolute(directory));
      assert.deepEqual(fs.readdirSync(directory).sort(), ['install_name_tool', 'lipo']);
      assert.equal(fs.readlinkSync(path.join(directory, 'lipo')), path.resolve('/Apple Tools/bin/lipo'));
    }
    return run(file, args, options);
  };
  f.config.prepare = options => { assert.equal(options.env.PATH, expected); return prepare(options); };
  build(f.config);
  assert.equal(f.config.env.PATH, '/custom/bin:/usr/bin');
  assert.ok(!fs.existsSync(directory), 'successful builds clean up temporary tool links');
});
test('wrong target Python prevents all packaging; wrong Runner prevents its package', () => {
  let f = fixture({ wrongPython: 'arm64' });
  assert.throws(() => build(f.config), /Python architecture differs/); assert.equal(f.calls.length, 0);
  f = fixture({ wrongRunner: 'x86_64' });
  assert.throws(() => build(f.config), /Runner architecture differs/); assert.equal(f.calls.length, 1);
});

test('a configured Developer ID identity is passed to every macOS package', () => {
  const f = fixture({ identity: 'Developer ID Application: SoduWork (TEAM123)', env: {
    SODUWORK_MAC_SIGN_IDENTITY: 'Developer ID Application: SoduWork (TEAM123)',
  } });
  build(f.config);
  const packageCalls = f.calls.filter(row => row[0] === process.execPath);
  assert.equal(packageCalls.length, 2);
  for (const call of packageCalls) {
    assert.ok(call.includes('--config.mac.identity=Developer ID Application: SoduWork (TEAM123)'));
    assert.ok(!call.includes('--config.mac.identity=-'));
  }
});

test('a macOS release build refuses to fall back to ad-hoc signing', () => {
  const f = fixture({ env: { SODUWORK_MAC_RELEASE: '1' } });
  assert.throws(() => build(f.config), /require SODUWORK_MAC_SIGN_IDENTITY/);
});

test('a macOS release build refuses to skip notarization', () => {
  const f = fixture({ identity: 'Developer ID Application: SoduWork (TEAM123)', env: {
    SODUWORK_MAC_RELEASE: '1',
    SODUWORK_MAC_SIGN_IDENTITY: 'Developer ID Application: SoduWork (TEAM123)',
    SODUWORK_MAC_SKIP_NOTARIZE: '1',
  } });
  assert.throws(() => build(f.config), /cannot skip notarization/);
});
