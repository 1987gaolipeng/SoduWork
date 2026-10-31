'use strict';

// Build-only preparation. The shipped interpreter and office wheels are
// portable artifacts; clients never invoke pip or inherit a developer venv.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { ensureArchive, extractArchive } = require('./prepare-node-runtime.cjs');

const VERSION = '3.12.15';
const RELEASE = '20261009';
// Upstream GitHub release asset digests; mirrors must serve identical bytes.
const TARGETS = Object.freeze({
  'win32-x64': ['x86_64-pc-windows-msvc', '11ed9f8a6ac64fb1b5a55e40e305a6744a3f77a70863c8f8197a6e4349abc64a'],
  'win32-arm64': ['aarch64-pc-windows-msvc', 'e2c1d6de6311d95b7bfaf3c46587cb5682e43415c19fcbef97595cb0b262f614'],
  'darwin-x64': ['x86_64-apple-darwin', 'fb3187d95334813b88940db0f1ca57b84cedfd552739c3a5771c3ea0e49988c9'],
  'darwin-arm64': ['aarch64-apple-darwin', '233f8e15255b3e1d1fd47ea5dd5230dfed803f371138e896e54d98c60ae19f6f'],
  'linux-x64': ['x86_64-unknown-linux-gnu', 'ffa8f85f1b56e88b687f08d743d817015524b86a9365fd921243132b80f1a36d'],
  'linux-arm64': ['aarch64-unknown-linux-gnu', '2e1ba0e7f22e01c534caebf7f09e7820322bc0d055271d3434af671e8400f96f'],
});
const MANIFEST = '.soduwork-python-runtime.json';
const REVISION = 2;
const PROBE = [
  'import sys, json, platform, io, ssl, sqlite3',
  'from docx import Document',
  'from openpyxl import Workbook, load_workbook',
  'from pptx import Presentation',
  'from PIL import Image',
  'd=Document(); d.add_paragraph("SoduWork"); b=io.BytesIO(); d.save(b); b.seek(0); assert Document(b).paragraphs[0].text=="SoduWork"',
  'w=Workbook(); w.active["A1"]="SoduWork"; b=io.BytesIO(); w.save(b); b.seek(0); assert load_workbook(b).active["A1"].value=="SoduWork"',
  'p=Presentation(); p.slides.add_slide(p.slide_layouts[0]); b=io.BytesIO(); p.save(b); b.seek(0); assert len(Presentation(b).slides)==1',
  'b=io.BytesIO(); Image.new("RGB",(2,2)).save(b,format="PNG"); b.seek(0); assert Image.open(b).size==(2,2)',
  'print(json.dumps({"version":platform.python_version(),"machine":platform.machine(),"office":True,"executable":sys.executable}))',
].join('\n');

function releaseFor(platform, arch, environment = process.env) {
  const entry = TARGETS[`${platform}-${arch}`];
  if (!entry) throw Error(`Unsupported bundled Python target: ${platform}-${arch}`);
  const file = `cpython-${VERSION}%2B${RELEASE}-${entry[0]}-install_only_stripped.tar.gz`;
  const official = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/${file}`;
  const mirror = environment.SODUWORK_PYTHON_MIRROR ?? 'https://registry.npmmirror.com/-/binary/python-build-standalone';
  if (mirror && !String(mirror).startsWith('https://')) throw Error('Python mirror must use HTTPS');
  return { sha256: entry[1], urls: [...(mirror ? [`${mirror.replace(/\/$/, '')}/${RELEASE}/${file}`] : []), official] };
}

function executable(root, platform) {
  return path.join(root, platform === 'win32' ? 'python.exe' : 'bin/python3');
}

function prepareAliases(root, platform) {
  // Skills use both python and python3. Do not let Windows Store aliases or a
  // system interpreter handle the name absent from the standalone archive.
  if (platform === 'win32') fs.copyFileSync(path.join(root, 'python.exe'), path.join(root, 'python3.exe'));
  else if (!fs.existsSync(path.join(root, 'bin/python'))) fs.symlinkSync('python3', path.join(root, 'bin/python'));
}

function isolatedEnv(environment = process.env) {
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (/^(?:PYTHON.*|VIRTUAL_ENV|CONDA_PREFIX|CONDA_DEFAULT_ENV|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/i.test(key)) delete result[key];
  }
  result.PYTHONDONTWRITEBYTECODE = '1';
  result.PYTHONNOUSERSITE = '1';
  return result;
}

function runChecked(run, bin, args, options) {
  const result = run(bin, args, { encoding: 'utf8', windowsHide: true, shell: false, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`Bundled Python preparation failed (${result.status}): ${String(result.stderr || result.stdout || '').slice(-4000)}`);
  return result;
}

function selfTest(root, platform = process.platform, arch = process.arch, run = spawnSync) {
  // No development tools on PATH or inherited Python configuration.
  // -I ignores Python user/system configuration, including user site packages.
  const env = isolatedEnv();
  for (const key of Object.keys(env)) if (/^path$/i.test(key)) delete env[key];
  env.PATH = '';
  const output = runChecked(run, executable(root, platform), ['-I', '-B', '-c', PROBE], { env, timeout: 30000 });
  const result = JSON.parse(String(output.stdout).trim());
  const machines = arch === 'x64' ? ['amd64', 'x86_64'] : ['arm64', 'aarch64'];
  if (result.version !== VERSION || !result.office || !machines.includes(String(result.machine).toLowerCase())) throw Error('Bundled Python target or office self-test mismatch');
  return result;
}

function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function inventory(root) {
  const files = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      const relative = path.relative(root, file).replaceAll('\\', '/');
      if (relative === MANIFEST) continue;
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        const resolved = path.resolve(path.dirname(file), target);
        if (!resolved.startsWith(path.resolve(root) + path.sep)) throw Error('Python runtime symlink escapes artifact');
        files[relative] = `link:${target}`;
      } else if (entry.isDirectory()) visit(file);
      else files[relative] = hash(file);
    }
  }
  visit(root);
  return files;
}

function installArgs(root, platform, requirements) {
  const target = path.join(root, platform === 'win32' ? 'Lib/site-packages' : 'lib/python3.12/site-packages');
  return ['-I', '-B', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-compile', '--only-binary=:all:', '--require-hashes', '--target', target, '-r', requirements];
}

async function renameRuntime(source, target) {
  // Loaded interpreter DLLs or antivirus scans can briefly retain Windows
  // handles after a probe exits. Retry sharing violations within a bound.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(source, target); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 10) throw error;
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
}

async function prepare({ root = path.resolve(__dirname, '..'), platform = process.platform,
  arch = process.env.npm_config_arch || process.arch, environment = process.env,
  run = spawnSync, fetchArchive = ensureArchive, extract = extractArchive } = {}) {
  const release = releaseFor(platform, arch, environment);
  if (platform !== process.platform) throw Error('Python runtime must be prepared on its target operating system');
  root = path.resolve(root);
  const runtimeParent = path.join(root, '.runtime');
  const runtime = path.join(runtimeParent, 'python');
  const requirements = path.join(__dirname, 'python-office-requirements.txt');
  const requirementsSha256 = hash(requirements);
  fs.mkdirSync(runtimeParent, { recursive: true });
  for (const item of [root, runtimeParent, runtime]) {
    if (fs.existsSync(item) && fs.lstatSync(item).isSymbolicLink()) throw Error('Python runtime output must not be a symbolic link');
  }
  // Serialize writers across packaging hooks/processes. A stale lock after a
  // killed build is retained for operator review rather than guessed away.
  const lock = path.join(runtimeParent, 'python.prepare.lock');
  let descriptor;
  try { descriptor = fs.openSync(lock, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw Error(`Python runtime preparation is already locked: ${lock}`);
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, platform, arch }));
    try {
      const prior = JSON.parse(fs.readFileSync(path.join(runtime, MANIFEST), 'utf8'));
      if (prior.revision === REVISION && prior.platform === platform && prior.arch === arch &&
          prior.sha256 === release.sha256 && prior.requirementsSha256 === requirementsSha256 &&
          JSON.stringify(prior.files) === JSON.stringify(inventory(runtime))) {
        selfTest(runtime, platform, arch, run);
        return runtime;
      }
    } catch (_) { /* A missing, damaged or stale artifact is rebuilt in staging. */ }
    const archive = await fetchArchive(release, path.join(root, '.runtime-cache', 'python'));
    const stage = fs.mkdtempSync(path.join(runtimeParent, 'python-stage-'));
    const built = path.join(stage, 'python');
    const backup = path.join(stage, 'previous');
    let preserveStage = false;
    async function restorePrevious(originalError) {
      if (!fs.existsSync(backup)) throw originalError;
      try { await renameRuntime(backup, runtime); }
      catch (restoreError) {
        preserveStage = true;
        throw new AggregateError([originalError, restoreError], `Python runtime rollback failed; previous artifact preserved at ${backup}`);
      }
      throw originalError;
    }
    try {
      await extract(archive, stage);
      if (!fs.existsSync(executable(built, platform))) throw Error('Python archive is missing its interpreter');
      prepareAliases(built, platform);
      runChecked(run, executable(built, platform), installArgs(built, platform, requirements), { env: isolatedEnv(environment), timeout: 10 * 60 * 1000 });
      selfTest(built, platform, arch, run);
      const manifest = { revision: REVISION, version: VERSION, release: RELEASE, platform, arch,
        sha256: release.sha256, source: release.urls.at(-1), requirementsSha256, files: inventory(built) };
      fs.writeFileSync(path.join(built, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
      if (fs.existsSync(runtime)) await renameRuntime(runtime, backup);
      try { await renameRuntime(built, runtime); }
      catch (error) { await restorePrevious(error); }
      // Relocation is part of acceptance: no staged absolute paths may leak.
      try { selfTest(runtime, platform, arch, run); }
      catch (error) {
        try { await renameRuntime(runtime, built); }
        catch (moveError) {
          preserveStage = true;
          throw new AggregateError([error, moveError], `Python relocation failed; recovery artifacts preserved at ${stage}`);
        }
        await restorePrevious(error);
      }
      return runtime;
    } finally {
      if (!stage.startsWith(runtimeParent + path.sep + 'python-stage-')) throw Error('Unsafe Python staging path');
      if (!preserveStage) fs.rmSync(stage, { recursive: true, force: true });
    }
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(lock);
  }
}

if (require.main === module) prepare().then(root => console.log(`[SoduWork Python runtime] ready: ${root}`)).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { prepare, selfTest, releaseFor, isolatedEnv, installArgs, inventory, executable, prepareAliases, VERSION, TARGETS, PROBE };
