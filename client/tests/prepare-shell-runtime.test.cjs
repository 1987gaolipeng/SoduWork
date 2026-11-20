'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { RELEASE, selectRelease, prepareArchive, prepare, selfTest } = require('../scripts/prepare-shell-runtime.cjs');

const digest = content => crypto.createHash('sha256').update(content).digest('hex');
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-portable-git-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function fixtureRelease(overrides = {}) {
  return { version: 'fixture', url: 'https://official.invalid/PortableGit-fixture.7z.exe',
    file: 'PortableGit-fixture.7z.exe', sha256: digest('verified executable fixture'),
    urls: ['https://mirror.invalid/PortableGit-fixture.7z.exe', 'https://official.invalid/PortableGit-fixture.7z.exe'],
    ...overrides };
}
const quiet = () => {};
const unexpected = () => { throw Error('unexpected network or executable launch'); };

test('PortableGit architectures keep the reviewed version and official SHA-256', () => {
  assert.deepEqual(Object.keys(RELEASE).sort(), ['arm64', 'x64']);
  assert.equal(RELEASE.x64.version, '2.55.0.4');
  assert.equal(RELEASE.arm64.version, '2.55.0.4');
  assert.equal(RELEASE.x64.sha256, '016e84230a3767f0c6b3788e79ba0c58a17377086801719d46700fca4f7b36b5');
  assert.equal(RELEASE.arm64.sha256, 'd69d0c6a3c5445553565ef74f1d9e22a9869f57c246111db347dd96c252b4da5');
  for (const arch of Object.keys(RELEASE)) {
    const item = selectRelease(arch, {});
    assert.equal(item.sha256, RELEASE[arch].sha256);
    assert.match(item.file, /\.7z\.exe$/);
    assert.deepEqual(item.urls, [RELEASE[arch].url]);
  }
  assert.throws(() => selectRelease('ia32', {}), /architecture/);
});

test('a configured mirror uses the same release tag and filename before official fallback', () => {
  for (const arch of Object.keys(RELEASE)) {
    const release = selectRelease(arch, { SODUWORK_PORTABLE_GIT_MIRROR: 'https://mirror.invalid/git///' });
    assert.deepEqual(release.urls, [
      `https://mirror.invalid/git/v2.55.0.windows.4/${release.file}`, RELEASE[arch].url,
    ]);
    assert.equal(release.sha256, RELEASE[arch].sha256);
  }
});

test('mirror-only selection never silently includes the official source', () => {
  const environment = { SODUWORK_RUNTIME_MIRROR_ONLY: '1', SODUWORK_PORTABLE_GIT_MIRROR: 'https://mirror.invalid/git' };
  assert.equal(selectRelease('x64', environment).urls.length, 1);
  assert.match(selectRelease('x64', environment).urls[0], /^https:\/\/mirror\.invalid\//);
  assert.deepEqual(selectRelease('x64', { SODUWORK_RUNTIME_MIRROR_ONLY: '1' }).urls, []);
});

test('PortableGit mirrors reject HTTP, credentials, query, fragment and invalid URLs', () => {
  for (const mirror of ['http://mirror.invalid/git', 'https://user:password@mirror.invalid/git',
    'https://mirror.invalid/git?token=fixture', 'https://mirror.invalid/git#fragment', 'not a URL']) {
    assert.throws(() => selectRelease('x64', { SODUWORK_PORTABLE_GIT_MIRROR: mirror }), /HTTPS|URL/);
  }
});

test('the old basename cache remains a verified offline .exe path in mirror-only mode', async t => {
  const cache = directory(t), release = fixtureRelease({ urls: [] });
  const archive = path.join(cache, release.file); fs.writeFileSync(archive, 'verified executable fixture');
  const result = await prepareArchive(release, { cache, environment: { SODUWORK_RUNTIME_MIRROR_ONLY: '1',
    HTTPS_PROXY: 'invalid proxy that must not be consulted for a cache hit' }, download: unexpected, log: quiet });
  assert.equal(result, archive);
  assert.match(result, /\.7z\.exe$/);
  assert.equal(fs.readFileSync(result, 'utf8'), 'verified executable fixture');
});

test('a verified explicit archive works offline without creating the managed cache', async t => {
  const root = directory(t), archive = path.join(root, 'offline archive.7z.exe'), cache = path.join(root, 'unused cache');
  fs.writeFileSync(archive, 'verified executable fixture');
  const result = await prepareArchive(fixtureRelease({ urls: [] }), { cache,
    environment: { SODUWORK_PORTABLE_GIT_ARCHIVE: archive, SODUWORK_RUNTIME_MIRROR_ONLY: '1' },
    download: unexpected, log: quiet });
  assert.equal(result, archive);
  assert.equal(fs.existsSync(cache), false);
});

test('an invalid explicit archive is never deleted or replaced by a network download', async t => {
  const root = directory(t), archive = path.join(root, 'my archive.exe'); fs.writeFileSync(archive, 'user input');
  await assert.rejects(prepareArchive(fixtureRelease(), { cache: path.join(root, 'cache'),
    environment: { SODUWORK_PORTABLE_GIT_ARCHIVE: archive }, download: unexpected, log: quiet }), /SHA-256|missing/);
  assert.equal(fs.readFileSync(archive, 'utf8'), 'user input');
  const missing = path.join(root, 'does not exist.exe');
  await assert.rejects(prepareArchive(fixtureRelease(), { environment: { SODUWORK_PORTABLE_GIT_ARCHIVE: missing },
    download: unexpected, log: quiet }), /missing/);
  assert.equal(fs.existsSync(missing), false);
});

test('a corrupt basename cache is replaced only with bytes matching the pinned digest', async t => {
  const cache = directory(t), release = fixtureRelease(), archive = path.join(cache, release.file);
  fs.writeFileSync(archive, 'corrupt cache');
  const environment = { HTTPS_PROXY: 'http://proxy.invalid:8080' }, attempts = [];
  const result = await prepareArchive(release, { cache, environment, log: quiet,
    download: async (url, target, options) => {
      attempts.push(url); assert.equal(target, archive); assert.match(target, /\.exe$/);
      assert.equal(options.environment, environment); assert.equal(options.resume, true);
      assert.equal(fs.existsSync(target), false);
      fs.writeFileSync(target, 'verified executable fixture');
    } });
  assert.equal(result, archive);
  assert.deepEqual(attempts, [release.urls[0]]);
  assert.equal(digest(fs.readFileSync(archive)), release.sha256);
});

test('a failed mirror drops its partial before official fallback and persists only a source hash', async t => {
  const cache = directory(t), release = fixtureRelease(), archive = path.join(cache, release.file), messages = [], attempts = [];
  const partial = archive + '.part', marker = partial + '.source';
  const result = await prepareArchive(release, { cache, environment: {}, log: message => messages.push(message),
    download: async (url, target) => {
      attempts.push(url);
      const stored = fs.readFileSync(marker, 'utf8');
      assert.equal(stored, digest(url)); assert.match(stored, /^[a-f0-9]{64}$/);
      assert.equal(stored.includes('https'), false);
      if (url === release.urls[0]) {
        fs.writeFileSync(partial, 'untrusted mirror prefix');
        throw new Error('proxy password=fixture-secret https://user:password@mirror.invalid/?token=private');
      }
      assert.equal(fs.existsSync(partial), false, 'a failed source must not poison the next source with its prefix');
      fs.writeFileSync(target, 'verified executable fixture');
    } });
  assert.equal(result, archive);
  assert.deepEqual(attempts, release.urls);
  assert.equal(fs.existsSync(marker), false);
  assert.ok(messages.every(message => !/fixture-secret|user:password|token=private/.test(message)));
});

test('mirror checksum mismatch cannot change the trusted digest and falls back to official bytes', async t => {
  const cache = directory(t), release = fixtureRelease(), attempts = [];
  const archive = await prepareArchive(release, { cache, environment: {}, log: quiet,
    download: async (url, target) => {
      attempts.push(url);
      if (attempts.length === 2) assert.equal(fs.existsSync(target), false, 'bad mirror bytes must be discarded');
      fs.writeFileSync(target, url === release.urls[0] ? 'incorrect mirror bytes' : 'verified executable fixture');
    } });
  assert.deepEqual(attempts, release.urls);
  assert.equal(digest(fs.readFileSync(archive)), release.sha256);
});

test('failure of every checksum publishes no archive', async t => {
  const cache = directory(t), release = fixtureRelease(), archive = path.join(cache, release.file), attempts = [];
  await assert.rejects(prepareArchive(release, { cache, environment: {}, log: quiet,
    download: async (url, target) => { attempts.push(url); fs.writeFileSync(target, 'bad bytes'); } }), /SHA-256/);
  assert.deepEqual(attempts, release.urls);
  assert.equal(fs.existsSync(archive), false);
  assert.equal(fs.existsSync(archive + '.part'), false);
});

test('legacy unmarked official partials are retained for Range resume', async t => {
  const cache = directory(t), release = fixtureRelease(); release.urls = [release.url];
  const archive = path.join(cache, release.file), partial = archive + '.part'; fs.writeFileSync(partial, 'old official prefix');
  const result = await prepareArchive(release, { cache, environment: {}, log: quiet,
    download: async (url, target, options) => {
      assert.equal(url, release.url); assert.equal(options.resume, true);
      assert.equal(fs.readFileSync(partial, 'utf8'), 'old official prefix');
      fs.writeFileSync(target, 'verified executable fixture'); fs.rmSync(partial);
    } });
  assert.equal(result, archive);
});

test('unmarked partials are not resumed against a mirror', async t => {
  const cache = directory(t), release = fixtureRelease(), archive = path.join(cache, release.file);
  fs.writeFileSync(archive + '.part', 'unknown-source prefix');
  await prepareArchive(release, { cache, environment: {}, log: quiet,
    download: async (_url, target) => {
      assert.equal(fs.existsSync(target + '.part'), false);
      fs.writeFileSync(target, 'verified executable fixture');
    } });
});

test('the final failed source preserves its partial and source marker for a retry', async t => {
  const cache = directory(t), release = fixtureRelease(); release.urls = [release.url];
  const archive = path.join(cache, release.file), partial = archive + '.part', marker = partial + '.source';
  await assert.rejects(prepareArchive(release, { cache, environment: {}, log: quiet,
    download: async () => { fs.writeFileSync(partial, 'official prefix'); throw Error('connection interrupted'); } }), /download failed/);
  assert.equal(fs.readFileSync(partial, 'utf8'), 'official prefix');
  assert.equal(fs.readFileSync(marker, 'utf8'), digest(release.url));
  await prepareArchive(release, { cache, environment: {}, log: quiet,
    download: async (_url, target) => {
      assert.equal(fs.readFileSync(partial, 'utf8'), 'official prefix');
      fs.writeFileSync(target, 'verified executable fixture'); fs.rmSync(partial);
    } });
  assert.equal(fs.existsSync(marker), false);
});

test('mirror-only mode without a mirror fails before any network attempt', async t => {
  await assert.rejects(prepareArchive(fixtureRelease({ urls: [] }), { cache: directory(t),
    environment: { SODUWORK_RUNTIME_MIRROR_ONLY: '1' }, download: unexpected, log: quiet }), /SODUWORK_PORTABLE_GIT_MIRROR/);
});

test('non-Windows preparation is a no-op before release selection or archive access', async t => {
  for (const platform of ['darwin', 'linux']) {
    await prepare({ platform, root: directory(t), arch: 'unsupported', environment: {},
      archiveOf: unexpected, download: unexpected, run: unexpected, test: unexpected, log: quiet });
  }
});

function existingManifest(root, arch = 'x64') {
  const runtime = path.join(root, '.runtime', 'git'); fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, '.soduwork-shell-runtime.json'), JSON.stringify({
    version: RELEASE[arch].version, arch, sha256: RELEASE[arch].sha256, prune: 1,
  }));
  return runtime;
}

test('a ready manifest still runs the real-runtime probe before skipping archive preparation', async t => {
  const root = directory(t), runtime = existingManifest(root), probes = [];
  const environment = { TMPDIR: path.join(root, 'cache', 'tmp') };
  await prepare({ root, platform: 'win32', arch: 'x64', environment, archiveOf: unexpected,
    download: unexpected, run: unexpected, test: (location, env) => {
      assert.equal(env, environment); probes.push(location);
    }, log: quiet });
  assert.deepEqual(probes, [runtime]);
});

test('shell self-test retains only the selected temporary directories and required OS settings', t => {
  const root = directory(t), temporary = path.join(root, 'cache', 'tmp');
  fs.mkdirSync(path.join(root, 'bin')); fs.writeFileSync(path.join(root, 'bin', 'bash.exe'), 'fixture');
  fs.mkdirSync(temporary, { recursive: true });
  const environment = { TMPDIR: temporary, TEMP: temporary, TMP: temporary,
    SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'untrusted tools', PRIVATE_FIXTURE: 'not inherited' };
  const before = { ...process.env };
  let called = false;
  selfTest(root, environment, (command, args, options) => {
    called = true;
    assert.equal(command, path.join(root, 'bin', 'bash.exe'));
    assert.deepEqual(options.env, { SystemRoot: environment.SystemRoot, WINDIR: environment.WINDIR,
      PATH: path.join(environment.SystemRoot, 'System32'), CHERE_INVOKING: '1', MSYS_NO_PATHCONV: '1',
      TMPDIR: temporary, TEMP: temporary, TMP: temporary });
    return { status: 0, stdout: 'SODUWORK_SHELL_OK\n' };
  });
  assert.equal(called, true);
  assert.equal(JSON.stringify({ ...process.env }) === JSON.stringify(before), true,
    'The parent environment must remain unchanged');
});

test('native Windows shell self-test creates its actual Git probe in the selected temporary directory',
  { skip: process.platform !== 'win32' }, t => {
    const root = path.resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim(), '../../..');
    const temporary = path.join(directory(t), 'cache', 'tmp with spaces');
    fs.mkdirSync(temporary, { recursive: true });
    const environment = { ...process.env, TMPDIR: temporary, TEMP: temporary, TMP: temporary };
    let observed;
    selfTest(root, environment, (command, args, options) => {
      const script = args[1].replace('cd "$work";',
        'printf "SODUWORK_SHELL_TEMP=%s\\n" "$(cygpath -aw "$work")"; cd "$work";');
      const result = spawnSync(command, [args[0], script], options);
      const marker = String(result.stdout).split(/\r?\n/).find(line => line.startsWith('SODUWORK_SHELL_TEMP='));
      observed = marker?.slice('SODUWORK_SHELL_TEMP='.length);
      return result;
    });
    assert.ok(observed, 'The actual mktemp directory must be observed');
    assert.equal(path.dirname(observed), temporary);
    assert.equal(fs.existsSync(observed), false, 'The probe must remove its temporary Git repository');
  });

test('preparation executes the verified .exe path, post-installs, prunes and probes before publishing its manifest', async t => {
  const root = directory(t), archive = path.join(root, 'verified offline archive.7z.exe'), calls = [], probes = [];
  fs.writeFileSync(archive, 'synthetic executable fixture');
  const runtime = path.join(root, '.runtime', 'git'), environment = { SODUWORK_PORTABLE_GIT_MIRROR: 'https://mirror.invalid/git' };
  let archives = 0;
  await prepare({ root, platform: 'win32', arch: 'arm64', environment, log: quiet,
    archiveOf: async (release, options) => {
      archives++; assert.equal(release.sha256, RELEASE.arm64.sha256);
      assert.equal(options.cache, path.join(root, '.runtime-cache')); assert.equal(options.environment, environment);
      return archive;
    },
    download: unexpected,
    run: (command, args, options) => {
      calls.push({ command, args: [...args], options });
      if (command === archive) {
        assert.deepEqual(args, ['-y', '-o' + runtime]); assert.equal(options.cwd, root); assert.equal(options.windowsHide, true);
        fs.mkdirSync(path.join(runtime, 'bin'), { recursive: true }); fs.writeFileSync(path.join(runtime, 'bin', 'bash.exe'), 'fixture');
        fs.mkdirSync(path.join(runtime, 'usr', 'bin'), { recursive: true }); fs.writeFileSync(path.join(runtime, 'usr', 'bin', 'vim.exe'), 'prunable');
        fs.writeFileSync(path.join(runtime, 'post-install.bat'), 'fixture'); return { status: 0 };
      }
      assert.equal(command, 'cmd.exe');
      assert.deepEqual(args, ['/d', '/c', path.join(runtime, 'post-install.bat')]);
      fs.rmSync(path.join(runtime, 'post-install.bat')); return { status: 1 };
    },
    test: (location, env) => {
      assert.equal(env, environment);
      probes.push(location); assert.equal(fs.existsSync(path.join(runtime, 'usr', 'bin', 'vim.exe')), false);
      assert.equal(fs.existsSync(path.join(runtime, 'bin', 'bash.exe')), true);
      assert.equal(fs.existsSync(path.join(runtime, '.soduwork-shell-runtime.json')), false);
    } });
  assert.equal(archives, 1); assert.equal(calls.length, 2); assert.deepEqual(probes, [runtime]);
  const manifest = JSON.parse(fs.readFileSync(path.join(runtime, '.soduwork-shell-runtime.json'), 'utf8'));
  assert.equal(manifest.arch, 'arm64'); assert.equal(manifest.sha256, RELEASE.arm64.sha256);
  assert.equal(manifest.source, RELEASE.arm64.url); assert.equal(manifest.prune, 1);
});

test('failed extraction never probes or publishes a ready manifest', async t => {
  const root = directory(t), archive = path.join(root, 'verified.exe');
  await assert.rejects(prepare({ root, platform: 'win32', arch: 'x64', environment: {}, log: quiet,
    archiveOf: async () => archive, run: () => ({ status: 1, stderr: 'synthetic extraction failed' }),
    test: unexpected, download: unexpected }), /extraction failed/);
  assert.equal(fs.existsSync(path.join(root, '.runtime', 'git', '.soduwork-shell-runtime.json')), false);
});

test('a failed runtime probe cannot publish a ready manifest', async t => {
  const root = directory(t);
  await assert.rejects(prepare({ root, platform: 'win32', arch: 'x64', environment: {}, log: quiet,
    archiveOf: async () => path.join(root, 'verified.exe'), run: () => ({ status: 0 }),
    test: () => { throw Error('synthetic runtime probe failed'); }, download: unexpected }), /runtime probe failed/);
  assert.equal(fs.existsSync(path.join(root, '.runtime', 'git', '.soduwork-shell-runtime.json')), false);
});

test('preparation reclaims deletable files across two interrupted runtime recoveries', async t => {
  const root = directory(t), runtime = path.join(root, '.runtime', 'git');
  const remove = fs.rmSync, unlink = fs.unlinkSync;
  t.after(() => t.mock.restoreAll());
  t.mock.method(fs, 'rmSync', (target, options) => {
    if (target === runtime) throw Object.assign(Error('protected entry'), {
      code: 'EPERM', syscall: 'unlink', path: path.join(runtime, 'etc', 'mtab'),
    });
    return remove(target, options);
  });
  t.mock.method(fs, 'unlinkSync', target => {
    if (path.basename(target) === 'mtab') throw Object.assign(Error('protected entry'), { code: 'EPERM' });
    assert.equal(fs.existsSync(path.join(runtime, '.soduwork-shell-runtime.json')), true,
      'cleanup must wait for successful self-test and manifest publication');
    return unlink(target);
  });
  const messages = [];
  const options = { root, platform: 'win32', arch: 'x64', environment: {}, log: value => messages.push(value),
    archiveOf: async () => path.join(root, 'verified.exe'),
    run: () => {
      fs.mkdirSync(path.join(runtime, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(runtime, 'bin', 'bash.exe'), 'new runtime');
      return { status: 0 };
    },
    test: location => assert.equal(fs.readFileSync(path.join(location, 'bin', 'bash.exe'), 'utf8'), 'new runtime'),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    fs.mkdirSync(path.join(runtime, 'etc'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'etc', 'mtab'), 'protected fixture');
    fs.writeFileSync(path.join(runtime, 'large.bin'), Buffer.alloc(8 * 1024 * 1024));
    fs.writeFileSync(path.join(runtime, '.soduwork-shell-runtime.json'), 'interrupted');
    await prepare(options);
  }
  const stale = fs.readdirSync(path.dirname(runtime)).filter(name => name.startsWith('git.stale-'));
  assert.equal(stale.length, 2);
  for (const name of stale) {
    const old = path.join(path.dirname(runtime), name);
    assert.equal(fs.existsSync(path.join(old, 'large.bin')), false);
    assert.equal(fs.readFileSync(path.join(old, 'etc', 'mtab'), 'utf8'), 'protected fixture');
    assert.ok(messages.some(message => message.includes(path.join(old, 'etc', 'mtab')) && message.includes('EPERM')));
  }
  assert.equal(fs.existsSync(path.join(runtime, '.soduwork-shell-runtime.json')), true);
  const manifestFile = path.join(runtime, '.soduwork-shell-runtime.json');
  const before = fs.readFileSync(manifestFile, 'utf8');
  await prepare({ ...options, archiveOf: unexpected, run: unexpected });
  assert.equal(fs.readFileSync(manifestFile, 'utf8'), before, 'normal restart must reuse the manifest');
  assert.deepEqual(fs.readdirSync(path.dirname(runtime)).filter(name => name.startsWith('git.stale-')), stale);
});

test('failed recovery logs both filesystem errors and exits nonzero without a new manifest', t => {
  const root = directory(t), runtime = path.join(root, '.runtime', 'git');
  const mtab = path.join(runtime, 'etc', 'mtab');
  fs.mkdirSync(path.dirname(mtab), { recursive: true });
  fs.writeFileSync(mtab, 'protected fixture');
  const script = `
    const fs = require('node:fs');
    const { prepare } = require(${JSON.stringify(require.resolve('../scripts/prepare-shell-runtime.cjs'))});
    fs.rmSync = () => { throw Object.assign(Error('delete denied'), {
      code: 'EPERM', syscall: 'unlink', path: ${JSON.stringify(mtab)} }); };
    fs.renameSync = (source, dest) => { throw Object.assign(Error('rename denied'), {
      code: 'EACCES', syscall: 'rename', path: source, dest }); };
    prepare({ root: ${JSON.stringify(root)}, platform: 'win32', arch: 'x64', environment: {},
      archiveOf: async () => 'fixture.exe',
      run: () => { throw Error('extraction must not run'); }
    }).catch(error => { console.error(error.stack); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stdout.includes('EPERM unlink ' + mtab), result.stdout);
  assert.ok(result.stdout.includes('EACCES rename ' + runtime + ' -> ' + runtime + '.stale-'), result.stdout);
  assert.equal(fs.existsSync(path.join(runtime, '.soduwork-shell-runtime.json')), false);
});

test('stale cleanup removes directory links without following their targets', async t => {
  const root = directory(t), runtime = path.join(root, '.runtime', 'git');
  const outside = path.join(root, 'unrelated');
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'untouched');
  fs.symlinkSync(outside, path.join(runtime, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const remove = fs.rmSync;
  t.after(() => t.mock.restoreAll());
  t.mock.method(fs, 'rmSync', (target, options) => {
    if (target === runtime) throw Object.assign(Error('interrupted'), { code: 'EPERM' });
    return remove(target, options);
  });
  await prepare({ root, platform: 'win32', arch: 'x64', environment: {}, log: quiet,
    archiveOf: async () => 'fixture.exe', run: () => ({ status: 0 }), test: quiet });
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'untouched');
  assert.deepEqual(fs.readdirSync(path.dirname(runtime)), ['git']);
});

test('a failed replacement probe leaves the renamed runtime untouched for diagnosis', async t => {
  const root = directory(t), runtime = path.join(root, '.runtime', 'git');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'keep.txt'), 'old runtime');
  const remove = fs.rmSync;
  t.after(() => t.mock.restoreAll());
  t.mock.method(fs, 'rmSync', (target, options) => {
    if (target === runtime) throw Object.assign(Error('interrupted'), { code: 'EPERM' });
    return remove(target, options);
  });
  await assert.rejects(prepare({ root, platform: 'win32', arch: 'x64', environment: {}, log: quiet,
    archiveOf: async () => 'fixture.exe', run: () => ({ status: 0 }),
    test: () => { throw Error('probe failed'); } }), /probe failed/);
  const stale = fs.readdirSync(path.dirname(runtime)).find(name => name.startsWith('git.stale-'));
  assert.equal(fs.readFileSync(path.join(path.dirname(runtime), stale, 'keep.txt'), 'utf8'), 'old runtime');
  assert.equal(fs.existsSync(path.join(runtime, '.soduwork-shell-runtime.json')), false);
});

test('a ready runtime reclaims old UUID directories without touching siblings or junction targets', async t => {
  const root = directory(t), runtime = existingManifest(root), parent = path.dirname(runtime);
  const manifestFile = path.join(runtime, '.soduwork-shell-runtime.json');
  const originalManifest = fs.readFileSync(manifestFile, 'utf8');
  const stale = path.join(parent, 'git.stale-' + crypto.randomUUID());
  const unrelated = path.join(parent, 'git.stale-manual-backup');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(stale);
  fs.mkdirSync(unrelated);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(stale, 'obsolete.bin'), Buffer.alloc(8 * 1024 * 1024));
  fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'keep backup');
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep target');
  const junction = path.join(parent, 'git.stale-' + crypto.randomUUID());
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(outside, junction, linkType);
  fs.symlinkSync(outside, path.join(stale, 'nested-link'), linkType);

  await prepare({ root, platform: 'win32', arch: 'x64', environment: {}, log: quiet,
    archiveOf: unexpected, run: unexpected, test: () => assert.equal(fs.existsSync(stale), true),
  });
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.lstatSync(junction).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep target');
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep backup');
  assert.equal(fs.readFileSync(manifestFile, 'utf8'), originalManifest);
});

test('ordinary rebuild reclaims a historical directory only after its replacement is ready', async t => {
  const root = directory(t), runtime = existingManifest(root);
  const stale = path.join(path.dirname(runtime), 'git.stale-' + crypto.randomUUID());
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, 'obsolete.txt'), 'historical fixture');
  fs.writeFileSync(path.join(runtime, '.soduwork-shell-runtime.json'), 'invalid');
  const options = { root, platform: 'win32', arch: 'x64', environment: {}, log: quiet,
    archiveOf: async () => 'fixture.exe', run: () => ({ status: 0 }),
  };
  await assert.rejects(prepare({ ...options, test: () => { throw Error('probe failed'); } }), /probe failed/);
  assert.equal(fs.existsSync(stale), true);
  assert.equal(fs.existsSync(path.join(runtime, '.soduwork-shell-runtime.json')), false);

  await prepare({ ...options, test: () => assert.equal(fs.existsSync(stale), true) });
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(path.join(runtime, '.soduwork-shell-runtime.json')), true);
});

test('a directory listing error during stale cleanup does not rebuild a ready runtime', async t => {
  const root = directory(t), runtime = existingManifest(root), parent = path.dirname(runtime);
  const list = fs.readdirSync, messages = [];
  t.after(() => t.mock.restoreAll());
  t.mock.method(fs, 'readdirSync', (target, options) => {
    if (target === parent) throw Object.assign(Error('permission denied'), { code: 'EACCES' });
    return list(target, options);
  });
  await prepare({ root, platform: 'win32', arch: 'x64', environment: {},
    archiveOf: unexpected, run: unexpected, test: quiet, log: message => messages.push(message),
  });
  assert.ok(messages.some(message => message.includes('EACCES readdir ' + parent)));
});
