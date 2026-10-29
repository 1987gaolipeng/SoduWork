'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { prune, retire, deleteRetired } = require('../build/prune-versions.cjs');

async function fixture(t, extra = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-prune-idle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.soduwork-versions'));
  await fs.writeFile(path.join(root, '.soduwork-launcher'), '1');
  await fs.writeFile(path.join(root, '.soduwork-active'), 'ns001.tmp');
  await fs.writeFile(path.join(root, '.soduwork-previous'), 'ns002.tmp');
  for (const name of ['ns001.tmp', 'ns002.tmp', ...extra]) {
    const dir = path.join(root, '.soduwork-versions', name);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, '.soduwork-stage'), '1');
  }
  return root;
}

test('no retired payload skips process enumeration and preserves active, previous and unrelated directories', async t => {
  const root = await fixture(t, ['user-files']);
  await fs.mkdir(path.join(root, '.soduwork-versions', 'ns003.tmp'));
  const probe = t.mock.method(childProcess, 'spawnSync', () => { throw Error('Unexpected process scan'); });
  assert.deepEqual(await prune(root), []);
  assert.equal(probe.mock.callCount(), 0);
  assert.deepEqual((await fs.readdir(path.join(root, '.soduwork-versions'))).sort(), ['ns001.tmp', 'ns002.tmp', 'ns003.tmp', 'user-files']);
});

test('a managed retired payload still requires a successful process scan before removal', async t => {
  const root = await fixture(t, ['ns003.tmp']);
  const probe = t.mock.method(childProcess, 'spawnSync', () => ({ status: 1, stdout: '' }));
  assert.deepEqual(await prune(root), []);
  assert.equal(probe.mock.callCount(), 1);
  await fs.access(path.join(root, '.soduwork-versions', 'ns003.tmp'));
  probe.mock.mockImplementation(() => ({ status: 0, stdout: JSON.stringify([{ ExecutablePath: null, CommandLine: '' }]) }));
  assert.deepEqual(await prune(root), [], 'inaccessible process ownership still fails closed');
  await fs.access(path.join(root, '.soduwork-versions', 'ns003.tmp'));
});

test('one process snapshot protects a running retired payload and deletes only the idle managed candidate', async t => {
  const root = await fixture(t, ['ns003.tmp', 'ns004.tmp']);
  const running = path.join(root, '.soduwork-versions', 'ns004.tmp', 'SoduWork.exe');
  const probe = t.mock.method(childProcess, 'spawnSync', () => ({ status: 0,
    stdout: JSON.stringify([{ ExecutablePath: running, CommandLine: '"' + running + '"' }]) }));
  assert.deepEqual(await prune(root), ['ns003.tmp']);
  assert.equal(probe.mock.callCount(), 1);
  await fs.access(path.join(root, '.soduwork-versions', 'ns004.tmp'));
  await assert.rejects(fs.access(path.join(root, '.soduwork-versions', 'ns003.tmp')), { code: 'ENOENT' });
});

test('install-root aliases preserve running payloads named through either original or canonical paths', async t => {
  for (const canonicalProcess of [false, true]) {
    const root = await fixture(t, ['ns003.tmp', 'ns004.tmp']);
    const processRoot = canonicalProcess ? await fs.realpath(root) : root;
    const running = path.join(processRoot, '.soduwork-versions', 'ns004.tmp', 'SoduWork.exe');
    assert.deepEqual(await prune(root, [running]), ['ns003.tmp']);
    await fs.access(path.join(root, '.soduwork-versions', 'ns004.tmp', '.soduwork-stage'));
  }
});

test('quoted Windows argv with forward slashes preserves its running payload', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t, ['ns003.tmp', 'ns004.tmp']);
  const script = path.join(root, '.soduwork-versions', 'ns003.tmp', 'worker.js');
  await fs.writeFile(script, 'synthetic worker');
  const commandLine = '"node.exe" "' + script.replace(/\\/g, '/') + '" --fixture';
  assert.deepEqual(await prune(root, [process.execPath, commandLine]), ['ns004.tmp']);
  assert.equal(await fs.readFile(script, 'utf8'), 'synthetic worker');
});

test('quoted short-path argv remains protected when the installation root uses its canonical spelling', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t, ['ns003.tmp', 'ns004.tmp']);
  const script = path.join(root, '.soduwork-versions', 'ns003.tmp', 'worker.js');
  await fs.writeFile(script, 'synthetic worker');
  const commandLine = '"node.exe" "' + script.replace(/\\/g, '/') + '" --fixture';
  assert.deepEqual(await prune(await fs.realpath(root), [process.execPath, commandLine]), ['ns004.tmp']);
  await fs.access(script);
});

test('an unresolved short-path process argument preserves candidate payloads', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t, ['ns003.tmp']);
  const unknown = path.join(root, 'missing~1', 'worker.js').replace(/\\/g, '/');
  assert.deepEqual(await prune(root, [process.execPath, '"node.exe" "' + unknown + '" --fixture']), []);
  await fs.access(path.join(root, '.soduwork-versions', 'ns003.tmp', '.soduwork-stage'));
});

test('an ancestor junction cannot authorize retirement through a normal child installation directory', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), outside = await fixture(t, ['ns003.tmp']);
  const alias = path.join(root, 'linked-parent');
  await fs.symlink(path.dirname(outside), alias, 'junction');
  const requested = path.join(alias, path.basename(outside));
  assert.equal((await fs.lstat(requested)).isSymbolicLink(), false, 'the junction is an ancestor');
  assert.deepEqual(await prune(requested, []), []);
  await fs.access(path.join(outside, '.soduwork-versions', 'ns003.tmp', '.soduwork-stage'));
});

test('root replacement during canonicalization cannot retire another installation', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t, ['ns003.tmp']), outside = await fixture(t, ['ns003.tmp']);
  const moved = root + '-moved';
  t.after(() => fs.rm(moved, { recursive: true, force: true }));
  const realpath = fs.realpath; let replaced = false;
  t.mock.method(fs, 'realpath', async target => {
    if (!replaced && path.resolve(target) === path.resolve(root)) {
      replaced = true;
      await fs.rename(root, moved);
      await fs.symlink(outside, root, 'junction');
    }
    return realpath(target);
  });
  assert.deepEqual(await prune(root, []), []);
  await fs.access(path.join(outside, '.soduwork-versions', 'ns003.tmp', '.soduwork-stage'));
});

test('candidate replaced by a junction during the process scan cannot authorize deleting its target', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t, ['ns003.tmp']);
  const candidate = path.join(root, '.soduwork-versions', 'ns003.tmp');
  const outside = path.join(root, 'user-files');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep.txt'), 'preserve');
  const nativeFs = require('node:fs');
  t.mock.method(childProcess, 'spawnSync', () => {
    nativeFs.rmSync(candidate, { recursive: true });
    nativeFs.symlinkSync(outside, candidate, 'junction');
    return { status: 0, stdout: '[]' };
  });
  assert.deepEqual(await prune(root), []);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'preserve');
});
test('cleanup retains active, previous, running and non-managed data; retires only owned payloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-prune-'));
  try {
    await fs.mkdir(path.join(root, '.soduwork-versions'));
    await fs.writeFile(path.join(root, '.soduwork-launcher'), '1');
    await fs.writeFile(path.join(root, '.soduwork-active'), 'ns001.tmp');
    await fs.writeFile(path.join(root, '.soduwork-previous'), 'ns002.tmp');
    for (const name of ['ns001.tmp', 'ns002.tmp', 'ns003.tmp', 'ns004.tmp', 'ns005.tmp', 'user-files']) {
      const dir = path.join(root, '.soduwork-versions', name);
      await fs.mkdir(dir);
      if (name !== 'ns005.tmp') await fs.writeFile(path.join(dir, '.soduwork-stage'), '1');
    }
    const running = [path.join(root, '.soduwork-versions/ns004.tmp/SoduWork.exe')];
    assert.deepEqual(await prune(root, running), ['ns003.tmp']);
    for (const name of ['ns001.tmp', 'ns002.tmp', 'ns004.tmp', 'ns005.tmp', 'user-files']) await fs.access(path.join(root, '.soduwork-versions', name));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('retirement does not recursively delete, and later deletion cannot reach active or rollback files', async t => {
  const root = await fixture(t, ['ns003.tmp']);
  await fs.writeFile(path.join(root, '.soduwork-versions/ns003.tmp/retained.txt'), 'old runtime');
  const remove = t.mock.method(fs, 'rm', () => { throw Error('Recursive deletion on the commit path'); });
  assert.deepEqual(await retire(root, []), ['ns003.tmp']);
  assert.equal(remove.mock.callCount(), 0);
  const retired = (await fs.readdir(path.join(root, '.soduwork-retired'), { withFileTypes: true })).find(row => row.isDirectory()).name;
  assert.equal(await fs.readFile(path.join(root, '.soduwork-retired', retired, 'retained.txt'), 'utf8'), 'old runtime');
  remove.mock.restore();
  assert.deepEqual(await deleteRetired(root, []), [retired]);
  await fs.access(path.join(root, '.soduwork-versions/ns001.tmp'));
  await fs.access(path.join(root, '.soduwork-versions/ns002.tmp'));
});

test('a pointer change during the ownership scan cancels retirement', async t => {
  const root = await fixture(t, ['ns003.tmp']);
  t.mock.method(childProcess, 'spawnSync', () => {
    require('node:fs').writeFileSync(path.join(root, '.soduwork-active'), 'ns003.tmp');
    return { status: 0, stdout: '[]' };
  });
  assert.deepEqual(await retire(root), []);
  await fs.access(path.join(root, '.soduwork-versions/ns003.tmp'));
});

test('background deletion preserves unknown data and explicitly running retired payloads', async t => {
  const root = await fixture(t, ['ns003.tmp']);
  await retire(root, []);
  const name = (await fs.readdir(path.join(root, '.soduwork-retired'), { withFileTypes: true })).find(row => row.isDirectory()).name;
  const unrelated = path.join(root, '.soduwork-retired/user-files');
  await fs.mkdir(unrelated); await fs.writeFile(path.join(unrelated, 'keep.txt'), 'keep');
  assert.deepEqual(await deleteRetired(root, [path.join(root, '.soduwork-retired', name, 'SoduWork.exe')]), []);
  assert.deepEqual(await deleteRetired(root, []), [name]);
  assert.equal(await fs.readFile(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep');
});

test('a retired-directory junction cannot authorize deleting its target', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t, ['ns003.tmp']);
  const outside = path.join(root, 'user-files');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  await fs.symlink(outside, path.join(root, '.soduwork-retired'), 'junction');
  assert.deepEqual(await retire(root, []), []);
  assert.deepEqual(await deleteRetired(root, []), []);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('partial recursive deletion remains retryable after all internal markers were removed', async t => {
  const root = await fixture(t, ['ns003.tmp']);
  await fs.writeFile(path.join(root, '.soduwork-versions/ns003.tmp/locked.dll'), 'still locked');
  await retire(root, []);
  const retired = path.join(root, '.soduwork-retired');
  const name = (await fs.readdir(retired, { withFileTypes: true })).find(row => row.isDirectory()).name;
  const remove = t.mock.method(fs, 'rm', async directory => {
    await fs.unlink(path.join(directory, '.soduwork-stage'));
    throw Object.assign(Error('file still busy'), { code: 'EBUSY' });
  });
  assert.deepEqual(await deleteRetired(root, []), []);
  assert.equal(await fs.readFile(path.join(retired, name, 'locked.dll'), 'utf8'), 'still locked');
  await fs.access(path.join(retired, name + '.json'));
  remove.mock.restore();
  assert.deepEqual(await deleteRetired(root, []), [name]);
  assert.deepEqual(await fs.readdir(retired), []);
});

test('a matching directory name with internal markers but no retirement receipt is preserved', async t => {
  const root = await fixture(t), name = 'ns999.tmp-12345678-1234-4234-8234-123456789abc';
  const directory = path.join(root, '.soduwork-retired', name);
  await fs.mkdir(directory, { recursive: true });await fs.writeFile(path.join(directory, '.soduwork-stage'), '1');
  assert.deepEqual(await deleteRetired(root, []), []);
  await fs.access(directory);
});
