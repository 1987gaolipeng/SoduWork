'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../scripts/build-macos.cjs');
const { notarizeArtifact, notarizeApp } = require('../scripts/notarize-macos.cjs');
const isEntry = (args, suffix) => String(args[0] || '').replaceAll('\\', '/').endsWith(suffix);
function fixture(options = {}) {
  const calls = [], env = { SODUWORK_MACOS_ARM64_PYTHON: '/python/arm64', SODUWORK_MACOS_X64_PYTHON: '/python/x64' };
  let current;
  return { calls, config: { root: '/fixture', platform: 'darwin', hostArch: 'arm64', env,
    prepare({ python }) { current = python; calls.push(['prepare', python]); return '/fixture/runner'; },
    run(file, args) {
      if (file === '/usr/bin/arch') return '/Apple Tools/bin/' + args.at(-1);
      if (args[0] === '-c') return file.endsWith('x64') ? (options.wrongPython || 'x86_64') : 'arm64';
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

test('multiple distributions share one verified Runner for each architecture', () => {
  const f = fixture(); f.config.env.SODUWORK_MACOS_ARCH = 'x64';
  f.config.distributions = ['stage', 'internal', 'cn', 'global'];
  const profiles = [], prepared = [];
  const run = f.config.run;
  f.config.run = (file, args, options) => {
    if (isEntry(args, 'electron-builder/cli.js')) profiles.push(options.env.SODUWORK_DISTRIBUTION);
    return run(file, args, options);
  };
  f.config.beforePackages = () => prepared.push('common');
  build(f.config);
  assert.deepEqual(prepared, ['common']);
  assert.equal(f.calls.filter(row => row[0] === 'prepare').length, 1);
  assert.deepEqual(profiles, f.config.distributions);
});

test('a checkpoint Runner packages only remaining environments without probing Python and still enforces architecture', () => {
  const f = fixture(); f.config.env = { SODUWORK_MACOS_ARCH: 'x64' };
  f.config.preparedRunner = '/original/soduwork-runner'; f.config.distributions = ['global'];
  const run = f.config.run; let packaged = 0;
  f.config.prepare = () => assert.fail('must preserve original Runner');
  f.config.run = (file, args, options) => {
    if (file === 'lipo') { assert.equal(args[1], f.config.preparedRunner); return 'x86_64'; }
    assert.notEqual(args[0], '-c', 'No Python is required after restoring verified preparation');
    if (isEntry(args, 'electron-builder/cli.js')) {
      assert.equal(options.env.SODUWORK_DISTRIBUTION, 'global'); packaged++;
    }
    return run(file, args, options);
  };
  build(f.config); assert.equal(packaged, 1);
  const inspect = f.config.run;
  f.config.run = (file, args, options) => file === 'lipo' ? 'arm64' : inspect(file, args, options);
  assert.throws(() => build(f.config), /Runner architecture differs/);
  assert.equal(packaged, 1);
});

const IDENTITY = 'Developer ID Application: Test (TEAMID)';
function signingFixture() {
  const f = fixture();
  f.config.env.SODUWORK_MAC_SIGN_IDENTITY = IDENTITY;
  f.config.env.HOME = '/Users/test';
  f.config.env.SODUWORK_MACOS_ARCH = 'arm64';
  delete f.config.env.SODUWORK_MACOS_X64_PYTHON;
  f.config.root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'soduwork-signing-'));
  fs.mkdirSync(path.join(f.config.root, 'client/dist/internal'), { recursive: true });
  fs.writeFileSync(path.join(f.config.root, 'client/package.json'), JSON.stringify({ version: '9.9.9' }));
  fs.writeFileSync(path.join(f.config.root, 'client/dist/internal/SoduWork-9.9.9-mac-arm64.dmg'), 'dmg');
  const run = f.config.run;
  f.config.run = (file, args, options) => {
    if (file === 'security') {
      f.calls.push([file, ...args]);
      return ' 1) ABCDEF1234 "' + IDENTITY + '"\n 1 valid identity found';
    }
    if (file === 'xcrun') { f.calls.push(['xcrun', ...args]); return ''; }
    return run(file, args, options);
  };
  return f;
}
test('Developer ID signing forwards the identity, hardened runtime and notarization hooks', () => {
  const f = signingFixture();
  build(f.config);
  const identityCheck = f.calls.find(row => row[0] === 'security');
  assert.deepEqual(identityCheck.slice(1), ['find-identity', '-v', '-p', 'codesigning',
    path.join(f.config.env.HOME, 'Library/Keychains/login.keychain-db')]);
  const builder = f.calls.find(row => isEntry(row.slice(1), 'electron-builder/cli.js'));
  assert.ok(builder, 'electron-builder must run once');
  assert.ok(builder.includes('--config.mac.identity=' + IDENTITY));
  assert.ok(builder.includes('--config.mac.hardenedRuntime=true'));
  assert.ok(builder.includes('--config.afterSign=scripts/notarize-macos.cjs'));
  assert.ok(builder.includes('--config.mac.identity=-') === false);
  const submit = f.calls.find(row => row[0] === 'xcrun' && row[1] === 'notarytool');
  assert.deepEqual(submit.slice(1), ['notarytool', 'submit',
    path.join(f.config.root, 'client/dist/internal/SoduWork-9.9.9-mac-arm64.dmg'), '--keychain-profile', 'SODUWORK_NOTARY', '--wait']);
  assert.deepEqual(f.calls.find(row => row[0] === 'xcrun' && row[1] === 'stapler').slice(1),
    ['stapler', 'staple', path.join(f.config.root, 'client/dist/internal/SoduWork-9.9.9-mac-arm64.dmg')]);
  fs.rmSync(f.config.root, { recursive: true, force: true });
});
test('SODUWORK_MAC_SKIP_NOTARIZE keeps a signed but unnotarized build', () => {
  const f = signingFixture();
  f.config.env.SODUWORK_MAC_SKIP_NOTARIZE = '1';
  build(f.config);
  assert.ok(f.calls.some(row => isEntry(row.slice(1), 'electron-builder/cli.js')));
  assert.deepEqual(f.calls.filter(row => row[0] === 'xcrun'), []);
  const builder = f.calls.find(row => isEntry(row.slice(1), 'electron-builder/cli.js'));
  assert.ok(builder.includes('--config.afterSign=scripts/notarize-macos.cjs') === false);
  fs.rmSync(f.config.root, { recursive: true, force: true });
});
test('a DMG wait failure resumes the exact container without repeating electron-builder or upload', t => {
  const f = signingFixture(); t.after(() => fs.rmSync(f.config.root, { recursive: true, force: true }));
  Object.assign(f.config.env, { SODUWORK_MAC_NOTARY_STATE_DIR: path.join(f.config.root, 'notary'),
    SODUWORK_MAC_BUILD_INPUT_ID: 'a'.repeat(64) });
  const run = f.config.run, uuid = '12345678-1234-1234-1234-123456789abc'; let wait = true, uploads = 0;
  f.config.run = (file, args, options) => {
    if (file === 'xcrun' && args[0] === 'notarytool') {
      if (args[1] === 'submit') uploads++;
      if (args[1] === 'wait' && wait) { wait = false; throw Object.assign(Error('injected timeout'), { code: 'ETIMEDOUT' }); }
      return JSON.stringify({ id: uuid, status: 'Accepted' });
    }
    return run(file, args, options);
  };
  assert.throws(() => build(f.config), /Notarization wait failed/);
  const dmg = path.join(f.config.root, 'client/dist/internal/SoduWork-9.9.9-mac-arm64.dmg');
  fs.writeFileSync(dmg, 'unrelated retry container'); build(f.config);
  assert.equal(fs.readFileSync(dmg, 'utf8'), 'dmg');
  assert.equal(f.calls.filter(row => isEntry(row.slice(1), 'electron-builder/cli.js')).length, 1);
  assert.equal(uploads, 1);
  const parent = path.join(f.config.env.SODUWORK_MAC_NOTARY_STATE_DIR, 'dmgs');
  fs.appendFileSync(path.join(parent, fs.readdirSync(parent)[0], path.basename(dmg)), 'tampered');
  assert.throws(() => build(f.config), /Original DMG checkpoint changed/);
});
test('App wait recovery uses verified prepackaged bytes without repeating App assembly or signing', t => {
  for (const arch of ['arm64', 'x64']) {
    const f = signingFixture(); t.after(() => fs.rmSync(f.config.root, {recursive: true, force: true}));
    Object.assign(f.config.env, {SODUWORK_MAC_NOTARY_STATE_DIR: path.join(f.config.root, 'notary'),
      SODUWORK_MAC_BUILD_INPUT_ID: 'b'.repeat(64), SODUWORK_MACOS_ARCH: arch,
      SODUWORK_MACOS_X64_PYTHON: '/python/x64'});
    const run = f.config.run, uuid = '12345678-1234-1234-1234-123456789abc';
    let interrupted = false, assemblies = 0, appUploads = 0, containers = 0;
    const dmg = path.join(f.config.root, 'client/dist/internal/SoduWork-9.9.9-mac-' + arch + '.dmg');
    f.config.run = (file, args, options) => {
      if (file === 'ditto') { fs.writeFileSync(args.at(-1), 'original signed zip'); return ''; }
      if (file === 'xcrun' && args[0] === 'notarytool') {
        if (args[1] === 'submit' && args[2].endsWith('.zip')) appUploads++;
        if (args[1] === 'wait' && !interrupted) { interrupted = true; throw Error('App wait interrupted'); }
        return JSON.stringify({id: uuid, status: 'Accepted'});
      }
      if (isEntry(args, 'electron-builder/cli.js')) {
        if (!args.includes('--prepackaged')) {
          assemblies++;
          const app = path.join(f.config.root, 'assembled/SoduWork.app'); fs.mkdirSync(app, {recursive: true});
          fs.writeFileSync(path.join(app, 'binary'), 'original signed bytes');
          notarizeApp({appPath: app, env: options.env, run: f.config.run});
        } else {
          const app = args[args.indexOf('--prepackaged') + 1];
          assert.equal(fs.readFileSync(path.join(app, 'binary'), 'utf8'), 'original signed bytes');
        }
        containers++; fs.writeFileSync(dmg, 'container from original App');
      }
      return run(file, args, options);
    };
    assert.throws(() => build(f.config), /Notarization wait failed/);
    fs.rmSync(path.join(f.config.root, 'client/dist'), {recursive: true});
    build(f.config);
    assert.equal(assemblies, 1); assert.equal(appUploads, 1); assert.equal(containers, 1);
    assert.equal(fs.readFileSync(dmg, 'utf8'), 'container from original App');
    const builder = f.calls.find(row => row.includes('--prepackaged'));
    assert.ok(builder.includes('--' + arch));
    assert.ok(f.calls.some(row => row[0] === 'xcrun' && row[1] === 'stapler' && row[2] === 'validate'));
  }
});
test('SODUWORK_MAC_SKIP_NOTARIZE=0 keeps notarization enabled', () => {
  const f = signingFixture();
  f.config.env.SODUWORK_MAC_SKIP_NOTARIZE = '0';
  build(f.config);
  assert.ok(f.calls.some(row => row[0] === 'xcrun' && row[1] === 'notarytool'));
  const builder = f.calls.find(row => isEntry(row.slice(1), 'electron-builder/cli.js'));
  assert.ok(builder.includes('--config.afterSign=scripts/notarize-macos.cjs'));
  fs.rmSync(f.config.root, { recursive: true, force: true });
});
test('notarization can use a separate keychain profile', () => {
  const calls = [];
  notarizeArtifact({
    artifactPath: '/tmp/SoduWork.app.zip',
    env: { SODUWORK_MAC_NOTARY_KEYCHAIN: '/Users/test/Library/Keychains/keychain-2.db' },
    run: (file, args) => calls.push([file, ...args]),
  });
  assert.deepEqual(calls, [
    ['xcrun', 'notarytool', 'submit', '/tmp/SoduWork.app.zip', '--keychain-profile', 'SODUWORK_NOTARY', '--keychain', '/Users/test/Library/Keychains/keychain-2.db', '--wait'],
    ['xcrun', 'stapler', 'staple', '/tmp/SoduWork.app.zip'],
  ]);
});
test('notarization can resolve an iCloud keychain profile through the search list', () => {
  const calls = [];
  notarizeArtifact({
    artifactPath: '/tmp/SoduWork.app.zip',
    env: {
      SODUWORK_MAC_NOTARY_KEYCHAIN: '/Users/test/Library/Keychains/keychain-2.db',
      SODUWORK_MAC_NOTARY_KEYCHAIN_SEARCH: '1',
    },
    run: (file, args) => calls.push([file, ...args]),
  });
  assert.deepEqual(calls[0], [
    'xcrun', 'notarytool', 'submit', '/tmp/SoduWork.app.zip', '--keychain-profile', 'SODUWORK_NOTARY', '--wait',
  ]);
});
test('app notarization staples the app after submitting its zip', () => {
  const calls = [];
  notarizeApp({
    appPath: '/tmp/SoduWork.app',
    env: { SODUWORK_MAC_NOTARY_KEYCHAIN_SEARCH: '1' },
    run: (file, args) => calls.push([file, ...args]),
  });
  assert.deepEqual(calls, [
    ['ditto', '-c', '-k', '--keepParent', '/tmp/SoduWork.app', '/tmp/SoduWork.app.notarize.zip'],
    ['xcrun', 'notarytool', 'submit', '/tmp/SoduWork.app.notarize.zip', '--keychain-profile', 'SODUWORK_NOTARY', '--wait'],
    ['xcrun', 'stapler', 'staple', '/tmp/SoduWork.app'],
  ]);
});
test('app and DMG notarization refresh keychain access immediately before each submission', () => {
  const calls = [];
  const env = { HOME: '/Users/test', SODUWORK_MAC_KEYCHAIN_PASSWORD: 'fixture-only-password',
    SODUWORK_MAC_KEYCHAIN: '/Users/test/Library/Keychains/login.keychain-db',
    SODUWORK_MAC_NOTARY_KEYCHAIN: '/Users/test/Library/Keychains/keychain-2.db',
    SODUWORK_MAC_NOTARY_KEYCHAIN_SEARCH: '1' };
  let unlocked = false;
  const run = (file, args, options) => {
    calls.push([file, ...args]);
    if (file === 'security') {
      assert.deepEqual(args, ['unlock-keychain', '-p', env.SODUWORK_MAC_KEYCHAIN_PASSWORD,
        '/Users/test/Library/Keychains/login.keychain-db']);
      assert.equal(options.stdio, 'pipe');
      assert.equal(options.timeout, 30000);
      unlocked = true;
    }
    if (file === 'xcrun' && args[0] === 'notarytool') {
      assert.ok(unlocked, 'submission requires fresh access after a long signing/compression step');
      assert.equal(args.includes('--keychain'), false, 'iCloud profile still uses the search list');
      unlocked = false;
    }
  };
  notarizeApp({ appPath: '/tmp/SoduWork.app', env, run });
  notarizeArtifact({ artifactPath: '/tmp/SoduWork.dmg', env, run });
  assert.equal(calls.filter(row => row[0] === 'security').length, 2);
  assert.equal(calls.filter(row => row[0] === 'xcrun' && row[1] === 'stapler').length, 2);
  assert.equal(calls[0][0], 'ditto', 'unlock occurs after compression');
});
test('notarization resolves an unconfigured signing keychain from the supplied home', () => {
  const calls = [];
  const env = { HOME: '/Users/test', SODUWORK_MAC_KEYCHAIN_PASSWORD: 'fixture-only-password' };
  notarizeArtifact({ artifactPath: '/tmp/SoduWork.dmg', env,
    run: (file, args) => calls.push([file, ...args]) });
  assert.deepEqual(calls[0], ['security', 'unlock-keychain', '-p', env.SODUWORK_MAC_KEYCHAIN_PASSWORD,
    path.join(env.HOME, 'Library/Keychains/login.keychain-db')]);
});
test('keychain unlock failure blocks submission and does not expose command credentials', () => {
  const env = { SODUWORK_MAC_KEYCHAIN: '/custom/signing.keychain-db',
    SODUWORK_MAC_KEYCHAIN_PASSWORD: 'fixture-only-secret' };
  const calls = [];
  assert.throws(() => notarizeArtifact({ artifactPath: '/tmp/SoduWork.dmg', env,
    run(file, args) {
      calls.push([file, ...args]);
      throw new Error('Command failed: security ' + args.join(' '));
    } }), error => {
    assert.match(error.message, /Unable to unlock the signing keychain/);
    assert.equal(error.stack.includes(env.SODUWORK_MAC_KEYCHAIN_PASSWORD), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(calls, [['security', 'unlock-keychain', '-p',
    env.SODUWORK_MAC_KEYCHAIN_PASSWORD, env.SODUWORK_MAC_KEYCHAIN]]);
});
test('a missing Developer ID keychain identity stops packaging before building', () => {
  const f = signingFixture();
  f.config.run = (file, args) => {
    if (file === 'security') return ' 1) ABCDEF1234 "Apple Development: someone (OTHER)"';
    if (file === 'xcrun') { f.calls.push(['xcrun', ...args]); return ''; }
    if (file === '/usr/bin/arch') return '/Apple Tools/bin/' + args.at(-1);
    if (args[0] === '-c') return 'arm64';
    if (file === 'lipo') return 'arm64';
    f.calls.push([file, ...args]); return '';
  };
  assert.throws(() => build(f.config), /Developer ID identity is missing/);
  assert.equal(f.calls.filter(row => row[0] === 'xcrun').length, 0);
  fs.rmSync(f.config.root, { recursive: true, force: true });
});
