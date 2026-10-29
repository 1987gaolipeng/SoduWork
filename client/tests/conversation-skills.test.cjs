'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const cache = require('../main/conversation/skill-cache');
const modelConfig = require('../main/pi-session/model-config');

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  entries.forEach((entry) => {
    const name = Buffer.from(entry.name, 'utf8');
    const body = Buffer.from(entry.body || '');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode || 0o644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  });
  const centralBody = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBody.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBody, eocd]);
}

function packageFor(name, version) {
  const manifest = {
    schemaVersion: 1,
    skills: [{
      name, description: 'Research with an evidence trail.',
      compatibility: '', version, dir: '00-' + name,
    }],
  };
  return zip([
    { name: 'manifest.json', body: JSON.stringify(manifest) },
    {
      name: 'skills/00-' + name + '/SKILL.md',
      body: '---\nname: ' + name + '\ndescription: Research with an evidence trail.\n---\n',
    },
  ]);
}

function appAt(root) {
  return { getPath(name) { assert.equal(name, 'userData'); return root; } };
}

test('Skill bundle is verified and atomically reused by exact version', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = appAt(root);
  const version = 'a'.repeat(64);
  const data = packageFor('company-research', version);
  const digest = cache._digest(data);

  assert.throws(() => cache.install(app, data, 'b'.repeat(64)), /完整性/);
  const first = cache.install(app, data, digest);
  assert.equal(first.length, 1);
  assert.equal(first[0].name, 'company-research');
  assert.equal(first[0].version, version);
  assert.ok(fs.existsSync(path.join(first[0].path, 'SKILL.md')));
  assert.deepEqual(cache.install(app, data, digest), first);
  assert.equal(cache.installed(app)[0].bundleChecksum, digest);

  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    return new Response(data, { status: 200, headers: { 'X-SoduWork-Skill-Sha256': digest } });
  };
  const policy = {
    skills: [{
      id: 'skill:company-research', name: 'company-research',
      checksum: version, downloadable: true,
    }],
    enabled: [],
  };
  const resolved = await cache.ensure({
    app, identity: { hub: 'http://hub', clientId: 'c1', secret: 's1' },
    policy, names: ['company-research'], fetchImpl,
  });
  assert.equal(fetches, 0, 'exact cached version must not download again');
  assert.equal(resolved.contracts[0].installed, true);
  assert.ok(resolved.dirs.includes(first[0].path));

  const revoked = await cache.ensure({
    app, identity: { hub: 'http://hub', clientId: 'c1', secret: 's1' },
    policy: { skills: [], enabled: [] }, names: ['company-research'], fetchImpl,
  });
  assert.deepEqual(revoked.contracts, []);
  assert.deepEqual(revoked.dirs, []);
});

test('Remote Skill is downloaded only when enabled or selected', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = appAt(root);
  const version = 'c'.repeat(64);
  const data = packageFor('product-brief', version);
  const digest = cache._digest(data);
  let fetches = 0;
  const fetchImpl = async (_url, options) => {
    fetches += 1;
    assert.deepEqual(JSON.parse(options.body).names, ['product-brief']);
    return new Response(data, { status: 200, headers: { 'X-SoduWork-Skill-Sha256': digest } });
  };
  const policy = {
    skills: [{ name: 'product-brief', checksum: version, downloadable: true }],
    enabled: [],
  };
  const catalogOnly = await cache.ensure({
    app, identity: { hub: 'http://hub', clientId: 'c1', secret: 's1' },
    policy, fetchImpl,
  });
  assert.equal(fetches, 0);
  assert.deepEqual(catalogOnly.contracts, []);

  const selected = await cache.ensure({
    app, identity: { hub: 'http://hub', clientId: 'c1', secret: 's1' },
    policy, names: ['product-brief'], fetchImpl,
  });
  assert.equal(fetches, 1);
  assert.equal(selected.contracts[0].version, version);
  assert.equal(selected.dirs.length, 1);
});

test('Exact governed Skill package wins over a same-name native folder', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-precedence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = appAt(root);
  const native = path.join(root, 'native-copy');
  fs.mkdirSync(native, { recursive: true });
  fs.writeFileSync(path.join(native, 'SKILL.md'), [
    '---', 'name: governed-review', 'description: stale native copy', '---', '',
  ].join('\n'));
  const version = 'd'.repeat(64);
  const data = packageFor('governed-review', version);
  const digest = cache._digest(data);
  let fetches = 0;
  const result = await cache.ensure({
    app,
    identity: { hub: 'http://hub', clientId: 'c1', secret: 's1' },
    policy: {
      skills: [{
        name: 'governed-review', checksum: version, downloadable: true,
      }],
      enabled: ['governed-review'],
    },
    localDirs: [native],
    fetchImpl: async () => {
      fetches += 1;
      return new Response(data, {
        status: 200, headers: { 'X-SoduWork-Skill-Sha256': digest },
      });
    },
  });
  assert.equal(fetches, 1);
  assert.equal(result.contracts[0].version, version);
  assert.notEqual(path.normalize(result.contracts[0].path), path.normalize(native));
  assert.deepEqual(result.dirs, [result.contracts[0].path]);
});

test('Unsafe ZIP paths and symbolic links are rejected', () => {
  const traversal = zip([{ name: '../SKILL.md', body: 'bad' }]);
  assert.throws(() => cache._entries(traversal), /越界|不安全/);
  const symlink = zip([{ name: 'skills/link', body: 'target', mode: 0o120777 }]);
  assert.throws(() => cache._entries(symlink), /符号链接/);
});

test('Hash opens palette queries but body syntax never creates a skill selection', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'components', 'panels', 'panels-compose-skills.js'), 'utf8');
  const localStorage = {
    getItem() { return null; }, setItem() {},
  };
  const context = { window: {}, localStorage };
  vm.runInNewContext(source, context);
  const skills = context.window.ComposeSkills;
  /* Use # for skill selection without triggering on mid-sentence hashtags. */
  assert.equal(skills.queryOf('帮我做 #prod', 10).query, 'prod');
  assert.equal(skills.queryOf('#prod', 5).query, 'prod');
  assert.equal(skills.queryOf('进度100%#完成', 9), null);
  assert.equal(skills.queryOf('https://example.com', 19), null);
  /* Only explicit menu selection creates structured skill metadata; typed markers alone do not. */
  assert.deepEqual(
    Array.from(skills.namesFromText('/skill:product-brief 写方案 #data-check #skill:web-audit')),
    []);
  assert.deepEqual(Array.from(skills.namesFromText('普通自然语言 #中文标签')), []);
});

test('Model config request is deduplicated and cached only in memory', async () => {
  modelConfig._modelCache.clear();
  modelConfig._modelPending.clear();
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(JSON.stringify({
      ok: true, key: 'short-ticket', mcpKey: 'mcp-ticket',
      expiresIn: 3600, model: 'company-model', path: '/api/v1/ai-proxy/v1',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const identity = require('./helpers/platform-session-fixture.cjs').identity();
    const [a, b] = await Promise.all([
      modelConfig.fetchModel(identity), modelConfig.fetchModel(identity),
    ]);
    assert.equal(a.model.id, 'company-model');
    assert.equal(b.model.key, 'short-ticket');
    assert.equal(calls, 1);
    await modelConfig.fetchModel(identity);
    assert.equal(calls, 1);
  } finally {
    global.fetch = original;
    modelConfig._modelCache.clear();
    modelConfig._modelPending.clear();
  }
});

test('expired device session retries model config with a renewed same-account session', async t => {
  const calls = [];
  const { identity: fixtureIdentity, sessions } = require('./helpers/platform-session-fixture.cjs');
  const auth = require('../main/device-auth-request');
  const identity = { ...fixtureIdentity('expired'), secret: 's'.repeat(40) };
  const renewed = sessions().renewed;
  auth.setIdentityRefresher(async () => ({ ...identity, session: renewed }));
  t.after(() => auth.setIdentityRefresher(null));
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: { ...options.headers } });
    if (calls.length === 1) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({
      ok: true, key: 'fresh-ticket', mcpKey: 'fresh-mcp', expiresIn: 43200,
      model: 'company-model', path: '/api/v1/ai-proxy/v1',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await modelConfig.fetchModel(identity, '', 8000, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.Authorization, 'Device ' + identity.session);
  assert.equal(calls[1].headers['X-Soduwork-Secret'], undefined);
  assert.equal(calls[1].headers.Authorization, 'Device ' + renewed);
  assert.ok(result.model.proxyExpiresAt > Date.now());
});

test('same Skill can synchronize into two independent client caches concurrently', async (t) => {
  const roots = [0, 1].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-isolated-')));
  t.after(() => roots.forEach(root => fs.rmSync(root, {recursive:true,force:true})));
  const version = 'e'.repeat(64), data = packageFor('shared', version);
  const policy = { skills: [{name:'shared',checksum:version,downloadable:true}],enabled:['shared'] };
  const fetchImpl = async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return new Response(data, { headers: { 'X-SoduWork-Skill-Sha256': cache._digest(data) } });
  };
  const results = await Promise.all(roots.map((root, i) => cache.ensure({
    app:appAt(root), policy, identity:{hub:'http://test',clientId:'c'+i,secret:'fixture'}, fetchImpl
  })));
  results.forEach((result, i) => {
    assert.equal(result.ok, true);
    assert.equal(result.contracts.length, 1);
    assert.ok(result.contracts[0].path.startsWith(roots[i]));
  });
});

test('coexisting old and new Skill caches reuse the exact requested version', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-versions-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const app = appAt(root), versions = ['1'.repeat(64), '2'.repeat(64)];
  versions.forEach(version => { const data=packageFor('shared',version); cache.install(app,data,cache._digest(data)); });
  for (const version of versions) {
    const result = await cache.ensure({app, policy:{skills:[{name:'shared',checksum:version,downloadable:true}],enabled:['shared']},
      identity:{hub:'http://test',clientId:'c1',secret:'fixture'},
      fetchImpl:()=>{ throw new Error('Exact cached version must not download'); }});
    assert.equal(result.ok,true);
    assert.equal(result.contracts[0].version, version);
  }
});

test('publication changing during download cannot silently drop a requested Skill', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-race-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const data = packageFor('shared','2'.repeat(64));
  const result = await cache.ensure({app:appAt(root),
    policy:{skills:[{name:'shared',checksum:'1'.repeat(64),downloadable:true}],enabled:['shared']},
    identity:{hub:'http://test',clientId:'c1',secret:'fixture'},
    fetchImpl:async()=>new Response(data,{headers:{'X-SoduWork-Skill-Sha256':cache._digest(data)}})});
  assert.equal(result.ok,false);
  assert.match(result.warning,/版本已变化/);
  assert.equal(result.contracts.length,0);
});
