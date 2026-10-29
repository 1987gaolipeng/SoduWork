'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { inventory } = require('../scripts/prepare-installer.cjs');
const { verify, createProgressWriter } = require('../build/verify-payload.cjs');
async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'soduwork-payload-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('soduwork-payload-'));
    await fsp.rm(root, { recursive: true, force: true });
  });
  await fsp.writeFile(path.join(root, 'runtime.dll'), 'GOOD');
  await inventory(root);
  return root;
}
function virtualSize(t, target, delta) {
  const lstat = fsp.lstat;
  const stat = fsp.stat;
  const change = value => Object.assign(Object.create(Object.getPrototypeOf(value)), value, { size: value.size + delta });
  t.mock.method(fsp, 'lstat', async function(file, ...args) {
    const value = await lstat.call(fsp, file, ...args);
    return file === target ? change(value) : value;
  });
  t.mock.method(fsp, 'stat', async function(file, ...args) {
    const value = await stat.call(fsp, file, ...args);
    return file === target ? change(value) : value;
  });
}
test('complete payload verifies; missing, corrupt, and traversing files fail before activation', async t => {
  const root = await fixture(t);
  assert.equal(await verify(root), 3);
  await fsp.writeFile(path.join(root, 'runtime.dll'), 'EVIL');
  await assert.rejects(verify(root), /Corrupt payload/);
  await fsp.unlink(path.join(root, 'runtime.dll'));
  await assert.rejects(verify(root), /ENOENT/);
  await fsp.writeFile(path.join(root, '.soduwork-payload.json'), JSON.stringify({
    schema: 1, files: [{ path: '../escape', size: 1, sha256: '' }],
  }));
  await assert.rejects(verify(root), /Invalid payload path/);
});
test('filesystem size translation preserves verification only for the exact inventoried bytes', async t => {
  const root = await fixture(t);
  const target = path.join(root, 'runtime.dll');
  virtualSize(t, target, 4096);
  const differences = [];
  assert.equal(await verify(root, differences), 3);
  assert.deepEqual(differences, [{ path: 'runtime.dll', filesystemSize: 4100, actualSize: 4 }]);
  // Equal readable length still requires the original hash; metadata is never a bypass.
  await fsp.writeFile(target, 'EVIL');
  await assert.rejects(verify(root), /Corrupt payload/);
});
test('inventory records the bytes hashed when filesystem metadata reports storage overhead', async t => {
  const root = await fixture(t);
  const target = path.join(root, 'runtime.dll');
  virtualSize(t, target, 4096);
  await inventory(root);
  const manifest = JSON.parse(await fsp.readFile(path.join(root, '.soduwork-payload.json'), 'utf8'));
  assert.equal(manifest.files.find(item => item.path === 'runtime.dll').size, 4);
  assert.equal(await verify(root), 3);
});
test('truncated and extended contents fail with expected and actual readable sizes', async t => {
  const root = await fixture(t);
  for (const text of ['GO', 'GOOD-extra']) {
    await fsp.writeFile(path.join(root, 'runtime.dll'), text);
    await assert.rejects(verify(root), error => {
      assert.match(error.message, /Incomplete payload/);
      assert.equal(error.details.expectedSize, 4);
      assert.equal(error.details.actualSize, Buffer.byteLength(text));
      return true;
    });
  }
});
test('a directory cannot replace an inventoried regular file', async t => {
  const root = await fixture(t);
  const target = path.join(root, 'runtime.dll');
  await fsp.unlink(target);
  await fsp.mkdir(target);
  await assert.rejects(verify(root), /Invalid payload file type/);
});
test('a symbolic link cannot replace an inventoried regular file', async t => {
  const root = await fixture(t);
  const target = path.join(root, 'runtime.dll');
  const lstat = fsp.lstat;
  t.mock.method(fsp, 'lstat', async function(file, ...args) {
    const value = await lstat.call(fsp, file, ...args);
    if (file === target) value.isSymbolicLink = () => true;
    return value;
  });
  await assert.rejects(verify(root), /Invalid payload file type/);
});
test('invalid inventory length or digest cannot authorize a payload', async t => {
  const root = await fixture(t);
  const file = path.join(root, '.soduwork-payload.json');
  const manifest = JSON.parse(await fsp.readFile(file, 'utf8'));
  for (const patch of [{ size: -1 }, { size: '4' }, { size: 1.5 }, { sha256: 'bad' }]) {
    const changed = structuredClone(manifest);
    Object.assign(changed.files[0], patch);
    await fsp.writeFile(file, JSON.stringify(changed));
    await assert.rejects(verify(root), /Invalid payload inventory/);
  }
});
test('CLI retains exit status and writes support diagnostics without file contents', async t => {
  const root = await fixture(t);
  const report = path.join(root, '.soduwork-update-details.json');
  const script = path.resolve(__dirname, '../build/verify-payload.cjs');
  let result = spawnSync(process.execPath, [script, root, report], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await fsp.readFile(report, 'utf8')).fileCount, 3);
  await fsp.writeFile(path.join(root, 'runtime.dll'), 'BROKEN-PAYLOAD-CONTENT');
  result = spawnSync(process.execPath, [script, root, report], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 2);
  const raw = await fsp.readFile(report, 'utf8');
  const data = JSON.parse(raw);
  assert.equal(data.ok, false);
  assert.equal(data.error.path, 'runtime.dll');
  assert.equal(data.error.expectedSize, 4);
  assert.equal(data.error.actualSize, 22);
  assert.match(data.error.actualSha256, /^[a-f0-9]{64}$/);
  assert.equal(raw.includes('BROKEN-PAYLOAD-CONTENT'), false);
});


test('temporary post-extraction access failures retry the same file and still require the exact hash', async t => {
  const root = await fixture(t), target = path.join(root, 'runtime.dll');
  const lstat = fsp.lstat;let calls = 0;const retries = [], waits = [];
  t.mock.method(fsp, 'lstat', async function(file, ...args) {
    if (file === target && ++calls < 3) throw Object.assign(Error('temporarily locked'), { code: 'EBUSY' });
    return lstat.call(fsp, file, ...args);
  });
  assert.equal(await verify(root, [], { sleep: async ms => waits.push(ms), onRetry: x => retries.push(x) }), 3);
  assert.equal(calls, 3);assert.deepEqual(waits, [200, 800]);assert.equal(retries.length, 2);
  assert.equal(retries[0].path, 'runtime.dll');assert.equal(retries[1].attempts, 2);
  await fsp.writeFile(target, 'EVIL');calls = 0;
  await assert.rejects(verify(root, [], { sleep: async () => {} }), error => {
    assert.match(error.message, /Corrupt payload/);assert.equal(error.details.attempts, 3);return true;
  });
});
test('persistent permission failures stop after a bounded number of reads with diagnosis', async t => {
  const root = await fixture(t), target = path.join(root, 'runtime.dll'), lstat = fsp.lstat;let calls = 0;
  t.mock.method(fsp, 'lstat', async function(file, ...args) {
    if (file === target) { calls++;throw Object.assign(Error('read denied'), { code: 'EACCES' }); }
    return lstat.call(fsp, file, ...args);
  });
  await assert.rejects(verify(root, [], { sleep: async () => {} }), error => {
    assert.equal(error.code, 'EACCES');assert.equal(error.details.path, 'runtime.dll');assert.equal(error.details.attempts, 3);return true;
  });
  assert.equal(calls, 3);
});



async function bundledNotices(t) {
  const root = await fixture(t);
  const names = ['LICENSE.electron.txt', 'LICENSES.chromium.html', 'resources/opencode/LICENSE.txt',
    'resources/pi/node_modules/sdk/LICENSE', 'resources/pi/node_modules/sdk/LICENCE.md',
    'resources/pi/node_modules/tslib/CopyrightNotice.txt',
    'resources/runner/_internal/sdk.dist-info/licenses/LICENSE.APACHE',
    'resources/shell/share/licenses/sdk/COPYING3', 'resources/shell/share/licenses/sdk/README',
    'resources/shell/share/licenses/sdk/RUNTIME.LIBRARY.EXCEPTION', 'resources/skills/example/LICENSE-MIT'];
  for (const name of names) {
    await fsp.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fsp.writeFile(path.join(root, name), 'Copyright upstream: permission is granted. ' + name);
  }
  await inventory(root);
  return { root, names };
}

test('all nested redistribution notices tolerate storage changes using hashed original copies', async t => {
  const { root, names } = await bundledNotices(t), differences = [];
  for (const name of names) fs.appendFileSync(path.join(root, name), Buffer.alloc(4096, 81));
  assert.equal(await verify(root, [], { onNoticeDifference: d => differences.push(d) }), names.length + 4);
  assert.deepEqual(differences.map(x => x.path).sort(), names.sort());
  for (const d of differences) {
    assert.equal(d.actualSize, d.sourceSize + 4096);
    assert.equal(d.sourceSha256, d.expectedSha256);
    assert.equal(d.verification, 'verified-redistribution-bundle');
    assert.equal(fs.readFileSync(path.join(root, d.path)).length, d.actualSize, 'protected document is not rewritten');
  }
});

test('missing or corrupt canonical bundle cannot authorize modified notice files', async t => {
  const { root, names } = await bundledNotices(t), bundle = path.join(root, '.soduwork-notices.bin');
  fs.appendFileSync(path.join(root, names[0]), Buffer.alloc(4096));
  const original = fs.readFileSync(bundle);
  fs.writeFileSync(bundle, 'BROKEN');
  await assert.rejects(verify(root), /Corrupt redistribution notice bundle/);
  fs.unlinkSync(bundle);
  await assert.rejects(verify(root, [], { sleep: async () => {} }), /ENOENT/);
  fs.writeFileSync(bundle, original);
  assert.equal(await verify(root), names.length + 4);
});

test('entry bytes and complete inventory membership are checked inside a valid compressed bundle', async t => {
  const { root } = await bundledNotices(t), zlib = require('node:zlib'), crypto = require('node:crypto');
  const file = path.join(root, '.soduwork-notices.bin'), manifestFile = path.join(root, '.soduwork-payload.json');
  const original = JSON.parse(zlib.gunzipSync(fs.readFileSync(file))), inventory = JSON.parse(fs.readFileSync(manifestFile));
  for (const mutate of [x => { x.files[0].content = Buffer.from('EVIL').toString('base64'); }, x => { x.files.pop(); },
    x => { x.files.push(x.files[0]); }, x => { x.files[0].path = 'runtime.dll'; }]) {
    const changed = structuredClone(original); mutate(changed);
    const bytes = zlib.gzipSync(JSON.stringify(changed));fs.writeFileSync(file, bytes);
    inventory.noticeBundle.size = bytes.length;
    inventory.noticeBundle.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    Object.assign(inventory.files.find(x => x.path === '.soduwork-notices.bin'), inventory.noticeBundle);
    fs.writeFileSync(manifestFile, JSON.stringify(inventory));
    await assert.rejects(verify(root), /redistribution notice entry/);
  }
});

test('missing or non-file public notice still fails even when its source copy is correct', async t => {
  const { root, names } = await bundledNotices(t), file = path.join(root, names[0]);
  fs.unlinkSync(file);
  await assert.rejects(verify(root, [], { sleep: async () => {} }), /ENOENT/);
  fs.mkdirSync(file);
  await assert.rejects(verify(root), /Invalid payload file type/);
});

test('scripts, configuration, prompts and runtime text are strict; all failures are reported together', async t => {
  const { root, names } = await bundledNotices(t);
  const strict = ['resources/pi/node_modules/sdk/index.js', 'resources/pi/node_modules/sdk/package.json',
    'resources/skills/demo/SKILL.md', 'resources/shell/share/antiword/UTF-8.txt', 'instructions.txt'];
  for (const name of strict) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });fs.writeFileSync(path.join(root, name), 'GOOD');
  }
  await inventory(root);
  for (const name of strict) fs.writeFileSync(path.join(root, name), 'EVIL');
  for (const name of names) fs.appendFileSync(path.join(root, name), Buffer.alloc(4096));
  await assert.rejects(verify(root), error => {
    assert.equal(error.errorCount, strict.length);
    assert.deepEqual(error.failures.map(x => x.path).sort(), strict.sort());
    assert.equal(error.checkedFiles, strict.length + names.length + 4);return true;
  });
});

test('new unknown license names fail at build time; executable-looking names cannot obtain notice status', async t => {
  const { isNoticePath } = require('../build/verify-payload.cjs');
  for (const name of ['LICENSE.js', 'NOTICE.cjs', 'LICENSE.txt.exe', 'COPYING.dll', 'LICENSE.json', 'LICENSE.ps1',
    'README.md', 'skills/SKILL.md', 'licenses/index.js']) assert.equal(isNoticePath(name), false, name);
  const root = await fixture(t);fs.writeFileSync(path.join(root, 'LICENSE.NewVendor'), 'Unknown upstream license');
  await assert.rejects(inventory(root), /Unclassified redistribution notice/);
});

test('already protected or binary notice build sources are rejected', async t => {
  const root = await fixture(t);fs.writeFileSync(path.join(root, 'LICENSE'), Buffer.from([0, 1, 2, 3]));
  await assert.rejects(inventory(root), /Invalid redistribution notice source/);
});

test('regenerating an inventory never includes stale notice bundle bytes', async t => {
  const { root } = await bundledNotices(t), file = path.join(root, '.soduwork-notices.bin');
  const first = fs.readFileSync(file);await inventory(root);
  assert.deepEqual(fs.readFileSync(file), first);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.soduwork-payload.json')));
  assert.equal(manifest.files.filter(x => x.path === '.soduwork-notices.bin').length, 1);
  assert.equal(await verify(root), manifest.files.length);
});

test('verification progress counts successful files once across retries and never reports success after corruption', async t => {
  const root = await fixture(t), target = path.join(root, 'runtime.dll');
  const lstat = fsp.lstat; let calls = 0; const snapshots = [];
  t.mock.method(fsp, 'lstat', async function(file, ...args) {
    if (file === target && ++calls < 3) throw Object.assign(Error('locked'), { code: 'EBUSY' });
    return lstat.call(fsp, file, ...args);
  });
  await verify(root, [], { sleep: async () => {}, onProgress: event => snapshots.push(event) });
  assert.equal(calls, 3);
  assert.deepEqual(snapshots.map(event => event.completed), [0, 1, 2, 3, 3]);
  assert.equal(snapshots.at(-1).finished, true);
  assert.equal(snapshots.at(-1).completedBytes, snapshots.at(-1).totalBytes);
  await fsp.writeFile(target, 'EVIL'); snapshots.length = 0;
  await assert.rejects(verify(root, [], { onProgress: event => snapshots.push(event) }), /Corrupt payload/);
  assert.equal(snapshots.some(event => event.finished), false);
  assert.equal(snapshots.at(-1).completed, 2);
});

test('progress writer is atomic, throttled, monotonic and reserves 98 for verified completion', async t => {
  const root = await fixture(t), file = path.join(root, '.soduwork-update-progress');
  let now = 1000; const publish = createProgressWriter(file, { now: () => now });
  const event = completed => ({ completed, total: 10, completedBytes: completed * 10, totalBytes: 100, finished: false });
  publish(event(0)); assert.equal(await fsp.readFile(file, 'ascii'), '70|0|10');
  now += 100; publish(event(5)); assert.equal(await fsp.readFile(file, 'ascii'), '70|0|10');
  now += 200; publish(event(5)); assert.equal(await fsp.readFile(file, 'ascii'), '84|5|10');
  now += 300; publish(event(10)); assert.equal(await fsp.readFile(file, 'ascii'), '97|10|10');
  publish({ ...event(10), finished: true }); assert.equal(await fsp.readFile(file, 'ascii'), '98|10|10');
  assert.equal((await fsp.readdir(root)).some(name => name.includes('.verify-')), false);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', function(source, destination) {
    if (destination === file) throw Object.assign(Error('locked'), { code: 'EPERM' });
    return rename.call(fs, source, destination);
  });
  now += 300;
  assert.doesNotThrow(() => publish(event(10)));
  assert.equal(await fsp.readFile(file, 'ascii'), '98|10|10', 'failed replacement leaves the last complete snapshot');
  assert.equal((await fsp.readdir(root)).some(name => name.includes('.verify-')), false);
});

test('CLI emits numeric installation progress and corrupt payload never reaches verification-complete', async t => {
  const root = await fixture(t), report = path.join(root, '.soduwork-update-details.json');
  const progress = path.join(root, '.soduwork-update-progress'), script = path.resolve(__dirname, '../build/verify-payload.cjs');
  const args = [script, root, report, '--progress-file', progress, '--installation'];
  let result = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fsp.readFile(progress, 'ascii'), '98|3|3');
  assert.equal(JSON.parse(await fsp.readFile(report, 'utf8')).verificationMode, 'installation');
  await fsp.writeFile(path.join(root, 'runtime.dll'), 'EVIL');
  result = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 2);
  assert.ok(Number((await fsp.readFile(progress, 'ascii')).split('|')[0]) < 98);
});

test('unwritable progress destination cannot turn verification into failure or weaken its hashes', async t => {
  const root = await fixture(t), report = path.join(root, '.soduwork-update-details.json');
  const script = path.resolve(__dirname, '../build/verify-payload.cjs');
  const args = [script, root, report, '--installation', '--progress-file', path.join(root, 'missing', 'progress')];
  let result = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  await fsp.writeFile(path.join(root, 'runtime.dll'), 'EVIL');
  result = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 2);
  assert.match(JSON.parse(await fsp.readFile(report, 'utf8')).error.message, /Corrupt payload/);
});

test('optimized small and large file reads retain complete byte counts and SHA-256 checks', async t => {
  const root = await fixture(t);
  await fsp.writeFile(path.join(root, 'large.dll'), Buffer.alloc(512 * 1024 + 7, 65));
  await inventory(root);
  assert.equal(await verify(root), 4);
  const fd = fs.openSync(path.join(root, 'large.dll'), 'r+');
  fs.writeSync(fd, Buffer.from('B'), 0, 1, 512 * 1024 + 6); fs.closeSync(fd);
  await assert.rejects(verify(root), error => {
    assert.match(error.message, /Corrupt payload/);
    assert.equal(error.details.actualSize, 512 * 1024 + 7);
    return true;
  });
});

test('independent files really read concurrently with bounded handles and independent buffers', async t => {
  const root = await fixture(t);
  for (let i = 0; i < 12; i++) await fsp.writeFile(path.join(root, `parallel-${i}.dll`), Buffer.alloc(96 * 1024 + i, i));
  await inventory(root);
  const open = fsp.open; let activeReads = 0, peakReads = 0, handles = 0, peakHandles = 0;
  let release; const gate = new Promise(resolve => { release = resolve; });
  const fallback = setTimeout(release, 2000); t.after(() => clearTimeout(fallback));
  const buffers = new Set();
  t.mock.method(fsp, 'open', async function(...args) {
    const handle = await open.apply(fsp, args), read = handle.read.bind(handle), close = handle.close.bind(handle);
    handles++; peakHandles = Math.max(peakHandles, handles);
    handle.read = async (...readArgs) => {
      activeReads++; peakReads = Math.max(peakReads, activeReads); buffers.add(readArgs[0]);
      if (activeReads === 4) release();
      await gate;
      try { return await read(...readArgs); } finally { activeReads--; }
    };
    handle.close = async () => { try { return await close(); } finally { handles--; } };
    return handle;
  });
  const snapshots = [], diagnostics = {};
  assert.equal(await verify(root, [], { concurrency: 4, diagnostics, onProgress: x => snapshots.push(x) }), 15);
  assert.equal(peakReads, 4, 'a different file must start before the first read is released');
  assert.equal(peakHandles, 4); assert.equal(handles, 0); assert.equal(activeReads, 0);
  assert.equal(buffers.size, 4); assert.equal(diagnostics.concurrency, 4);
  assert.equal([...buffers].reduce((total, buffer) => total + buffer.length, 0), 4 * 256 * 1024);
  for (let i = 1; i < snapshots.length; i++) {
    assert.ok(snapshots[i].completed >= snapshots[i - 1].completed);
    assert.ok(snapshots[i].completedBytes >= snapshots[i - 1].completedBytes);
  }
  assert.equal(snapshots.at(-1).completed, 15); assert.equal(snapshots.at(-1).finished, true);
});

test('a retry gives up its reader so healthy files finish even with only one reader', async t => {
  const root = await fixture(t), target = path.join(root, 'runtime.dll');
  const manifestPath = path.join(root, '.soduwork-payload.json'), manifest = JSON.parse(await fsp.readFile(manifestPath));
  manifest.files.sort((a, b) => Number(b.path === 'runtime.dll') - Number(a.path === 'runtime.dll'));
  await fsp.writeFile(manifestPath, JSON.stringify(manifest));
  const lstat = fsp.lstat, snapshots = [], waits = []; let attempts = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const fallback = setTimeout(release, 2000); t.after(() => clearTimeout(fallback));
  t.mock.method(fsp, 'lstat', async function(file, ...args) {
    if (file === target && ++attempts === 1) throw Object.assign(Error('locked'), { code: 'EBUSY' });
    return lstat.call(fsp, file, ...args);
  });
  await verify(root, [], { concurrency: 1, sleep: async delay => { waits.push(delay); await gate; }, onProgress: event => {
    snapshots.push(event);
    if (event.completed === 2) { assert.equal(attempts, 1); release(); }
  } });
  assert.deepEqual(waits, [200]); assert.equal(attempts, 2);
  assert.equal(snapshots.at(-1).completed, 3);
});

test('600 temporarily locked files wait together instead of consuming reader slots', { timeout: 10000 }, async t => {
  const root = await fixture(t), count = 600;
  // A minimal inventory isolates scheduling from build-time hashing overhead.
  const crypto = require('node:crypto'), bytes = Buffer.from('GOOD'), files = [];
  for (let i = 0; i < count; i++) {
    const name = `locked-${i}.dll`; await fsp.writeFile(path.join(root, name), bytes);
    files.push({ path: name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  await fsp.writeFile(path.join(root, '.soduwork-payload.json'), JSON.stringify({ schema: 1, files }));
  const lstat = fsp.lstat, calls = new Map(), waiting = new Map(), diagnostics = {}; let peakWaiting = 0;
  const releaseRound = delay => {
    const pending = waiting.get(delay);
    if (pending?.length === count) { for (const release of pending) release(); waiting.delete(delay); }
  };
  t.mock.method(fsp, 'lstat', async function(file, ...args) {
    const attempt = (calls.get(file) || 0) + 1; calls.set(file, attempt);
    if (attempt < 3) throw Object.assign(Error('temporarily unavailable'), { code: 'EBUSY' });
    return lstat.call(fsp, file, ...args);
  });
  const fallback = setTimeout(() => { for (const pending of waiting.values()) for (const release of pending) release(); }, 2000);
  t.after(() => clearTimeout(fallback));
  await verify(root, [], { concurrency: 4, diagnostics, sleep: delay => new Promise(resolve => {
    if (!waiting.has(delay)) waiting.set(delay, []);
    waiting.get(delay).push(resolve); peakWaiting = Math.max(peakWaiting, waiting.get(delay).length);
    releaseRound(delay);
  }) });
  assert.equal(peakWaiting, count, 'all 600 retries must be scheduled without occupying the four readers');
  assert.equal(calls.size, count); assert.ok([...calls.values()].every(value => value === 3));
  assert.equal(diagnostics.retryCount, 1200); assert.equal(diagnostics.retryDelayMs, 600000);
  assert.equal(diagnostics.slowFiles.length, 10);
});

test('corruption rejects only after other outstanding reads have closed', async t => {
  const root = await fixture(t);
  await fsp.writeFile(path.join(root, 'slow.dll'), Buffer.alloc(256 * 1024 + 17, 66));
  await inventory(root); await fsp.writeFile(path.join(root, 'runtime.dll'), 'EVIL');
  const open = fsp.open; let release, started, corruptClosed, openHandles = 0, settled = false;
  const gate = new Promise(resolve => { release = resolve; });
  const slowStarted = new Promise(resolve => { started = resolve; });
  const corruptionRead = new Promise(resolve => { corruptClosed = resolve; });
  const fallback = setTimeout(release, 2000); t.after(() => clearTimeout(fallback));
  t.mock.method(fsp, 'open', async function(file, ...args) {
    const handle = await open.call(fsp, file, ...args), read = handle.read.bind(handle), close = handle.close.bind(handle);
    openHandles++;
    handle.read = async (...params) => {
      if (file === path.join(root, 'slow.dll')) { started(); await gate; }
      return read(...params);
    };
    handle.close = async () => {
      try { return await close(); } finally {
        openHandles--; if (file === path.join(root, 'runtime.dll')) corruptClosed();
      }
    };
    return handle;
  });
  const snapshots = [];
  const pending = verify(root, [], { concurrency: 4, onProgress: x => snapshots.push(x) });
  pending.then(() => { settled = true; }, () => { settled = true; });
  await Promise.all([slowStarted, corruptionRead]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.ok(openHandles > 0); release();
  await assert.rejects(pending, /Corrupt payload/);
  assert.equal(openHandles, 0); assert.equal(snapshots.some(event => event.finished), false);
});

test('diagnostics bound slow paths and contain timing data without file contents', async t => {
  const root = await fixture(t), report = path.join(root, '.soduwork-update-details.json');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../build/verify-payload.cjs'), root, report], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const metrics = JSON.parse(await fsp.readFile(report, 'utf8')).performance;
  for (const key of ['elapsedMs', 'readMs', 'retryDelayMs', 'retryCount', 'concurrency']) assert.ok(Number.isFinite(metrics[key]), key);
  assert.ok(metrics.slowFiles.length <= 10);
  assert.ok(metrics.slowFiles.every(item => !path.isAbsolute(item.path) && !('content' in item)));
  for (const concurrency of [0, -1, 1.5, 9, '4']) await assert.rejects(verify(root, [], { concurrency }), /Invalid verification concurrency/);
});

test('failed retry waits and diagnostic callbacks do not leave background reads or timers', async t => {
  const root = await fixture(t), target = path.join(root, 'runtime.dll'), lstat = fsp.lstat;
  let pendingWaits = 0, activeStats = 0;
  t.mock.method(fsp, 'lstat', async function(file, ...args) {
    activeStats++;
    try {
      await new Promise(resolve => setImmediate(resolve));
      if (file === target) throw Object.assign(Error('locked'), { code: 'EBUSY' });
      return await lstat.call(fsp, file, ...args);
    } finally { activeStats--; }
  });
  await assert.rejects(verify(root, [], { concurrency: 2, sleep: async () => {
    pendingWaits++;
    try { await new Promise(resolve => setImmediate(resolve)); throw Error('wait failed'); }
    finally { pendingWaits--; }
  } }), /wait failed/);
  assert.equal(activeStats, 0); assert.equal(pendingWaits, 0);
  await assert.rejects(verify(root, [], { concurrency: 2, onRetry() { throw Error('observer failed'); } }), /observer failed/);
  assert.equal(activeStats, 0); assert.equal(pendingWaits, 0);
});

test('a small file growing after the first read is hashed through its new EOF and rejected', async t => {
  const root = await fixture(t), target = path.join(root, 'runtime.dll'), open = fsp.open;
  let appended = false;
  t.mock.method(fsp, 'open', async function(file, ...args) {
    const handle = await open.call(fsp, file, ...args), read = handle.read.bind(handle);
    if (file === target) handle.read = async (...params) => {
      const result = await read(...params);
      if (!appended && result.bytesRead > 0) { appended = true; await fsp.appendFile(file, Buffer.alloc(128 * 1024, 65)); }
      return result;
    };
    return handle;
  });
  await assert.rejects(verify(root), error => {
    assert.match(error.message, /Incomplete payload/);
    assert.equal(error.details.actualSize, 4 + 128 * 1024);
    assert.equal(error.details.actualSha256, require('node:crypto').createHash('sha256').update(fs.readFileSync(target)).digest('hex'));
    return true;
  });
});
