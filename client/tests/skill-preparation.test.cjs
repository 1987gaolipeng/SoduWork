'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const cache = require('../main/conversation/skill-cache');
const worker = require('../main/conversation/skill-cache-worker');
const roots = require('../main/conversation/skill-roots');

function archive(rows) {
  const locals = [], central = []; let offset = 0;
  for (const row of rows) {
    const name = Buffer.from(row.name), plain = Buffer.from(row.body), data = zlib.deflateRawSync(plain);
    const local = Buffer.alloc(30), entry = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(plain.length, 22); local.writeUInt16LE(name.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(plain.length, 24); entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42); entry.writeUInt32LE(((row.mode || 0o644) << 16) >>> 0, 38);
    locals.push(local, name, data); central.push(entry, name); offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(rows.length, 8); end.writeUInt16LE(rows.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function bundle(extra = []) {
  return archive([
    { name: 'manifest.json', body: JSON.stringify({ schemaVersion: 1,
      skills: [{ name: 'test-skill', dir: 'test-skill', version: 'v1' }] }) },
    { name: 'skills/test-skill/SKILL.md', body: '---\nname: test-skill\ndescription: Isolated fixture\n---\n' }, ...extra,
  ]);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-prep-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, app: { getPath: () => root } };
}

test('large first-time Skill installation preserves exact bytes while the main loop remains active', async t => {
  const { root, app } = fixture(t);
  const body = Buffer.alloc(128 * 1024, 65);
  const data = bundle(Array.from({ length: 200 }, (_, i) => ({ name: 'skills/test-skill/files/' + i + '.txt', body })));
  const digest = cache._digest(data); let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  let result;
  try { result = await worker.install(app, data, digest); } finally { clearInterval(timer); }
  assert.ok(ticks > 0, 'the desktop runs while hash/decompression/writes are in progress');
  assert.equal(result[0].bundleChecksum, digest);
  for (const i of [0, 99, 199]) assert.deepEqual(fs.readFileSync(path.join(result[0].path, 'files', i + '.txt')), body);
  assert.deepEqual(cache.installed(app), result);
  assert.deepEqual(fs.readdirSync(path.join(root, 'skill-cache')), [digest]);
});

test('worker integrity and archive guards fail closed, leave no staged files and permit a healthy retry', async t => {
  const { root, app } = fixture(t), good = bundle();
  const wrong = worker.install(app, good, '0'.repeat(64));
  const healthy = worker.install(app, good, cache._digest(good));
  await assert.rejects(wrong, /完整性/); assert.equal((await healthy).length, 1);
  for (const item of [
    { name: '../escape.txt', body: 'bad' },
    { name: 'skills/test-skill/link', body: 'target', mode: 0xa1ff },
    { name: 'skills/test-skill/bomb', body: Buffer.alloc(31 * 1024 * 1024) },
  ]) {
    const data = bundle([item]);
    await assert.rejects(worker.install(app, data, cache._digest(data)));
  }
  assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false);
  assert.ok(fs.readdirSync(path.join(root, 'skill-cache')).every(name => /^[a-f0-9]{64}$/.test(name)));
});

test('async Skill discovery preserves order and picks up installations without synchronous directory reads', async t => {
  const { root, app } = fixture(t), options = { home: path.join(root, 'home'), env: { CODEX_HOME: path.join(root, 'codex') } };
  const dir = path.join(root, 'skills', 'first'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), 'first');
  const expected = roots.discover(app, options), original = fs.readdirSync;
  try {
    fs.readdirSync = () => { throw Error('synchronous traversal'); };
    assert.deepEqual(await roots.discoverAsync(app, options), expected);
  } finally { fs.readdirSync = original; }
  const added = path.join(root, 'skills', 'second'); fs.mkdirSync(added); fs.writeFileSync(path.join(added, 'SKILL.md'), 'second');
  assert.ok((await roots.discoverAsync(app, options)).includes(added));
});

test('capability policy and asynchronous Skill discovery can finish in either order', async () => {
  let release; const dirs = new Promise(resolve => { release = resolve; });
  const result = require('../main/conversation/capabilities').inspect({
    skillDirs: dirs, policy: { ok: true, skills: [], enabled: [] }, deps: { exists: () => false, which: () => '' },
  });
  release([]);
  assert.equal((await result).policyOk, true);
});

