'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const cache = require('../main/conversation/skill-cache');
const worker = require('../main/conversation/skill-cache-worker');
const capabilities = require('../main/conversation/capabilities');
const frontmatter = require('../main/conversation/skill-frontmatter');
const { entryCandidates } = require('../main/pi-session/session-helpers');

function zip(rows) {
  const locals = [], centrals = []; let offset = 0;
  for (const row of rows) {
    const name = Buffer.from(row.name), body = Buffer.from(row.body);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body); centrals.push(central, name); offset += local.length + name.length + body.length;
  }
  const central = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(rows.length, 8); end.writeUInt16LE(rows.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
function bundle(body, version = 'v1', name = 'debug-radar') {
  const manifest = { schemaVersion: 1, skills: [{ name, dir: '00-' + name, version, description: 'stale catalog description' }] };
  return { manifest, data: zip([{ name: 'manifest.json', body: JSON.stringify(manifest) }, { name: 'skills/00-' + name + '/SKILL.md', body }]) };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-yaml-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, app: { getPath: () => root }, identity: { hub: 'http://isolated.invalid', clientId: 'fixture', secret: 'fixture' } };
}
function policy(version = 'v1', enabled = true) {
  return { ok: true, skills: [{ name: 'debug-radar', checksum: version, downloadable: true }], enabled: enabled ? ['debug-radar'] : [] };
}
function seedLegacy(root, body, version = 'v1') {
  const { data, manifest } = bundle(body, version), digest = cache._digest(data), dir = path.join(root, 'skill-cache', digest);
  fs.mkdirSync(path.join(dir, 'skills/00-debug-radar'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, '.ready'), digest);
  fs.writeFileSync(path.join(dir, 'skills/00-debug-radar/SKILL.md'), body);
  return { dir, data, digest };
}
const BAD = '---\nname: debug-radar\ndescription: Systematic debugging: preserve evidence\n---\n# Instructions\n';
const GOOD = '---\nname: debug-radar\ndescription: "Systematic debugging: preserve evidence"\n---\n# Instructions\n';

for (const [label, body, reason] of [
  ['unquoted colon', BAD, /YAML/],
  ['duplicate key', '---\nname: debug-radar\ndescription: one\ndescription: two\n---\n', /YAML/],
  ['boolean description', '---\nname: debug-radar\ndescription: true\n---\n', /description/],
  ['number name', '---\nname: 12\ndescription: valid description\n---\n', /name/],
  ['manifest mismatch', '---\nname: issue-gardener\ndescription: valid description\n---\n', /name|名称/],
  ['oversized unicode description', '---\nname: debug-radar\ndescription: "' + '😀'.repeat(513) + '"\n---\n', /1024/],
  ['missing frontmatter', '# Instructions\n', /头|frontmatter|description/],
  ['invalid closing delimiter', '---\nname: debug-radar\ndescription: usable\n---garbage\nbody', /YAML/],
  ['numeric mapping key', '---\nname: debug-radar\ndescription: usable\nmetadata:\n  1: numeric key\n---\n', /YAML/],
  ['unsupported tagged metadata', '---\nname: debug-radar\ndescription: usable\nmetadata: !!set\n  first: null\n---\n', /YAML/],
  ['aliased metadata', '---\nname: debug-radar\ndescription: usable\nmetadata: &value example\nextra: *value\n---\n', /YAML/],
  ['nontext compatibility', '---\nname: debug-radar\ndescription: usable\ncompatibility: false\n---\n', /compatibility/],
  ['oversized compatibility', '---\nname: debug-radar\ndescription: usable\ncompatibility: "' + '😀'.repeat(251) + '"\n---\n', /500/],
  ['invalid UTF-8', Buffer.concat([Buffer.from('---\nname: debug-radar\ndescription: text '), Buffer.from([0xff]), Buffer.from('\n---\n')]), /UTF-8/],
]) test('invalid ' + label + ' cannot publish a ready installation', t => {
  const { root, app } = fixture(t), { data } = bundle(body), digest = cache._digest(data);
  assert.throws(() => cache.install(app, data, digest), e => /debug-radar/.test(e.message) && reason.test(e.message));
  assert.equal(fs.existsSync(path.join(root, 'skill-cache', digest, '.ready')), false);
  assert.deepEqual(cache.installed(app), []);
});

const variants = [
  ['double quoted', GOOD, 'Systematic debugging: preserve evidence'],
  ['single quoted', "---\nname: debug-radar\ndescription: 'Track evidence: do not guess'\n---\n", 'Track evidence: do not guess'],
  ['block', '---\nname: debug-radar\ndescription: |\n  Track evidence: now\n  Then verify\n---\n', 'Track evidence: now\nThen verify\n'],
  ['hash quoted', '---\nname: debug-radar\ndescription: "Keep # tags: all"\n---\n', 'Keep # tags: all'],
  ['inline comment', '---\nname: debug-radar\ndescription: useful # comment\n---\n', 'useful'],
  ['CRLF BOM', '\ufeff' + GOOD.replace(/\n/g, '\r\n'), 'Systematic debugging: preserve evidence'],
  ['YAML 1.2 ordinary word', '---\nname: debug-radar\ndescription: on\n---\n', 'on'],
  ['UTF-16 length boundary', '---\nname: debug-radar\ndescription: "' + '😀'.repeat(512) + '"\n---\n', '😀'.repeat(512)],
];
for (const [label, body, description] of variants) test('valid ' + label + ' retains exact runtime metadata and loads in Pi', async t => {
  const { app } = fixture(t), { data } = bundle(body), [record] = await worker.install(app, data, cache._digest(data));
  assert.equal(record.name, 'debug-radar');
  assert.equal(record.description, description);
  assert.equal(fs.readFileSync(path.join(record.path, 'SKILL.md'), 'utf8'), body);
  const entry = entryCandidates(app).find(fs.existsSync);
  const sdk = await import(pathToFileURL(path.join(path.dirname(entry), 'core/skills.js')).href);
  const loaded = sdk.loadSkillsFromDir({ dir: record.path, source: 'path' });
  assert.equal(loaded.skills.length, 1);
  assert.equal(loaded.skills[0].description, description);
  assert.deepEqual(loaded.diagnostics, []);
});

test('corrupt old ready cache is not installed and requested capability cannot silently omit it', async t => {
  const f = fixture(t), old = seedLegacy(f.root, BAD);
  assert.deepEqual(cache.installed(f.app), []);
  const opts = { ...f, policy: policy(), skillDirs: [], deps: { exists: () => false }, fetchImpl: async () => new Response(null, { status: 503 }) };
  const defaults = await capabilities.resolve(opts);
  assert.deepEqual(defaults.skills, []);
  assert.ok(defaults.warnings.some(message => /debug-radar.*YAML/.test(message)));
  await assert.rejects(capabilities.resolve({ ...opts, selectedSkills: ['debug-radar'] }), /debug-radar.*YAML/);
  assert.equal(fs.readFileSync(path.join(old.dir, 'skills/00-debug-radar/SKILL.md'), 'utf8'), BAD);
  const result = await cache.ensure({ ...opts, policy: policy('v1', false) });
  assert.equal(result.ok, true, 'unrequested old invalid packages must not block an unrelated conversation');
});

test('invalid download throws before capability resolution succeeds and cleans only its staging directory', async t => {
  const f = fixture(t), { data } = bundle(BAD), digest = cache._digest(data);
  const opts = { ...f, policy: policy(), selectedSkills: ['debug-radar'], skillDirs: [], deps: { exists: () => false }, fetchImpl: async () => new Response(data, { headers: { 'X-SoduWork-Skill-Sha256': digest } }) };
  await assert.rejects(capabilities.resolve(opts), /debug-radar.*YAML/);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'skill-cache')), []);
});

test('a corrected version installs beside an invalid old immutable cache and is reused without download', async t => {
  const f = fixture(t), old = seedLegacy(f.root, BAD), { data } = bundle(GOOD, 'v2');
  const options = { ...f, policy: policy('v2'), fetchImpl: async () => new Response(data, { headers: { 'X-SoduWork-Skill-Sha256': cache._digest(data) } }) };
  const result = await cache.ensure(options);
  assert.equal(result.ok, true); assert.equal(result.contracts[0].version, 'v2');
  assert.equal(fs.readFileSync(path.join(old.dir, 'skills/00-debug-radar/SKILL.md'), 'utf8'), BAD);
  assert.deepEqual(await cache.ensure({ ...options, fetchImpl: () => assert.fail('exact healthy version must be reused') }), result);
});

test('post-install modification is detected before an enabled cached Skill is reused', async t => {
  const f = fixture(t), { data } = bundle(GOOD), [record] = cache.install(f.app, data, cache._digest(data));
  fs.writeFileSync(path.join(record.path, 'SKILL.md'), BAD);
  await assert.rejects(cache.ensure({ ...f, policy: policy(), fetchImpl: async () => new Response(null, { status: 503 }) }), /debug-radar.*YAML/);
});

test('cached validation runs outside the main thread even when no download is necessary', async t => {
  const f = fixture(t), { data } = bundle(GOOD); cache.install(f.app, data, cache._digest(data));
  const read = fs.readFileSync, readdir = fs.readdirSync;
  try {
    fs.readFileSync = function(file, ...args) { if (String(file).includes(path.join(f.root, 'skill-cache'))) throw Error('main-thread cache read'); return read.call(this, file, ...args); };
    fs.readdirSync = function(file, ...args) { if (String(file).includes(path.join(f.root, 'skill-cache'))) throw Error('main-thread cache traversal'); return readdir.call(this, file, ...args); };
    const result = await cache.ensure({ ...f, policy: policy(), fetchImpl: () => assert.fail('download must not be necessary') });
    assert.equal(result.contracts[0].installed, true);
  } finally { fs.readFileSync = read; fs.readdirSync = readdir; }
});

test('a damaged copy cannot hide a healthy exact version in a different immutable bundle', async t => {
  const f = fixture(t), old = seedLegacy(f.root, BAD), { data } = bundle(GOOD);
  const [healthy] = cache.install(f.app, data, cache._digest(data));
  const readdir = fs.readdirSync;
  try {
    // Directory enumeration order is unspecified: exercise damaged-first order.
    fs.readdirSync = function(dir, ...args) {
      if (String(dir) === path.join(f.root, 'skill-cache')) return [old.digest, healthy.bundleChecksum];
      return readdir.call(this, dir, ...args);
    };
    assert.deepEqual(cache.installed(f.app).map(item => item.path), [healthy.path]);
  } finally { fs.readdirSync = readdir; }
});

test('duplicate manifest names cannot select one of two conflicting identities', t => {
  const f = fixture(t);
  const manifest = { schemaVersion: 1, skills: [
    { name: 'debug-radar', dir: 'one', version: 'v1' },
    { name: 'debug-radar', dir: 'two', version: 'v2' },
  ] };
  const data = zip([{ name: 'manifest.json', body: JSON.stringify(manifest) },
    { name: 'skills/one/SKILL.md', body: GOOD }, { name: 'skills/two/SKILL.md', body: GOOD }]);
  const digest = cache._digest(data), dir = path.join(f.root, 'skill-cache', digest);
  for (const folder of ['one', 'two']) { fs.mkdirSync(path.join(dir, 'skills', folder), { recursive: true }); fs.writeFileSync(path.join(dir, 'skills', folder, 'SKILL.md'), GOOD); }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest)); fs.writeFileSync(path.join(dir, '.ready'), digest);
  assert.deepEqual(cache.installed(f.app), []);
  assert.throws(() => cache.install(f.app, data, digest), /debug-radar.*重复/);
});

test('retrying a damaged cache marker never deletes an existing immutable directory', t => {
  const f = fixture(t), { data } = bundle(GOOD), digest = cache._digest(data), dir = path.join(f.root, 'skill-cache', digest);
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'user-notes.txt'), 'keep existing files');
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{broken');
  assert.throws(() => cache.install(f.app, data, digest), /缓存/);
  assert.equal(fs.readFileSync(path.join(dir, 'user-notes.txt'), 'utf8'), 'keep existing files');
});

test('packaged worker validates using the parser shipped with its Pi runtime', async t => {
  const f = fixture(t), previousResources = process.resourcesPath;
  const entry = entryCandidates(f.app).find(fs.existsSync);
  const yamlRoot = path.dirname(createRequire(entry).resolve('yaml/package.json'));
  const resources = path.join(f.root, 'resources'), sdk = path.join(resources, 'pi/node_modules/@earendil-works/pi-coding-agent');
  fs.mkdirSync(path.join(sdk, 'dist'), { recursive: true }); fs.writeFileSync(path.join(sdk, 'dist/index.js'), '');
  await fs.promises.cp(yamlRoot, path.join(sdk, 'node_modules/yaml'), { recursive: true });
  process.resourcesPath = resources;
  try {
    const { data } = bundle(GOOD), [record] = await worker.install({ ...f.app, isPackaged: true }, data, cache._digest(data));
    assert.equal(record.description, 'Systematic debugging: preserve evidence');
  } finally {
    if (previousResources === undefined) delete process.resourcesPath; else process.resourcesPath = previousResources;
  }
});

for (const [label, extras] of [
  ['duplicate manifest', [{ name: 'manifest.json', body: '{"schemaVersion":1,"skills":[]}' }]],
  ['case variant manifest', [{ name: 'MANIFEST.JSON', body: '{"schemaVersion":1,"skills":[]}' }]],
  ['case variant Skill', [{ name: 'skills/00-debug-radar/skill.md', body: BAD }]],
  ['Unicode equivalent files', [{ name: 'skills/00-debug-radar/assets/café.txt', body: 'one' },
    { name: 'skills/00-debug-radar/assets/cafe\u0301.txt', body: 'two' }]],
  ['file and directory collision', [{ name: 'skills/00-debug-radar/assets/item', body: 'one' },
    { name: 'skills/00-debug-radar/assets/ITEM/', body: '' }]],
]) test(label + ' is rejected before extraction or publication', t => {
  const f = fixture(t);
  const manifest = { schemaVersion: 1, skills: [{ name: 'debug-radar', dir: '00-debug-radar', version: 'v1' }] };
  const data = zip([{ name: 'manifest.json', body: JSON.stringify(manifest) },
    { name: 'skills/00-debug-radar/SKILL.md', body: GOOD }, ...extras]);
  assert.throws(() => cache.install(f.app, data, cache._digest(data)), /重复|冲突/);
  assert.equal(fs.existsSync(path.join(f.root, 'skill-cache')), false);
});

for (const [levels, allowed] of [[14, true], [16, true], [20, true], [30, true], [31, false], [32, false]]) {
  test('frontmatter mapping depth ' + levels + ' follows the shared 32-node-depth boundary', () => {
    // Root map depth 1, metadata map depth 2; the final scalar is levels + 2.
    const nested = '{ child: '.repeat(levels) + 'value' + ' }'.repeat(levels);
    const raw = '---\nname: debug-radar\ndescription: Valid nested metadata\nmetadata: ' + nested + '\n---\n';
    if (allowed) assert.equal(frontmatter.parse(raw, 'debug-radar').description, 'Valid nested metadata');
    else assert.throws(() => frontmatter.parse(raw, 'debug-radar'), /YAML/);
  });
}
for (const [count, allowed] of [[2040, true], [2041, true], [2042, false]]) {
  test('frontmatter sequence ' + count + ' follows the shared 2048-node-count boundary', () => {
    // Root map + 3 keys + name/description values + sequence = 7 nodes.
    const raw = '---\nname: debug-radar\ndescription: Valid metadata\nmetadata: [' + Array(count).fill('value').join(',') + ']\n---\n';
    if (allowed) assert.equal(frontmatter.parse(raw, 'debug-radar').metadata.length, count);
    else assert.throws(() => frontmatter.parse(raw, 'debug-radar'), /YAML/);
  });
}
for (const scalar of ['!!bool yes', '!!bool bananas', '!!float 1:2.3', '!!int 12:34', '!!null anything']) {
  test('invalid explicit core scalar ' + scalar + ' matches backend rejection', () => {
    const raw = '---\nname: debug-radar\ndescription: Valid metadata\nmetadata: ' + scalar + '\n---\n';
    assert.throws(() => frontmatter.parse(raw, 'debug-radar'), /YAML/);
  });
}
test('frontmatter delimiters match backend exact full-line validation', () => {
  for (const raw of [GOOD.replace('---\n', '--- \n'), GOOD.replace('\n---\n', '\n--- \n')]) {
    assert.throws(() => frontmatter.parse(raw, 'debug-radar'), /YAML/);
  }
});

for (const enabled of [true, false]) test('HTTP 409 isolates defaults but blocks explicit Skill selection: ' + enabled, async t => {
  const f = fixture(t);
  const options = { ...f, policy: policy('v1', enabled),
    selectedSkills: enabled ? [] : ['debug-radar'], skillDirs: [], deps: { exists: () => false },
    fetchImpl: async () => new Response(JSON.stringify({ detail: 'debug-radar/SKILL.md: YAML 格式无效\n  source body must not be repeated' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } }),
  };
  const validReason = message => /debug-radar/.test(message) && /SKILL.md/.test(message) &&
    /修正|重新导入/.test(message) && !/source body/.test(message);
  if (enabled) {
    const result = await capabilities.resolve(options);
    assert.deepEqual(result.skills, []);
    assert.ok(result.warnings.some(validReason));
  } else await assert.rejects(capabilities.resolve(options), error => validReason(error.message));
  assert.equal(fs.existsSync(path.join(f.root, 'skill-cache')), false);
});

test('HTTP 409 policy change retains its distinct refresh guidance', async t => {
  const f = fixture(t);
  await assert.rejects(capabilities.resolve({ ...f, policy: policy(), selectedSkills: ['debug-radar'], skillDirs: [], deps: { exists: () => false },
    fetchImpl: async () => new Response(JSON.stringify({ detail: '企业能力目录配置正在变化，请刷新后重试' }), { status: 409 }),
  }), error => /debug-radar/.test(error.message) && /配置正在变化/.test(error.message) && /刷新/.test(error.message) && !/YAML|格式无效/.test(error.message));
});

test('HTTP 409 remains blocking with oversized or non-JSON details', async t => {
  const f = fixture(t);
  for (const body of ['<html>' + 'untrusted'.repeat(3000) + '</html>', '{broken json']) {
    await assert.rejects(capabilities.resolve({ ...f, policy: policy(), selectedSkills: ['debug-radar'], skillDirs: [], deps: { exists: () => false },
      fetchImpl: async () => new Response(body, { status: 409 }),
    }), error => /debug-radar/.test(error.message) && /409/.test(error.message) && /刷新/.test(error.message) && error.message.length < 1000 && !/html|untrusted/.test(error.message));
  }
});

test('ordinary HTTP 503 keeps the existing temporary-sync warning behavior', async t => {
  const f = fixture(t);
  const result = await capabilities.resolve({ ...f, policy: policy(), selectedSkills: ['debug-radar'], skillDirs: [], deps: { exists: () => false },
    fetchImpl: async () => new Response(null, { status: 503 }),
  });
  assert.deepEqual(result.skills, []);
  assert.ok(result.warnings.some(warning => /HTTP 503/.test(warning)));
});

for (const explicitHealthy of [false, true]) test('one malformed default does not hide a healthy ' + (explicitHealthy ? 'selected' : 'default') + ' Skill in a failed aggregate', async t => {
  const f = fixture(t), requests = [];
  const validBody = GOOD.replace('name: debug-radar', 'name: healthy');
  const healthy = bundle(validBody, 'good-v1', 'healthy').data;
  const result = await capabilities.resolve({ ...f, skillDirs: [], deps: { exists: () => false },
    policy: { ok: true, enabled: ['debug-radar', ...(explicitHealthy ? [] : ['healthy'])], skills: [
      { name: 'debug-radar', checksum: 'bad-v1', downloadable: true },
      { name: 'healthy', checksum: 'good-v1', downloadable: true },
    ] }, selectedSkills: explicitHealthy ? ['healthy'] : [],
    fetchImpl: async (_url, init) => {
      const names = JSON.parse(init.body).names; requests.push(names);
      if (names.includes('debug-radar')) return new Response(JSON.stringify({ detail: 'debug-radar/SKILL.md: YAML 格式无效' }), { status: 409 });
      return new Response(healthy, { headers: { 'X-SoduWork-Skill-Sha256': cache._digest(healthy) } });
    },
  });
  assert.deepEqual(requests[0], ['debug-radar', 'healthy']);
  assert.equal(requests.length, 3);
  assert.deepEqual(result.skills.map(item => item.name), ['healthy']);
  assert.equal(result.skillDirs.length, 1);
  assert.equal(result.optionalSkillDirs.length, explicitHealthy ? 0 : 1);
  assert.ok(result.warnings.some(message => /debug-radar.*YAML/.test(message)));
  assert.deepEqual(cache.installed(f.app).map(item => item.name), ['healthy']);
});

test('a malformed default download is rejected without marking it ready or blocking ordinary chat', async t => {
  const f = fixture(t), { data } = bundle(BAD);
  const result = await capabilities.resolve({ ...f, policy: policy(), skillDirs: [], deps: { exists: () => false },
    fetchImpl: async () => new Response(data, { headers: { 'X-SoduWork-Skill-Sha256': cache._digest(data) } }),
  });
  assert.deepEqual(result.skills, []);
  assert.ok(result.warnings.some(message => /debug-radar.*YAML/.test(message)));
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'skill-cache')), []);
});

test('an invalid explicitly selected Skill still blocks even when defaults are allowed to be unavailable', async t => {
  const f = fixture(t);
  await assert.rejects(capabilities.resolve({ ...f, policy: { ok: true, enabled: ['healthy'], skills: [
    { name: 'healthy', checksum: 'v1', downloadable: true },
    { name: 'debug-radar', checksum: 'v1', downloadable: true },
  ] }, selectedSkills: ['debug-radar'], skillDirs: [], deps: { exists: () => false },
    fetchImpl: async () => new Response(JSON.stringify({ detail: 'SKILL.md: YAML 格式无效' }), { status: 409 }),
  }), /debug-radar.*YAML/);
});
