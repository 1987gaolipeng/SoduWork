const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { promisify } = require('node:util');
const background = require('../main/pi-session/background-process');

test('runtime discovery honors cwd, PATH, PATHEXT, duplicate paths, and output encoding', () => {
  const options = { cwd: 'C:\\work', env: { Path: 'C:\\tools;C:\\tools', PATHEXT: '.EXE;.CMD' }, encoding: 'utf8' };
  const files = new Set(['C:\\work\\node.CMD', 'C:\\tools\\node.EXE']);
  const deps = { platform: 'win32', isFile: file => files.has(file) };
  assert.equal(background.whereResult('where node', options, deps).value, 'C:\\work\\node.CMD\r\nC:\\tools\\node.EXE\r\n');
  assert.ok(Buffer.isBuffer(background.whereResult('where node', { ...options, encoding: undefined }, deps).value));
  const error = background.whereResult('where missing', options, deps).error;
  assert.equal(error.status, 1); assert.equal(error.stdout.length, 0);
});

test('compound commands, custom shells, expanded paths and redirected output use the native API', () => {
  for (const command of ['where node & echo ok', 'where /R C:\\ node', 'where $NODE', 'where node.exe > output', 'where node python']) {
    assert.equal(background.whereResult(command, {}, { platform: 'win32' }), null);
  }
  for (const options of [{ shell: 'powershell.exe' }, { stdio: 'inherit' }, { env: { PATH: '%SystemRoot%' } }]) {
    assert.equal(background.whereResult('where node', options, { platform: 'win32' }), null);
  }
  assert.equal(background.whereResult('where node', {}, { platform: 'linux' }), null);
});

test('background defaults preserve explicit interactive options and callback overloads', () => {
  const cb = () => {}, opts = { windowsHide: false, cwd: 'C:\\work' };
  assert.deepEqual(background.backgroundArgs('spawn', ['node', ['--version'], opts]), ['node', ['--version'], opts]);
  assert.deepEqual(background.backgroundArgs('execFile', ['node', cb]), ['node', { windowsHide: true }, cb]);
  assert.deepEqual(background.backgroundArgs('execFile', ['node', ['--version'], cb]), ['node', ['--version'], { windowsHide: true }, cb]);
  assert.deepEqual(background.backgroundArgs('exec', ['node --version', cb]), ['node --version', { windowsHide: true }, cb]);
  assert.deepEqual(background.backgroundArgs('execSync', ['node --version', { windowsHide: undefined }]), ['node --version', { windowsHide: true }]);
  assert.deepEqual(background.backgroundArgs('spawn', ['node', undefined, opts]), ['node', undefined, opts]);
  assert.deepEqual(background.backgroundArgs('execFile', ['node', null, opts, cb]), ['node', null, opts, cb]);
  assert.deepEqual(opts, { windowsHide: false, cwd: 'C:\\work' });
});

test('Windows duplicate environment keys follow Node ordering and null options remain valid', () => {
  const options = { cwd: 'C:\\work', env: { Path: 'C:\\old', PATH: 'C:\\new', PATHEXT: '.EXE' }, encoding: 'utf8' };
  const result = background.whereResult('where node', options, { platform: 'win32', isFile: file => file === 'C:\\new\\node.EXE' });
  assert.equal(result.value, 'C:\\new\\node.EXE\r\n');
  assert.doesNotThrow(() => background.whereResult('where node', null, { platform: 'win32', isFile: () => false }));
});

test('Windows discovery matches real where and immediately notices new installations', { skip: process.platform !== 'win32' }, () => {
  // Native where expands a short-name TEMP path; use the same physical cwd.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-where-')));
  const name = 'soduwork-test-runtime', executable = path.join(root, name + '.exe');
  const options = { cwd: root, env: { PATH: root, PATHEXT: '.EXE;.CMD' }, encoding: 'utf8' };
  try {
    assert.equal(background.whereResult('where ' + name, options).error.status, 1);
    fs.writeFileSync(executable, 'fixture');
    const native = cp.execFileSync(path.join(process.env.SystemRoot, 'System32', 'where.exe'), [name], { ...options, windowsHide: true });
    assert.equal(background.run(() => cp.execSync('where ' + name, options)).toLowerCase(), native.toLowerCase());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scoped CJS and ESM children retain stdout, exit errors, callbacks, and promisified result objects', async () => {
  await background.run(async () => {
    const esm = await import('node:child_process');
    assert.equal(esm.execFileSync(process.execPath, ['-p', '21*2'], { encoding: 'utf8' }).trim(), '42');
    const result = await promisify(cp.execFile)(process.execPath, ['-p', '21*2']);
    assert.equal(result.stdout.trim(), '42'); assert.equal(result.stderr, '');
    await new Promise((resolve, reject) => cp.execFile(process.execPath, ['-p', '6*7'], (error, stdout) => {
      if (error) return reject(error); assert.equal(stdout.trim(), '42'); resolve();
    }));
    await assert.rejects(promisify(cp.execFile)(process.execPath, ['-e', 'process.exit(7)']), error => error.code === 7);
  });
  // The normal API is still usable outside the async scope.
  assert.equal(cp.execFileSync(process.execPath, ['-p', '7*6'], { encoding: 'utf8', windowsHide: true }).trim(), '42');
});
