'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises');
const os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const filename = path.join(__dirname, '../main/pi-session/history-ipc.js');
const source = fs.readFileSync(filename, 'utf8'), realRequire = createRequire(filename);
const SID = 'S-1-5-21-111-222-333-1001';

// All writes stay in this test's directory, including the simulated Windows
// recycle directory. Never repair or remove a host-volume recycle bin.
async function fixture(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'soduwork-recycle-fixture-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const events = [];
  const local = value => {
    assert.match(value, /^C:\\\$Recycle\.Bin(?:\\S-1-[\d-]+)?$/);
    return path.join(root, ...value.slice(3).split('\\'));
  };
  const io = {
    async lstat(value) {
      events.push(['lstat', value]);
      if (options.link) return { isDirectory: () => true, isSymbolicLink: () => true };
      return fsp.lstat(local(value));
    },
    async mkdir(value) {
      events.push(['mkdir', value]);
      if (options.denied) throw Object.assign(Error('fixture denied'), { code: 'EACCES' });
      await fsp.mkdir(local(value));
    },
  };
  const loaded = { exports: {} };
  vm.runInNewContext(source, { module: loaded, process: {
    platform: options.platform || 'win32', env: { SystemRoot: 'C:\\Windows' },
  }, require(name) {
    if (name === 'node:fs/promises') return io;
    if (name === 'node:path') return path.win32;
    if (name === 'node:child_process') return { execFile(exe, args, opts, callback) {
      events.push(['whoami', exe]);
      assert.equal(exe, 'C:\\Windows\\System32\\whoami.exe');
      assert.deepEqual(Array.from(args), ['/user', '/fo', 'csv', '/nh']);
      assert.equal(opts.windowsHide, true); assert.ok(opts.timeout <= 4000);
      callback(options.sidError || null, options.stdout ?? '"fixture\\user","' + SID + '"\r\n');
    } };
    return realRequire(name);
  } }, { filename });
  const file = path.join(root, 'session.jsonl'); await fsp.writeFile(file, 'fixture archive');
  const bin = path.join(root, '$Recycle.Bin', SID);
  return { api: loaded.exports, root, file, bin, events };
}

test('missing recycle directory is prepared before the first shell deletion', async t => {
  const f = await fixture(t); let calls = 0;
  await f.api.trashWithRecovery({ async trashItem(file) {
    calls++; assert.equal(file, 'C:\\sessions\\one.jsonl');
    assert.ok((await fsp.stat(f.bin)).isDirectory());
    await fsp.rename(f.file, path.join(f.bin, 'session.jsonl'));
  } }, 'C:\\sessions\\one.jsonl');
  assert.equal(calls, 1);
  assert.equal(await fsp.readFile(path.join(f.bin, 'session.jsonl'), 'utf8'), 'fixture archive');
  await assert.rejects(fsp.stat(f.file), { code: 'ENOENT' });
});

test('existing recycle directories are not changed and preparation is idempotent', async t => {
  const f = await fixture(t);
  await fsp.mkdir(f.bin, { recursive: true });
  await fsp.writeFile(path.join(f.bin, 'existing.txt'), 'keep');
  assert.equal(await f.api.ensureRecycleBinFor('C:\\'), true);
  assert.equal(await f.api.ensureRecycleBinFor('C:\\'), true);
  assert.equal(f.events.filter(e => e[0] === 'mkdir').length, 0);
  assert.equal(await fsp.readFile(path.join(f.bin, 'existing.txt'), 'utf8'), 'keep');
});

for (const [name, options, target] of [
  ['permission denied', { denied: true }], ['SID query failed', { sidError: Error('failed') }],
  ['malformed SID output', { stdout: 'garbage ' + SID + ' trailing' }],
  ['junction in recycle path', { link: true }],
  ['network share', {}, '\\\\fixture\\share\\session.jsonl'],
  ['relative path', {}, 'session.jsonl'],
]) test('preparation failure preserves archive without invoking shell: ' + name, async t => {
  const f = await fixture(t, options); let calls = 0;
  await assert.rejects(f.api.trashWithRecovery({ async trashItem() { calls++; } },
    target || 'C:\\sessions\\one.jsonl'), /回收站尚未就绪/);
  assert.equal(calls, 0);
  assert.equal(await fsp.readFile(f.file, 'utf8'), 'fixture archive');
});

test('directory disappearing during shell call is repaired for one bounded retry', async t => {
  const f = await fixture(t); let calls = 0;
  await f.api.trashWithRecovery({ async trashItem() {
    calls++;
    if (calls === 1) { await fsp.rm(f.bin, { recursive: true }); throw Error('first failure'); }
    assert.ok((await fsp.stat(f.bin)).isDirectory());
    await fsp.rename(f.file, path.join(f.bin, 'session.jsonl'));
  } }, 'C:\\sessions\\one.jsonl');
  assert.equal(calls, 2);
});

test('two shell failures retain the original error and original archive', async t => {
  const f = await fixture(t), first = Error('first failure'); let calls = 0;
  await assert.rejects(f.api.trashWithRecovery({ async trashItem() {
    calls++; throw calls === 1 ? first : Error('second failure');
  } }, 'C:\\sessions\\one.jsonl'), error => error === first);
  assert.equal(calls, 2);
  assert.equal(await fsp.readFile(f.file, 'utf8'), 'fixture archive');
});

test('non-Windows delegates once without querying SID or preparing directories', async t => {
  const f = await fixture(t, { platform: 'linux' }); let calls = 0;
  const failure = Error('native failure');
  await assert.rejects(f.api.trashWithRecovery({ async trashItem() { calls++; throw failure; } },
    '/fixture/session.jsonl'), error => error === failure);
  assert.equal(await f.api.currentWindowsSid(), '');
  assert.equal(calls, 1); assert.equal(f.events.length, 0);
});
