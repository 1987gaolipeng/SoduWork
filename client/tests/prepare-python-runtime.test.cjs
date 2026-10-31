'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtime = require('../scripts/prepare-python-runtime.cjs');

test('Python archive matrix is immutable and rejects unsupported targets and unsafe mirrors', () => {
  for (const platform of ['win32', 'darwin', 'linux']) for (const arch of ['x64', 'arm64']) {
    const item = runtime.releaseFor(platform, arch, {});
    assert.match(item.sha256, /^[0-9a-f]{64}$/);
    assert.ok(item.urls.every(url => url.startsWith('https://')));
    assert.ok(item.urls.at(-1).includes('github.com/astral-sh/python-build-standalone/'));
  }
  assert.throws(() => runtime.releaseFor('linux', 'ia32'), /Unsupported/);
  assert.throws(() => runtime.releaseFor('win32', 'x64', { SODUWORK_PYTHON_MIRROR: 'http://unsafe' }), /HTTPS/);
});

test('office preparation only accepts hashed binary wheels into the artifact', () => {
  const args = runtime.installArgs('/artifact', 'linux', '/locked.txt');
  assert.ok(args.includes('--only-binary=:all:'));
  assert.ok(args.includes('--require-hashes'));
  assert.ok(args.includes('--no-compile'));
  assert.equal(args[args.indexOf('--target') + 1], path.join('/artifact', 'lib/python3.12/site-packages'));
  assert.equal(args[args.indexOf('-r') + 1], '/locked.txt');
  const lock = fs.readFileSync(path.resolve(__dirname, '../scripts/python-office-requirements.txt'), 'utf8');
  assert.match(lock, /python-docx==1\.2\.0/);
  assert.match(lock, /python-pptx==1\.0\.2/);
  assert.match(lock, /openpyxl==3\.1\.5/);
  assert.equal(lock.split('\n').filter(line => /^[A-Za-z]/.test(line)).length, 8);
});

test('Python bootstrap does not inherit host virtualenv or loader injection', () => {
  const env = runtime.isolatedEnv({ PATH: '/system', PYTHONHOME: '/evil', PYTHONPATH: '/evil', pythonpath: '/evil', PYTHONSTARTUP: 'evil', VIRTUAL_ENV: 'venv', CONDA_PREFIX: 'conda', LD_PRELOAD: 'evil', DYLD_LIBRARY_PATH: 'evil', HOME: '/home', PIP_INDEX_URL: 'https://mirror' });
  for (const key of ['PYTHONHOME', 'PYTHONPATH', 'pythonpath', 'PYTHONSTARTUP', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'LD_PRELOAD', 'DYLD_LIBRARY_PATH']) assert.equal(env[key], undefined);
  assert.equal(env.HOME, '/home');
  assert.equal(env.PIP_INDEX_URL, 'https://mirror');
});

test('Windows python3 alias uses the exact bundled interpreter bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-python-alias-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'python.exe'), 'signed interpreter bytes');
  runtime.prepareAliases(root, 'win32');
  assert.deepEqual(fs.readFileSync(path.join(root, 'python3.exe')), fs.readFileSync(path.join(root, 'python.exe')));
});

test('self-test runs the bundled interpreter with no PATH and checks target architecture', () => {
  let seen;
  const run = (command, args, options) => {
    seen = { command, args, options };
    return { status: 0, stdout: JSON.stringify({ version: runtime.VERSION, machine: 'AMD64', office: true }) };
  };
  assert.equal(runtime.selfTest('/bundle', 'win32', 'x64', run).office, true);
  assert.equal(seen.command, path.join('/bundle', 'python.exe'));
  assert.equal(seen.options.env.PATH, '');
  assert.equal(seen.options.env.Path, undefined);
  assert.deepEqual(seen.args.slice(0, 3), ['-I', '-B', '-c']);
  assert.match(seen.args[3], /Document\(b\)/);
  assert.throws(() => runtime.selfTest('/bundle', 'win32', 'arm64', run), /mismatch/);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-python-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let extracts = 0;
  const options = { root, platform: process.platform, arch: process.arch,
    fetchArchive: async () => '/verified-archive',
    extract: async (_archive, stage) => {
      extracts++;
      const bin = runtime.executable(path.join(stage, 'python'), process.platform);
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, 'portable interpreter');
      fs.writeFileSync(path.join(stage, 'python', 'LICENSE.txt'), 'Python license');
    },
    run: (_bin, args) => ({ status: 0, stdout: args.includes('-c') ? JSON.stringify({ version: runtime.VERSION, machine: process.arch === 'arm64' ? 'arm64' : 'AMD64', office: true }) : '' }),
  };
  return { root, options, count: () => extracts };
}

test('damaged cached interpreters rebuild and preserve notices without installing on the host', async t => {
  const { options, count } = fixture(t);
  const prepared = await runtime.prepare(options);
  assert.equal(count(), 1);
  assert.equal(fs.readFileSync(path.join(prepared, 'LICENSE.txt'), 'utf8'), 'Python license');
  await runtime.prepare(options);
  assert.equal(count(), 1);
  fs.writeFileSync(runtime.executable(prepared, process.platform), 'tampered');
  await runtime.prepare(options);
  assert.equal(count(), 2);
  assert.equal(fs.readFileSync(runtime.executable(prepared, process.platform), 'utf8'), 'portable interpreter');
});

test('failed dependency installation preserves the previous environment and removes staging', async t => {
  const { options, root } = fixture(t);
  const prepared = await runtime.prepare(options);
  fs.writeFileSync(path.join(prepared, 'extra'), 'keep existing environment');
  await assert.rejects(runtime.prepare({ ...options, run: () => ({ status: 1, stderr: 'offline mirror' }) }), /offline mirror/);
  assert.equal(fs.readFileSync(path.join(prepared, 'extra'), 'utf8'), 'keep existing environment');
  assert.deepEqual(fs.readdirSync(path.join(root, '.runtime')), ['python']);
});

test('relocation failure restores the previously working artifact', async t => {
  const { options } = fixture(t);
  const prepared = await runtime.prepare(options);
  fs.writeFileSync(path.join(prepared, 'extra'), 'previous');
  const run = (bin, args, opts) => bin.startsWith(prepared + path.sep)
    ? { status: 1, stderr: 'relocation failed' } : options.run(bin, args, opts);
  await assert.rejects(runtime.prepare({ ...options, run }), /relocation failed/);
  assert.equal(fs.readFileSync(path.join(prepared, 'extra'), 'utf8'), 'previous');
});

test('a second preparation cannot replace a runtime while another process holds its lock', async t => {
  const { options, root } = fixture(t);
  const parent = path.join(root, '.runtime');
  fs.mkdirSync(parent);
  const lock = path.join(parent, 'python.prepare.lock');
  fs.writeFileSync(lock, 'other process');
  await assert.rejects(runtime.prepare(options), /already locked/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'other process');
});

test('failed promotion and failed rollback preserve the backup for recovery', async t => {
  const { options, root } = fixture(t);
  const prepared = await runtime.prepare(options);
  fs.writeFileSync(path.join(prepared, 'extra'), 'recover me');
  const original = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === prepared) throw Error('simulated locked destination');
    return original(source, target);
  };
  try { await assert.rejects(runtime.prepare(options), /previous artifact preserved/); }
  finally { fs.renameSync = original; }
  const parent = path.join(root, '.runtime');
  const staging = fs.readdirSync(parent).find(name => name.startsWith('python-stage-'));
  assert.ok(staging);
  assert.equal(fs.readFileSync(path.join(parent, staging, 'previous', 'extra'), 'utf8'), 'recover me');
  assert.equal(fs.existsSync(path.join(parent, 'python.prepare.lock')), false);
});

test('transient Windows loader handles do not fail runtime activation', async t => {
  const { options, root } = fixture(t);
  const target = path.join(root, '.runtime', 'python');
  const original = fs.renameSync;
  let transient = true;
  fs.renameSync = (source, destination) => {
    if (destination === target && transient) {
      transient = false;
      throw Object.assign(Error('loader retained a DLL handle'), { code: 'EPERM' });
    }
    return original(source, destination);
  };
  try { assert.equal(await runtime.prepare(options), target); }
  finally { fs.renameSync = original; }
  assert.equal(transient, false);
  assert.ok(fs.existsSync(runtime.executable(target, process.platform)));
});
