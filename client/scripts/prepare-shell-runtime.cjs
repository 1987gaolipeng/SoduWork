'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { downloadFile, downloadLabel, errorLabel } = require('./runtime-download.cjs');

const RELEASE = Object.freeze({
  x64: Object.freeze({
    version: '2.55.0.4',
    url: 'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.4/PortableGit-2.55.0.4-64-bit.7z.exe',
    size: 58915456,
    sha256: '016e84230a3767f0c6b3788e79ba0c58a17377086801719d46700fca4f7b36b5',
  }),
  arm64: Object.freeze({
    version: '2.55.0.4',
    url: 'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.4/PortableGit-2.55.0.4-arm64.7z.exe',
    size: 59191568,
    sha256: 'd69d0c6a3c5445553565ef74f1d9e22a9869f57c246111db347dd96c252b4da5',
  }),
});

const clientRoot = path.resolve(__dirname, '..');
const cacheRoot = path.join(clientRoot, '.runtime-cache');
const STALE_GIT_DIRECTORY = /^git\.stale-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Retain the shell utilities, Git core, and HTTPS transport used by automation.
// Remove optional Perl, editor, Tcl/Tk, magic-database, and graphical-terminal components.
// Validate the trimmed runtime through real operations in selfTest.
// Increment PRUNE_REV when this list changes so build caches are regenerated.
const PRUNE_REV = 1;
const PRUNE_PATHS = Object.freeze([
  'usr/lib/perl5',
  'usr/share/perl5',
  'usr/share/vim',
  'usr/share/misc',
  'usr/share/mintty',
  'usr/bin/vim.exe',
  'usr/bin/perl.exe',
  'mingw64/share/doc',
  'mingw64/share/git-gui',
  'mingw64/share/gitk',
  'mingw64/lib/tcl8.6',
  'mingw64/lib/tk8.6',
  'mingw64/bin/tcl86.dll',
  'mingw64/bin/tk86.dll',
  'mingw64/bin/wish.exe',
]);

function prune(root) {
  let removed = 0;
  for (const rel of PRUNE_PATHS) {
    const target = path.join(root, rel);
    ensureInside(target, root);
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed += 1;
  }
  console.log('[SoduWork shell runtime] pruned ' + removed + ' unused components (rev ' + PRUNE_REV + ')');
}

function fail(message) {
  throw new Error('[SoduWork shell runtime] ' + message);
}

function ensureInside(target, root) {
  const resolved = path.resolve(target);
  const base = path.resolve(root) + path.sep;
  if (!resolved.startsWith(base)) fail('unsafe path: ' + resolved);
}

function operationError(error, operation, target, destination) {
  return `${error.code || 'UNKNOWN'} ${error.syscall || operation} ${error.path || target}` +
    ((error.dest || destination) ? ' -> ' + (error.dest || destination) : '');
}

// Visit siblings even when a protected entry cannot be removed. lstat keeps
// links/reparse points as leaves so cleanup never traverses their targets.
function reclaimStaleRuntime(stale, root, log) {
  function remove(target) {
    ensureInside(target, root);
    let operation = 'lstat';
    try {
      const stat = fs.lstatSync(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        operation = 'readdir';
        const names = fs.readdirSync(target);
        for (const name of names) remove(path.join(target, name));
        operation = 'rmdir';
        fs.rmdirSync(target);
      } else {
        operation = 'unlink';
        fs.unlinkSync(target);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        log('[SoduWork shell runtime] retained stale entry: ' + operationError(error, operation, target));
      }
    }
  }
  remove(stale);
}

function reclaimStaleRuntimes(runtimeParent, log) {
  let entries;
  try {
    if (!fs.lstatSync(runtimeParent).isDirectory()) return;
    entries = fs.readdirSync(runtimeParent, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log('[SoduWork shell runtime] could not list stale runtimes: ' + operationError(error, 'readdir', runtimeParent));
    }
    return;
  }
  // Older releases used the same UUID suffix. Restrict cleanup to their
  // directories and skip sibling junctions and other unrelated entries.
  for (const entry of entries) {
    if (STALE_GIT_DIRECTORY.test(entry.name) && entry.isDirectory()) {
      reclaimStaleRuntime(path.join(runtimeParent, entry.name), runtimeParent, log);
    }
  }
}

function hash(file) {
  const digest = crypto.createHash('sha256');
  digest.update(fs.readFileSync(file));
  return digest.digest('hex');
}

function selectRelease(arch, environment = process.env) {
  const item = RELEASE[arch];
  if (!item) fail('unsupported architecture: ' + arch);
  const official = new URL(item.url), file = path.basename(official.pathname);
  const mirror = environment.SODUWORK_PORTABLE_GIT_MIRROR || '';
  let mirrored;
  if (mirror) {
    let parsed;
    try { parsed = new URL(mirror); } catch { fail('PortableGit mirror must be a valid HTTPS URL'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      fail('PortableGit mirror must use HTTPS without URL credentials, query or fragment');
    }
    const tag = official.pathname.split('/').at(-2);
    mirrored = `${mirror.replace(/\/+$/, '')}/${tag}/${file}`;
  }
  return { ...item, file, urls: [...(mirrored ? [mirrored] : []),
    ...(environment.SODUWORK_RUNTIME_MIRROR_ONLY === '1' ? [] : [item.url])] };
}

async function prepareArchive(release, { cache = cacheRoot, environment = process.env,
  download = downloadFile, log = console.log } = {}) {
  const explicit = environment.SODUWORK_PORTABLE_GIT_ARCHIVE;
  if (explicit) {
    if (!fs.existsSync(explicit) || !fs.statSync(explicit).isFile() || hash(explicit) !== release.sha256) {
      fail('Configured PortableGit archive is missing or has a SHA-256 mismatch; the file was not changed');
    }
    return explicit;
  }
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, release.file), partial = archive + '.part', marker = partial + '.source';
  if (fs.existsSync(archive)) {
    if (hash(archive) === release.sha256) return archive;
    fs.rmSync(archive, { force: true });
  }
  if (!release.urls.length) fail('Mirror-only PortableGit download requires SODUWORK_PORTABLE_GIT_MIRROR or a verified local archive');
  let lastError = '';
  for (let index = 0; index < release.urls.length; index++) {
    const url = release.urls[index];
    const source = crypto.createHash('sha256').update(url).digest('hex');
    let previous = '';
    try { previous = fs.readFileSync(marker, 'utf8'); } catch { /* Legacy official partials have no marker. */ }
    if (previous !== source && !(previous === '' && url === release.url)) fs.rmSync(partial, { force: true });
    fs.writeFileSync(marker, source);
    log('[SoduWork shell runtime] downloading ' + downloadLabel(url));
    try {
      await download(url, archive, { environment, expectedBytes: release.size, resume: true, log });
      if (hash(archive) !== release.sha256) {
        fs.rmSync(archive, { force: true });
        fs.rmSync(partial, { force: true });
        fs.rmSync(marker, { force: true });
        lastError = 'SHA-256 mismatch';
      } else {
        fs.rmSync(marker, { force: true });
        return archive;
      }
    } catch (error) { lastError = errorLabel(error); }
    log('[SoduWork shell runtime] ' + downloadLabel(url) + ' failed: ' + lastError);
    if (index + 1 < release.urls.length) {
      fs.rmSync(partial, { force: true });
      fs.rmSync(marker, { force: true });
    }
  }
  fail('PortableGit download failed: ' + lastError + '. Check HTTP_PROXY/HTTPS_PROXY, configure SODUWORK_PORTABLE_GIT_MIRROR, or use SODUWORK_PORTABLE_GIT_ARCHIVE');
}

function selfTest(root, environment = process.env, run = spawnSync) {
  const bash = path.join(root, 'bin', 'bash.exe');
  if (!fs.existsSync(bash)) fail('archive does not contain bin/bash.exe');
  // Run actual Git init, commit, log, and utility operations after pruning.
  // Executable discovery alone cannot detect removed runtime dependencies.
  const command = "set -e; printf 'SODUWORK_SHELL_OK\\n'; " +
    "for tool in git find grep sed tar; do command -v \"$tool\" >/dev/null || exit 31; done; " +
    'git --version >/dev/null; work="$(mktemp -d)"; cd "$work"; ' +
    'git init -q .; printf hello > probe.txt; git add probe.txt; ' +
    'git -c user.email=selftest@soduwork -c user.name=soduwork commit -q -m probe; ' +
    "git log --oneline | grep -q probe; " +
    "printf x | sed s/x/y/ | grep -q y; " +
    "find . -name probe.txt | grep -q probe; " +
    "tar -cf probe.tar probe.txt; tar -tf probe.tar | grep -q probe; " +
    'cd /; rm -rf "$work"';
  const windowsRoot = environment.SystemRoot || 'C:\\Windows';
  const result = run(bash, ['-c', command], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: {
      SystemRoot: windowsRoot, WINDIR: environment.WINDIR || windowsRoot,
      PATH: path.join(windowsRoot, 'System32'), CHERE_INVOKING: '1', MSYS_NO_PATHCONV: '1',
      ...Object.fromEntries(Object.entries(environment).filter(([key]) => /^(TMPDIR|TEMP|TMP)$/i.test(key))),
    },
  });
  if (result.status !== 0 || !String(result.stdout || '').includes('SODUWORK_SHELL_OK')) {
    fail('runtime self-test failed (' + result.status + '): ' + String(result.stderr || '').trim());
  }
}

async function prepare({ platform = process.platform, environment = process.env,
  arch = String(environment.npm_config_arch || process.arch).toLowerCase(), root = clientRoot,
  download = downloadFile, run = spawnSync, test = selfTest, archiveOf = prepareArchive, log = console.log } = {}) {
  if (platform !== 'win32') {
    // Git for Windows only ships bash.exe; on macOS/Linux the Runner resolves
    // the system bash/git itself (_bundledShell stays null) and jobs rely on
    // the OS toolchain. Keep this a no-op so mac packaging can reuse prebuild.
    console.log('[SoduWork shell runtime] skipped: bundled Git for Windows is only used on Windows builds');
    return;
  }
  const runtimeParent = path.join(root, '.runtime');
  const runtimeRoot = path.join(runtimeParent, 'git'), cache = path.join(root, '.runtime-cache');
  const item = RELEASE[arch];
  if (!item) fail('unsupported architecture: ' + arch);
  const manifestFile = path.join(runtimeRoot, '.soduwork-shell-runtime.json');
  let ready = false;
  if (fs.existsSync(manifestFile)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (manifest.version === item.version && manifest.arch === arch &&
          manifest.sha256 === item.sha256 && manifest.prune === PRUNE_REV) {
        test(runtimeRoot, environment);
        ready = true;
      }
    } catch (error) { /* rebuild below */ }
  }
  if (ready) {
    reclaimStaleRuntimes(runtimeParent, log);
    console.log('[SoduWork shell runtime] ready: Git for Windows ' + item.version + ' (' + arch + ')');
    return;
  }
  const archive = await archiveOf(selectRelease(arch, environment), { cache, environment, download, log });

  ensureInside(runtimeRoot, root);
  try {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    // Interrupted extraction can leave an undeletable reparse point.
    const stale = runtimeRoot + '.stale-' + crypto.randomUUID();
    ensureInside(stale, root);
    try {
      fs.renameSync(runtimeRoot, stale);
    } catch (renameError) {
      log('[SoduWork shell runtime] cleanup failed: ' + operationError(error, 'rm', runtimeRoot));
      log('[SoduWork shell runtime] recovery rename failed: ' +
        operationError(renameError, 'rename', runtimeRoot, stale));
      throw renameError;
    }
    log('[SoduWork shell runtime] retained an unremovable previous runtime at ' + stale);
  }
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const extracted = run(archive, ['-y', '-o' + runtimeRoot], {
    cwd: root, encoding: 'utf8', timeout: 10 * 60 * 1000, windowsHide: true,
  });
  if (extracted.status !== 0) {
    fail('PortableGit extraction failed (' + extracted.status + '): ' +
      String(extracted.stderr || '').trim());
  }
  const postInstall = path.join(runtimeRoot, 'post-install.bat');
  if (fs.existsSync(postInstall)) {
    // Pass paths as independent cmd arguments and let Node quote them.
    // Hand-built call quoting can break paths containing spaces.
    const installed = run('cmd.exe', ['/d', '/c', postInstall], {
      cwd: runtimeRoot, encoding: 'utf8', timeout: 5 * 60 * 1000, windowsHide: true,
    });
    // The post-install script deletes itself on success, which may leave cmd returning 1.
    // Use script consumption as its completion signal and real selfTest operations as the quality check.
    if (fs.existsSync(postInstall)) {
      fail('PortableGit post-install failed (' + installed.status + '): ' +
        String(installed.stderr || installed.stdout || '').trim().slice(-500));
    }
  }
  prune(runtimeRoot);
  test(runtimeRoot, environment);
  fs.writeFileSync(manifestFile, JSON.stringify({
    product: 'Git for Windows PortableGit', version: item.version, arch,
    sha256: item.sha256, source: item.url, prune: PRUNE_REV,
    preparedAt: new Date().toISOString(),
  }, null, 2) + '\n', 'utf8');
  reclaimStaleRuntimes(runtimeParent, log);
  console.log('[SoduWork shell runtime] prepared: Git for Windows ' + item.version + ' (' + arch + ')');
}

if (require.main === module) prepare().catch((error) => {
  console.error(String((error && error.stack) || error));
  process.exitCode = 1;
});
module.exports = { RELEASE, selectRelease, prepareArchive, prepare, selfTest };
