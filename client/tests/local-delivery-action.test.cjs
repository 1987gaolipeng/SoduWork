'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const { install } = require('../main/conversation/local-delivery-action');
const { scope } = require('../main/platform-connections/runtime.cjs');

function identity(user = 'one', hub = 'http://fixture.invalid') {
  const now = Math.floor(Date.now() / 1000);
  return { hub, clientId: 'test-device', session: Buffer.from(JSON.stringify({
    typ: 'device', uid: user, cid: 'test-device', iat: now - 10, exp: now + 3600,
  })).toString('base64url') + '.' + '0'.repeat(64) };
}
async function fixture(t, names = ['report.md']) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-local-action-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const items = [];
  for (const [index, name] of names.entries()) {
    const filename = path.join(cwd, name);
    await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, '# current local file');
    items.push({ artifactId: 'opaque-' + index, path: filename });
  }
  const calls = [], auth = identity();
  const handle = { cwd, sessionId: 'local', deliveryOwner: scope(auth), snapshot: () => ({ status: 'idle' }) };
  const frame = {}, event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false,
    getURL: () => pathToFileURL(path.resolve(__dirname, '../desk.html')).href } };
  const context = { handle, event, calls, items, auth, ids: items.map(row => row.artifactId), cwd };
  context.install = (options, action = 'open-local') => {
    let handler;
    install({ ipcMain: { handle: (channel, fn) => { if (channel === 'conversation-delivery-' + action) handler = fn; } },
      session: { get: ref => ref === 'valid' ? handle : null }, ownerOf: () => scope(auth),
      shell: { showItemInFolder: file => calls.push(['reveal', file]), openPath: async folder => { calls.push(['folder', folder]); return ''; } },
      snapshotFiles: () => ({ items }), ...options });
    return (ids = context.ids, supplied = event, ref = 'valid') => handler(supplied, ref, ids);
  };
  return context;
}

test('single current file is revealed without launching it or packaging/downloading', async t => {
  const f = await fixture(t, ['execute.cmd']);
  const action = f.install();
  await fs.writeFile(f.items[0].path, 'updated since original saved revision');
  assert.deepEqual(await action(), { ok: true });
  assert.deepEqual(f.calls, [['reveal', await fs.realpath(f.items[0].path)]]);
});

test('cloud continuation copies HTML and supporting assets into a new private local workspace', async t => {
  const f = await fixture(t), cache = await fixture(t, ['site/index.html','site/assets/app.js']);
  f.handle.passiveCloudView = true;
  for (const item of cache.items) { const stat = await fs.stat(item.path); Object.assign(item, {
    relative: path.relative(cache.cwd,item.path), name: path.basename(item.path), size: stat.size, at: Math.round(stat.mtimeMs) }); }
  const projected = { ...f.handle, cwd: cache.cwd, cloudArtifactCache: true };
  const action = f.install({ app: {getPath:()=>f.cwd}, resolveSession:async()=>projected, snapshotFiles:()=>({items:cache.items}) }, 'continue-local');
  const result = await action([cache.ids[0]]);
  assert.equal(result.ok,true,result.reason); assert.equal(result.preview,true); assert.notEqual(result.cwd,cache.cwd);
  assert.equal(await fs.readFile(path.join(result.cwd,'site/assets/app.js'),'utf8'),'# current local file');
  await fs.writeFile(result.file.path,'local edit');
  assert.equal(await fs.readFile(cache.items[0].path,'utf8'),'# current local file');
  assert.deepEqual(f.calls,[],'continuation must not launch executables or a file manager');
  const denied = await f.install({app:{getPath:()=>f.cwd},resolveSession:async()=>projected,snapshotFiles:()=>({items:cache.items}),ownerOf:()=>scope(identity('other'))},'continue-local')();
  assert.equal(denied.code,'DELIVERY_FORBIDDEN');
});

test('local continuation rejects non-cloud sessions and changed supporting files', async t => {
  const f=await fixture(t);
  assert.equal((await f.install({},'continue-local')()).code,'DELIVERY_INVALID_SELECTION');
  const projected={...f.handle,cloudArtifactCache:true};
  const stat=await fs.stat(f.items[0].path);
  Object.assign(f.items[0],{relative:'report.md',size:stat.size,at:Math.round(stat.mtimeMs)-1000});
  const result=await f.install({app:{getPath:()=>f.cwd},resolveSession:async()=>projected},'continue-local')();
  assert.equal(result.ok,false);assert.deepEqual(f.calls,[]);
});

test('multiple PC files produce a verified local ZIP without any save dialog or network', async t => {
  const f=await fixture(t,['index.html','notes.md']);
  f.handle.outputSnapshot=()=>require('../main/pi-session/outputs').scan(f.cwd,0,1);
  const runtime=require('../main/conversation/artifact-runtime');
  const indexed=runtime.snapshot(f.handle).items;
  const action=f.install({app:{getPath:()=>f.cwd},snapshotFiles:()=>({items:indexed})},'open-archive');
  assert.equal((await action(indexed.map(item=>item.artifactId))).ok,true);
  const archive=f.calls.at(-1)[1];assert.match(archive,/delivery-archives/);
  assert.equal((await fs.readFile(archive)).readUInt32LE(0),0x04034b50);
  assert.equal((await action(indexed.map(item=>item.artifactId))).ok,true);
  assert.equal(f.calls.at(-1)[1],archive,'same content reuses the immutable archive');
});
test('the ordinary artifact index works for reopened sessions without supplied file paths', async t => {
  const f = await fixture(t, ['report.md']);
  const artifacts = require('../main/conversation/artifact-runtime');
  f.handle.outputSnapshot = () => require('../main/pi-session/outputs').scan(f.cwd, 0);
  const ids = artifacts.snapshot(f.handle).items.map(row => row.artifactId);
  assert.equal(ids.length, 1);
  const action = f.install({ snapshotFiles: artifacts.snapshot });
  assert.deepEqual(await action(ids), { ok: true });
  assert.deepEqual(f.calls, [['reveal', await fs.realpath(f.items[0].path)]]);
});
test('multiple files open the actual common parent; different subfolders use the workspace', async t => {
  const f = await fixture(t, ['site/index.html', 'site/assets/style.css', 'reports/check.md']);
  const action = f.install();
  assert.equal((await action(f.ids.slice(0, 2))).ok, true);
  assert.deepEqual(f.calls.pop(), ['folder', await fs.realpath(path.join(f.cwd, 'site'))]);
  assert.equal((await action()).ok, true);
  assert.deepEqual(f.calls.pop(), ['folder', await fs.realpath(f.cwd)]);
});
test('remote views, in-progress handoffs, busy generation and missing sessions never open local caches', async t => {
  const f = await fixture(t);
  f.handle.passiveCloudView = true;
  assert.equal((await f.install()()).code, 'DELIVERY_REMOTE');
  f.handle.passiveCloudView = false;
  assert.equal((await f.install({ isRemote: () => true })()).code, 'DELIVERY_REMOTE');
  f.handle.inFlight = () => true;
  assert.equal((await f.install()()).code, 'DELIVERY_BUSY');
  delete f.handle.inFlight;
  for (const status of ['running', 'streaming', 'queued', 'compacting']) {
    f.handle.snapshot = () => ({ status });
    assert.equal((await f.install()()).code, 'DELIVERY_BUSY');
  }
  assert.equal((await f.install()(f.ids, f.event, 'closed')).code, 'DELIVERY_LOCAL_UNAVAILABLE');
  assert.equal(f.calls.length, 0);
});
test('missing and unknown outputs offer recovery but invalid selections and permissions do not', async t => {
  const f = await fixture(t), action = f.install();
  assert.equal((await action(['unknown'])).code, 'DELIVERY_LOCAL_UNAVAILABLE');
  for (const ids of [[], null, ['opaque-0', 'opaque-0'], [{ path: f.cwd }]]) {
    assert.equal((await action(ids)).code, 'DELIVERY_INVALID_SELECTION');
  }
  assert.equal((await f.install({ fileSystem: { ...fs, realpath: async () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); } } })()).code, 'DELIVERY_FORBIDDEN');
  await fs.unlink(f.items[0].path);
  assert.equal((await action()).code, 'DELIVERY_LOCAL_UNAVAILABLE');
  assert.equal(f.calls.length, 0);
});
test('untrusted frames, other accounts and other services are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.install()(f.ids, { ...f.event, senderFrame: {} })).code, 'DELIVERY_FORBIDDEN');
  assert.equal((await f.install()(f.ids, { ...f.event, sender: { ...f.event.sender, getURL: () => 'https://untrusted.invalid/desk.html' } })).code, 'DELIVERY_FORBIDDEN');
  assert.equal((await f.install({ ownerOf: () => scope(identity('two')) })()).code, 'DELIVERY_FORBIDDEN');
  // Account-scoped ownership permits local output access after a same-account Hub change.
  assert.deepEqual(await f.install({ ownerOf: () => scope(identity('one', 'https://other.invalid')) })(), { ok: true });
  assert.equal((await f.install({ ownerOf: () => { throw Error('no cached account'); } })()).code, 'DELIVERY_FORBIDDEN');
  delete f.handle.deliveryOwner;
  assert.equal((await f.install()()).code, 'DELIVERY_FORBIDDEN');
  assert.deepEqual(f.calls, [['reveal', await fs.realpath(f.items[0].path)]]);
});
test('account switch and session replacement during asynchronous validation cannot open files', async t => {
  const f = await fixture(t);
  let count = 0;
  assert.equal((await f.install({ ownerOf: () => scope(++count === 1 ? f.auth : identity('two')) })()).code, 'DELIVERY_FORBIDDEN');
  assert.equal((await f.install({ ownerOf: () => { f.handle.cwd += '-changed'; return scope(f.auth); } })()).code, 'DELIVERY_CONTEXT_CHANGED');
  f.handle.cwd = f.cwd;
  assert.equal((await f.install({ ownerOf: () => { f.handle.inFlight = () => true; return scope(f.auth); } })()).code, 'DELIVERY_BUSY');
  assert.equal(f.calls.length, 0);
});
test('lexical traversal, directory outputs and links outside the session are rejected', async t => {
  const f = await fixture(t), other = await fixture(t);
  const original = f.items[0].path;
  f.items[0].path = other.items[0].path;
  assert.equal((await f.install()()).code, 'DELIVERY_FORBIDDEN');
  f.items[0].path = path.join(f.cwd, 'folder'); await fs.mkdir(f.items[0].path);
  assert.equal((await f.install()()).code, 'DELIVERY_FORBIDDEN');
  const link = path.join(f.cwd, 'external');
  await fs.symlink(other.cwd, link, process.platform === 'win32' ? 'junction' : 'dir');
  f.items[0].path = path.join(link, 'report.md');
  assert.equal((await f.install()()).code, 'DELIVERY_FORBIDDEN');
  f.items[0].path = original;
  assert.equal(f.calls.length, 0);
});
test('a symlink retargeted during asynchronous checking cannot reveal a different local file', async t => {
  const f = await fixture(t, ['one/report.md', 'two/report.md']);
  const link = path.join(f.cwd, 'current');
  await fs.symlink(path.join(f.cwd, 'one'), link, process.platform === 'win32' ? 'junction' : 'dir');
  f.items[0].path = path.join(link, 'report.md');
  let scopes = 0;
  const action = f.install({ ownerOf: async () => {
    if (++scopes === 2) {
      await fs.unlink(link);
      await fs.symlink(path.join(f.cwd, 'two'), link, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return scope(f.auth);
  } });
  assert.equal((await action([f.ids[0]])).code, 'DELIVERY_CONTEXT_CHANGED');
  assert.equal(f.calls.length, 0);
});
test('file manager failure stays an open failure and never looks like a missing-file recovery', async t => {
  const f = await fixture(t, ['one.md', 'two.md']);
  const result = await f.install({ shell: { openPath: async () => 'OS failure' } })();
  assert.equal(result.code, 'DELIVERY_OPEN_FAILED');
  assert.equal(f.calls.length, 0);
});

test('an authenticated private cloud projection can reveal a cached output while its source workspace stays untouched', async t => {
  const f = await fixture(t), cache = await fixture(t);
  f.handle.passiveCloudView = true;
  const projected = { ...f.handle, cwd: cache.cwd, cloudArtifactCache: true };
  const action = f.install({ resolveSession: async original => {
    assert.equal(original, f.handle); return projected;
  }, snapshotFiles: handle => { assert.equal(handle, projected); return { items: cache.items }; } });
  assert.deepEqual(await action(), { ok: true });
  assert.deepEqual(f.calls, [['reveal', await fs.realpath(cache.items[0].path)]]);
  assert.equal(await fs.readFile(f.items[0].path, 'utf8'), '# current local file');
});

test('a cloud account or service switch during cache validation prevents revealing cached bytes', async t => {
  const f = await fixture(t);
  f.handle.passiveCloudView = true;
  let resolves = 0;
  const action = f.install({ resolveSession: async () => {
    if (++resolves > 2) throw Error('cloud owner changed');
    return { ...f.handle, cloudArtifactCache: true };
  } });
  assert.equal((await action()).code, 'DELIVERY_FORBIDDEN');
  assert.deepEqual(f.calls, []);
});
